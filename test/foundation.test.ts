import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { EventStream, type AssistantMessageEvent, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { CheckpointStore } from "../src/checkpoint/store.js";
import { parseChapterPlan, parseGeneratedChapterPlan } from "../src/contracts/chapter.js";
import { parseCharacters, parseNarrativePlan, parseStoryArchitectureIntent, parseWorldSetting } from "../src/contracts/foundation.js";
import {
  applyFoundationDecision,
  beginLegacyFoundationUpgrade,
  decideFoundation,
  runFoundationGeneration,
  runFoundationUpgrade,
} from "../src/agents/foundation.js";
import { PiAgentRuntime } from "../src/runtime/agent.js";
import { buildContinuityContext } from "../src/state/continuity.js";
import { recordFoundationDocument, validateFoundationRegistry } from "../src/state/foundation-registry.js";
import { createInitialState } from "../src/state/state.js";
import { enhancedFoundationResponses } from "./foundation-fixture.js";

function model(): Model<"openai-responses"> {
  return {
    id: "mock", name: "mock", api: "openai-responses", provider: "openai",
    baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384, maxTokens: 8_192,
  };
}

function response(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "openai-responses",
    provider: "openai", model: "mock", stopReason, timestamp: Date.now(),
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function streamFor(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): ReturnType<StreamFn> {
  const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return event.message;
      if (event.type === "error") return event.error;
      throw new Error("Mock stream ended without a final event");
    },
  );
  queueMicrotask(() => stream.push({ type: "done", reason: stopReason === "length" ? "length" : "stop", message: response(text, stopReason) }));
  return stream;
}

function foundationResponses(): string[] {
  return enhancedFoundationResponses();
}

test("Foundation contracts reject output that exceeds fixed collection and field limits", () => {
  const character = JSON.parse(enhancedFoundationResponses()[2]!) as Record<string, unknown>[];
  assert.throws(
    () => parseCharacters(JSON.stringify(Array.from({ length: 25 }, (_, index) => ({
      ...character[0], characterId: `char_${index}`, name: `角色${index}`,
    })))),
    /核心角色最多包含 24 人/,
  );
  const architecture = JSON.parse(enhancedFoundationResponses()[4]!) as any;
  assert.throws(
    () => parseStoryArchitectureIntent(JSON.stringify({
      ...architecture,
      storyArcs: Array.from({ length: 9 }, (_, index) => ({ ...architecture.storyArcs[0], name: `阶段${index}` })),
    })),
    /最多包含 8 项/,
  );
  const world = JSON.parse(enhancedFoundationResponses()[1]!) as any;
  world.history = "过".repeat(801);
  assert.throws(() => parseWorldSetting(JSON.stringify(world)), /最多包含 800 个字符/);
  const narrative = JSON.parse(enhancedFoundationResponses()[5]!) as any;
  narrative.foreshadowingPlan[0].reinforceChapters = Array.from({ length: 65 }, (_, index) => index + 2);
  assert.throws(() => parseNarrativePlan(JSON.stringify(narrative), 100), /最多包含 64 项/);
});

test("Foundation graph writes candidates and pauses at its Gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-"));
  const state = createInitialState("foundation-test", "Foundation Test");
  state.creativeGenre = "都市科幻";
  state.creativePremise = "维修员追查海上城秘密";
  state.creativeTheme = "真相与责任";
  state.targetTotalChapters = 12;
  const responses = foundationResponses();
  let index = 0;
  const result = await runFoundationGeneration(
    state,
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(responses[index++]) },
    new CheckpointStore(root),
  );

  assert.equal(result.status, "awaiting_approval", JSON.stringify(state.lastError));
  assert.equal(state.pendingGate, "foundation");
  assert.equal(state.worldSetting?.location, "海上城");
  assert.equal(state.characters[0]?.name, "林澈");
  assert.equal(state.novelOutline?.chapterOutlines[0]?.chapterNumber, 1);
  assert.equal(state.foundationReview?.passed, true);
  assert.equal(state.foundationValidation?.passed, true);
  assert.ok(state.foundationRegistry?.entries.some((entry) => entry.id === "char_lin_che"));
  assert.equal(state.continuityBaseline?.storyTime, "第一日清晨");
  assert.equal(state.narrativeFacts.length, 0, "unapproved Foundation must not mutate continuity ledgers");
  assert.equal((await new CheckpointStore(root).load(state.projectId))?.pendingGate, "foundation");
  assert.equal(
    state.executionEvents.filter((event) => event.type === "gate_reached").length,
    1,
  );
});

test("Foundation prompts include complete output contracts for every node", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-contract-"));
  const state = createInitialState("foundation-contract-test", "Foundation Contract Test");
  state.creativeGenre = "都市科幻";
  state.creativePremise = "维修员追查海上城秘密";
  state.creativeTheme = "真相与责任";
  state.targetTotalChapters = 12;
  const responses = foundationResponses();
  let index = 0;
  const prompts: string[] = [];
  const requestOptions: Array<{ maxTokens?: number; reasoning?: unknown }> = [];
  const streamFn: StreamFn = (_model, context, options) => {
    prompts.push(`${context.systemPrompt}\n${JSON.stringify(context.messages ?? null)}`);
    requestOptions.push({ maxTokens: options?.maxTokens, reasoning: options?.reasoning });
    return streamFor(responses[index++]);
  };

  await runFoundationGeneration(
    state,
    { runtime: new PiAgentRuntime(), model: model(), streamFn },
    new CheckpointStore(root),
  );

  assert.equal(prompts.length, 10);
  assert.match(prompts[0]!, /genrePromise/);
  assert.match(prompts[1]!, /rulesAndLaws/);
  assert.match(prompts[2]!, /arcDescription/);
  assert.match(prompts[2]!, /secretId/);
  assert.match(prompts[3]!, /hiddenInformation/);
  assert.match(prompts[3]!, /必须引用角色设定集中的秘密 ID/);
  assert.match(prompts[4]!, /storyArcs/);
  assert.match(prompts[5]!, /revelationPlan/);
  assert.match(prompts[6]!, /chapterOutlines/);
  assert.match(prompts[6]!, /禁止虚构或使用占位 ID/);
  assert.match(prompts[7]!, /forbiddenPatterns/);
  assert.doesNotMatch(prompts[7]!, /characterVoices/);
  assert.match(prompts[8]!, /initialKnowledge/);
  assert.match(prompts[9]!, /rewriteTargets/);
  assert.ok(requestOptions.every((item) => item.reasoning === undefined));
  assert.deepEqual(requestOptions.map((item) => item.maxTokens), [2_048, 4_096, 6_144, 4_096, 4_096, 6_144, 6_144, 2_048, 6_144, 2_048]);
});

