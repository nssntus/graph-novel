import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { EventStream, type AssistantMessage, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";
import { CheckpointStore } from "../src/checkpoint/store.js";
import { decideFoundation, runFoundationGeneration } from "../src/agents/foundation.js";
import { parseChapterPlan } from "../src/contracts/chapter.js";
import { parseChapterWritingOutput } from "../src/contracts/writing.js";
import { parseStylePolishOutput } from "../src/contracts/style.js";
import { decideChapterWriting, reopenChapterWriting, runChapterWriting } from "../src/agents/chapter-writing.js";
import { PiAgentRuntime } from "../src/runtime/agent.js";
import { buildContinuityContext } from "../src/state/continuity.js";
import { createInitialState } from "../src/state/state.js";
import { enhancedFoundationResponses } from "./foundation-fixture.js";

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

function stateForWriting() {
  const state = createInitialState("writing-test", "Writing Test");
  state.targetTotalChapters = 3;
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
    factId: "signal_exists", character: "林澈", knowledgeLevel: "confirmed", learnedInChapter: 1,
    sourceType: "observed", sourceCharacter: "", evidence: "亲自听见",
  }];
  state.chapterPlans["2"] = {
    contextHash: "placeholder", chapterNumber: 2, title: "回声来源",
    openingBridge: {
      previousChapter: 1, inheritedEndpoint: "警报在维修舱深处再次响起。",
      transitionSteps: ["林澈确认信号仍在重复"], firstSceneStart: "林澈检查频段记录。", carryOverThreads: ["确认信号来源"],
    },
    causalChain: [{ cause: "信号持续", event: "林澈追踪", effect: "发现旧编号" }],
    requiredFactIds: ["signal_exists"],
    plannedFacts: [{ factId: "badge_frequency_link", statement: "异常信号使用旧徽章编号对应的频段", category: "plot", visibility: "林澈可验证" }],
    informationFlow: [{ factId: "signal_exists", character: "林澈", knowledgeLevel: "confirmed", sourceType: "observed", sourceCharacter: "", evidence: "复核记录" }],
  };
  return state;
}

function writingOutput(contextHash: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    contextHash, chapterNumber: 2, title: "回声来源",
    draft: "林澈沿着保存的频段记录走进旧天线室。墙后的编号与信号波形完全吻合。",
    chapterHook: "天线室的备用终端突然显示出父亲的工号。",
    chapterSummary: "林澈追踪异常信号，确认其与旧徽章编号有关。",
    endingExcerpt: "备用终端亮起父亲的工号。",
    lastScene: {
      time: "第二日清晨", location: "海上城旧天线室", povCharacter: "林澈",
      charactersPresent: ["林澈"], finalAction: "林澈看见父亲的工号", finalDialogue: "你还活着？",
    },
    unresolvedActions: ["确认父亲工号的来源"], openThreads: ["父亲是否仍在海上城"],
    factsEstablished: [{ factId: "badge_frequency_link", statement: "异常信号使用旧徽章编号对应的频段", category: "plot", visibility: "林澈可验证" }],
    knowledgeChanges: [{ factId: "signal_exists", character: "林澈", knowledgeLevel: "confirmed", sourceType: "observed", sourceCharacter: "", evidence: "复核记录" }],
    continuityChanges: {
      time: "第二日清晨", characterLocations: { 林澈: "海上城旧天线室" },
      characterConditions: { 林澈: "轻微擦伤" }, resources: { 林澈: "维修工具" },
    },
    ...extra,
  });
}

function reviewOutput(contextHash: string, requiresRewrite = false): string {
  return JSON.stringify({
    contextHash,
    chapterNumber: 2,
    score: requiresRewrite ? 5 : 9,
    requiresRewrite,
    rewriteScope: requiresRewrite ? "补足维修舱到旧天线室的移动过程" : "",
    issues: requiresRewrite ? ["开场移动过程不足"] : [],
    narrativeViolations: [],
    summary: requiresRewrite ? "承接需要补充" : "承接、事实和认知来源通过",
  });
}

