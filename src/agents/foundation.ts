import { createHash } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  OutputContractError,
  parseCharacters,
  parseContinuityBaseline,
  parseCreativeCharter,
  parseFoundationReview,
  parseNarrativePlan,
  parseNovelOutline,
  parseRelationshipMap,
  parseStoryArchitecture,
  parseStoryArchitectureIntent,
  parseStyleGuide,
  parseWorldSetting,
} from "../contracts/foundation.js";
import { GraphEngine, type GraphNode, type GraphRunResult } from "../graph/engine.js";
import { PiAgentRuntime } from "../runtime/agent.js";
import type { GraphEventSink } from "../runtime/types.js";
import type { CheckpointStore } from "../checkpoint/store.js";
import type { GraphNovelState } from "../state/state.js";
import type {
  Character,
  ContinuityBaseline,
  FoundationRewriteTarget,
  NarrativePlan,
  NovelOutline,
  StoryArchitecture,
  WorldSetting,
} from "../state/foundation.js";
import type { StoryArchitectureIntent } from "../contracts/foundation.js";
import { buildRollingNarrativePlan, buildRollingNovelOutline } from "../state/rolling-outline.js";
import type { LegacyFoundationSource } from "../state/foundation-upgrade.js";
import {
  createFoundationSnapshot,
  FOUNDATION_DOCUMENT_ORDER,
  recordFoundationDocument,
  validateFoundationRegistry,
} from "../state/foundation-registry.js";
import { runContractedNode } from "../runtime/contracts.js";

export interface FoundationAgentDependencies {
  runtime: PiAgentRuntime;
  model: Model<any>;
  streamFn: StreamFn;
}

const CHARTER_NODE = "creative_charter";
const WORLD_NODE = "world_building";
const CHARACTER_NODE = "character_design";
const RELATIONSHIP_NODE = "relationship_design";
const ARCHITECTURE_NODE = "story_architecture";
const NARRATIVE_NODE = "narrative_planning";
const OUTLINE_NODE = "outline_planning";
const STYLE_NODE = "style_design";
const BASELINE_NODE = "continuity_baseline";
const VALIDATION_NODE = "foundation_registry_validation";
const REVIEW_NODE = "foundation_consistency_review";
const GATE_NODE = "human_approval_foundation";

export const MAX_FOUNDATION_REVIEW_REWRITES = 2;

interface FoundationEngineOptions {
  upgradeSource?: LegacyFoundationSource;
}

const CREATIVE_CHARTER_CONTRACT = {
  targetAudience: "非空字符串：核心读者与阅读场景",
  genrePromise: "非空字符串：本书必须持续兑现的题材承诺",
  coreAppeal: "非空字符串：一句话核心卖点",
  emotionalPromise: "非空字符串：读者持续获得的情绪体验",
  themes: ["非空字符串；至少一项"],
  contentBoundaries: ["非空字符串；至少一项，说明不写什么或不可破坏的边界"],
  successCriteria: ["非空字符串；至少一项，可用于审查是否兑现"],
};

const WORLD_SETTING_CONTRACT = {
  era: "非空字符串", location: "非空字符串", magicSystem: "非空字符串",
  technologyLevel: "非空字符串", socialStructure: "非空字符串",
  rulesAndLaws: "非空字符串", history: "非空字符串",
  keyLocations: [{ locationId: "稳定 ASCII ID", name: "非空字符串", roleInStory: "非空字符串", distinguishingFeatures: "非空字符串", accessConstraints: "非空字符串" }],
  factions: [{ factionId: "稳定 ASCII ID", name: "非空字符串", goal: "非空字符串", resources: "非空字符串", relationshipToProtagonist: "非空字符串" }],
  powerSystem: { systemId: "稳定 ASCII ID", source: "非空字符串", capabilities: "非空字符串", limitations: "非空字符串", costs: "非空字符串", progression: "非空字符串" },
  rules: [{ ruleId: "稳定 ASCII ID", statement: "规则内容", consequence: "违反或触发后的结果" }],
};

const CHARACTER_CONTRACT = {
  characterId: "稳定 ASCII ID", name: "非空字符串", role: "非空字符串", background: "非空字符串",
  personality: "非空字符串", motivation: "非空字符串", arcDescription: "非空字符串",
  fear: "非空字符串", secrets: [{ secretId: "稳定 ASCII ID", content: "秘密内容；没有则为空数组" }],
  strengths: ["非空字符串；至少一项"], weaknesses: ["非空字符串；至少一项"],
  abilities: ["非空字符串；至少一项"], voice: "非空字符串：语言和表达特征",
  firstAppearance: "非空字符串：首次出场的场景与记忆点",
};

const RELATIONSHIP_CONTRACT = {
  relationships: [{ fromCharacterId: "角色 ID", toCharacterId: "角色 ID", nature: "关系性质", currentState: "当前状态", tension: "矛盾张力", hiddenInformation: "双方未共享的信息" }],
  secrets: [{ secretId: "必须引用角色设定集中的秘密 ID", holders: ["知情角色 ID，至少一项"], affectedCharacters: ["受影响角色 ID，至少一项"], plannedReveal: "计划揭示方式", plannedRevealChapter: "正整数" }],
};

const ARCHITECTURE_CONTRACT = {
  centralConflict: "非空字符串", stakes: "非空字符串", endingDirection: "非空字符串",
  storyArcs: [{ arcId: "稳定 ASCII ID；全书共 1-12 个阶段", name: "非空字符串", chapterRange: "明确的连续章节范围，例如 1-40；所有阶段必须无缝覆盖全书", objective: "非空字符串", opposition: "非空字符串", turningPoint: "非空字符串", outcome: "非空字符串" }],
  characterArcMilestones: [{ characterId: "角色 ID", startingState: "非空字符串", milestones: ["非空字符串；至少一项"], endingState: "非空字符串" }],
};

const ARCHITECTURE_INTENT_CONTRACT = {
  centralConflict: "最多 400 字",
  stakes: "最多 400 字",
  endingDirection: "最多 400 字",
  storyArcs: [{
    arcId: "可选的稳定 ASCII ID；缺省时由 Graph 引擎分配",
    name: "最多 80 字；全书共 1-8 个阶段",
    objective: "最多 300 字",
    opposition: "最多 300 字",
    turningPoint: "最多 300 字",
    outcome: "最多 300 字",
    weight: "1-5 的整数，表示相对篇幅；不输出章节号或 ID",
  }],
};

const NARRATIVE_PLAN_CONTRACT = {
  pacingPrinciples: ["非空字符串；至少一项"],
  payoffSchedule: [{ chapterRange: "明确章节范围，例如 1-40；最多 24 项", type: "爽点、反转、情绪兑现等", setup: "前置铺垫", payoff: "兑现内容" }],
  foreshadowingPlan: [{ id: "稳定标识", description: "伏笔内容", plantChapter: "正整数", reinforceChapters: ["正整数，可为空"], payoffChapter: "正整数", payoff: "回收方式" }],
  revelationPlan: [{ factId: "稳定 ASCII ID", information: "信息内容", knownInitiallyBy: ["仅限故事开篇前已经知道完整事实的角色 ID；角色在某章才获知时禁止列入，可为空"], revealTo: ["后续获知角色 ID，至少一项"], earliestChapter: "正整数", method: "可追溯的获知方式" }],
};

const OUTLINE_CHAPTER_CONTRACT = {
  chapterNumber: "正整数，必须与请求范围内的章节号完全连续",
  title: "非空字符串",
  summary: "非空字符串，说明本章可验证的剧情推进",
  povCharacter: "角色名，仅用于阅读",
  povCharacterId: "角色 ID",
  involvedCharacterIds: ["在场或参与角色 ID，至少一项"],
  locationIds: ["地点 ID，至少一项"],
  factionIds: ["本章实际涉及的势力 ID，可为空"],
  requiredSystemIds: ["本章实际使用或约束情节的能力体系 ID，可为空"],
  requiredRuleIds: ["本章必须遵守的世界规则 ID，至少一项"],
  storyArcIds: ["本章所属故事阶段 ID，至少一项"],
  chapterGoal: "本章目标",
  conflict: "本章主要冲突",
  causalPrerequisites: ["必须在本章前已成立的条件，可为空；引用事实 ID 时只能使用输入中已登记且在本章前成立的 ID，未来条件必须写成具体自然语言，禁止虚构或使用占位 ID"],
  keyEvents: ["非空字符串；至少一项；每项都是本章实际发生的关键事件，禁止省略、空数组或用占位符代替"],
  turningPoint: "转折",
  payoff: "本章兑现",
  chapterHook: "章末钩子",
  revealedSecretIds: ["本章揭示的秘密 ID，可为空"],
  revealedFactIds: ["本章揭示的事实 ID，可为空"],
  foreshadowingToPlant: ["伏笔 ID，可为空"],
  foreshadowingToPayOff: ["伏笔 ID，可为空"],
};