test("Foundation retries one malformed model response with the contract error", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-contract-retry-"));
  const state = createInitialState("foundation-contract-retry-test", "Foundation Contract Retry Test");
  state.creativeGenre = "都市科幻";
  state.creativePremise = "维修员追查海上城秘密";
  state.creativeTheme = "真相与责任";
  state.targetTotalChapters = 12;
  const responses = [
    JSON.stringify({ location: "海上城" }),
    ...foundationResponses(),
  ];
  let index = 0;
  const prompts: string[] = [];
  const result = await runFoundationGeneration(
    state,
    {
      runtime: new PiAgentRuntime(),
      model: model(),
      streamFn: (_model, context) => {
        prompts.push(JSON.stringify(context.messages ?? null));
        return streamFor(responses[index++]!);
      },
    },
    new CheckpointStore(root),
  );

  assert.equal(result.status, "awaiting_approval");
  assert.equal(prompts.length, 11);
  assert.match(prompts[1]!, /creative_charter\.targetAudience/);
  assert.equal(state.worldSetting?.era, "近未来");
});

test("long Foundation creates a bounded rolling roadmap without an outline model request", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-rolling-"));
  const state = createInitialState("foundation-rolling", "Foundation Rolling Roadmap");
  state.creativeGenre = "都市科幻";
  state.creativePremise = "维修员追查海上城秘密";
  state.creativeTheme = "真相与责任";
  state.targetTotalChapters = 400;
  const full = enhancedFoundationResponses({ totalChapters: 400 });
  const responses = [...full.slice(0, 5), full[7]!, full[8]!, full[9]!];
  const prompts: string[] = [];
  let index = 0;
  const result = await runFoundationGeneration(
    state,
    {
      runtime: new PiAgentRuntime(),
      model: model(),
      streamFn: (_model, request) => {
        prompts.push(`${request.systemPrompt ?? ""}\n${JSON.stringify(request.messages ?? null)}`);
        return streamFor(responses[index++]!);
      },
    },
    new CheckpointStore(root),
  );
  assert.equal(result.status, "awaiting_approval", JSON.stringify(result.state.lastError));
  assert.equal(index, 8);
  assert.equal(state.novelOutline?.planningMode, "rolling");
  assert.equal(state.novelOutline?.chapterOutlines.length, 0);
  assert.deepEqual(state.novelOutline?.roadmapSegments?.map((item) => [item.chapterStart, item.chapterEnd]), [[1, 400]]);
  assert.equal(state.foundationOutlineProgress, null);
  assert.equal(state.foundationValidation?.passed, true);
  assert.equal(prompts.some((prompt) => prompt.includes("novel_outline.chapterOutlines")), false);
  assert.equal(prompts.some((prompt) => prompt.includes("节奏、伏笔与信息流设计师")), false);
  assert.deepEqual(state.narrativePlan?.revelationPlan.map((item) => [item.factId, item.earliestChapter]), [["fact_secret_father_card", 400]]);
});

test("Foundation model workload stays bounded when a long project grows to 5000 chapters", async () => {
  const measurements: Array<{ calls: number; largestPrompt: number }> = [];
  for (const totalChapters of [400, 5000]) {
    const root = await mkdtemp(join(tmpdir(), `graphnovel-foundation-scale-${totalChapters}-`));
    const state = createInitialState(`foundation-scale-${totalChapters}`, `Foundation Scale ${totalChapters}`);
    state.creativeGenre = "都市科幻";
    state.creativePremise = "维修员追查海上城秘密";
    state.creativeTheme = "真相与责任";
    state.targetTotalChapters = totalChapters;
    const full = enhancedFoundationResponses({ totalChapters });
    const responses = [...full.slice(0, 5), full[7]!, full[8]!, full[9]!];
    const promptSizes: number[] = [];
    let index = 0;
    const result = await runFoundationGeneration(
      state,
      {
        runtime: new PiAgentRuntime(),
        model: model(),
        streamFn: (_model, request) => {
          promptSizes.push((request.systemPrompt?.length ?? 0) + JSON.stringify(request.messages ?? null).length);
          return streamFor(responses[index++]!);
        },
      },
      new CheckpointStore(root),
    );
    assert.equal(result.status, "awaiting_approval", JSON.stringify(result.state.lastError));
    assert.equal(state.novelOutline?.roadmapSegments?.length, 1);
    measurements.push({ calls: index, largestPrompt: Math.max(...promptSizes) });
  }
  assert.deepEqual(measurements.map((item) => item.calls), [8, 8]);
  assert.ok(Math.abs(measurements[1]!.largestPrompt - measurements[0]!.largestPrompt) < 256, JSON.stringify(measurements));
});

test("a failed architecture retry resumes at architecture with compact input and bounded policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-architecture-resume-"));
  const state = createInitialState("foundation-architecture-resume", "Foundation Architecture Resume");
  state.targetTotalChapters = 400;
  const full = enhancedFoundationResponses({ totalChapters: 400 });
  let index = 0;
  const store = new CheckpointStore(root);
  const failed = await runFoundationGeneration(
    state,
    {
      runtime: new PiAgentRuntime({ thinkingLevel: "max" }),
      model: { ...model(), reasoning: true },
      streamFn: () => {
        const current = index++;
        if (current === 4) return streamFor("", "length");
        return streamFor(full[current]!);
      },
    },
    store,
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.state.lastError?.nodeKey, "story_architecture");
  const upstreamAttempts = Object.fromEntries(
    ["creative_charter", "world_building", "character_design", "relationship_design"]
      .map((key) => [key, state.nodes[key]?.attempts]),
  );

  const prompts: string[] = [];
  const options: Array<{ maxTokens?: number; reasoning?: unknown }> = [];
  const responses = [full[4]!, full[7]!, full[8]!, full[9]!];
  let resumedIndex = 0;
  const resumed = await runFoundationGeneration(
    state,
    {
      runtime: new PiAgentRuntime({ thinkingLevel: "max" }),
      model: { ...model(), reasoning: true, maxTokens: 8_192 },
      streamFn: (_model, request, requestOptions) => {
        prompts.push(`${request.systemPrompt}\n${JSON.stringify(request.messages ?? null)}`);
        options.push({ maxTokens: requestOptions?.maxTokens, reasoning: requestOptions?.reasoning });
        return streamFor(responses[resumedIndex++]!);
      },
    },
    store,
  );
  assert.equal(resumed.status, "awaiting_approval", JSON.stringify(state.lastError));
  assert.equal(resumedIndex, 4);
  assert.deepEqual(Object.fromEntries(Object.keys(upstreamAttempts).map((key) => [key, state.nodes[key]?.attempts])), upstreamAttempts);
  assert.ok(prompts[0]!.length < 20_000, `architecture prompt is ${prompts[0]!.length} chars`);
  assert.doesNotMatch(prompts[0]!, /foundationRegistry/);
  assert.ok(options.every((item) => item.reasoning === undefined));
  assert.equal(options[0]?.maxTokens, 4_096);
  assert.deepEqual(state.storyArchitecture?.storyArcs.map((arc) => arc.chapterRange), ["1-400"]);
});