function styleOutput(contextHash: string, polishedDraft = "润色后的正文：林澈沿着频段记录走进旧天线室。墙后的编号与信号波形完全吻合。", extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    contextHash,
    chapterNumber: 2,
    polishedDraft,
    factIds: ["badge_frequency_link"],
    knowledgeSignatures: ["signal_exists\u0000林澈\u0000confirmed\u0000observed\u0000"],
    ...extra,
  });
}

async function prepareState(root: string) {
  const state = stateForWriting();
  const context = buildContinuityContext(state, 2);
  state.chapterPlans["2"]!.contextHash = context.contextHash;
  state.chapterPlanApproval = "approved";
  const store = new CheckpointStore(root);
  let call = 0;
  const dependencies = {
    runtime: new PiAgentRuntime(),
    model: model(),
    streamFn: () => {
      const current = call++ % 3;
      if (current === 0) return streamFor(writingOutput(context.contextHash));
      if (current === 1) return streamFor(reviewOutput(context.contextHash));
      return streamFor(styleOutput(context.contextHash));
    },
  };
  return { state, context, store, dependencies };
}

test("writing keeps narrative delta isolated until chapter approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-writing-"));
  const { state, context, store, dependencies } = await prepareState(root);
  const result = await runChapterWriting(state, 2, dependencies, store);
  assert.equal(result.status, "awaiting_approval");
  assert.equal(state.approvedChapters.length, 1);
  assert.equal(state.narrativeFacts.some((fact) => fact.factId === "badge_frequency_link"), false);
  assert.equal(state.chapterCandidates["2"]?.revision, 1);
  assert.notEqual(state.chapterCandidates["2"]?.polishedDraft, state.chapterCandidates["2"]?.draft);

  await decideChapterWriting(state, 2, true, store);
  assert.equal(state.approvedChapters.length, 2);
  assert.equal(state.approvedChapters[1]?.polishedDraft, "润色后的正文：林澈沿着频段记录走进旧天线室。墙后的编号与信号波形完全吻合。");
  assert.equal(state.narrativeFacts.some((fact) => fact.factId === "badge_frequency_link"), true);
  assert.equal(state.continuity.characterLocations["林澈"], "海上城旧天线室");
  assert.equal(state.executionEvents.at(-1)?.type, "route_selected");
  assert.equal(state.chapterCandidates["2"]?.contextHash, context.contextHash);
});

test("chapter writing resumes an interrupted style polish without rewriting the draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-writing-resume-"));
  const { state, context, store, dependencies } = await prepareState(root);
  await runChapterWriting(state, 2, dependencies, store);
  const candidate = state.chapterCandidates["2"]!;
  const originalDraft = candidate.draft;
  candidate.polishedDraft = candidate.draft;
  state.pendingGate = null;
  state.workflowPhase = "chapter_loop";
  state.nodes.style_polish_2 = {
    status: "in_progress",
    attempts: 1,
    sessionId: "interrupted-style-session",
    startedAt: new Date().toISOString(),
  };
  delete state.nodes.human_approval_chapter_writing_2;
  await store.save(state);

  let calls = 0;
  const result = await runChapterWriting(
    state,
    2,
    {
      runtime: new PiAgentRuntime(),
      model: model(),
      streamFn: () => {
        calls += 1;
        return streamFor(styleOutput(context.contextHash));
      },
    },
    store,
  );

  assert.equal(result.status, "awaiting_approval");
  assert.equal(calls, 1);
  assert.equal(candidate.draft, originalDraft);
  assert.equal(state.nodes.chapter_writing_2?.attempts, 1);
  assert.equal(state.nodes.consistency_review_2?.attempts, 1);
  assert.equal(state.nodes.style_polish_2?.attempts, 2);
  assert.equal(state.pendingGate, "chapter_writing:2");
});

