import { randomUUID } from "node:crypto";
import { Agent, type AgentEvent, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ThinkingBudgets } from "@earendil-works/pi-ai";
import type {
  AgentNodeRequest,
  AgentNodeResult,
  GraphEvent,
  GraphEventSink,
} from "./types.js";

export class PiAgentRunError extends Error {
  readonly nodeKey: string;
  readonly attempt: number;
  readonly sessionId: string;

  constructor(
    message: string,
    request: Pick<AgentNodeRequest, "nodeKey" | "attempt">,
    sessionId: string,
  ) {
    super(message);
    this.name = "PiAgentRunError";
    this.nodeKey = request.nodeKey;
    this.attempt = request.attempt;
    this.sessionId = sessionId;
  }
}

export interface PiAgentRuntimeOptions {
  thinkingLevel?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
}

export class PiAgentRuntime {
  constructor(private readonly options: PiAgentRuntimeOptions = {}) {}

  async run(
    request: AgentNodeRequest,
    sink?: GraphEventSink,
  ): Promise<AgentNodeResult> {
    const sessionId = request.sessionId ?? randomUUID();
    const streamFn = request.maxOutputTokens
      ? ((model, context, options) => request.streamFn(model, context, {
          ...options,
          maxTokens: Math.min(request.maxOutputTokens!, model.maxTokens),
        })) satisfies typeof request.streamFn
      : request.streamFn;
    const agent = new Agent({
      initialState: {
        systemPrompt: request.systemPrompt,
        model: request.model,
        thinkingLevel: this.options.thinkingLevel ?? "off",
      },
      sessionId,
      streamFn,
      thinkingBudgets: this.options.thinkingBudgets,
    });

    await this.emit(sink, {
      type: "node_started",
      nodeKey: request.nodeKey,
      attempt: request.attempt,
      sessionId,
      timestamp: new Date().toISOString(),
    });

    const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
      await this.emit(sink, {
        type: "agent_event",
        nodeKey: request.nodeKey,
        attempt: request.attempt,
        sessionId,
        event,
        timestamp: new Date().toISOString(),
      });
    });

    try {
      await agent.prompt(request.prompt);
      const assistantMessage = this.findAssistantMessage(agent.state.messages);
      if (!assistantMessage) {
        throw new Error("Pi Agent completed without an assistant message");
      }
      if (assistantMessage.stopReason !== "stop") {
        throw new Error(
          assistantMessage.errorMessage
            ? `Pi Agent stopped with ${assistantMessage.stopReason}: ${assistantMessage.errorMessage}`
            : `Pi Agent stopped with ${assistantMessage.stopReason}`,
        );
      }

      const result: AgentNodeResult = {
        nodeKey: request.nodeKey,
        attempt: request.attempt,
        sessionId,
        messages: agent.state.messages,
        assistantMessage,
        text: this.extractText(assistantMessage),
      };
      await this.emit(sink, {
        type: "node_completed",
        nodeKey: request.nodeKey,
        attempt: request.attempt,
        sessionId,
        timestamp: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.emit(sink, {
        type: "node_failed",
        nodeKey: request.nodeKey,
        attempt: request.attempt,
        sessionId,
        error: message,
        timestamp: new Date().toISOString(),
      });
      throw new PiAgentRunError(message, request, sessionId);
    } finally {
      unsubscribe();
    }
  }

  private async emit(sink: GraphEventSink | undefined, event: GraphEvent): Promise<void> {
    await sink?.(event);
  }

  private findAssistantMessage(messages: readonly { role: string }[]): AssistantMessage | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "assistant") {
        return message as AssistantMessage;
      }
    }
    return undefined;
  }

  private extractText(message: AssistantMessage): string {
    return message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
  }
}