test("deterministic architecture compilation avoids upstream Registry ID collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-architecture-id-collision-"));
  const state = createInitialState("architecture-id-collision", "Architecture ID Collision");
  state.targetTotalChapters = 12;
  const responses = enhancedFoundationResponses();
  const architecture = JSON.parse(responses[4]!) as any;
  architecture.storyArcs[0].arcId = "rule_dual_witness";
  responses[4] = JSON.stringify(architecture);
  const outline = JSON.parse(responses[6]!) as any;
  outline.chapterOutlines.forEach((chapter: any) => { chapter.storyArcIds = ["rule_dual_witness_1"]; });
  responses[6] = JSON.stringify(outline);
  let index = 0;

  const result = await runFoundationGeneration(
    state,
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(responses[index++]!) },
    new CheckpointStore(root),
  );

  assert.equal(result.status, "awaiting_approval", JSON.stringify(state.lastError));
  assert.equal(state.storyArchitecture?.storyArcs[0]?.arcId, "rule_dual_witness_1");
  assert.equal(state.foundationValidation?.passed, true);
  assert.equal(state.foundationValidation?.issues.some((issue) => issue.code === "duplicate_id"), false);
});

test("rolling narrative compilation binds collision-free Registry IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-rolling-id-collision-"));
  const state = createInitialState("rolling-id-collision", "Rolling ID Collision");
  state.targetTotalChapters = 400;
  const full = enhancedFoundationResponses({ totalChapters: 400 });
  const world = JSON.parse(full[1]!) as any;
  world.rules.push({
    ruleId: "fact_secret_father_card",
    statement: "权限卡必须登记",
    consequence: "未登记会触发审计",
  });
  world.keyLocations.push({
    locationId: "foreshadow_secret_father_card",
    name: "权限档案室",
    roleInStory: "保存权限记录",
    distinguishingFeatures: "离线审计终端",
    accessConstraints: "双人授权",
  });
  const responses = [full[0]!, JSON.stringify(world), ...full.slice(2, 5), full[7]!, full[8]!, full[9]!];
  let index = 0;

  const result = await runFoundationGeneration(
    state,
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(responses[index++]!) },
    new CheckpointStore(root),
  );

  assert.equal(result.status, "awaiting_approval", JSON.stringify(state.lastError));
  assert.equal(state.foundationValidation?.passed, true);
  assert.equal(state.narrativePlan?.foreshadowingPlan[0]?.id, "foreshadow_secret_father_card_2");
  assert.equal(state.narrativePlan?.revelationPlan[0]?.factId, "fact_secret_father_card_2");
  assert.equal(state.foundationValidation?.issues.some((issue) => issue.code === "duplicate_id"), false);
});

test("an old failed outline checkpoint resumes through the deterministic roadmap", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-rolling-resume-"));
  const state = createInitialState("foundation-rolling-resume", "Foundation Rolling Resume");
  state.creativeGenre = "都市科幻";
  state.creativePremise = "维修员追查海上城秘密";
  state.creativeTheme = "真相与责任";
  state.targetTotalChapters = 400;
  const full = enhancedFoundationResponses({ totalChapters: 400 });
  const firstResponses = [...full.slice(0, 5), full[7]!, full[8]!, full[9]!];
  let firstIndex = 0;
  const store = new CheckpointStore(root);
  const first = await runFoundationGeneration(
    state,
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(firstResponses[firstIndex++]!) },
    store,
  );
  assert.equal(first.status, "awaiting_approval");
  state.pendingGate = null;
  state.workflowPhase = "failed";
  state.novelOutline = null;
  state.foundationOutlineProgress = {
    status: "failed", totalChapters: 400, chunkSize: 1, nextChapter: 29,
    currentRange: { start: 29, end: 29 }, chunks: [], lastError: "Pi Agent stopped with length",
  };
  state.nodes.outline_planning = { status: "failed", attempts: 4, error: "Pi Agent stopped with length" };
  const responses = [full[7]!, full[8]!, full[9]!];
  const prompts: string[] = [];
  let index = 0;
  const resumed = await runFoundationGeneration(
    state,
    {
      runtime: new PiAgentRuntime(),
      model: model(),
      streamFn: (_model, request) => {
        prompts.push(`${request.systemPrompt}\n${JSON.stringify(request.messages ?? null)}`);
        return streamFor(responses[index++]!);
      },
    },
    store,
  );
  assert.equal(resumed.status, "awaiting_approval", JSON.stringify(resumed.state.lastError));
  assert.equal(index, 3);
  assert.equal(resumed.state.novelOutline?.planningMode, "rolling");
  assert.equal(resumed.state.foundationOutlineProgress, null);
  assert.equal(prompts.some((prompt) => prompt.includes("chapterOutlines")), false);
});

test("a failed long narrative checkpoint resumes from deterministic narrative compilation", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-narrative-resume-"));
  const state = createInitialState("foundation-narrative-resume", "Foundation Narrative Resume");
  state.creativeGenre = "都市科幻";
  state.creativePremise = "维修员追查海上城秘密";
  state.creativeTheme = "真相与责任";
  state.targetTotalChapters = 400;
  const full = enhancedFoundationResponses({ totalChapters: 400 });
  const initialResponses = [...full.slice(0, 5), full[7]!, full[8]!, full[9]!];
  let initialIndex = 0;
  const store = new CheckpointStore(root);
  const initial = await runFoundationGeneration(
    state,
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(initialResponses[initialIndex++]!) },
    store,
  );
  assert.equal(initial.status, "awaiting_approval");
  const charterAttempts = state.nodes.creative_charter?.attempts;
  state.pendingGate = null;
  state.workflowPhase = "failed";
  state.nodes.narrative_planning = { status: "failed", attempts: 2, error: "Pi Agent stopped with length" };
  state.lastError = { nodeKey: "narrative_planning", message: "Pi Agent stopped with length", attempt: 2, timestamp: new Date().toISOString() };
  state.narrativePlan = JSON.parse(full[5]!);

  const responses = [full[7]!, full[8]!, full[9]!];
  const prompts: string[] = [];
  let index = 0;
  const resumed = await runFoundationGeneration(
    state,
    {
      runtime: new PiAgentRuntime(), model: model(),
      streamFn: (_model, request) => {
        prompts.push(`${request.systemPrompt ?? ""}\n${JSON.stringify(request.messages ?? null)}`);
        return streamFor(responses[index++]!);
      },
    },
    store,
  );

  assert.equal(resumed.status, "awaiting_approval", JSON.stringify(resumed.state.lastError));
  assert.equal(index, 3);
  assert.equal(state.nodes.creative_charter?.attempts, charterAttempts);
  assert.equal(state.nodes.narrative_planning?.attempts, 3);
  assert.equal(prompts.some((prompt) => prompt.includes("节奏、伏笔与信息流设计师")), false);
  assert.deepEqual(state.narrativePlan?.revelationPlan.map((item) => [item.factId, item.earliestChapter]), [["fact_secret_father_card", 400]]);
});