const OUTLINE_CONTRACT = {
  genre: "非空字符串", premise: "非空字符串", theme: "非空字符串", targetLength: "非空字符串",
  chapterOutlines: [OUTLINE_CHAPTER_CONTRACT],
};

const OUTLINE_BATCH_THRESHOLD = 24;

const STYLE_GUIDE_CONTRACT = {
  pointOfView: "非空字符串", tense: "非空字符串", tone: "非空字符串",
  proseStyle: "非空字符串", dialogueStyle: "非空字符串", pacing: "非空字符串",
  chapterOpening: "非空字符串", chapterEnding: "非空字符串",
  forbiddenPatterns: ["非空字符串；至少一项"],
};

const BASELINE_CONTRACT = {
  storyTime: "故事开始时的明确时间状态",
  characterLocations: { 角色ID: "地点 ID" },
  characterConditions: { 角色ID: "故事开始时身体或心理状态" },
  resources: { 角色ID: "故事开始时资源状态" },
  initialFacts: [{ factId: "稳定标识", statement: "开篇前已成立事实", category: "类别", visibility: "可见范围" }],
  initialKnowledge: [{ factId: "必须引用 Registry 中的事实 ID，且事实在故事开篇前已经成立", characterId: "开篇前已知该完整事实的角色 ID", knowledgeLevel: "heard|suspected|inferred|confirmed", sourceType: "observed|told|inferred|public|document", sourceCharacterId: "told 时为告知者角色 ID，否则为空字符串", evidence: "开篇前可追溯的获知依据" }],
};

const REVIEW_CONTRACT = {
  passed: "布尔值",
  score: "0-100 数字",
  summary: "非空字符串",
  issues: [{ target: "允许的 Foundation 节点 key", severity: "critical|major|minor", message: "具体矛盾或缺口" }],
  rewriteTargets: ["需要重写的节点 key；通过时为空数组"],
};

export function createFoundationEngine(
  dependencies: FoundationAgentDependencies,
  checkpoints: CheckpointStore,
  options: FoundationEngineOptions = {},
): GraphEngine {
  const nodes: GraphNode[] = [
    contractedNode(CHARTER_NODE, "创作总监", CREATIVE_CHARTER_CONTRACT, parseCreativeCharter, (state) => ({
      novelTitle: state.novelTitle, genre: state.creativeGenre, premise: state.creativePremise,
      theme: state.creativeTheme, notes: state.creativeNotes, targetTotalChapters: state.targetTotalChapters,
      targetTotalWords: state.targetTotalWords,
    }), (state, value) => { state.creativeCharter = value; }, dependencies, options.upgradeSource),
    contractedNode(WORLD_NODE, "世界设定架构师", WORLD_SETTING_CONTRACT, parseWorldSetting, (state) => ({
      creativeCharter: state.creativeCharter, notes: state.creativeNotes,
    }), (state, value) => { state.worldSetting = value; }, dependencies, options.upgradeSource),
    contractedNode(CHARACTER_NODE, "角色设计师", [CHARACTER_CONTRACT], parseCharacters, (state) => ({
      creativeCharter: state.creativeCharter, worldSetting: compactWorld(state),
    }), (state, value) => { state.characters = value; }, dependencies, options.upgradeSource, "JSON 数组"),
    contractedNode(RELATIONSHIP_NODE, "人物关系与秘密揭示调度师", RELATIONSHIP_CONTRACT, parseRelationshipMap, (state) => ({
      creativeCharter: state.creativeCharter, worldSetting: compactWorld(state), characters: compactCharacters(state),
    }), (state, value) => { state.relationshipMap = value; }, dependencies, options.upgradeSource),
    architectureNode(dependencies, options.upgradeSource),
    narrativeNode(dependencies, options.upgradeSource),
    outlineNode(dependencies, options.upgradeSource),
    contractedNode(STYLE_NODE, "文风与叙事规范设计师", STYLE_GUIDE_CONTRACT, parseStyleGuide, (state) => ({
      creativeCharter: state.creativeCharter, characters: compactCharacterVoices(state),
      storyArchitecture: state.storyArchitecture, outlineDigest: compactOutline(state.novelOutline),
    }), (state, value) => { state.styleGuide = value; }, dependencies, options.upgradeSource),
    contractedNode(BASELINE_NODE, "开篇连续性建档员", BASELINE_CONTRACT, (text, state) => (
      alignBaselineKnowledge(parseContinuityBaseline(text), state)
    ), (state) => ({
      ...baselinePlanningInput(state),
    }), (state, value) => { state.continuityBaseline = value; }, dependencies, options.upgradeSource),
    {
      key: VALIDATION_NODE,
      async run(context) {
        const validation = validateFoundationRegistry(context.state);
        if (!validation.passed) {
          context.state.foundationReviewAttempts += 1;
          if (context.state.foundationReviewAttempts > MAX_FOUNDATION_REVIEW_REWRITES) {
            return { status: "failed", error: `Foundation 确定性校验连续 ${context.state.foundationReviewAttempts} 次未通过：${validation.summary}` };
          }
        }
        return { status: "completed" };
      },
    },
    {
      key: REVIEW_NODE,
      async run(context) {
        const review = await runContractedNode(
          context,
          dependencies,
          REVIEW_NODE,
          `你是 Foundation 一致性审查员，不负责补写设定。只输出一个 JSON 对象。检查题材承诺、世界规则、角色动机、角色秘密与关系揭示计划、故事阶段、信息揭示、文风和开篇基线是否互相一致。planningMode 为 rolling 时，Foundation 只审批固定规模的全书路线图，逐章细节将在章节规划前结合最新 State 生成；不得因为不存在预生成的逐章细纲而报错，也不得要求补写全书逐章细纲。rolling 模式的 narrative_planning 与 outline_planning 都是从角色秘密、关系揭示计划和 story_architecture 确定性编译的派生文档；若其语义有问题，issue.target 必须指向 character_design、relationship_design 或 story_architecture，禁止把这两个派生节点作为重写目标。秘密正文归 character_design，秘密持有者和计划揭示章节归 relationship_design；短篇完整大纲模式的事实揭示时序及 knownInitiallyBy 归 narrative_planning，rolling 模式则派生自 relationship_design；开篇认知记录归 continuity_baseline。knownInitiallyBy 只能包含故事开篇前已经知道完整事实的角色。issue.target 必须指向真正拥有待修改字段的节点。${options.upgradeSource ? "这是旧项目升级；还必须逐项对照 legacyUpgradeReference，任何与已批准章节、既有设定、事实账本或角色认知冲突的内容都不得通过。" : ""}严格使用契约：${JSON.stringify(REVIEW_CONTRACT)}。target 只能取：${FOUNDATION_REWRITE_ORDER.join(",")}。通过时 issues 与 rewriteTargets 必须为空；未通过时指出最早产生问题的节点。`,
          JSON.stringify(foundationReviewInput(context.state, options.upgradeSource)),
          (text) => {
            const review = parseFoundationReview(text);
            if (context.state.novelOutline?.planningMode === "rolling"
              && review.rewriteTargets.some((target) => target === NARRATIVE_NODE || target === OUTLINE_NODE)) {
              throw new OutputContractError(
                "foundation_review.rewriteTargets",
                "rolling 节奏表与路线图是确定性派生文档；请把问题指向 character_design、relationship_design 或 story_architecture",
              );
            }
            return review;
          },
          { maxOutputTokens: 2_048, thinkingLevel: "off" },
        );
        context.state.foundationReview = review;
        context.state.foundationReviewAttempts += 1;
        if (!review.passed && context.state.foundationReviewAttempts > MAX_FOUNDATION_REVIEW_REWRITES) {
          return { status: "failed", error: `Foundation 一致性审查连续 ${context.state.foundationReviewAttempts} 次未通过：${review.summary}` };
        }
        return { status: "completed" };
      },
    },
    {
      key: GATE_NODE,
      async run(context) {
        if (context.state.foundationUpgrade?.source) context.state.foundationUpgrade.status = "awaiting_approval";
        return { status: "awaiting_gate", gate: "foundation" };
      },
    },
  ];

  return new GraphEngine(nodes, [
    edge(CHARTER_NODE, WORLD_NODE, "charter_ready"),
    edge(WORLD_NODE, CHARACTER_NODE, "world_ready"),
    edge(CHARACTER_NODE, RELATIONSHIP_NODE, "characters_ready"),
    edge(RELATIONSHIP_NODE, ARCHITECTURE_NODE, "relationships_ready"),
    edge(ARCHITECTURE_NODE, NARRATIVE_NODE, "architecture_ready"),
    edge(NARRATIVE_NODE, OUTLINE_NODE, "narrative_plan_ready"),
    edge(OUTLINE_NODE, STYLE_NODE, "outline_ready"),
    edge(STYLE_NODE, BASELINE_NODE, "style_ready"),
    edge(BASELINE_NODE, VALIDATION_NODE, "baseline_ready"),
    { from: VALIDATION_NODE, to: REVIEW_NODE, reason: "foundation_registry_valid", when: (_outcome, state) => state.foundationValidation?.passed === true },
    ...FOUNDATION_REWRITE_ORDER.map((target) => ({
      from: VALIDATION_NODE,
      to: target,
      reason: `foundation_validation_rewrite_${target}`,
      when: (_outcome: { status: string }, state: GraphNovelState) => validationStartsAt(state, target),
    })),
    { from: REVIEW_NODE, to: GATE_NODE, reason: "foundation_review_passed", when: (_outcome, state) => state.foundationReview?.passed === true },
    ...FOUNDATION_REWRITE_ORDER.map((target) => ({
      from: REVIEW_NODE,
      to: target,
      reason: `foundation_review_rewrite_${target}`,
      when: (_outcome: { status: string }, state: GraphNovelState) => reviewStartsAt(state, target),
    })),
  ], checkpoints);
}

