import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { EventStream, type AssistantMessage, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";
import { CheckpointStore } from "../src/checkpoint/store.js";
import { PiAgentRuntime } from "../src/runtime/agent.js";
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
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
  return stream;
}

function approvedChapter() {
  return {
    chapterNumber: 1,
    title: "第一章",
    summary: "主角发现异常",
    polishedDraft: "润色正文",
    endingExcerpt: "异常信号再次响起。",
    lastScene: { time: "夜间", location: "维修舱", povCharacter: "主角", charactersPresent: ["主角"], finalAction: "保存信号", finalDialogue: "" },
    unresolvedActions: [],
    openThreads: [],
  };
}

test("global review runs through the shared service and completes only after all chapters", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-global-review-"));
  const service = new GraphNovelService(new CheckpointStore(root), {
    runtime: new PiAgentRuntime(),
    model: model(),
    streamFn: () => streamFor(JSON.stringify({ overallScore: 8, readyForPlatform: true, summary: "结构完整", recommendations: ["继续保持承接"] })),
  });
  await service.createProject({ projectId: "review-ok", novelTitle: "Review OK", targetTotalChapters: 1 });
  const state = await service.getState("review-ok");
  state.foundationApproval = "approved";
  state.approvedChapters = [approvedChapter()];
  await service.checkpoints.save(state);
  await service.startGlobalReviewFor("review-ok");
  for (let index = 0; index < 50; index += 1) {
    const current = await service.getStatus("review-ok");
    if (current.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const completed = await service.getState("review-ok");
  assert.equal(completed.workflowPhase, "done");
  assert.equal(completed.globalReview?.overallScore, 8);
});

test("global review retries a malformed structured response", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-global-review-retry-"));
  let call = 0;
  const service = new GraphNovelService(new CheckpointStore(root), {
    runtime: new PiAgentRuntime(),
    model: model(),
    streamFn: () => streamFor(call++ === 0 ? JSON.stringify({}) : JSON.stringify({
      overallScore: 8,
      readyForPlatform: true,
      summary: "结构完整",
      recommendations: ["继续保持承接"],
    })),
  });
  await service.createProject({ projectId: "review-retry", novelTitle: "Review Retry", targetTotalChapters: 1 });
  const state = await service.getState("review-retry");
  state.foundationApproval = "approved";
  state.approvedChapters = [approvedChapter()];
  await service.checkpoints.save(state);
  await service.startGlobalReviewFor("review-retry");
  for (let index = 0; index < 50; index += 1) {
    const current = await service.getStatus("review-retry");
    if (current.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const completed = await service.getState("review-retry");
  assert.equal(completed.workflowPhase, "done");
  assert.equal(completed.globalReview?.overallScore, 8);
  assert.equal(call, 2);
});

test("global review fails visibly when chapters are not complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-global-review-fail-"));
  const service = new GraphNovelService(new CheckpointStore(root), {
    runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor("{}"),
  });
  await service.createProject({ projectId: "review-fail", novelTitle: "Review Fail", targetTotalChapters: 2 });
  await service.startGlobalReviewFor("review-fail");
  for (let index = 0; index < 50; index += 1) {
    const current = await service.getStatus("review-fail");
    if (current.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const failed = await service.getState("review-fail");
  assert.equal(failed.workflowPhase, "failed");
  assert.match(failed.lastError?.message ?? "", /All chapters must be approved/);
});