test("rolling directives resolve chapter obligations without storing per-chapter outlines", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-rolling-directive-"));
  const state = createInitialState("foundation-rolling-directive", "Foundation Rolling Directive");
  state.creativeGenre = "都市科幻";
  state.creativePremise = "维修员追查海上城秘密";
  state.creativeTheme = "真相与责任";
  state.targetTotalChapters = 400;
  const full = enhancedFoundationResponses({ totalChapters: 400 });
  const responses = [...full.slice(0, 5), full[7]!, full[8]!, full[9]!];
  let index = 0;
  const result = await runFoundationGeneration(
    state,
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(responses[index++]!) },
    new CheckpointStore(root),
  );
  assert.equal(result.status, "awaiting_approval");
  await decideFoundation(state, true, new CheckpointStore(root));
  const opening = buildContinuityContext(state, 1).targetOutline;
  const middle = buildContinuityContext(state, 200).targetOutline;
  const ending = buildContinuityContext(state, 400).targetOutline;
  assert.deepEqual(opening?.foreshadowingToPlant, []);
  assert.deepEqual(opening?.revealedFactIds, []);
  assert.deepEqual(middle?.storyArcIds, ["arc_anomaly_echo"]);
  assert.notEqual(middle?.payoff, "揭露协议来源");
  assert.deepEqual(middle?.involvedCharacterIds, ["char_lin_che"]);
  assert.deepEqual(ending?.foreshadowingToPayOff, ["foreshadow_secret_father_card"]);
  assert.equal(ending?.payoff, "真相被公开");
  assert.deepEqual(ending?.revealedSecretIds, ["secret_father_card"]);
  assert.deepEqual(ending?.revealedFactIds, ["fact_secret_father_card"]);
  assert.equal(state.novelOutline?.chapterOutlines.length, 0);
});

test("Foundation approval is persisted and routes to chapter loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-approval-"));
  const state = createInitialState("approval-test", "Approval Test");
  state.pendingGate = "foundation";
  state.worldSetting = {
    era: "近未来", location: "海上城", magicSystem: "潮汐协议",
    technologyLevel: "高科技", socialStructure: "城邦联盟",
    rulesAndLaws: "协议必须由两名见证者确认", history: "海平面上升后建立",
  };
  state.characters = [{
    name: "林澈", role: "protagonist", background: "港口维修员",
    personality: "谨慎执拗", motivation: "查清父亲失踪真相", arcDescription: "从独行到承担责任",
  }];
  state.novelOutline = {
    genre: "都市科幻", premise: "维修员追查海上城秘密", theme: "真相与责任",
    targetLength: "12章", chapterOutlines: [],
  };

  await decideFoundation(state, true, new CheckpointStore(root));

  const loaded = await new CheckpointStore(root).load(state.projectId);
  assert.equal(state.foundationApproval, "approved");
  assert.equal(state.workflowPhase, "chapter_loop");
  assert.equal(loaded?.workflowPhase, "chapter_loop");
  assert.equal(loaded?.executionEvents.at(-2)?.type, "gate_decided");
  const approvalRoute = loaded?.executionEvents.at(-1);
  assert.equal(approvalRoute?.type, "route_selected");
  if (approvalRoute?.type === "route_selected") {
    assert.equal(approvalRoute.target, "chapter_loop");
  }
  await assert.rejects(
    decideFoundation(state, true, new CheckpointStore(root)),
    /not waiting for approval/,
  );
});

test("Foundation rejection persists feedback and can regenerate from the first node", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-reject-"));
  const state = createInitialState("reject-test", "Reject Test");
  state.creativeGenre = "都市科幻";
  state.creativePremise = "维修员追查海上城秘密";
  state.creativeTheme = "真相与责任";
  state.targetTotalChapters = 12;
  const firstResponses = foundationResponses();
  let index = 0;
  const dependencies = {
    runtime: new PiAgentRuntime(), model: model(),
    streamFn: () => streamFor(firstResponses[index++]),
  };
  const store = new CheckpointStore(root);
  await runFoundationGeneration(state, dependencies, store);
  await decideFoundation(state, false, store, "请让第一章先建立异常信号的来源");

  const rejected = await store.load(state.projectId);
  assert.equal(rejected?.foundationApproval, "rejected");
  assert.equal(rejected?.foundationFeedback, "请让第一章先建立异常信号的来源");
  assert.equal(rejected?.workflowPhase, "foundation");
  assert.equal(rejected?.pendingGate, null);
  assert.equal(rejected?.executionEvents.at(-2)?.type, "gate_decided");
  const rejectionRoute = rejected?.executionEvents.at(-1);
  assert.equal(rejectionRoute?.type, "route_selected");
  if (rejectionRoute?.type === "route_selected") {
    assert.equal(rejectionRoute.target, "creative_charter");
  }

  const secondResponses = foundationResponses();
  let secondIndex = 0;
  const regenerated = await runFoundationGeneration(
    rejected!,
    { ...dependencies, streamFn: () => streamFor(secondResponses[secondIndex++]) },
    store,
  );
  assert.equal(regenerated.status, "awaiting_approval");
  assert.equal(regenerated.state.nodes.world_building?.attempts, 2);
  assert.equal(regenerated.state.foundationFeedback, "请让第一章先建立异常信号的来源");
  assert.equal(regenerated.state.pendingGate, "foundation");
});

test("Foundation review loops to the earliest requested node and then reaches its Gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-review-loop-"));
  const state = createInitialState("review-loop", "Review Loop");
  state.targetTotalChapters = 12;
  const failed = enhancedFoundationResponses({ reviewPassed: false, reviewTarget: "outline_planning" });
  const passed = enhancedFoundationResponses();
  const responses = [...failed, ...passed.slice(6)];
  let index = 0;
  const result = await runFoundationGeneration(
    state,
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(responses[index++]!) },
    new CheckpointStore(root),
  );

  assert.equal(result.status, "awaiting_approval");
  assert.equal(state.foundationReviewAttempts, 2);
  assert.equal(state.nodes.outline_planning?.attempts, 2);
  assert.equal(state.nodes.story_architecture?.attempts, 1);
  assert.equal(state.foundationReview?.passed, true);
  assert.ok(state.executionEvents.some((event) => event.type === "route_selected"
    && event.reason === "foundation_review_rewrite_outline_planning"));
});