test("chapter writing retries malformed writing output before review and polish", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-writing-contract-retry-"));
  const { state, context, store } = await prepareState(root);
  const prompts: string[] = [];
  let call = 0;
  const result = await runChapterWriting(
    state,
    2,
    {
      runtime: new PiAgentRuntime(),
      model: model(),
      streamFn: (_model, request) => {
        prompts.push(JSON.stringify(request.messages ?? null));
        const current = call++;
        if (current === 0) return streamFor(JSON.stringify({ chapterNumber: 2 }));
        if (current === 1) return streamFor(writingOutput(context.contextHash));
        if (current === 2) return streamFor(reviewOutput(context.contextHash));
        return streamFor(styleOutput(context.contextHash));
      },
    },
    store,
  );

  assert.equal(result.status, "awaiting_approval");
  assert.equal(prompts.length, 4);
  assert.match(prompts[1]!, /chapter_writing\.contextHash/);
  assert.equal(state.chapterReviews["2"]?.requiresRewrite, false);
  assert.equal(state.chapterCandidates["2"]?.polishedDraft, "润色后的正文：林澈沿着频段记录走进旧天线室。墙后的编号与信号波形完全吻合。");
});

test("style polish cannot alter the narrative delta signatures", () => {
  const state = stateForWriting();
  const context = buildContinuityContext(state, 2);
  const plan = state.chapterPlans["2"]!;
  plan.contextHash = context.contextHash;
  assert.throws(
    () => parseStylePolishOutput(
      styleOutput(context.contextHash, "润色后的正文", { factIds: ["mysterious_superior"] }),
      2,
      context,
      ["badge_frequency_link"],
      ["signal_exists\u0000林澈\u0000confirmed\u0000observed\u0000"],
    ),
    /style_polish\.factIds.*完全一致/,
  );
});

test("writing rejects an unplanned fact at the output contract boundary", () => {
  const state = stateForWriting();
  const context = buildContinuityContext(state, 2);
  const plan = state.chapterPlans["2"]!;
  plan.contextHash = context.contextHash;
  const invalid = JSON.parse(writingOutput(context.contextHash));
  invalid.factsEstablished = [{
    factId: "mysterious_superior", statement: "有一位神秘上级", category: "character", visibility: "林澈可验证",
  }];
  assert.throws(
    () => parseChapterWritingOutput(JSON.stringify(invalid), 2, context, plan),
    /factsEstablished.*包含未规划事实.*mysterious_superior/,
  );
});

test("writing rejection preserves candidate history and feeds the next revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-writing-reject-"));
  const { state, context, store, dependencies } = await prepareState(root);
  await runChapterWriting(state, 2, dependencies, store);
  await decideChapterWriting(state, 2, false, store, "把移动过程写清楚");
  assert.equal(state.chapterCandidates["2"]?.approved, false);
  assert.equal(state.chapterWritingFeedback["2"], "把移动过程写清楚");
  const regenerated = await runChapterWriting(state, 2, dependencies, store);
  assert.equal(regenerated.status, "awaiting_approval");
  assert.equal(state.chapterCandidates["2"]?.revision, 2);
  assert.equal(state.chapterCandidates["2"]?.revisionHistory.length, 1);
  assert.equal(state.chapterCandidates["2"]?.humanFeedback, "把移动过程写清楚");
  assert.equal(state.chapterCandidates["2"]?.contextHash, context.contextHash);
});

test("consistency review sends a failed candidate through a bounded rewrite loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-writing-rewrite-"));
  const state = stateForWriting();
  const context = buildContinuityContext(state, 2);
  state.chapterPlans["2"]!.contextHash = context.contextHash;
  state.chapterPlanApproval = "approved";
  const store = new CheckpointStore(root);
  let call = 0;
  const result = await runChapterWriting(
    state,
    2,
    {
      runtime: new PiAgentRuntime(),
      model: model(),
      streamFn: () => {
        const current = call++;
        if (current === 0 || current === 2) return streamFor(writingOutput(context.contextHash));
        if (current === 1) return streamFor(reviewOutput(context.contextHash, true));
        if (current === 3) return streamFor(reviewOutput(context.contextHash, false));
        return streamFor(styleOutput(context.contextHash));
      },
    },
    store,
  );
  assert.equal(result.status, "awaiting_approval");
  assert.equal(state.chapterRewriteAttempts["2"], 1);
  assert.equal(state.chapterCandidates["2"]?.revision, 2);
  assert.equal(state.chapterCandidates["2"]?.revisionHistory.length, 1);
  assert.equal(state.chapterReviews["2"]?.requiresRewrite, false);
});