export async function runFoundationGeneration(
  state: GraphNovelState,
  dependencies: FoundationAgentDependencies,
  checkpoints: CheckpointStore,
  sink?: GraphEventSink,
): Promise<GraphRunResult> {
  const startNode = foundationGenerationStartNode(state);
  const resumeOutline = startNode === OUTLINE_NODE;
  state.foundationReview = null;
  state.foundationReviewAttempts = 0;
  state.foundationValidation = null;
  state.foundationSnapshot = null;
  state.foundationOutlineProgress = resumeOutline ? state.foundationOutlineProgress : null;
  return createFoundationEngine(dependencies, checkpoints).run(state, startNode, sink);
}

function foundationGenerationStartNode(state: GraphNovelState): string {
  const failedNode = state.lastError?.nodeKey;
  const restartable = new Set<string>([...FOUNDATION_DOCUMENT_ORDER, VALIDATION_NODE, REVIEW_NODE]);
  const legacyOutlineResume = Boolean(
    (state.foundationOutlineProgress?.status === "failed" || state.foundationOutlineProgress?.status === "running")
      && state.foundationOutlineProgress.nextChapter <= state.targetTotalChapters,
  );
  if (legacyOutlineResume) return OUTLINE_NODE;
  if (!failedNode || !restartable.has(failedNode)) return CHARTER_NODE;
  const failedIndex = FOUNDATION_DOCUMENT_ORDER.indexOf(failedNode as FoundationRewriteTarget);
  const requiredThrough = failedIndex >= 0 ? failedIndex : FOUNDATION_DOCUMENT_ORDER.length;
  for (let index = 0; index < requiredThrough; index += 1) {
    const key = FOUNDATION_DOCUMENT_ORDER[index]!;
    if (!foundationDocumentAvailable(state, key) || state.foundationDocuments[key]?.status !== "current") return key;
  }
  return failedNode;
}

function foundationDocumentAvailable(state: GraphNovelState, key: FoundationRewriteTarget): boolean {
  if (key === CHARTER_NODE) return Boolean(state.creativeCharter);
  if (key === WORLD_NODE) return Boolean(state.worldSetting);
  if (key === CHARACTER_NODE) return state.characters.length > 0;
  if (key === RELATIONSHIP_NODE) return Boolean(state.relationshipMap);
  if (key === ARCHITECTURE_NODE) return Boolean(state.storyArchitecture);
  if (key === NARRATIVE_NODE) return Boolean(state.narrativePlan);
  if (key === OUTLINE_NODE) return Boolean(state.novelOutline);
  if (key === STYLE_NODE) return Boolean(state.styleGuide);
  return Boolean(state.continuityBaseline);
}

export function isLegacyFoundationProject(state: GraphNovelState): boolean {
  return state.foundationApproval === "approved"
    && Boolean(state.worldSetting && state.characters.length && state.novelOutline)
    && !state.creativeCharter && !state.relationshipMap && !state.storyArchitecture
    && !state.narrativePlan && !state.styleGuide && !state.continuityBaseline
    && !state.foundationSnapshot;
}

export function beginLegacyFoundationUpgrade(
  state: GraphNovelState,
  backupFile: string,
): void {
  if (!isLegacyFoundationProject(state)) {
    throw new Error("Only an approved legacy Foundation can be upgraded");
  }
  const source = captureLegacyFoundationSource(state);
  const now = new Date().toISOString();
  state.foundationUpgrade = {
    status: "running",
    startedAt: now,
    backupFile,
    sourceHash: hashValue(source),
    targetChapter: state.pendingChapterNumber ?? state.approvedChapters.length + 1,
    source,
  };
  state.foundationApproval = "pending";
  state.pendingGate = null;
  state.workflowPhase = "foundation";
  state.foundationReview = null;
  state.foundationReviewAttempts = 0;
  state.foundationRegistry = null;
  state.foundationDocuments = {};
  state.foundationValidation = null;
  state.foundationSnapshot = null;
  state.lastError = null;
  suspendUnapprovedChapterNodes(state);
  state.updatedAt = now;
}

export async function runFoundationUpgrade(
  state: GraphNovelState,
  dependencies: FoundationAgentDependencies,
  checkpoints: CheckpointStore,
  sink?: GraphEventSink,
  resumeInterrupted = false,
): Promise<GraphRunResult> {
  const upgrade = state.foundationUpgrade;
  if (!upgrade?.source) throw new Error("Legacy Foundation upgrade source is unavailable");
  if (hashValue(upgrade.source) !== upgrade.sourceHash) {
    throw new Error("Legacy Foundation upgrade source hash does not match");
  }
  if (!resumeInterrupted || upgrade.status === "failed") {
    state.foundationReview = null;
    state.foundationReviewAttempts = 0;
    state.foundationValidation = null;
    state.foundationSnapshot = null;
  }
  upgrade.status = "running";
  state.foundationApproval = "pending";
  state.pendingGate = null;
  state.workflowPhase = "foundation";
  suspendUnapprovedChapterNodes(state);
  await checkpoints.save(state);
  const startNode = resumeInterrupted ? foundationUpgradeResumeNode(state, upgrade.startedAt) : CHARTER_NODE;
  const result = await createFoundationEngine(dependencies, checkpoints, { upgradeSource: upgrade.source })
    .run(state, startNode, sink);
  upgrade.status = result.status === "awaiting_approval" ? "awaiting_approval"
    : result.status === "failed" ? "failed" : "running";
  await checkpoints.save(state);
  return result;
}

export async function decideFoundation(
  state: GraphNovelState,
  approved: boolean,
  checkpoints: CheckpointStore,
  feedback = "",
): Promise<void> {
  await checkpoints.withProjectLock(state.projectId, async () => {
    const upgradeTarget = state.foundationUpgrade?.targetChapter;
    applyFoundationDecision(state, approved, feedback);
    const normalizedFeedback = feedback.trim();
    const timestamp = new Date().toISOString();
    state.executionEvents.push({ type: "gate_decided", nodeKey: GATE_NODE, gate: "foundation", approved, feedback: normalizedFeedback, timestamp });
    state.executionEvents.push({
      type: "route_selected",
      source: GATE_NODE,
      target: approved && upgradeTarget ? `chapter_planning_${upgradeTarget}` : approved ? "chapter_loop" : CHARTER_NODE,
      reason: approved && upgradeTarget ? "foundation_upgrade_approved" : approved ? "foundation_approved" : "foundation_rejected_with_feedback",
      timestamp,
    });
    await checkpoints.save(state);
  });
}

export function applyFoundationDecision(state: GraphNovelState, approved: boolean, feedback = ""): void {
  if (state.pendingGate !== "foundation") throw new Error("Foundation is not waiting for approval");
  if (approved && !hasCompleteFoundation(state)) throw new Error("Cannot approve incomplete Foundation");
  if (!approved && !feedback.trim()) throw new Error("Rejected Foundation requires feedback");

  state.foundationApproval = approved ? "approved" : "rejected";
  state.foundationFeedback = feedback.trim();
  state.pendingGate = null;
  state.workflowPhase = approved ? "chapter_loop" : "foundation";
  if (approved) {
    if (state.foundationValidation?.passed && state.foundationReview?.passed) {
      state.foundationSnapshot = createFoundationSnapshot(state);
    }
    if (state.approvedChapters.length === 0) applyContinuityBaseline(state);
    if (state.foundationUpgrade?.source) completeLegacyFoundationUpgrade(state);
  } else if (state.foundationUpgrade?.source) {
    state.foundationUpgrade.status = "needs_revision";
  }
  const gate = state.nodes[GATE_NODE];
  if (gate) {
    gate.status = approved ? "completed" : "pending";
    gate.completedAt = approved ? new Date().toISOString() : undefined;
    state.nodes[GATE_NODE] = gate;
  }
  state.updatedAt = new Date().toISOString();
}

