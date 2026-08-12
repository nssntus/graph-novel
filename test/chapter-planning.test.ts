import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { EventStream, type AssistantMessage, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";
import { CheckpointStore } from "../src/checkpoint/store.js";
import { decideChapterPlan, runChapterPlanning } from "../src/agents/chapter-planning.js";
import { PiAgentRuntime } from "../src/runtime/agent.js";
import { buildContinuityContext } from "../src/state/continuity.js";
import { createInitialState } from "../src/state/state.js";

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
      if (event.type === "error") return event.error;
      throw new Error("Mock stream ended without a final event");
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

function stateForChapterTwo() {
  const state = createInitialState("chapter-plan-test", "Chapter Plan Test");
  state.approvedChapters = [{
    chapterNumber: 1, title: "潮汐警报", summary: "林澈发现异常信号",
    polishedDraft: "警报在维修舱深处再次响起。",
    endingExcerpt: "警报在维修舱深处再次响起。",
    lastScene: {
      time: "第一日夜间", location: "海上城维修舱", povCharacter: "林澈",
      charactersPresent: ["林澈"], finalAction: "林澈保存了信号频段", finalDialogue: "这不是潮汐噪声。",
    },
    unresolvedActions: ["确认信号来源"], openThreads: ["旧徽章上的编号"],
  }];
  state.narrativeFacts = [{
    factId: "signal_exists", statement: "维修舱收到一段异常信号", category: "plot",
    establishedInChapter: 1, visibility: "林澈已知",
  }];
  state.characterKnowledge = [{
    factId: "signal_exists", character: "林澈", knowledgeLevel: "confirmed",
    learnedInChapter: 1, sourceType: "observed", sourceCharacter: "", evidence: "亲自听见",
  }];
  state.novelOutline = {
    genre: "都市科幻", premise: "追查信号", theme: "真相", targetLength: "12章",
    chapterOutlines: [{
      chapterNumber: 2, title: "回声来源", summary: "沿信号寻找来源", keyEvents: ["追踪"],
      foreshadowingToPlant: [], foreshadowingToPayOff: [],
    }],
  };
  return state;
}

function chapterPlan(contextHash: string): string {
  return JSON.stringify({
    contextHash, chapterNumber: 2, title: "回声来源",
    openingBridge: {
      previousChapter: 1, inheritedEndpoint: "警报在维修舱深处再次响起。",
      transitionSteps: ["林澈确认信号仍在重复"], firstSceneStart: "林澈检查频段记录。",
      carryOverThreads: ["确认信号来源"],
    },
    causalChain: [{ cause: "信号持续", event: "林澈追踪", effect: "发现旧编号" }],
    requiredFactIds: ["signal_exists"], plannedFacts: [{
      factId: "badge_frequency_link", statement: "异常信号使用旧徽章编号对应的频段",
      category: "plot", visibility: "林澈可验证",
    }],
    informationFlow: [{
      factId: "signal_exists", character: "林澈", knowledgeLevel: "confirmed",
      sourceType: "observed", sourceCharacter: "", evidence: "复核记录",
    }],
  });
}

test("chapter planning uses the continuity package and pauses at its Gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-chapter-plan-"));
  const state = stateForChapterTwo();
  const context = buildContinuityContext(state, 2);
  const result = await runChapterPlanning(
    state, 2,
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(chapterPlan(context.contextHash)) },
    new CheckpointStore(root),
  );
  assert.equal(result.status, "awaiting_approval");
  assert.equal(state.pendingGate, "chapter_plan:2");
  assert.equal(state.chapterPlans["2"]?.contextHash, context.contextHash);
  assert.equal((await new CheckpointStore(root).load(state.projectId))?.pendingGate, "chapter_plan:2");
});