test("manual reopen clears the exhausted review budget without losing candidate history", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-writing-reopen-"));
  const state = stateForWriting();
  const context = buildContinuityContext(state, 2);
  state.chapterPlans["2"]!.contextHash = context.contextHash;
  state.chapterPlanApproval = "approved";
  const store = new CheckpointStore(root);
  let call = 0;
  const dependencies = {
    runtime: new PiAgentRuntime(),
    model: model(),
    streamFn: () => {
      const current = call++;
      if (current === 0 || current === 2 || current === 4) return streamFor(writingOutput(context.contextHash));
      if (current === 1 || current === 3 || current === 5) return streamFor(reviewOutput(context.contextHash, true));
      if (current === 6) return streamFor(reviewOutput(context.contextHash, false));
      return streamFor(styleOutput(context.contextHash));
    },
  };

  const failed = await runChapterWriting(state, 2, dependencies, store);
  assert.equal(failed.status, "failed");
  assert.equal(state.chapterRewriteAttempts["2"], 3);
  assert.equal(state.chapterCandidates["2"]?.revision, 3);
  const historyLength = state.chapterCandidates["2"]!.revisionHistory.length;
  state.chapterCandidates["2"]!.draft = "人工修订后的正文";
  state.chapterCandidates["2"]!.polishedDraft = "人工修订后的正文";

  await reopenChapterWriting(state, 2, store, "已按审稿意见修正连续性和伏笔兑现");
  assert.equal(state.chapterRewriteAttempts["2"], 0);
  assert.equal(state.chapterCandidates["2"]?.revisionHistory.length, historyLength);
  assert.equal(state.nodes.consistency_review_2?.status, "pending");
  assert.equal(state.workflowPhase, "chapter_loop");
  assert.equal(state.lastError, null);

  const resumed = await runChapterWriting(state, 2, dependencies, store);
  assert.equal(resumed.status, "awaiting_approval");
  assert.equal(state.chapterReviews["2"]?.requiresRewrite, false);
  assert.equal(state.chapterCandidates["2"]?.draft, "人工修订后的正文");
  assert.equal(state.chapterRewriteAttempts["2"], 0);
});