function contractedNode<T>(
  key: FoundationRewriteTarget,
  role: string,
  contract: unknown,
  parser: (text: string, state: GraphNovelState) => T,
  input: (state: GraphNovelState) => Record<string, unknown>,
  apply: (state: GraphNovelState, value: T) => void,
  dependencies: FoundationAgentDependencies,
  upgradeSource?: LegacyFoundationSource,
  outputKind = "JSON 对象",
): GraphNode {
  return {
    key,
    async run(context) {
      const nodeInput = {
        ...input(context.state),
        registryCatalog: registryCatalogFor(context.state, key),
        revision: revisionContext(context.state, key),
        ...(upgradeSource ? { legacyUpgradeReference: legacyReferenceForNode(upgradeSource, key) } : {}),
      };
      const value = await runContractedNode(
        context,
        dependencies,
        key,
        `你是${role}。只输出${outputKind}，不要 Markdown 代码围栏、解释或额外文字。所有契约字段都必须存在，禁止 null；除明确允许为空的数组或字符串外，内容必须具体且可执行。严格使用契约：${JSON.stringify(contract)}。这是有界结构化任务，务必简洁，禁止扩写契约外字段。registryCatalog 是唯一允许引用的 ID 白名单，不得自行创建引用 ID。不得违背已确定的上游文档。${upgradeSource ? "这是旧项目结构化升级。legacyUpgradeReference 是不可改写的既有正文与设定证据；只能补齐结构、稳定 ID 和缺失计划，禁止改变已经确立的世界事实、角色核心设定、章节标题、摘要和关键事件。" : ""}`,
        JSON.stringify(nodeInput),
        (text) => {
          const parsed = parser(text, context.state);
          if (!upgradeSource) return parsed;
          const preserved = preserveLegacyUpgradeValue(key, parsed, upgradeSource, context.state);
          assertLegacyUpgradeValue(key, preserved, upgradeSource);
          return preserved;
        },
        { maxOutputTokens: foundationOutputBudget(key), thinkingLevel: "off" },
      );
      apply(context.state, value);
      recordFoundationDocument(context.state, key, nodeInput, value);
      return { status: "completed" };
    },
  };
}

function architectureNode(
  dependencies: FoundationAgentDependencies,
  upgradeSource?: LegacyFoundationSource,
): GraphNode {
  if (upgradeSource) {
    return contractedNode(
      ARCHITECTURE_NODE,
      "长篇故事架构师",
      ARCHITECTURE_CONTRACT,
      (text, state) => parseStoryArchitecture(text, state.targetTotalChapters),
      architecturePlanningInput,
      (state, value) => { state.storyArchitecture = value; },
      dependencies,
      upgradeSource,
    );
  }
  return {
    key: ARCHITECTURE_NODE,
    async run(context) {
      const nodeInput = {
        ...architecturePlanningInput(context.state),
        registryCatalog: registryCatalogFor(context.state, ARCHITECTURE_NODE),
        revision: revisionContext(context.state, ARCHITECTURE_NODE),
      };
      const intent = await runContractedNode(
        context,
        dependencies,
        ARCHITECTURE_NODE,
        `你是长篇故事架构师。只输出 JSON，不要解释。你只负责固定规模的全书宏观阶段语义，不输出章节范围或人物里程碑；这些字段由 Graph 引擎确定性编译。全书阶段最多 8 个，所有字段严格遵守契约且保持简洁：${JSON.stringify(ARCHITECTURE_INTENT_CONTRACT)}`,
        JSON.stringify(nodeInput),
        parseStoryArchitectureIntent,
        { maxOutputTokens: 4_096, thinkingLevel: "off" },
      );
      const value = compileStoryArchitecture(intent, context.state);
      context.state.storyArchitecture = value;
      recordFoundationDocument(context.state, ARCHITECTURE_NODE, nodeInput, value);
      return { status: "completed" };
    },
  };
}

function narrativeNode(
  dependencies: FoundationAgentDependencies,
  upgradeSource?: LegacyFoundationSource,
): GraphNode {
  const generated = contractedNode(
    NARRATIVE_NODE,
    "节奏、伏笔与信息流设计师",
    NARRATIVE_PLAN_CONTRACT,
    (text, state) => parseNarrativePlan(text, state.targetTotalChapters),
    (state) => ({
      creativeCharter: state.creativeCharter,
      characters: state.characters,
      relationshipMap: state.relationshipMap,
      storyArchitecture: state.storyArchitecture,
      targetTotalChapters: state.targetTotalChapters,
    }),
    (state, value) => { state.narrativePlan = value; },
    dependencies,
    upgradeSource,
  );
  return {
    key: NARRATIVE_NODE,
    async run(context) {
      if (context.state.targetTotalChapters <= OUTLINE_BATCH_THRESHOLD) {
        return generated.run(context);
      }
      const nodeInput = {
        planningMode: "rolling",
        targetTotalChapters: context.state.targetTotalChapters,
        storyArchitecture: context.state.storyArchitecture,
        relationshipMap: context.state.relationshipMap,
      };
      const value = normalizeNarrativePlanIds(buildRollingNarrativePlan(context.state), context.state);
      context.state.narrativePlan = value;
      recordFoundationDocument(context.state, NARRATIVE_NODE, nodeInput, value);
      return { status: "completed" };
    },
  };
}

function outlineNode(
  dependencies: FoundationAgentDependencies,
  upgradeSource?: LegacyFoundationSource,
): GraphNode {
  return {
    key: OUTLINE_NODE,
    async run(context) {
      if (context.state.targetTotalChapters > OUTLINE_BATCH_THRESHOLD) {
        const nodeInput = {
          planningMode: "rolling",
          targetTotalChapters: context.state.targetTotalChapters,
          storyArchitecture: context.state.storyArchitecture,
          narrativePlan: context.state.narrativePlan,
        };
        const value = buildRollingNovelOutline(context.state);
        context.state.novelOutline = value;
        context.state.foundationOutlineProgress = null;
        recordFoundationDocument(context.state, OUTLINE_NODE, nodeInput, value);
        return { status: "completed" };
      }

      const nodeInput = {
        creativeCharter: context.state.creativeCharter,
        worldSetting: context.state.worldSetting,
        characters: context.state.characters,
        relationshipMap: context.state.relationshipMap,
        storyArchitecture: context.state.storyArchitecture,
        narrativePlan: context.state.narrativePlan,
        targetTotalChapters: context.state.targetTotalChapters,
        targetTotalWords: context.state.targetTotalWords,
        foundationRegistry: context.state.foundationRegistry,
        revision: revisionContext(context.state, OUTLINE_NODE),
        ...(upgradeSource ? { legacyUpgradeReference: legacyReferenceForNode(upgradeSource, OUTLINE_NODE) } : {}),
        outputContract: OUTLINE_CONTRACT,
      };
      const value = await runContractedNode(
        context,
        dependencies,
        OUTLINE_NODE,
        outlineSystemPrompt(OUTLINE_CONTRACT, upgradeSource),
        JSON.stringify(nodeInput),
        (text) => {
          const parsed = parseFoundationOutline(text, context.state);
          if (!upgradeSource) return parsed;
          const preserved = preserveLegacyUpgradeValue(OUTLINE_NODE, parsed, upgradeSource, context.state);
          assertLegacyOutline(preserved as NovelOutline, upgradeSource.novelOutline);
          return preserved;
        },
        { maxOutputTokens: foundationOutputBudget(OUTLINE_NODE), thinkingLevel: "off" },
      );
      context.state.novelOutline = value;
      context.state.foundationOutlineProgress = null;
      recordFoundationDocument(context.state, OUTLINE_NODE, nodeInput, value);
      return { status: "completed" };
    },
  };
}

function outlineSystemPrompt(contract: unknown, upgradeSource?: LegacyFoundationSource): string {
  return `你是全书章节大纲规划师。只输出 JSON，不要 Markdown、解释或额外文字。严格使用契约：${JSON.stringify(contract)}。所有章节必须遵守已确定的 Foundation 文档、角色 ID、地点 ID、规则 ID、伏笔和信息揭示计划。所有 *Id 字段只能逐字复制输入 foundationRegistry 中对应的 id，禁止根据名称推测、翻译、缩写或创造新 ID。章节大纲阶段禁止创建未登记的角色、地点、势力或规则；若确实需要新设定，必须返回失败并回到 Foundation 阶段处理。${upgradeSource ? "这是旧项目升级，不得改变已批准正文和既有章节关键事实。" : ""}`;
}

function compactOutline(outline: NovelOutline | null): unknown {
  if (!outline) return null;
  if (outline.planningMode === "rolling") {
    return {
      planningMode: outline.planningMode,
      targetLength: outline.targetLength,
      roadmapSegments: outline.roadmapSegments,
    };
  }
  return {
    genre: outline.genre,
    premise: outline.premise,
    theme: outline.theme,
    targetLength: outline.targetLength,
    chapterOutlines: outline.chapterOutlines.map((chapter) => ({
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      summary: chapter.summary,
      chapterGoal: chapter.chapterGoal,
      conflict: chapter.conflict,
      chapterHook: chapter.chapterHook,
      storyArcIds: chapter.storyArcIds,
    })),
  };
}

