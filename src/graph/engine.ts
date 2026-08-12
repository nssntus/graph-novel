import { randomUUID } from "node:crypto";
import type { GraphEventSink } from "../runtime/types.js";
import type { CheckpointStore } from "../checkpoint/store.js";
import {
  type ExecutionEvent,
  type GraphNovelState,
  type NodeExecutionRecord,
} from "../state/state.js";

export interface GraphNodeContext {
  state: GraphNovelState;
  nodeKey: string;
  attempt: number;
  sessionId: string;
  signal?: AbortSignal;
  eventSink?: GraphEventSink;
}

export type GraphNodeOutcome =
  | { status: "completed" }
  | { status: "awaiting_gate"; gate: string }
  | { status: "failed"; error: string };

export interface GraphNode {
  key: string;
  run(context: GraphNodeContext): Promise<GraphNodeOutcome>;
}

export interface GraphEdge {
  from: string;
  to: string | null;
  reason: string;
  when(outcome: GraphNodeOutcome, state: GraphNovelState): boolean;
}

export type GraphRunStatus = "completed" | "awaiting_approval" | "failed";

export interface GraphRunResult {
  status: GraphRunStatus;
  state: GraphNovelState;
}

export interface GraphRunOptions {
  signal?: AbortSignal;
}

export class GraphEngine {
  constructor(
    private readonly nodes: readonly GraphNode[],
    private readonly edges: readonly GraphEdge[],
    private readonly checkpoints: CheckpointStore,
    private readonly maxTransitions = 100,
  ) {}

  async run(
    state: GraphNovelState,
    startNode: string,
    sink?: GraphEventSink,
    options: GraphRunOptions = {},
  ): Promise<GraphRunResult> {
    return this.checkpoints.withProjectLock(state.projectId, async () => {
      let currentNode: string | null = startNode;
      let transitions = 0;

      while (currentNode !== null) {
        if (options.signal?.aborted) {
          return this.fail(
            state,
            currentNode,
            state.nodes[currentNode]?.attempts ?? 0,
            "Graph run aborted",
            sink,
          );
        }
        if (transitions >= this.maxTransitions) {
          return this.fail(state, currentNode, 0, "Graph transition limit exceeded", sink);
        }
        transitions += 1;

        const node = this.nodes.find((candidate) => candidate.key === currentNode);
        if (!node) return this.fail(state, currentNode, 0, "Unknown graph node", sink);

        const record = this.beginNode(state, currentNode);
        const sessionId = record.sessionId!;
        this.appendEvent(state, {
          type: "node_started",
          nodeKey: currentNode,
          attempt: record.attempts,
          sessionId,
          timestamp: new Date().toISOString(),
        });
        await this.checkpoints.save(state);
        await sink?.({
          type: "node_started",
          nodeKey: currentNode,
          attempt: record.attempts,
          sessionId,
          timestamp: new Date().toISOString(),
        });

        let outcome: GraphNodeOutcome;
        try {
          outcome = await node.run({
            state,
            nodeKey: currentNode,
            attempt: record.attempts,
            sessionId,
            signal: options.signal,
            eventSink: sink,
          });
        } catch (error) {
          outcome = {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }

        if (outcome.status === "failed") {
          return this.fail(state, currentNode, record.attempts, outcome.error, sink);
        }
        if (outcome.status === "awaiting_gate") {
          state.workflowPhase = "awaiting_approval";
          state.pendingGate = outcome.gate;
          this.appendEvent(state, {
            type: "gate_reached",
            nodeKey: currentNode,
            gate: outcome.gate,
            attempt: record.attempts,
            timestamp: new Date().toISOString(),
          });
          await this.checkpoints.save(state);
          return { status: "awaiting_approval", state };
        }

        this.completeNode(state, currentNode, record);
        const edge = this.edges.find(
          (candidate) =>
            candidate.from === currentNode && candidate.when(outcome, state),
        );
        currentNode = edge?.to ?? null;
        this.appendEvent(state, {
          type: "node_completed",
          nodeKey: node.key,
          attempt: record.attempts,
          timestamp: new Date().toISOString(),
        });
        this.appendEvent(state, {
          type: "route_selected",
          source: node.key,
          target: currentNode,
          reason: edge?.reason ?? "no matching edge",
          timestamp: new Date().toISOString(),
        });
        await this.checkpoints.save(state);
      }

      state.workflowPhase = "done";
      state.pendingGate = null;
      await this.checkpoints.save(state);
      return { status: "completed", state };
    });
  }

  private beginNode(state: GraphNovelState, nodeKey: string): NodeExecutionRecord {
    const existing = state.nodes[nodeKey];
    const record: NodeExecutionRecord = {
      status: "in_progress",
      attempts: (existing?.attempts ?? 0) + 1,
      sessionId: randomUUID(),
      startedAt: new Date().toISOString(),
    };
    state.nodes[nodeKey] = record;
    state.lastError = null;
    state.updatedAt = new Date().toISOString();
    return record;
  }

  private completeNode(
    state: GraphNovelState,
    nodeKey: string,
    record: NodeExecutionRecord,
  ): void {
    record.status = "completed";
    record.completedAt = new Date().toISOString();
    state.nodes[nodeKey] = record;
    state.pendingGate = null;
  }

  private async fail(
    state: GraphNovelState,
    nodeKey: string,
    attempt: number,
    message: string,
    sink?: GraphEventSink,
  ): Promise<GraphRunResult> {
    const record = state.nodes[nodeKey] ?? {
      status: "failed",
      attempts: attempt,
    };
    record.status = "failed";
    record.error = message;
    state.nodes[nodeKey] = record;
    state.workflowPhase = "failed";
    state.pendingGate = null;
    state.lastError = {
      nodeKey,
      message,
      attempt,
      timestamp: new Date().toISOString(),
    };
    const event: ExecutionEvent = {
      type: "node_failed",
      nodeKey,
      attempt,
      error: message,
      timestamp: new Date().toISOString(),
    };
    this.appendEvent(state, event);
    await this.checkpoints.save(state);
    await sink?.({
      type: "node_failed",
      nodeKey,
      attempt,
      sessionId: record.sessionId ?? "",
      error: message,
      timestamp: new Date().toISOString(),
    });
    return { status: "failed", state };
  }

  private appendEvent(state: GraphNovelState, event: ExecutionEvent): void {
    state.executionEvents.push(event);
    state.updatedAt = new Date().toISOString();
  }
}