test("deterministic Foundation validation rejects unknown IDs before semantic review", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-registry-loop-"));
  const state = createInitialState("registry-loop", "Registry Loop");
  state.targetTotalChapters = 12;
  const valid = enhancedFoundationResponses();
  const invalidOutline = JSON.parse(valid[6]!) as any;
  invalidOutline.chapterOutlines[0].povCharacterId = "char_missing";
  const responses = [
    ...valid.slice(0, 6), JSON.stringify(invalidOutline), valid[7]!, valid[8]!,
    ...valid.slice(6),
  ];
  const prompts: string[] = [];
  let index = 0;
  const result = await runFoundationGeneration(
    state,
    {
      runtime: new PiAgentRuntime(), model: model(),
      streamFn: (_model, request) => {
        prompts.push(JSON.stringify(request.messages ?? null));
        return streamFor(responses[index++]!);
      },
    },
    new CheckpointStore(root),
  );

  assert.equal(result.status, "awaiting_approval");
  assert.equal(state.foundationReviewAttempts, 2);
  assert.equal(state.nodes.foundation_consistency_review?.attempts, 1);
  assert.equal(state.nodes.outline_planning?.attempts, 2);
  assert.ok(prompts.slice(9).some((prompt) => prompt.includes("char_missing")), "rewrite prompt includes its validation issue");
  assert.ok(state.executionEvents.some((event) => event.type === "route_selected"
    && event.reason === "foundation_validation_rewrite_outline_planning"));
});

test("Foundation validation accepts facts already established by approved chapters", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-established-fact-"));
  const state = createInitialState("established-fact", "Established Fact");
  state.targetTotalChapters = 12;
  const responses = enhancedFoundationResponses();
  let index = 0;
  await runFoundationGeneration(
    state,
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(responses[index++]!) },
    new CheckpointStore(root),
  );
  state.narrativeFacts = [{
    factId: "approved_chapter_fact", statement: "已批准章节建立的事实", category: "plot",
    establishedInChapter: 1, visibility: "主角已确认",
  }];
  state.novelOutline!.chapterOutlines[0]!.revealedFactIds = ["approved_chapter_fact"];
  recordFoundationDocument(state, "outline_planning", {}, state.novelOutline);

  const validation = validateFoundationRegistry(state);

  assert.equal(validation.issues.some((issue) => issue.path.endsWith("revealedFactIds[0]") && issue.code === "unknown_reference"), false);
});

test("deterministic Foundation validation sends unknown secret references back to relationship design", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-secret-reference-"));
  const state = createInitialState("secret-reference", "Secret Reference");
  state.targetTotalChapters = 12;
  const valid = enhancedFoundationResponses();
  const invalidRelationships = JSON.parse(valid[3]!) as any;
  invalidRelationships.secrets[0].secretId = "secret_missing";
  const responses = [
    ...valid.slice(0, 3), JSON.stringify(invalidRelationships), ...valid.slice(4, 9),
    ...valid.slice(3),
  ];
  let index = 0;
  const result = await runFoundationGeneration(
    state,
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(responses[index++]!) },
    new CheckpointStore(root),
  );

  assert.equal(result.status, "awaiting_approval");
  assert.equal(state.nodes.relationship_design?.attempts, 2);
  assert.equal(state.nodes.foundation_consistency_review?.attempts, 1);
  assert.ok(state.executionEvents.some((event) => event.type === "route_selected"
    && event.reason === "foundation_validation_rewrite_relationship_design"));
});

test("Foundation validation enforces canonical secret and voice ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-canonical-owner-"));
  const state = createInitialState("canonical-owner", "Canonical Owner");
  state.targetTotalChapters = 12;
  const responses = enhancedFoundationResponses();
  let index = 0;
  await runFoundationGeneration(
    state,
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(responses[index++]!) },
    new CheckpointStore(root),
  );
  state.characters[0]!.secret = "重复的秘密正文";
  state.relationshipMap!.secrets[0]!.content = "关系文档中的重复秘密正文";
  state.styleGuide!.characterVoices = [{ characterId: "char_lin_che", voice: "重复的人物声音" }];
  const validation = validateFoundationRegistry(state);

  assert.equal(validation.passed, false);
  assert.ok(validation.issues.some((issue) => issue.code === "duplicate_secret_source" && issue.target === "character_design"));
  assert.ok(validation.issues.some((issue) => issue.code === "duplicate_secret_source" && issue.target === "relationship_design"));
  assert.ok(validation.issues.some((issue) => issue.code === "duplicate_character_voice_source" && issue.target === "style_design"));
});

test("Foundation validation requires reveal, foreshadowing, and initial knowledge plans to agree", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-schedule-alignment-"));
  const state = createInitialState("schedule-alignment", "Schedule Alignment");
  state.targetTotalChapters = 12;
  const responses = enhancedFoundationResponses();
  let index = 0;
  await runFoundationGeneration(
    state,
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(responses[index++]!) },
    new CheckpointStore(root),
  );
  state.novelOutline!.chapterOutlines[0]!.foreshadowingToPlant = [];
  state.novelOutline!.chapterOutlines[11]!.foreshadowingToPayOff = [];
  state.novelOutline!.chapterOutlines[11]!.revealedSecretIds = [];
  state.novelOutline!.chapterOutlines[8]!.causalPrerequisites = ["ch8_fact_???"];
  state.narrativePlan!.revelationPlan[0]!.knownInitiallyBy = ["char_lin_che"];
  state.narrativePlan!.revelationPlan.push({
    factId: "fact_father_card",
    information: "林澈私藏父亲的旧权限卡",
    knownInitiallyBy: ["char_lin_che"],
    revealTo: ["char_lin_che"],
    earliestChapter: 11,
    method: "旧权限卡被公开验证",
  });
  const validation = validateFoundationRegistry(state);

  assert.equal(validation.passed, false);
  assert.ok(validation.issues.some((issue) => issue.code === "missing_secret_reveal"));
  assert.ok(validation.issues.some((issue) => issue.code === "foreshadowing_plant_missing"));
  assert.ok(validation.issues.some((issue) => issue.code === "foreshadowing_payoff_missing"));
  assert.ok(validation.issues.some((issue) => issue.code === "initial_knowledge_missing"));
  assert.ok(validation.issues.some((issue) => issue.code === "secret_fact_reveal_mismatch" && issue.target === "relationship_design"));
  assert.ok(validation.issues.some((issue) => issue.code === "unknown_causal_fact" && issue.target === "outline_planning"));
});

