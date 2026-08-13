import type {
  AgentEvent,
  AgentMessage,
  StreamFn,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";

export type NodeStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped";

export interface AgentNodeRequest {
  nodeKey: string;
  attempt: number;
  systemPrompt: string;
  prompt: string;
  model: Model<any>;
  streamFn: StreamFn;
  maxOutputTokens?: number;
  thinkingLevel?: ThinkingLevel;
  jsonMode?: boolean;
  sessionId?: string;
}

export interface AgentNodeResult {
  nodeKey: string;
  attempt: number;
  sessionId: string;
  messages: AgentMessage[];
  assistantMessage: AssistantMessage;
  text: string;
}

export type GraphEvent =
  | {
      type: "node_started";
      nodeKey: string;
      attempt: number;
      sessionId: string;
      timestamp: string;
    }
  | {
      type: "agent_event";
      nodeKey: string;
      attempt: number;
      sessionId: string;
      event: AgentEvent;
      timestamp: string;
    }
  | {
      type: "node_completed";
      nodeKey: string;
      attempt: number;
      sessionId: string;
      timestamp: string;
    }
  | {
      type: "node_failed";
      nodeKey: string;
      attempt: number;
      sessionId: string;
      error: string;
      timestamp: string;
    };

export type GraphEventSink = (event: GraphEvent) => void | Promise<void>;

export interface GateDecision {
  gate: string;
  approved: boolean;
  feedback: string;
  decidedAt: string;
}

export interface RewriteAttempt {
  scope: string;
  attempt: number;
  feedback: string;
  sessionId?: string;
}