function reviewOutlineDigest(outline: NovelOutline | null): unknown {
  if (!outline) return null;
  if (outline.planningMode === "rolling") return compactOutline(outline);
  return {
    genre: outline.genre,
    premise: outline.premise,
    theme: outline.theme,
    targetLength: outline.targetLength,
    chapterOutlines: outline.chapterOutlines.map((chapter) => ({
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      summary: chapter.summary,
      povCharacterId: chapter.povCharacterId,
      involvedCharacterIds: chapter.involvedCharacterIds,
      locationIds: chapter.locationIds,
      factionIds: chapter.factionIds,
      requiredSystemIds: chapter.requiredSystemIds,
      requiredRuleIds: chapter.requiredRuleIds,
      storyArcIds: chapter.storyArcIds,
      chapterGoal: chapter.chapterGoal,
      conflict: chapter.conflict,
      causalPrerequisites: chapter.causalPrerequisites,
      keyEvents: chapter.keyEvents,
      turningPoint: chapter.turningPoint,
      payoff: chapter.payoff,
      chapterHook: chapter.chapterHook,
      revealedSecretIds: chapter.revealedSecretIds,
      revealedFactIds: chapter.revealedFactIds,
      foreshadowingToPlant: chapter.foreshadowingToPlant,
      foreshadowingToPayOff: chapter.foreshadowingToPayOff,
    })),
  };
}

function compactWorld(state: GraphNovelState) {
  const world = state.worldSetting;
  if (!world) return null;
  return {
    era: world.era,
    location: world.location,
    magicSystem: world.magicSystem,
    technologyLevel: world.technologyLevel,
    socialStructure: world.socialStructure,
    rulesAndLaws: world.rulesAndLaws,
    keyLocations: (world.keyLocations ?? []).map(({ locationId, name, roleInStory }) => ({ locationId, name, roleInStory })),
    factions: (world.factions ?? []).map(({ factionId, name, goal }) => ({ factionId, name, goal })),
    powerSystem: world.powerSystem ? {
      systemId: world.powerSystem.systemId,
      capabilities: world.powerSystem.capabilities,
      limitations: world.powerSystem.limitations,
      costs: world.powerSystem.costs,
    } : null,
    rules: (world.rules ?? []).map(({ ruleId, statement, consequence }) => ({ ruleId, statement, consequence })),
  };
}

function compactCharacters(state: GraphNovelState) {
  return state.characters.map((character) => ({
    characterId: character.characterId,
    name: character.name,
    role: character.role,
    personality: character.personality,
    motivation: character.motivation,
    arcDescription: character.arcDescription,
    secrets: character.secrets,
  }));
}

function compactCharacterVoices(state: GraphNovelState) {
  return state.characters.map(({ characterId, name, role, voice }) => ({ characterId, name, role, voice }));
}

function architecturePlanningInput(state: GraphNovelState) {
  return {
    creativeCharter: state.creativeCharter,
    worldSetting: compactWorld(state),
    characters: compactCharacters(state),
    relationshipMap: state.relationshipMap,
    targetTotalChapters: state.targetTotalChapters,
  };
}

function compileStoryArchitecture(intent: StoryArchitectureIntent, state: GraphNovelState): StoryArchitecture {
  const plannedArcs = intent.storyArcs.slice(0, Math.max(1, Math.min(intent.storyArcs.length, state.targetTotalChapters)));
  const totalWeight = plannedArcs.reduce((sum, arc) => sum + arc.weight, 0);
  let allocatedWeight = 0;
  let start = 1;
  const storyArcs = plannedArcs.map((arc, index) => {
    allocatedWeight += arc.weight;
    const end = index === plannedArcs.length - 1
      ? state.targetTotalChapters
      : Math.max(start, Math.min(
        state.targetTotalChapters - (plannedArcs.length - index - 1),
        Math.round((allocatedWeight / totalWeight) * state.targetTotalChapters),
      ));
    const compiled = {
      arcId: arc.arcId ?? `arc_${slugId(arc.name)}`,
      name: arc.name,
      chapterRange: `${start}-${end}`,
      objective: arc.objective,
      opposition: arc.opposition,
      turningPoint: arc.turningPoint,
      outcome: arc.outcome,
    };
    start = end + 1;
    return compiled;
  });
  const usedIds = new Set(registryCatalogFor(state, ARCHITECTURE_NODE).map((entry) => entry.id));
  storyArcs.forEach((arc, index) => { arc.arcId = uniqueArchitectureId(arc.arcId!, index, usedIds); usedIds.add(arc.arcId!); });
  return {
    centralConflict: intent.centralConflict,
    stakes: intent.stakes,
    endingDirection: intent.endingDirection,
    storyArcs,
    characterArcMilestones: state.characters.map((character) => ({
      characterId: character.characterId,
      startingState: character.personality,
      milestones: [character.arcDescription],
      endingState: `完成角色弧：${character.arcDescription}`,
    })),
  };
}

function slugId(value: string): string {
  const ascii = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return ascii || "stage";
}

function uniqueArchitectureId(requested: string, index: number, used: Set<string>): string {
  let candidate = requested;
  let suffix = index + 1;
  while (used.has(candidate)) candidate = `${requested}_${suffix++}`;
  return candidate;
}

function edge(from: string, to: string, reason: string) {
  return { from, to, reason, when: completed };
}

const FOUNDATION_REWRITE_ORDER: FoundationRewriteTarget[] = FOUNDATION_DOCUMENT_ORDER;

function reviewStartsAt(state: GraphNovelState, target: FoundationRewriteTarget): boolean {
  if (state.foundationReview?.passed !== false) return false;
  const earliest = FOUNDATION_REWRITE_ORDER.find((candidate) => state.foundationReview?.rewriteTargets.includes(candidate));
  return earliest === target;
}

function validationStartsAt(state: GraphNovelState, target: FoundationRewriteTarget): boolean {
  if (state.foundationValidation?.passed !== false) return false;
  const targets = new Set(state.foundationValidation.issues.map((item) => item.target));
  return FOUNDATION_REWRITE_ORDER.find((candidate) => targets.has(candidate)) === target;
}

function revisionContext(state: GraphNovelState, node: FoundationRewriteTarget) {
  return {
    humanFeedback: state.foundationFeedback,
    validationIssues: state.foundationValidation?.passed === false
      ? state.foundationValidation.issues.filter((issue) => issue.target === node)
      : [],
    reviewIssues: state.foundationReview?.issues.filter((issue) => issue.target === node) ?? [],
  };
}

function foundationOutputBudget(node: FoundationRewriteTarget): number {
  if (node === CHARTER_NODE || node === STYLE_NODE) return 2_048;
  if (node === WORLD_NODE || node === RELATIONSHIP_NODE || node === ARCHITECTURE_NODE) return 4_096;
  return 6_144;
}

function registryCatalogFor(state: GraphNovelState, node: FoundationRewriteTarget) {
  const nodeIndex = FOUNDATION_DOCUMENT_ORDER.indexOf(node);
  if (nodeIndex <= 0) return [];
  const allowedOwners = new Set(FOUNDATION_DOCUMENT_ORDER.slice(0, nodeIndex).filter((owner) => (
    state.foundationDocuments[owner]?.status === "current"
  )));
  return (state.foundationRegistry?.entries ?? [])
    .filter((entry) => allowedOwners.has(entry.owner))
    .map(({ id, kind, label }) => ({ id, kind, label }));
}

function foundationReviewInput(state: GraphNovelState, upgradeSource?: LegacyFoundationSource) {
  return {
    targetTotalChapters: state.targetTotalChapters,
    creativeCharter: state.creativeCharter,
    worldSetting: compactWorld(state),
    characters: compactCharacters(state),
    relationshipMap: state.relationshipMap,
    storyArchitecture: state.storyArchitecture,
    narrativePlan: state.narrativePlan,
    outlineDigest: reviewOutlineDigest(state.novelOutline),
    styleGuide: state.styleGuide,
    continuityBaseline: state.continuityBaseline,
    registryCatalog: (state.foundationRegistry?.entries ?? []).map(({ id, kind, label }) => ({ id, kind, label })),
    deterministicValidation: state.foundationValidation,
    ...(upgradeSource ? { legacyUpgradeReference: legacyReviewReference(upgradeSource) } : {}),
  };
}