test("Foundation Registry treats a matching baseline fact as a reference and rejects conflicting content", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-fact-reference-"));
  const state = createInitialState("fact-reference", "Fact Reference");
  state.targetTotalChapters = 12;
  const responses = enhancedFoundationResponses();
  let index = 0;
  await runFoundationGeneration(
    state,
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(responses[index++]!) },
    new CheckpointStore(root),
  );
  state.continuityBaseline!.initialFacts.push({
    factId: "fact_signal_exists",
    statement: "旧港存在异常信号",
    category: "plot",
    visibility: "林澈可验证",
  });
  recordFoundationDocument(state, "continuity_baseline", {}, state.continuityBaseline);

  const matching = validateFoundationRegistry(state);
  assert.equal(matching.issues.some((issue) => issue.code === "duplicate_id" && issue.path.includes("initialFacts")), false);
  assert.equal(matching.issues.some((issue) => issue.code === "fact_definition_mismatch"), false);

  state.continuityBaseline!.initialFacts.at(-1)!.statement = "旧港不存在异常信号";
  recordFoundationDocument(state, "continuity_baseline", {}, state.continuityBaseline);
  const conflicting = validateFoundationRegistry(state);
  assert.ok(conflicting.issues.some((issue) => issue.code === "fact_definition_mismatch" && issue.target === "continuity_baseline"));
});

test("Foundation generation rewrites a baseline fact that conflicts with the narrative definition", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-baseline-fact-conflict-"));
  const state = createInitialState("baseline-fact-conflict", "Baseline Fact Conflict");
  state.targetTotalChapters = 12;
  const full = enhancedFoundationResponses();
  const conflictingBaseline = JSON.parse(full[8]!) as any;
  conflictingBaseline.initialFacts.push({
    factId: "fact_signal_exists",
    statement: "旧港不存在异常信号",
    category: "plot",
    visibility: "林澈可验证",
  });
  const correctedBaseline = JSON.parse(full[8]!) as any;
  correctedBaseline.initialFacts.push({
    factId: "fact_signal_exists",
    statement: "  旧港存在异常信号  ",
    category: "plot",
    visibility: "林澈可验证",
  });
  const responses = [
    ...full.slice(0, 8),
    JSON.stringify(conflictingBaseline),
    JSON.stringify(correctedBaseline),
    full[9]!,
  ];
  let index = 0;

  const result = await runFoundationGeneration(
    state,
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(responses[index++]!) },
    new CheckpointStore(root),
  );

  assert.equal(result.status, "awaiting_approval", JSON.stringify(state.lastError));
  assert.equal(state.nodes.continuity_baseline?.attempts, 2);
  assert.ok(state.executionEvents.some((event) => event.type === "route_selected"
    && event.reason === "foundation_validation_rewrite_continuity_baseline"));
  assert.equal(state.continuityBaseline?.initialFacts.at(-1)?.statement, "旧港存在异常信号");
  assert.equal(state.foundationValidation?.passed, true);
});

test("rolling payoff validation routes derived schedule errors to story architecture", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-rolling-payoff-owner-"));
  const state = createInitialState("rolling-payoff-owner", "Rolling Payoff Owner");
  state.targetTotalChapters = 400;
  const full = enhancedFoundationResponses({ totalChapters: 400 });
  const responses = [...full.slice(0, 5), full[7]!, full[8]!, full[9]!];
  let index = 0;
  await runFoundationGeneration(
    state,
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(responses[index++]!) },
    new CheckpointStore(root),
  );
  state.narrativePlan!.payoffSchedule[0]!.chapterRange = "1-401";
  recordFoundationDocument(state, "narrative_planning", {}, state.narrativePlan);

  const validation = validateFoundationRegistry(state);

  assert.ok(validation.issues.some((issue) => issue.code === "payoff_range" && issue.target === "story_architecture"));
  assert.equal(validation.issues.some((issue) => issue.code === "payoff_range" && issue.target === "narrative_planning"), false);
});

test("Foundation validation detects untracked manual changes by document hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-hash-"));
  const state = createInitialState("registry-hash", "Registry Hash");
  state.targetTotalChapters = 12;
  const responses = enhancedFoundationResponses();
  let index = 0;
  await runFoundationGeneration(
    state,
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(responses[index++]!) },
    new CheckpointStore(root),
  );
  state.novelOutline!.chapterOutlines[0]!.povCharacterId = "char_missing";
  const validation = validateFoundationRegistry(state);

  assert.equal(validation.passed, false);
  assert.ok(validation.issues.some((issue) => issue.code === "document_hash_mismatch" && issue.target === "outline_planning"));
  assert.ok(validation.issues.some((issue) => issue.code === "unknown_reference" && issue.path.endsWith("povCharacterId")));
});

test("Foundation review fails explicitly after two rewrite loops", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-review-limit-"));
  const state = createInitialState("review-limit", "Review Limit");
  state.targetTotalChapters = 12;
  const failed = enhancedFoundationResponses({ reviewPassed: false, reviewTarget: "outline_planning" });
  const responses = [...failed, ...failed.slice(6), ...failed.slice(6)];
  let index = 0;
  const result = await runFoundationGeneration(
    state,
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(responses[index++]!) },
    new CheckpointStore(root),
  );

  assert.equal(result.status, "failed");
  assert.equal(state.foundationReviewAttempts, 3);
  assert.equal(state.nodes.outline_planning?.attempts, 3);
  assert.equal(state.pendingGate, null);
  assert.match(state.lastError?.message ?? "", /一致性审查连续 3 次未通过/);
});

