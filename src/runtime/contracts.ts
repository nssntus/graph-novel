import type { Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { GraphNodeContext } from "../graph/engine.js";
import { PiAgentRuntime } from "./agent.js";

export interface ContractAgentDependencies {
  runtime: PiAgentRuntime;
  model: Model<any>;
  streamFn: StreamFn;
}

export const MAX_CONTRACT_RETRIES = 1;

export async function runContractedNode<T>(
  context: GraphNodeContext,
  dependencies: ContractAgentDependencies,
  nodeKey: string,
  systemPrompt: string,
  prompt: string,
  parse: (text: string) => T,
): Promise<T> {
  let validationFeedback = "";
  for (let retry = 0; retry <= MAX_CONTRACT_RETRIES; retry += 1) {
    const result = await dependencies.runtime.run({
      nodeKey,
      attempt: context.attempt,
      sessionId: context.sessionId,
      systemPrompt,
      prompt: validationFeedback ? `${prompt}\n\n${validationFeedback}` : prompt,
      model: dependencies.model,
      streamFn: dependencies.streamFn,
    }, context.eventSink);
    try {
      return parse(result.text);
    } catch (error) {
      if (!isContractValidationError(error) || retry >= MAX_CONTRACT_RETRIES) throw error;
      validationFeedback = `上一轮响应未通过输出契约：${error.message}。请修正该字段并从头输出完整 JSON，不要解释原因，不要省略任何必填字段。`;
    }
  }
  throw new Error("Contract output retry exhausted");
}

function isContractValidationError(error: unknown): error is Error & { path: string } {
  return error instanceof Error
    && typeof (error as Error & { path?: unknown }).path === "string";
}