test("enhanced Foundation directive reaches writing, review, and polish", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-writing-foundation-directive-"));
  const state = createInitialState("writing-foundation-directive", "Foundation Directive");
  state.creativeGenre = "都市科幻";
  state.creativePremise = "维修员追查海上城秘密";
  state.creativeTheme = "真相与责任";
  state.targetTotalChapters = 12;
  const store = new CheckpointStore(root);
  const foundationResponses = enhancedFoundationResponses();
  let foundationIndex = 0;
  await runFoundationGeneration(
    state,
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(foundationResponses[foundationIndex++]!) },
    store,
  );
  await decideFoundation(state, true, store);

  const context = buildContinuityContext(state, 1);
  const directiveHash = context.chapterFoundationDirective!.directiveHash;
  state.chapterPlans["1"] = parseChapterPlan(JSON.stringify({
    contextHash: context.contextHash,
    foundationDirectiveHash: directiveHash,
    chapterNumber: 1,
    title: "潮汐回声",
    openingBridge: {
      previousChapter: 0,
      inheritedEndpoint: "Foundation 开篇基线",
      transitionSteps: ["林澈从旧港维修现场开始检查异常"],
      firstSceneStart: "旧港警报响起时，林澈正在检修潮汐塔。",
      carryOverThreads: [],
    },
    causalChain: [{ cause: "潮汐塔出现异常", event: "林澈记录信号", effect: "异常频段被确认" }],
    requiredFactIds: ["fact_father_missing"],
    plannedFacts: [{ factId: "fact_signal_exists", statement: "旧港存在异常信号", category: "plot", visibility: "林澈可验证" }],
    informationFlow: [{ factId: "fact_signal_exists", character: "林澈", knowledgeLevel: "confirmed", sourceType: "observed", sourceCharacter: "", evidence: "亲自监听并保存频段" }],
  }), 1, context);
  state.chapterPlanApproval = "approved";

  const writing = JSON.stringify({
    contextHash: context.contextHash,
    foundationDirectiveHash: directiveHash,
    chapterNumber: 1,
    title: "潮汐回声",
    draft: "城务署封锁线外，林澈按双见证规则检修旧港潮汐塔。他没有强行调用协议，只在潮位变化时记录到异常频段。",
    chapterHook: "频段尾端出现父亲的旧权限签名。",
    chapterSummary: "林澈遵守协议规则，在旧港确认异常信号。",
    endingExcerpt: "屏幕上浮出父亲的旧权限签名。",
    lastScene: { time: "第一日清晨", location: "旧港", povCharacter: "林澈", charactersPresent: ["林澈"], finalAction: "保存异常频段", finalDialogue: "" },
    unresolvedActions: ["确认权限签名来源"],
    openThreads: ["父亲的旧权限签名"],
    factsEstablished: [{ factId: "fact_signal_exists", statement: "旧港存在异常信号", category: "plot", visibility: "林澈可验证" }],
    knowledgeChanges: [{ factId: "fact_signal_exists", character: "林澈", knowledgeLevel: "confirmed", sourceType: "observed", sourceCharacter: "", evidence: "亲自监听并保存频段" }],
    continuityChanges: { time: "第一日清晨", characterLocations: { 林澈: "旧港" }, characterConditions: { 林澈: "警觉" }, resources: { 林澈: "维修工具和异常频段记录" } },
  });
  const review = JSON.stringify({
    contextHash: context.contextHash,
    foundationDirectiveHash: directiveHash,
    chapterNumber: 1,
    score: 9,
    requiresRewrite: false,
    rewriteScope: "",
    issues: [],
    narrativeViolations: [],
    foundationViolations: [],
    summary: "承接、Foundation 指令、事实来源和文风均通过",
  });
  const polish = JSON.stringify({
    contextHash: context.contextHash,
    foundationDirectiveHash: directiveHash,
    chapterNumber: 1,
    polishedDraft: "城务署封锁线外，林澈依照双见证规则检修潮汐塔。潮位变化时，异常频段终于浮出水面。",
    factIds: ["fact_signal_exists"],
    knowledgeSignatures: ["fact_signal_exists\u0000林澈\u0000confirmed\u0000observed\u0000"],
  });
  const prompts: string[] = [];
  const responses = [writing, review, polish];
  let index = 0;
  const result = await runChapterWriting(
    state,
    1,
    {
      runtime: new PiAgentRuntime(),
      model: model(),
      streamFn: (_model, request) => {
        prompts.push(JSON.stringify(request.messages ?? null));
        return streamFor(responses[index++]!);
      },
    },
    store,
  );

  assert.equal(result.status, "awaiting_approval");
  assert.equal(state.chapterCandidates["1"]?.foundationDirectiveHash, directiveHash);
  assert.equal(state.chapterReviews["1"]?.foundationViolations?.length, 0);
  assert.equal(prompts.length, 3);
  for (const prompt of prompts) {
    assert.match(prompt, /chapterFoundationDirective/);
    assert.match(prompt, new RegExp(directiveHash));
  }
  assert.match(prompts[0]!, /sourceDocuments/);
  assert.doesNotMatch(prompts[0]!, /foundationContext/);
  assert.match(prompts[1]!, /foundationViolations/);
  assert.match(prompts[1]!, /foundationContext/);
  assert.match(prompts[2]!, /styleGuide/);
  assert.doesNotMatch(prompts[2]!, /foundationContext/);
});