test("approving enhanced Foundation seeds the chapter continuity baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-baseline-"));
  const state = createInitialState("baseline", "Baseline");
  state.targetTotalChapters = 12;
  const responses = enhancedFoundationResponses();
  let index = 0;
  const store = new CheckpointStore(root);
  await runFoundationGeneration(
    state,
    { runtime: new PiAgentRuntime(), model: model(), streamFn: () => streamFor(responses[index++]!) },
    store,
  );
  await decideFoundation(state, true, store);

  assert.equal(state.narrativeFacts[0]?.factId, "fact_father_missing");
  assert.equal(state.narrativeFacts[0]?.establishedInChapter, 0);
  assert.equal(state.characterKnowledge[0]?.learnedInChapter, 0);
  assert.equal(state.continuity.time, "第一日清晨");
  assert.equal(state.continuity.characterLocations.林澈, "旧港");
  assert.equal(state.characterArcs.林澈, "从独行到承担责任");
  assert.equal(state.foundationSnapshot?.version, 1);
  assert.equal(state.foundationSnapshot?.snapshotHash.length, 64);
  const context = buildContinuityContext(state, 1);
  assert.equal(context.contextVersion, 4);
  assert.equal(context.foundationContext?.styleGuide.pointOfView, "第三人称限知，固定跟随林澈");
  assert.equal(context.targetOutline?.chapterGoal, "确认第1条线索");
  const directive = context.chapterFoundationDirective!;
  assert.equal(Object.keys(directive.sourceDocuments).length, 9);
  assert.deepEqual(directive.references.factionIds, ["faction_city_admin"]);
  assert.deepEqual(directive.references.systemIds, ["system_tidal_protocol"]);
  assert.deepEqual(directive.references.storyArcIds, ["arc_anomaly_echo"]);
  assert.equal(directive.worldSetting.rules?.[0]?.ruleId, "rule_dual_witness");
  assert.equal(directive.characters[0]?.characterId, "char_lin_che");
  assert.equal(directive.narrativePlan.revelationPlan[0]?.factId, "fact_signal_exists");
  const chapterPlan = {
    contextHash: context.contextHash,
    foundationDirectiveHash: directive.directiveHash,
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
  };
  assert.equal(parseChapterPlan(JSON.stringify(chapterPlan), 1, context).foundationDirectiveHash, directive.directiveHash);
  const generatedPlan = { ...chapterPlan } as Record<string, unknown>;
  delete generatedPlan.contextHash;
  delete generatedPlan.foundationDirectiveHash;
  delete generatedPlan.chapterNumber;
  (generatedPlan.plannedFacts as Array<{ statement: string }>)[0]!.statement = "模型对批准事实的同义改写";
  const parsedGenerated = parseGeneratedChapterPlan(JSON.stringify(generatedPlan), 1, context);
  assert.equal(parsedGenerated.contextHash, context.contextHash);
  assert.equal(parsedGenerated.foundationDirectiveHash, directive.directiveHash);
  assert.equal(parsedGenerated.chapterNumber, 1);
  assert.equal(parsedGenerated.plannedFacts[0]?.statement, "旧港存在异常信号");
  assert.deepEqual(parsedGenerated.foundationObligations, {
    revealedSecretIds: [],
    revealedFactIds: ["fact_signal_exists"],
    foreshadowingToPlant: ["old_badge"],
    foreshadowingToReinforce: [],
    foreshadowingToPayOff: [],
  });
  assert.throws(
    () => parseChapterPlan(JSON.stringify({ ...chapterPlan, foundationDirectiveHash: "wrong" }), 1, context),
    /foundationDirectiveHash.*必须匹配/,
  );
  state.styleGuide!.tone = "未经批准的修改";
  assert.throws(() => buildContinuityContext(state, 1), /Approved Foundation document has changed/);
});

test("Foundation decision requires complete candidates and feedback on rejection", async () => {
  assert.throws(() => parseWorldSetting(JSON.stringify({ era: "only" })), /world_setting\.location/);
  const state = createInitialState("decision-test", "Decision Test");
  state.pendingGate = "foundation";
  assert.throws(() => applyFoundationDecision(state, false), /requires feedback/);
  assert.throws(() => applyFoundationDecision(state, true), /incomplete Foundation/);
});