function legacyReviewReference(source: LegacyFoundationSource) {
  const chapterSummary = (chapter: LegacyFoundationSource["approvedChapters"][number]) => ({
    chapterNumber: chapter.chapterNumber,
    title: clipText(chapter.title),
    summary: clipText(chapter.summary),
    endingExcerpt: clipText(chapter.endingExcerpt),
    unresolvedActions: chapter.unresolvedActions.slice(0, 8).map((item) => clipText(item)),
    openThreads: chapter.openThreads.slice(0, 8).map((item) => clipText(item)),
  });
  const approved = source.approvedChapters;
  return {
    world: {
      era: clipText(source.worldSetting.era),
      location: clipText(source.worldSetting.location),
      rulesAndLaws: clipText(source.worldSetting.rulesAndLaws),
    },
    characters: source.characters.slice(0, 24).map((character) => ({
      characterId: character.characterId,
      name: clipText(character.name),
      role: clipText(character.role),
      motivation: clipText(character.motivation),
      arcDescription: clipText(character.arcDescription),
    })),
    outline: {
      genre: clipText(source.novelOutline.genre),
      premise: clipText(source.novelOutline.premise),
      theme: clipText(source.novelOutline.theme),
      targetLength: clipText(source.novelOutline.targetLength),
      chapterCount: source.novelOutline.chapterOutlines.length,
    },
    approvedChapterCount: approved.length,
    approvedChapterSamples: uniqueByChapter([
      ...approved.slice(0, 2),
      ...approved.slice(-6),
    ]).map(chapterSummary),
    narrativeFactCount: source.narrativeFacts.length,
    latestFacts: source.narrativeFacts.slice(-32).map((fact) => ({
      factId: fact.factId,
      statement: clipText(fact.statement),
      establishedInChapter: fact.establishedInChapter,
    })),
  };
}