test("chapter planning injects engine-owned control fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-chapter-plan-control-fields-"));
  const state = stateForChapterTwo();
  const context = buildContinuityContext(state, 2);
  const generated = JSON.parse(chapterPlan(context.contextHash));
  delete generated.contextHash;
  delete generated.foundationDirectiveHash;
  generated.chapterNumber = "2";
  const prompts: string[] = [];
  const result = await runChapterPlanning(
    state,
    2,
    {
      runtime: new PiAgentRuntime(), model: model(),
      streamFn: (_model, request) => {
        prompts.push(JSON.stringify(request.messages ?? null));
        return streamFor(JSON.stringify(generated));
      },
    },
    new CheckpointStore(root),
  );

  assert.equal(result.status, "awaiting_approval");
  assert.equal(state.chapterPlans["2"]?.chapterNumber, 2);
  assert.equal(state.chapterPlans["2"]?.contextHash, context.contextHash);
  const messages = JSON.parse(prompts[0]!);
  const request = JSON.parse(messages[0].content[0].text);
  assert.equal(request.outputContract.chapterNumber, undefined);
  assert.equal(request.outputContract.contextHash, undefined);
  assert.equal(request.outputContract.foundationDirectiveHash, undefined);
  assert.equal(request.continuityContext.characterKnowledge, undefined);
  assert.deepEqual(request.knowledgeByFact.signal_exists, [{ character: "林澈", knowledgeLevel: "confirmed" }]);
});

test("chapter planning retries a malformed contract response with the failing path", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-chapter-plan-contract-retry-"));
  const state = stateForChapterTwo();
  const context = buildContinuityContext(state, 2);
  const prompts: string[] = [];
  let call = 0;
  const result = await runChapterPlanning(
    state,
    2,
    {
      runtime: new PiAgentRuntime(),
      model: model(),
      streamFn: (_model, request) => {
        prompts.push(JSON.stringify(request.messages ?? null));
        return streamFor(call++ === 0 ? JSON.stringify({ chapterNumber: 2 }) : chapterPlan(context.contextHash));
      },
    },
    new CheckpointStore(root),
  );

  assert.equal(result.status, "awaiting_approval");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /chapter_plan\.title/);
  assert.equal(state.chapterPlans["2"]?.contextHash, context.contextHash);
});

test("chapter plan rejection is persisted and re-generation keeps feedback", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-chapter-plan-reject-"));
  const state = stateForChapterTwo();
  const context = buildContinuityContext(state, 2);
  const store = new CheckpointStore(root);
  const dependencies = {
    runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(chapterPlan(context.contextHash)),
  };
  await runChapterPlanning(state, 2, dependencies, store);
  await decideChapterPlan(state, 2, false, store, "先补出从维修舱到旧天线室的移动过程");
  const rejected = await store.load(state.projectId);
  assert.equal(rejected?.chapterPlanApproval, "rejected");
  assert.equal(rejected?.chapterPlanFeedback, "先补出从维修舱到旧天线室的移动过程");
  assert.equal(rejected?.workflowPhase, "chapter_loop");

  const regenerated = await runChapterPlanning(rejected!, 2, dependencies, store);
  assert.equal(regenerated.status, "awaiting_approval");
  assert.equal(regenerated.state.nodes.chapter_planning_2?.attempts, 2);
  assert.equal(regenerated.state.chapterPlanFeedback, "先补出从维修舱到旧天线室的移动过程");
});

test("approved chapter plan routes to chapter writing without waiting in the request", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-chapter-plan-approve-"));
  const state = stateForChapterTwo();
  const context = buildContinuityContext(state, 2);
  const store = new CheckpointStore(root);
  await runChapterPlanning(
    state, 2,
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(chapterPlan(context.contextHash)) },
    store,
  );
  await decideChapterPlan(state, 2, true, store);
  const route = state.executionEvents.at(-1);
  assert.equal(state.chapterPlanApproval, "approved");
  assert.equal(state.pendingGate, null);
  assert.equal(route?.type, "route_selected");
  if (route?.type === "route_selected") assert.equal(route.target, "chapter_writing_2");
  assert.equal((await store.load(state.projectId))?.workflowPhase, "chapter_loop");
});
