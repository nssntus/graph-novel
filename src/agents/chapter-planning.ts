import type { Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { parseGeneratedChapterPlan } from "../contracts/chapter.js";
import { CheckpointStore } from "../checkpoint/store.js";
import { buildContinuityContext, directiveScopedContinuityContext } from "../state/continuity.js";
import { GraphEngine, type GraphNode, type GraphRunResult } from "../graph/engine.js";
import { PiAgentRuntime } from "../runtime/agent.js";
import { runContractedNode } from "../runtime/contracts.js";
import type { GraphEventSink } from "../runtime/types.js";
import type { GraphNovelState } from "../state/state.js";

export interface ChapterPlanningDependencies {
  runtime: PiAgentRuntime;
  model: Model<any>;
  streamFn: StreamFn;
}

export function chapterPlanningNodeKey(chapterNumber: number): string {
  return `chapter_planning_${chapterNumber}`;
}

export function chapterPlanGateKey(chapterNumber: number): string {
  return `chapter_plan:${chapterNumber}`;
}

const CHAPTER_PLAN_CONTRACT = {
  title: "非空字符串",
  openingBridge: {
    previousChapter: "非负整数；第1章为0，后续章节为直接前章号",
    inheritedEndpoint: "非空字符串，直接承接前章结尾状态",
    transitionSteps: ["非空字符串；至少一项，说明从前章结尾到本章首场景的过程"],
    firstSceneStart: "非空字符串",
    carryOverThreads: ["字符串；前章未决线索，没有则为空数组"],
  },
  causalChain: [{ cause: "非空字符串", event: "非空字符串", effect: "非空字符串" }],
  requiredFactIds: ["字符串；只能引用 continuityContext.facts 中已有事实；没有则为空数组"],
  plannedFacts: [{ factId: "非空字符串", statement: "非空字符串", category: "非空字符串", visibility: "非空字符串" }],
  informationFlow: [{
    factId: "已有事实或本章 plannedFacts 中的 factId",
    character: "非空字符串",
    knowledgeLevel: "heard|suspected|inferred|confirmed",
    sourceType: "observed|told|inferred|public|document",
    sourceCharacter: "字符串；sourceType 不是 told 时也必须提供空字符串，不得为 null",
    evidence: "非空字符串，说明角色如何获得信息；没有信息变化则为空数组",
  }],
};

export function createChapterPlanningEngine(
  chapterNumber: number,
  dependencies: ChapterPlanningDependencies,
  checkpoints: CheckpointStore,
): GraphEngine {
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
    throw new Error("chapterNumber must be a positive integer");
  }
  const planningNode = chapterPlanningNodeKey(chapterNumber);
  const gateNode = `human_approval_${planningNode}`;
  const nodes: GraphNode[] = [
    {
      key: planningNode,
      async run(context) {
        const continuityContext = buildContinuityContext(context.state, chapterNumber);
        const scopedContext = directiveScopedContinuityContext(continuityContext);
        const { characterKnowledge: _characterKnowledge, ...planningContext } = scopedContext;
        const knowledgeByFact = buildKnowledgeByFact(continuityContext);
        const plan = await runContractedNode(
          context,
          dependencies,
          planningNode,
          `你负责章节规划。只输出一个 JSON 对象，不要 Markdown 代码围栏、解释或额外文字。严格遵守以下完整输出契约：${JSON.stringify(CHAPTER_PLAN_CONTRACT)}。所有契约字段必须存在；除明确允许为空的数组和非 told 来源的 sourceCharacter 外，字符串均不得为空；禁止使用 null。chapterNumber、contextHash 和 foundationDirectiveHash 由引擎从输入注入，不要输出。若存在 chapterFoundationDirective，必须把它视为本章唯一有效的 Foundation 执行指令：逐项使用其中的角色、地点、势力、能力体系、世界规则、故事阶段、秘密/事实揭示、伏笔和文风要求。planningHorizon 是固定长度的近期路线图，只用于确保本章不会抢跑后续章节的转折、伏笔或揭示义务；不得提前兑现后续章节专属内容。knowledgeByFact 列出开章前每项事实的已有知情者及认知等级；sourceType 为 told 时，sourceCharacter 必须来自对应 factId 的列表且认知等级不能低于接收者，否则应使用有证据支持的 observed、inferred、public 或 document。规划必须把前章结尾、首场景和因果链连接起来，不得让角色获得来源不可追溯的信息。`,
          JSON.stringify({
            chapterNumber,
            continuityContext: planningContext,
            knowledgeByFact,
            feedback: context.state.chapterPlanFeedback,
            output: "ChapterPlan",
            outputContract: CHAPTER_PLAN_CONTRACT,
          }),
          (text) => parseGeneratedChapterPlan(text, chapterNumber, continuityContext),
        );
        context.state.chapterPlans[String(chapterNumber)] = plan;
        context.state.pendingChapterNumber = chapterNumber;
        context.state.chapterPlanApproval = "pending";
        return { status: "completed" };
      },
    },
    {
      key: gateNode,
      async run() {
        return { status: "awaiting_gate", gate: chapterPlanGateKey(chapterNumber) };
      },
    },
  ];
  return new GraphEngine(
    nodes,
    [{ from: planningNode, to: gateNode, reason: "chapter_plan_gate", when: completed }],
    checkpoints,
  );
}

