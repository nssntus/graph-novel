import assert from "node:assert/strict";
import test from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  EventStream,
  type AssistantMessageEvent,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { PiAgentRuntime, PiAgentRunError } from "../src/runtime/agent.js";
import type { GraphEvent } from "../src/runtime/types.js";

function createMockModel(): Model<"openai-responses"> {
  return {
    id: "mock",
    name: "mock",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
}

function createAssistantMessage(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "mock",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function createMockStream(text: string, stopReason: "stop" | "error" = "stop"):
  ReturnType<StreamFn> {
  const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return event.message;
      if (event.type === "error") return event.error;
      throw new Error("Mock stream ended without a final event");
    },
  );
  queueMicrotask(() => {
    const message = createAssistantMessage(text, stopReason);
    if (stopReason === "stop") {
      stream.push({ type: "done", reason: "stop", message });
    } else {
      stream.push({ type: "error", reason: "error", error: message });
    }
  });
  return stream;
}

test("runs a Pi Agent turn and maps lifecycle events", async () => {
  const events: GraphEvent[] = [];
  const runtime = new PiAgentRuntime();
  const result = await runtime.run(
    {
      nodeKey: "test_node",
      attempt: 1,
      systemPrompt: "You are a test agent.",
      prompt: "Return the fixed result.",
      model: createMockModel(),
      streamFn: () => createMockStream("fixed result"),
      sessionId: "session-test-1",
    },
    (event) => {
      events.push(event);
    },
  );

  assert.equal(result.text, "fixed result");
  assert.equal(result.sessionId, "session-test-1");
  assert.equal(events[0]?.type, "node_started");
  assert.equal(events.at(-1)?.type, "node_completed");
  assert.ok(events.some((event) => event.type === "agent_event" && event.event.type === "agent_end"));
});

test("runtime forwards an explicit output budget to the provider stream", async () => {
  let observedMaxTokens: number | undefined;
  const runtime = new PiAgentRuntime();
  await runtime.run({
    nodeKey: "bounded_node",
    attempt: 1,
    systemPrompt: "You are a test agent.",
    prompt: "Return the fixed result.",
    model: createMockModel(),
    streamFn: (_model, _context, options) => {
      observedMaxTokens = options?.maxTokens;
      return createMockStream("fixed result");
    },
    maxOutputTokens: 512,
  });
  assert.equal(observedMaxTokens, 512);
});

test("turn failures become observable node failures", async () => {
  const events: GraphEvent[] = [];
  const runtime = new PiAgentRuntime();

  await assert.rejects(
    runtime.run(
      {
        nodeKey: "failing_node",
        attempt: 1,
        systemPrompt: "You are a test agent.",
        prompt: "Fail.",
        model: createMockModel(),
        streamFn: () => createMockStream("provider failed", "error"),
      },
      (event) => {
        events.push(event);
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof PiAgentRunError);
      assert.equal(error.nodeKey, "failing_node");
      return true;
    },
  );

  const failure = events.find((event) => event.type === "node_failed");
  assert.ok(failure);
  assert.match(failure.error, /Pi Agent stopped with error/);
});