function clipText(value: string, maximum = 300): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}...`;
}

function uniqueByChapter<T extends { chapterNumber: number }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.chapterNumber, item])).values()];
}

function sampleByChapter<T extends { chapterNumber: number }>(items: T[]): T[] {
  return uniqueByChapter([...items.slice(0, 2), ...items.slice(-6)]);
}

function baselinePlanningInput(state: GraphNovelState) {
  const openingFacts = (state.narrativePlan?.revelationPlan ?? [])
    .filter((item) => item.knownInitiallyBy.length > 0 || item.earliestChapter <= 1)
    .map(({ factId, information, knownInitiallyBy, earliestChapter }) => ({ factId, information, knownInitiallyBy, earliestChapter }));
  return {
    worldSetting: compactWorld(state),
    characters: compactCharacters(state),
    relationshipSecrets: (state.relationshipMap?.secrets ?? []).map(({ secretId, holders, affectedCharacters, plannedRevealChapter }) => ({
      secretId, holders, affectedCharacters, plannedRevealChapter,
    })),
    openingFacts,
    openingRoadmap: (state.novelOutline?.roadmapSegments ?? []).slice(0, 1),
  };
}

function hasCompleteFoundation(state: GraphNovelState): boolean {
  const legacyComplete = Boolean(state.worldSetting && state.characters.length && state.novelOutline)
    && !state.creativeCharter && !state.relationshipMap && !state.storyArchitecture
    && !state.narrativePlan && !state.styleGuide && !state.continuityBaseline && !state.foundationReview;
  const enhancedComplete = Boolean(
    state.creativeCharter && state.worldSetting && state.characters.length && state.relationshipMap
    && state.storyArchitecture && state.narrativePlan && state.novelOutline && state.styleGuide
    && state.continuityBaseline && state.foundationRegistry && state.foundationValidation?.passed
    && state.foundationReview?.passed
    && FOUNDATION_DOCUMENT_ORDER.every((key) => state.foundationDocuments[key]?.status === "current"),
  );
  return legacyComplete || enhancedComplete;
}

function applyContinuityBaseline(state: GraphNovelState): void {
  const baseline = state.continuityBaseline;
  if (!baseline) return;
  const characterNames = new Map(state.characters.map((item) => [item.characterId, item.name]));
  const locationNames = new Map((state.worldSetting?.keyLocations ?? []).map((item) => [item.locationId, item.name]));
  const characterName = (id: string | undefined, fallback = "") => id ? characterNames.get(id) ?? id : fallback;
  const factIds = new Set(state.narrativeFacts.map((fact) => fact.factId));
  for (const fact of baseline.initialFacts) {
    if (!factIds.has(fact.factId)) {
      state.narrativeFacts.push({ ...fact, establishedInChapter: 0 });
      factIds.add(fact.factId);
    }
  }
  const knowledgeKeys = new Set(state.characterKnowledge.map((item) => `${item.factId}\u0000${item.character}`));
  for (const item of baseline.initialKnowledge) {
    const character = characterName(item.characterId, item.character);
    const sourceCharacter = characterName(item.sourceCharacterId, item.sourceCharacter);
    const key = `${item.factId}\u0000${character}`;
    if (!knowledgeKeys.has(key)) {
      state.characterKnowledge.push({
        factId: item.factId,
        character,
        knowledgeLevel: item.knowledgeLevel,
        learnedInChapter: 0,
        sourceType: item.sourceType,
        sourceCharacter,
        evidence: item.evidence,
      });
      knowledgeKeys.add(key);
    }
  }
  state.continuity.time ||= baseline.storyTime;
  const locations = Object.fromEntries(Object.entries(baseline.characterLocations).map(([characterId, locationId]) => [characterName(characterId), locationNames.get(locationId) ?? locationId]));
  const conditions = Object.fromEntries(Object.entries(baseline.characterConditions).map(([characterId, value]) => [characterName(characterId), value]));
  const resources = Object.fromEntries(Object.entries(baseline.resources).map(([characterId, value]) => [characterName(characterId), value]));
  state.continuity.characterLocations = { ...locations, ...state.continuity.characterLocations };
  state.continuity.characterConditions = { ...conditions, ...state.continuity.characterConditions };
  state.continuity.resources = { ...resources, ...state.continuity.resources };
  for (const character of state.characters) {
    if (!state.characterArcs[character.name]) state.characterArcs[character.name] = character.arcDescription;
  }
}

function captureLegacyFoundationSource(state: GraphNovelState): LegacyFoundationSource {
  const worldSetting = state.worldSetting;
  const novelOutline = state.novelOutline;
  if (!worldSetting || !novelOutline) throw new Error("Legacy Foundation source is incomplete");
  return {
    worldSetting: cloneValue(worldSetting),
    characters: cloneValue(state.characters),
    novelOutline: cloneValue(novelOutline),
    approvedChapters: state.approvedChapters.map((chapter) => {
      const { polishedDraft, ...metadata } = chapter;
      return { ...cloneValue(metadata), textSample: chapterTextSample(polishedDraft) };
    }),
    firstChapterPlan: cloneValue(state.chapterPlans["1"] ?? null),
    narrativeFacts: cloneValue(state.narrativeFacts),
    characterKnowledge: cloneValue(state.characterKnowledge),
    characterArcs: cloneValue(state.characterArcs),
    foreshadowings: cloneValue(state.foreshadowings),
    continuity: cloneValue(state.continuity),
  };
}

function foundationUpgradeResumeNode(state: GraphNovelState, startedAt: string): string {
  const graphOrder = [
    CHARTER_NODE, WORLD_NODE, CHARACTER_NODE, RELATIONSHIP_NODE, ARCHITECTURE_NODE,
    NARRATIVE_NODE, OUTLINE_NODE, STYLE_NODE, BASELINE_NODE, VALIDATION_NODE,
    REVIEW_NODE, GATE_NODE,
  ];
  const interrupted = graphOrder.find((key) => state.nodes[key]?.status === "in_progress");
  if (interrupted) return interrupted;
  if (state.lastError && state.lastError.timestamp >= startedAt && graphOrder.includes(state.lastError.nodeKey)) {
    return state.lastError.nodeKey;
  }
  const lastRoute = state.executionEvents
    .filter((event) => event.type === "route_selected" && event.timestamp >= startedAt
      && typeof event.target === "string" && graphOrder.includes(event.target))
    .at(-1);
  return lastRoute?.type === "route_selected" && lastRoute.target ? lastRoute.target : CHARTER_NODE;
}

function legacyReferenceForNode(source: LegacyFoundationSource, node: FoundationRewriteTarget): unknown {
  const chapterCanon = sampleByChapter(source.approvedChapters).map((chapter) => ({
    chapterNumber: chapter.chapterNumber,
    title: clipText(chapter.title),
    summary: clipText(chapter.summary),
    endingExcerpt: clipText(chapter.endingExcerpt),
    unresolvedActions: chapter.unresolvedActions.slice(0, 8).map(clipText),
    openThreads: chapter.openThreads.slice(0, 8).map(clipText),
  }));
  const outlineSummary = {
    genre: source.novelOutline.genre,
    premise: source.novelOutline.premise,
    theme: source.novelOutline.theme,
    targetLength: source.novelOutline.targetLength,
    planningMode: source.novelOutline.planningMode,
    chapterCount: source.novelOutline.chapterOutlines.length,
    chapterSamples: sampleByChapter(source.novelOutline.chapterOutlines).map((chapter) => ({
      chapterNumber: chapter.chapterNumber,
      title: clipText(chapter.title),
      summary: clipText(chapter.summary),
      keyEvents: chapter.keyEvents.slice(0, 8).map((item) => clipText(item)),
    })),
  };
  const approvedChapterCount = source.approvedChapters.length;
  if (node === CHARTER_NODE) return {
    worldSetting: source.worldSetting,
    characters: source.characters,
    novelOutline: outlineSummary,
    approvedChapterCount,
    approvedChapters: chapterCanon,
  };
  if (node === WORLD_NODE) return {
    worldSetting: source.worldSetting,
    novelOutline: outlineSummary,
    approvedChapterCount,
    approvedChapters: chapterCanon,
    narrativeFacts: source.narrativeFacts.slice(-64),
  };
  if (node === CHARACTER_NODE || node === RELATIONSHIP_NODE) return {
    characters: source.characters,
    ...(node === RELATIONSHIP_NODE ? { novelOutline: outlineSummary } : {}),
    approvedChapterCount,
    approvedChapters: chapterCanon,
    characterKnowledge: source.characterKnowledge.slice(-128),
    characterArcs: Object.fromEntries(Object.entries(source.characterArcs).slice(-24)),
  };
  if (node === ARCHITECTURE_NODE) return {
    novelOutline: outlineSummary,
    approvedChapterCount,
    approvedChapters: chapterCanon,
  };
  if (node === NARRATIVE_NODE) return {
    novelOutline: outlineSummary,
    approvedChapterCount,
    approvedChapters: chapterCanon,
    narrativeFacts: source.narrativeFacts.slice(-64),
    characterKnowledge: source.characterKnowledge.slice(-128),
    foreshadowings: source.foreshadowings.slice(-64),
  };
  if (node === OUTLINE_NODE) return {
    novelOutline: outlineSummary,
    approvedChapterCount,
    approvedChapters: chapterCanon,
    narrativeFacts: source.narrativeFacts.slice(-64),
  };
  if (node === STYLE_NODE) return {
    characters: source.characters,
    approvedChapterCount,
    chapterSamples: sampleByChapter(source.approvedChapters).map((chapter) => ({
      chapterNumber: chapter.chapterNumber,
      title: clipText(chapter.title),
      textSample: clipText(chapter.textSample, 600),
    })),
  };
  return {
    worldSetting: source.worldSetting,
    characters: source.characters,
    firstChapterPlan: source.firstChapterPlan,
    firstApprovedChapter: source.approvedChapters.find((chapter) => chapter.chapterNumber === 1) ?? null,
  };
}

function assertLegacyUpgradeValue(
  node: FoundationRewriteTarget,
  value: unknown,
  source: LegacyFoundationSource,
): void {
  if (node === WORLD_NODE) assertLegacyWorld(value as WorldSetting, source.worldSetting);
  if (node === CHARACTER_NODE) assertLegacyCharacters(value as Character[], source.characters);
  if (node === OUTLINE_NODE) assertLegacyOutline(value as NovelOutline, source.novelOutline);
}

function preserveLegacyUpgradeValue<T>(
  node: FoundationRewriteTarget,
  value: T,
  source: LegacyFoundationSource,
  state: GraphNovelState,
): T {
  if (node === WORLD_NODE) {
    const generated = value as WorldSetting;
    const legacy = source.worldSetting;
    return {
      ...generated,
      era: legacy.era,
      location: legacy.location,
      magicSystem: legacy.magicSystem,
      technologyLevel: legacy.technologyLevel,
      socialStructure: legacy.socialStructure,
      rulesAndLaws: legacy.rulesAndLaws,
      history: legacy.history,
    } as T;
  }

  if (node === CHARACTER_NODE) {
    const generated = value as Character[];
    if (generated.length !== source.characters.length) {
      throw new OutputContractError("characters", `升级必须保留原有 ${source.characters.length} 名角色，实际 ${generated.length} 名`);
    }
    return source.characters.map((legacy) => {
      const upgraded = generated.find((character) => character.name === legacy.name);
      if (!upgraded) throw new OutputContractError("characters", `升级结果缺少既有角色：${legacy.name}`);
      return {
        ...upgraded,
        name: legacy.name,
        role: legacy.role,
        background: legacy.background,
        personality: legacy.personality,
        motivation: legacy.motivation,
        arcDescription: legacy.arcDescription,
      };
    }) as T;
  }

  if (node === NARRATIVE_NODE) {
    const narrativePlan = normalizeNarrativePlanIds(value as NarrativePlan, state);
    return {
      ...narrativePlan,
      foreshadowingPlan: narrativePlan.foreshadowingPlan.map((plan) => ({
        ...plan,
        reinforceChapters: plan.reinforceChapters.filter((chapter) => (
          chapter > plan.plantChapter && chapter < plan.payoffChapter
        )),
      })),
    } as T;
  }

  if (node === OUTLINE_NODE) {
    const generated = value as NovelOutline;
    const legacy = source.novelOutline;
    if (generated.chapterOutlines.length !== legacy.chapterOutlines.length) {
      throw new OutputContractError("novel_outline.chapterOutlines", "升级不得改变既有章节数量");
    }
    const chapterOutlines = legacy.chapterOutlines.map((original) => {
      const upgraded = generated.chapterOutlines.find((chapter) => chapter.chapterNumber === original.chapterNumber);
      if (!upgraded) throw new OutputContractError("novel_outline.chapterOutlines", `缺少既有第 ${original.chapterNumber} 章`);
      return {
        ...upgraded,
        chapterNumber: original.chapterNumber,
        title: original.title,
        summary: original.summary,
        keyEvents: cloneValue(original.keyEvents),
      };
    });
    const preserved = {
      ...generated,
      genre: legacy.genre,
      premise: legacy.premise,
      theme: legacy.theme,
      targetLength: legacy.targetLength,
      chapterOutlines,
    };
    return alignUpgradeOutlineReferences(preserved, state) as T;
  }

  if (node === BASELINE_NODE) return alignUpgradeBaselineKnowledge(value as ContinuityBaseline, state) as T;

  return value;
}

function normalizeNarrativePlanIds(plan: NarrativePlan, state: GraphNovelState): NarrativePlan {
  const reservedIds = new Set<string>();
  for (const location of state.worldSetting?.keyLocations ?? []) reservedIds.add(location.locationId);
  for (const faction of state.worldSetting?.factions ?? []) reservedIds.add(faction.factionId);
  if (state.worldSetting?.powerSystem) reservedIds.add(state.worldSetting.powerSystem.systemId);
  for (const rule of state.worldSetting?.rules ?? []) reservedIds.add(rule.ruleId);
  for (const character of state.characters) {
    if (character.characterId) reservedIds.add(character.characterId);
    for (const secret of character.secrets ?? []) reservedIds.add(secret.secretId);
  }
  for (const arc of state.storyArchitecture?.storyArcs ?? []) {
    if (arc.arcId) reservedIds.add(arc.arcId);
  }

  const allocateId = (requested: string, fallbackPrefix: string, allocated: Set<string>): string => {
    if (!reservedIds.has(requested) && !allocated.has(requested)) return requested;
    const base = requested.startsWith(`${fallbackPrefix}_`) ? requested : `${fallbackPrefix}_${requested}`;
    let candidate = base;
    let suffix = 2;
    while (reservedIds.has(candidate) || allocated.has(candidate)) candidate = `${base}_${suffix++}`;
    return candidate;
  };

  const foreshadowingIds = new Set<string>();
  const foreshadowingPlan = plan.foreshadowingPlan.map((item) => {
    const id = allocateId(item.id, "foreshadow", foreshadowingIds);
    foreshadowingIds.add(id);
    return { ...item, id };
  });
  foreshadowingIds.forEach((id) => reservedIds.add(id));

  const factIds = new Set<string>();
  const revelationPlan = plan.revelationPlan.map((item) => {
    const factId = allocateId(item.factId, "fact", factIds);
    factIds.add(factId);
    return { ...item, factId };
  });
  return { ...plan, foreshadowingPlan, revelationPlan };
}

function alignUpgradeOutlineReferences(outline: NovelOutline, state: GraphNovelState): NovelOutline {
  const secretPlans = state.relationshipMap?.secrets ?? [];
  const revelationPlans = new Map((state.narrativePlan?.revelationPlan ?? []).map((item) => [item.factId, item]));
  const establishedFactIds = new Set(state.narrativeFacts.map((fact) => fact.factId));
  const foreshadowingPlans = state.narrativePlan?.foreshadowingPlan ?? [];
  return {
    ...outline,
    chapterOutlines: outline.chapterOutlines.map((chapter) => ({
      ...chapter,
      revealedSecretIds: secretPlans
        .filter((secret) => secret.plannedRevealChapter === chapter.chapterNumber)
        .map((secret) => secret.secretId),
      revealedFactIds: (chapter.revealedFactIds ?? []).filter((factId) => {
        if (establishedFactIds.has(factId)) return true;
        const plan = revelationPlans.get(factId);
        return Boolean(plan && chapter.chapterNumber >= plan.earliestChapter);
      }),
      foreshadowingToPlant: foreshadowingPlans
        .filter((plan) => plan.plantChapter === chapter.chapterNumber)
        .map((plan) => plan.id),
      foreshadowingToPayOff: foreshadowingPlans
        .filter((plan) => plan.payoffChapter === chapter.chapterNumber)
        .map((plan) => plan.id),
    })),
  };
}

function alignUpgradeBaselineKnowledge(
  baseline: ContinuityBaseline,
  state: GraphNovelState,
): ContinuityBaseline {
  const locationIds = new Set((state.worldSetting?.keyLocations ?? []).map((location) => location.locationId));
  const characterLocations = Object.fromEntries(
    Object.entries(baseline.characterLocations).filter(([, locationId]) => locationIds.has(locationId)),
  );
  return alignBaselineKnowledge({ ...baseline, characterLocations }, state);
}

function alignBaselineKnowledge(
  baseline: ContinuityBaseline,
  state: GraphNovelState,
): ContinuityBaseline {
  const characterIds = new Set(state.characters.flatMap((character) => character.characterId ? [character.characterId] : []));
  const locationIds = new Set((state.worldSetting?.keyLocations ?? []).map((location) => location.locationId));
  const plannedFactPlans = new Map((state.narrativePlan?.revelationPlan ?? []).map((plan) => [plan.factId, plan]));
  const plannedFacts = new Map([...plannedFactPlans].map(([factId, plan]) => [factId, plan.information]));
  const initialFacts = baseline.initialFacts.map((fact) => {
    const planned = plannedFacts.get(fact.factId);
    return {
      ...fact,
      statement: planned !== undefined && planned.trim() === fact.statement.trim() ? planned : fact.statement,
    };
  });
  const factIds = new Set([
    ...plannedFacts.keys(),
    ...initialFacts.map((fact) => fact.factId),
    ...state.narrativeFacts.map((fact) => fact.factId),
  ]);
  const characterLocations = Object.fromEntries(Object.entries(baseline.characterLocations).filter(
    ([characterId, locationId]) => characterIds.has(characterId) && locationIds.has(locationId),
  ));
  const characterConditions = Object.fromEntries(Object.entries(baseline.characterConditions).filter(
    ([characterId]) => characterIds.has(characterId),
  ));
  const resources = Object.fromEntries(Object.entries(baseline.resources).filter(
    ([characterId]) => characterIds.has(characterId),
  ));
  const initialKnowledge = cloneValue(baseline.initialKnowledge).filter((item) => (
    factIds.has(item.factId)
      && Boolean(item.characterId && characterIds.has(item.characterId))
      && (item.sourceType !== "told" || Boolean(item.sourceCharacterId && characterIds.has(item.sourceCharacterId)))
      && (!plannedFactPlans.has(item.factId) || plannedFactPlans.get(item.factId)!.knownInitiallyBy.includes(item.characterId!))
  ));
  const existing = new Set(initialKnowledge.map((item) => `${item.factId}\u0000${item.characterId ?? ""}`));
  for (const plan of state.narrativePlan?.revelationPlan ?? []) {
    for (const characterId of plan.knownInitiallyBy) {
      const key = `${plan.factId}\u0000${characterId}`;
      if (existing.has(key)) continue;
      initialKnowledge.push({
        factId: plan.factId,
        characterId,
        knowledgeLevel: "confirmed",
        sourceType: "inferred",
        sourceCharacterId: "",
        evidence: `开篇前既有认知：${plan.information}`,
      });
      existing.add(key);
    }
  }
  return {
    ...baseline,
    characterLocations,
    characterConditions,
    resources,
    initialFacts,
    initialKnowledge,
  };
}

function assertLegacyWorld(value: WorldSetting, legacy: WorldSetting): void {
  const fields: Array<keyof Pick<WorldSetting, "era" | "location" | "magicSystem" | "technologyLevel" | "socialStructure" | "rulesAndLaws" | "history">> = [
    "era", "location", "magicSystem", "technologyLevel", "socialStructure", "rulesAndLaws", "history",
  ];
  for (const field of fields) assertPreservedText(value[field], legacy[field], `world_setting.${field}`);
}

function assertLegacyCharacters(value: Character[], legacy: Character[]): void {
  if (value.length !== legacy.length) {
    throw new OutputContractError("characters", `升级必须保留原有 ${legacy.length} 名角色，实际 ${value.length} 名`);
  }
  for (const original of legacy) {
    const upgraded = value.find((character) => character.name === original.name);
    if (!upgraded) throw new OutputContractError("characters", `升级结果缺少既有角色：${original.name}`);
    for (const field of ["role", "background", "personality", "motivation", "arcDescription"] as const) {
      assertPreservedText(upgraded[field], original[field], `characters.${original.name}.${field}`);
    }
    if (original.secret?.trim() && !upgraded.secrets?.some((secret) => secret.content === original.secret)) {
      throw new OutputContractError(`characters.${original.name}.secrets`, "必须把旧 secret 原文迁移到唯一的 secrets[] 事实来源");
    }
  }
}

function assertLegacyOutline(value: NovelOutline, legacy: NovelOutline): void {
  for (const field of ["genre", "premise", "theme", "targetLength"] as const) {
    assertPreservedText(value[field], legacy[field], `novel_outline.${field}`);
  }
  if (value.chapterOutlines.length !== legacy.chapterOutlines.length) {
    throw new OutputContractError("novel_outline.chapterOutlines", "升级不得改变既有章节数量");
  }
  for (const original of legacy.chapterOutlines) {
    const upgraded = value.chapterOutlines.find((chapter) => chapter.chapterNumber === original.chapterNumber);
    if (!upgraded) throw new OutputContractError("novel_outline.chapterOutlines", `缺少既有第 ${original.chapterNumber} 章`);
    assertPreservedText(upgraded.title, original.title, `novel_outline.chapterOutlines[${original.chapterNumber}].title`);
    assertPreservedText(upgraded.summary, original.summary, `novel_outline.chapterOutlines[${original.chapterNumber}].summary`);
    if (JSON.stringify(upgraded.keyEvents) !== JSON.stringify(original.keyEvents)) {
      throw new OutputContractError(`novel_outline.chapterOutlines[${original.chapterNumber}].keyEvents`, "升级不得改写既有关键事件");
    }
  }
}

function assertPreservedText(actual: string, legacy: string, path: string): void {
  if (legacy.trim() && actual !== legacy) {
    throw new OutputContractError(path, "旧项目升级必须原样保留既有内容");
  }
}

function completeLegacyFoundationUpgrade(state: GraphNovelState): void {
  const upgrade = state.foundationUpgrade;
  if (!upgrade) return;
  const approvedNumbers = new Set(state.approvedChapters.map((chapter) => chapter.chapterNumber));
  for (const collection of [state.chapterPlans, state.chapterCandidates, state.chapterReviews, state.chapterRewriteAttempts]) {
    for (const key of Object.keys(collection)) {
      if (!approvedNumbers.has(Number(key))) delete collection[key];
    }
  }
  for (const key of Object.keys(state.nodes)) {
    const match = key.match(/_(\d+)$/);
    if (match && !approvedNumbers.has(Number(match[1]))) delete state.nodes[key];
  }
  state.pendingChapterNumber = null;
  state.chapterPlanApproval = "pending";
  state.globalReview = null;
  upgrade.status = "completed";
  upgrade.completedAt = new Date().toISOString();
  upgrade.source = null;
}

function suspendUnapprovedChapterNodes(state: GraphNovelState): void {
  const approvedNumbers = new Set(state.approvedChapters.map((chapter) => chapter.chapterNumber));
  for (const [key, record] of Object.entries(state.nodes)) {
    const match = key.match(/_(\d+)$/);
    if (!match || approvedNumbers.has(Number(match[1]))) continue;
    record.status = "pending";
    delete record.sessionId;
    delete record.startedAt;
    delete record.completedAt;
    delete record.error;
  }
}

function chapterTextSample(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= 2400) return normalized;
  return `${normalized.slice(0, 1200)}\n\n[中段省略]\n\n${normalized.slice(-1200)}`;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseFoundationOutline(text: string, state: GraphNovelState) {
  const outline = parseNovelOutline(text);
  const expected = state.targetTotalChapters;
  if (outline.chapterOutlines.length !== expected) {
    throw new OutputContractError("novel_outline.chapterOutlines", `期望 ${expected} 章，实际 ${outline.chapterOutlines.length} 章`);
  }
  outline.chapterOutlines.forEach((chapter, index) => {
    if (chapter.chapterNumber !== index + 1) {
      throw new OutputContractError(`novel_outline.chapterOutlines[${index}].chapterNumber`, `期望 ${index + 1}，实际 ${chapter.chapterNumber}`);
    }
  });
  return outline;
}

function completed(outcome: { status: string }): boolean {
  return outcome.status === "completed";
}