export async function runChapterPlanning(
  state: GraphNovelState,
  chapterNumber: number,
  dependencies: ChapterPlanningDependencies,
  checkpoints: CheckpointStore,
  sink?: GraphEventSink,
): Promise<GraphRunResult> {
  return createChapterPlanningEngine(chapterNumber, dependencies, checkpoints)
    .run(state, chapterPlanningNodeKey(chapterNumber), sink);
}

export async function decideChapterPlan(
  state: GraphNovelState,
  chapterNumber: number,
  approved: boolean,
  checkpoints: CheckpointStore,
  feedback = "",
): Promise<void> {
  await checkpoints.withProjectLock(state.projectId, async () => {
    const gate = chapterPlanGateKey(chapterNumber);
    if (state.pendingGate !== gate) {
      throw new Error(`Chapter ${chapterNumber} is not waiting for plan approval`);
    }
    if (!state.chapterPlans[String(chapterNumber)]) {
      throw new Error("Cannot decide an incomplete chapter plan");
    }
    if (!approved && !feedback.trim()) {
      throw new Error("Rejected chapter plan requires feedback");
    }
    const normalizedFeedback = feedback.trim();
    state.chapterPlanApproval = approved ? "approved" : "rejected";
    state.chapterPlanFeedback = normalizedFeedback;
    state.pendingGate = null;
    state.workflowPhase = "chapter_loop";
    if (approved) state.pendingChapterNumber = null;
    const gateRecord = state.nodes[`human_approval_chapter_planning_${chapterNumber}`];
    if (gateRecord) {
      gateRecord.status = approved ? "completed" : "pending";
      gateRecord.completedAt = approved ? new Date().toISOString() : undefined;
      state.nodes[`human_approval_chapter_planning_${chapterNumber}`] = gateRecord;
    }
    const timestamp = new Date().toISOString();
    state.executionEvents.push({
      type: "gate_decided",
      nodeKey: `human_approval_chapter_planning_${chapterNumber}`,
      gate,
      approved,
      feedback: normalizedFeedback,
      timestamp,
    });
    state.executionEvents.push({
      type: "route_selected",
      source: gate,
      target: approved ? `chapter_writing_${chapterNumber}` : chapterPlanningNodeKey(chapterNumber),
      reason: approved ? "chapter_plan_approved" : "chapter_plan_rejected_with_feedback",
      timestamp,
    });
    state.updatedAt = timestamp;
    await checkpoints.save(state);
  });
}

function buildKnowledgeByFact(
  context: ReturnType<typeof buildContinuityContext>,
): Record<string, Array<{ character: string; knowledgeLevel: string }>> {
  const grouped = new Map<string, Map<string, string>>();
  for (const item of context.characterKnowledge) {
    const characters = grouped.get(item.factId) ?? new Map<string, string>();
    characters.set(item.character, item.knowledgeLevel);
    grouped.set(item.factId, characters);
  }
  return Object.fromEntries([...grouped].map(([factId, characters]) => [
    factId,
    [...characters].map(([character, knowledgeLevel]) => ({ character, knowledgeLevel })),
  ]));
}

function completed(outcome: { status: string }): boolean {
  return outcome.status === "completed";
}