test("legacy Foundation upgrade preserves approved canon and invalidates only future chapter work", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-upgrade-"));
  const store = new CheckpointStore(root);
  const state = createInitialState("legacy-upgrade", "Legacy Upgrade");
  state.creativeGenre = "都市科幻";
  state.creativePremise = "维修员追查海上城秘密";
  state.creativeTheme = "真相与责任";
  state.targetTotalChapters = 12;
  const responses = enhancedFoundationResponses();
  state.worldSetting = JSON.parse(responses[1]!);
  state.characters = JSON.parse(responses[2]!);
  state.novelOutline = JSON.parse(responses[6]!);
  const legacyWorld = JSON.stringify(state.worldSetting);
  const legacyCharacters = JSON.stringify(state.characters);
  const legacyOutline = JSON.stringify(state.novelOutline);
  const rewrittenWorld = JSON.parse(responses[1]!);
  rewrittenWorld.era = "模型擅自改写的时代";
  responses[1] = JSON.stringify(rewrittenWorld);
  const rewrittenCharacters = JSON.parse(responses[2]!);
  rewrittenCharacters[0].motivation = "模型擅自改写的动机";
  responses[2] = JSON.stringify(rewrittenCharacters);
  const rewrittenNarrativePlan = JSON.parse(responses[5]!);
  rewrittenNarrativePlan.revelationPlan[0].knownInitiallyBy = ["char_lin_che"];
  rewrittenNarrativePlan.revelationPlan.push({
    factId: "rule_dual_witness", information: "双见证规则被重新确认", knownInitiallyBy: [],
    revealTo: ["char_lin_che"], earliestChapter: 2, method: "协议日志",
  });
  rewrittenNarrativePlan.foreshadowingPlan[0].reinforceChapters = [12];
  responses[5] = JSON.stringify(rewrittenNarrativePlan);
  const rewrittenOutline = JSON.parse(responses[6]!);
  rewrittenOutline.chapterOutlines[1].summary = "模型擅自改写的第二章摘要";
  rewrittenOutline.chapterOutlines[1].keyEvents = ["模型擅自改写的关键事件"];
  rewrittenOutline.chapterOutlines[0].revealedSecretIds = ["secret_father_card"];
  rewrittenOutline.chapterOutlines[0].foreshadowingToPayOff = ["old_badge"];
  responses[6] = JSON.stringify(rewrittenOutline);
  const rewrittenBaseline = JSON.parse(responses[8]!);
  rewrittenBaseline.characterLocations.char_lin_che = "unregistered_apartment";
  responses[8] = JSON.stringify(rewrittenBaseline);
  state.foundationApproval = "approved";
  state.workflowPhase = "awaiting_approval";
  state.pendingGate = "chapter_plan:2";
  state.pendingChapterNumber = 2;
  state.approvedChapters = [{
    chapterNumber: 1,
    title: "潮汐回声",
    summary: "林澈在旧港确认异常信号。",
    polishedDraft: "旧港警报响起。林澈记录信号，随后发现父亲留下的权限签名。",
    endingExcerpt: "屏幕上浮出父亲的旧权限签名。",
    lastScene: {
      time: "第一日清晨", location: "旧港", povCharacter: "林澈",
      charactersPresent: ["林澈"], finalAction: "保存信号", finalDialogue: "",
    },
    unresolvedActions: ["确认签名来源"],
    openThreads: ["父亲的权限签名"],
  }];
  state.narrativeFacts = [{
    factId: "fact_signal_exists", statement: "旧港存在异常信号", category: "plot",
    establishedInChapter: 1, visibility: "林澈可验证",
  }];
  state.continuity = {
    time: "第一日清晨",
    characterLocations: { 林澈: "旧港" },
    characterConditions: { 林澈: "警觉" },
    resources: { 林澈: "异常频段记录" },
  };
  state.chapterPlans["2"] = { chapterNumber: 2, title: "旧版候选" } as any;
  state.nodes.chapter_planning_2 = { status: "completed", attempts: 1 };
  state.nodes.human_approval_chapter_planning_2 = { status: "in_progress", attempts: 1 };
  await store.save(state);
  const backupFile = await store.backup(state, "pre-foundation-upgrade");
  beginLegacyFoundationUpgrade(state, backupFile);
  state.nodes.human_approval_chapter_planning_2!.status = "in_progress";
  await store.save(state);

  const approvedBefore = JSON.stringify(state.approvedChapters);
  const factsBefore = JSON.stringify(state.narrativeFacts);
  const continuityBefore = JSON.stringify(state.continuity);
  const prompts: string[] = [];
  let index = 0;
  const result = await runFoundationUpgrade(
    state,
    {
      runtime: new PiAgentRuntime(), model: model(),
      streamFn: (_model, request) => {
        prompts.push(JSON.stringify(request.messages ?? null));
        return streamFor(responses[index++]!);
      },
    },
    store,
  );

  assert.equal(result.status, "awaiting_approval", JSON.stringify(state.lastError));
  assert.equal(state.pendingGate, "foundation");
  assert.equal(state.foundationUpgrade?.status, "awaiting_approval");
  assert.equal(state.worldSetting?.era, JSON.parse(legacyWorld).era);
  assert.equal(state.characters[0]?.motivation, JSON.parse(legacyCharacters)[0].motivation);
  assert.deepEqual(state.novelOutline?.chapterOutlines[1], JSON.parse(legacyOutline).chapterOutlines[1]);
  assert.deepEqual(state.novelOutline?.chapterOutlines[0]?.revealedSecretIds, []);
  assert.deepEqual(state.novelOutline?.chapterOutlines[0]?.foreshadowingToPayOff, []);
  assert.deepEqual(state.narrativePlan?.foreshadowingPlan[0]?.reinforceChapters, []);
  assert.equal(state.narrativePlan?.revelationPlan.at(-1)?.factId, "fact_rule_dual_witness");
  assert.ok(state.continuityBaseline?.initialKnowledge.some((item) => item.factId === "fact_signal_exists" && item.characterId === "char_lin_che"));
  assert.deepEqual(state.continuityBaseline?.characterLocations, {});
  assert.equal(state.chapterPlans["2"]?.title, "旧版候选", "unapproved work remains recoverable until upgrade approval");
  assert.equal(state.nodes.human_approval_chapter_planning_2?.status, "pending");
  assert.match(prompts[0]!, /legacyUpgradeReference/);
  assert.match(prompts[3]!, /novelOutline/);
  assert.match(prompts.at(-1)!, /legacyUpgradeReference/);
  assert.equal(JSON.parse(await readFile(join(root, backupFile), "utf8")).pendingGate, "chapter_plan:2");

  await decideFoundation(state, true, store);

  assert.equal(JSON.stringify(state.approvedChapters), approvedBefore);
  assert.equal(JSON.stringify(state.narrativeFacts), factsBefore);
  assert.equal(JSON.stringify(state.continuity), continuityBefore);
  assert.equal(state.chapterPlans["2"], undefined);
  assert.equal(state.nodes.chapter_planning_2, undefined);
  assert.equal(state.foundationUpgrade?.status, "completed");
  assert.equal(state.foundationUpgrade?.source, null);
  assert.equal(state.foundationSnapshot?.snapshotHash.length, 64);
  assert.equal(buildContinuityContext(state, 2).chapterFoundationDirective?.sourceSnapshotHash, state.foundationSnapshot?.snapshotHash);
});

test("long legacy Foundation upgrade switches to a rolling roadmap without an outline model request", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphnovel-foundation-upgrade-rolling-"));
  const store = new CheckpointStore(root);
  const state = createInitialState("legacy-upgrade-rolling", "Legacy Upgrade Rolling");
  state.creativeGenre = "都市科幻";
  state.creativePremise = "维修员追查海上城秘密";
  state.creativeTheme = "真相与责任";
  state.targetTotalChapters = 400;
  const full = enhancedFoundationResponses({ totalChapters: 400 });
  state.worldSetting = JSON.parse(full[1]!);
  state.characters = JSON.parse(full[2]!);
  state.novelOutline = JSON.parse(full[6]!);
  state.foundationApproval = "approved";
  state.workflowPhase = "awaiting_approval";
  state.pendingGate = "chapter_plan:2";
  state.pendingChapterNumber = 2;
  state.approvedChapters = [{
    chapterNumber: 1,
    title: "潮汐回声",
    summary: "林澈在旧港确认异常信号。",
    polishedDraft: "旧港警报响起。林澈记录信号。",
    endingExcerpt: "新的频段再次响起。",
    lastScene: {
      time: "第一日清晨", location: "旧港", povCharacter: "林澈",
      charactersPresent: ["林澈"], finalAction: "保存信号", finalDialogue: "",
    },
    unresolvedActions: ["确认信号来源"],
    openThreads: ["异常频段"],
  }];
  const approvedBefore = JSON.stringify(state.approvedChapters);
  await store.save(state);
  const backupFile = await store.backup(state, "pre-foundation-upgrade");
  beginLegacyFoundationUpgrade(state, backupFile);

  const responses = [...full.slice(0, 5), full[7]!, full[8]!, full[9]!];
  const prompts: string[] = [];
  let index = 0;
  const result = await runFoundationUpgrade(
    state,
    {
      runtime: new PiAgentRuntime(), model: model(),
      streamFn: (_model, request) => {
        prompts.push(`${request.systemPrompt ?? ""}\n${JSON.stringify(request.messages ?? null)}`);
        return streamFor(responses[index++]!);
      },
    },
    store,
  );

  assert.equal(result.status, "awaiting_approval", JSON.stringify(state.lastError));
  assert.equal(index, 8);
  assert.equal(state.novelOutline?.planningMode, "rolling");
  assert.equal(state.novelOutline?.chapterOutlines.length, 0);
  assert.deepEqual(state.novelOutline?.roadmapSegments?.map((item) => [item.chapterStart, item.chapterEnd]), [[1, 400]]);
  assert.equal(prompts.some((prompt) => prompt.includes("novel_outline.chapterOutlines")), false);
  assert.equal(prompts.some((prompt) => prompt.includes('"chapterOutlines"')), false);
  assert.ok(Math.max(...prompts.map((prompt) => prompt.length)) < 50_000);
  assert.equal(JSON.stringify(state.approvedChapters), approvedBefore);
});
