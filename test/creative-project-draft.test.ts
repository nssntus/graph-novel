import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { EventStream, type AssistantMessage, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";
import { CheckpointStore } from "../src/checkpoint/store.js";
import { PiAgentRuntime } from "../src/runtime/agent.js";
import { parseCreativeProjectDraft } from "../src/agents/creative-project-draft.js";
import { createGraphNovelHttpServer } from "../src/web/server.js";
import { GraphNovelService } from "../src/web/service.js";

function model(): Model<"openai-responses"> {
  return {
    id: "mock", name: "mock", api: "openai-responses", provider: "openai",
    baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192, maxTokens: 1024,
  };
}

function streamFor(text: string): ReturnType<StreamFn> {
  const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return event.message;
      if (event.type === "error") throw event.error;
      throw new Error("incomplete");
    },
  );
  const message: AssistantMessage = {
    role: "assistant", content: [{ type: "text", text }], api: "openai-responses",
    provider: "openai", model: "mock", stopReason: "stop", timestamp: Date.now(),
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
  return stream;
}

async function startServer(service: GraphNovelService): Promise<{ server: ReturnType<typeof createGraphNovelHttpServer>; baseUrl: string }> {
  const server = createGraphNovelHttpServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function request(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("creative project draft parser keeps the whitelist and applies numeric defaults", () => {
  const draft = parseCreativeProjectDraft(JSON.stringify({
    novelTitle: "  重返灾变前夜 ",
    creativeGenre: "末日重生",
    creativePremise: "主角回到灾变前三天，必须让证据和行动逐步形成因果。",
    creativeTheme: "信任与生存选择",
    creativeNotes: "避免无代价全知。",
    targetTotalChapters: 400,
    unknownGraphField: { projectId: "must not leak" },
  }));
  assert.deepEqual(draft, {
    novelTitle: "重返灾变前夜",
    creativeGenre: "末日重生",
    creativePremise: "主角回到灾变前三天，必须让证据和行动逐步形成因果。",
    creativeTheme: "信任与生存选择",
    creativeNotes: "避免无代价全知。",
    targetTotalChapters: 400,
    targetTotalWords: 0,
  });
});

test("creative project draft parser rejects malformed and out-of-range agent output", () => {
  assert.throws(() => parseCreativeProjectDraft("不是 JSON"), /不是合法 JSON/);
  assert.throws(() => parseCreativeProjectDraft(JSON.stringify({ targetTotalChapters: 0 })), /targetTotalChapters/);
  assert.throws(() => parseCreativeProjectDraft(JSON.stringify({ creativeGenre: 42 })), /creativeGenre/);
  assert.throws(() => parseCreativeProjectDraft(JSON.stringify({ creativeNotes: "x".repeat(4001) })), /creativeNotes/);
});

test("project draft API validates history, returns a temporary whitelist draft, and does not persist a project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-project-draft-"));
  const service = new GraphNovelService(
    new CheckpointStore(root),
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(JSON.stringify({
      novelTitle: "重返灾变前夜", creativeGenre: "末日重生", creativePremise: "回到灾变前三天。",
      creativeTheme: "信任", creativeNotes: "逐步铺垫", targetTotalChapters: 60, targetTotalWords: 180000,
      projectId: "do-not-return", creativeCharter: "do-not-return",
    })) },
  );
  const { server, baseUrl } = await startServer(service);
  t.after(() => server.close());

  const response = await request(baseUrl, "/api/creative/project-draft", {
    history: [{ role: "user", content: "我想写一个末日重生故事" }, { role: "assistant", content: "先明确灾变时间和主角目标" }],
  });
  assert.equal(response.status, 200);
  const payload = await response.json() as { success: boolean; draft: Record<string, unknown>; sessionId: string };
  assert.equal(payload.success, true);
  assert.equal(payload.sessionId.length > 0, true);
  assert.deepEqual(payload.draft, {
    novelTitle: "重返灾变前夜", creativeGenre: "末日重生", creativePremise: "回到灾变前三天。",
    creativeTheme: "信任", creativeNotes: "逐步铺垫", targetTotalChapters: 60, targetTotalWords: 180000,
  });
  assert.equal(JSON.stringify(payload).includes("creativeCharter"), false);
  assert.deepEqual(await service.listProjects(), []);

  const emptyHistory = await request(baseUrl, "/api/creative/project-draft", { history: [] });
  assert.equal(emptyHistory.status, 400);
  assert.equal((await emptyHistory.json() as { code: string }).code, "invalid_input");
  const nullBody = await request(baseUrl, "/api/creative/project-draft", null);
  assert.equal(nullBody.status, 400);
  const assistantOnly = await request(baseUrl, "/api/creative/project-draft", { history: [{ role: "assistant", content: "建议" }] });
  assert.equal(assistantOnly.status, 400);
  const tooMany = await request(baseUrl, "/api/creative/project-draft", { history: Array.from({ length: 21 }, () => ({ role: "user", content: "想法" })) });
  assert.equal(tooMany.status, 400);
});

test("project creation accepts chapter targets above the former 200 chapter limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-project-target-"));
  const service = new GraphNovelService(new CheckpointStore(root));
  const state = await service.createProject({ projectId: "four-hundred", novelTitle: "四百章测试", targetTotalChapters: 400, targetTotalWords: 1_000_000 });
  assert.equal(state.targetTotalChapters, 400);
  assert.equal(state.targetTotalWords, 1_000_000);
});

test("project draft API distinguishes malformed output and unavailable Agent", async (t) => {
  const malformedRoot = await mkdtemp(join(tmpdir(), "graphnovel-project-draft-invalid-"));
  const malformed = new GraphNovelService(
    new CheckpointStore(malformedRoot),
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor("not-json") },
  );
  const malformedServer = await startServer(malformed);
  t.after(() => malformedServer.server.close());
  const malformedResponse = await request(malformedServer.baseUrl, "/api/creative/project-draft", { history: [{ role: "user", content: "整理这个想法" }] });
  assert.equal(malformedResponse.status, 502);
  assert.equal((await malformedResponse.json() as { code: string }).code, "invalid_agent_output");
  assert.deepEqual(await malformed.listProjects(), []);

  const unavailableRoot = await mkdtemp(join(tmpdir(), "graphnovel-project-draft-no-agent-"));
  const unavailable = new GraphNovelService(new CheckpointStore(unavailableRoot));
  const unavailableServer = await startServer(unavailable);
  t.after(() => unavailableServer.server.close());
  const unavailableResponse = await request(unavailableServer.baseUrl, "/api/creative/project-draft", { history: [{ role: "user", content: "整理这个想法" }] });
  assert.equal(unavailableResponse.status, 503);
  assert.equal((await unavailableResponse.json() as { code: string }).code, "agent_unavailable");
  assert.deepEqual(await unavailable.listProjects(), []);
});
