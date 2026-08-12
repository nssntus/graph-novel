import type { Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { parseChapterWritingOutput } from "../contracts/writing.js";
import { parseChapterReview } from "../contracts/review.js";
import { parseStylePolishOutput } from "../contracts/style.js";
import { CheckpointStore } from "../checkpoint/store.js";
import { buildContinuityContext, directiveScopedContinuityContext } from "../state/continuity.js";
import { GraphEngine, type GraphNode, type GraphRunResult } from "../graph/engine.js";
import { PiAgentRuntime } from "../runtime/agent.js";
import { runContractedNode } from "../runtime/contracts.js";
import type { GraphEventSink } from "../runtime/types.js";
import type { CandidateChapter } from "../state/chapter.js";
import type { GraphNovelState } from "../state/state.js";

export const MAX_CHAPTER_REWRITES = 2;

export interface ChapterWritingDependencies {
  runtime: PiAgentRuntime;
  model: Model<any>;
  streamFn: StreamFn;
}

export function chapterWritingNodeKey(chapterNumber: number): string {
  return `chapter_writing_${chapterNumber}`;
}

export function chapterWritingGateKey(chapterNumber: number): string {
  return `chapter_writing:${chapterNumber}`;
}

const CHAPTER_WRITING_CONTRACT = {
  contextHash: "非空字符串，必须原样等于 continuityContext.contextHash",
  foundationDirectiveHash: "增强 Foundation 项目必须原样等于 continuityContext.chapterFoundationDirective.directiveHash；旧项目可省略",
  chapterNumber: "正整数，必须等于目标章节号",
  title: "非空字符串",
  draft: "非空字符串，完整章节正文",
  chapterHook: "非空字符串",
  chapterSummary: "非空字符串",
  endingExcerpt: "非空字符串",
  lastScene: {
    time: "非空字符串",
    location: "非空字符串",
    povCharacter: "非空字符串",
    charactersPresent: ["非空字符串；至少一项"],
    finalAction: "非空字符串",
    finalDialogue: "字符串；无对白时为空字符串",
  },
  unresolvedActions: ["非空字符串；没有则为空数组"],
  openThreads: ["非空字符串；没有则为空数组"],
  factsEstablished: [{ factId: "必须与 plan.plannedFacts 完全一致", statement: "必须与规划一致", category: "非空字符串", visibility: "非空字符串" }],
  knowledgeChanges: [{
    factId: "必须与 plan.informationFlow 完全一致",
    character: "非空字符串",
    knowledgeLevel: "heard|suspected|inferred|confirmed",
    sourceType: "observed|told|inferred|public|document",
    sourceCharacter: "字符串；必须提供，不能为 null",
    evidence: "非空字符串",
  }],
  continuityChanges: {
    time: "非空字符串",
    characterLocations: { character: "非空字符串" },
    characterConditions: { character: "非空字符串" },
    resources: { resource: "非空字符串" },
  },
};

const CHAPTER_REVIEW_CONTRACT = {
  contextHash: "非空字符串，必须原样等于 continuityContext.contextHash",
  foundationDirectiveHash: "增强 Foundation 项目必须原样等于 continuityContext.chapterFoundationDirective.directiveHash；旧项目可省略",
  chapterNumber: "正整数，必须等于目标章节号",
  score: "1 到 10 的整数",
  requiresRewrite: "布尔值",
  rewriteScope: "字符串；requiresRewrite 为 true 时必须非空，否则可为空字符串",
  issues: ["非空字符串；没有问题则为空数组"],
  narrativeViolations: ["非空字符串；没有违反则为空数组"],
  foundationViolations: ["违反本章 Foundation 指令的具体问题；没有则为空数组"],
  summary: "非空字符串",
};

const STYLE_POLISH_CONTRACT = {
  contextHash: "非空字符串，必须原样等于 continuityContext.contextHash",
  foundationDirectiveHash: "增强 Foundation 项目必须原样等于 continuityContext.chapterFoundationDirective.directiveHash；旧项目可省略",
  chapterNumber: "正整数，必须等于目标章节号",
  polishedDraft: "非空字符串，只改善表达，不改变事件、事实、认知和结尾状态",
  factIds: ["必须与 protectedFactIds 完全一致，不能新增、删除或重复"],
  knowledgeSignatures: ["必须与 protectedKnowledgeSignatures 完全一致，不能新增、删除或重复"],
};

export function createChapterWritingEngine(
  chapterNumber: number,
  dependencies: ChapterWritingDependencies,
  checkpoints: CheckpointStore,
): GraphEngine {
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
    throw new Error("chapterNumber must be a positive integer");
  }
  const writingNode = chapterWritingNodeKey(chapterNumber);
  const reviewNode = `consistency_review_${chapterNumber}`;
  const gateNode = `human_approval_${writingNode}`;
  const nodes: GraphNode[] = [
    {
      key: writingNode,
      async run(context) {
        const plan = context.state.chapterPlans[String(chapterNumber)];
        if (!plan || context.state.chapterPlanApproval !== "approved") {
          return { status: "failed", error: "Chapter plan must be approved before writing" };
        }
        const continuityContext = buildContinuityContext(context.state, chapterNumber);
        const writingContext = directiveScopedContinuityContext(continuityContext);
        if (plan.contextHash !== continuityContext.contextHash) {
          return { status: "failed", error: "Chapter plan context no longer matches current continuity state" };
        }
        const output = await runContractedNode(
          context,
          dependencies,
          writingNode,
          `你负责章节写作。只输出一个 JSON 对象，不要 Markdown 代码围栏、解释或额外文字。严格遵守以下完整输出契约：${JSON.stringify(CHAPTER_WRITING_CONTRACT)}。除旧项目允许省略 foundationDirectiveHash 外，所有字段必须存在，禁止 null；factsEstablished 必须与 plan.plannedFacts 完全对应，knowledgeChanges 必须与 plan.informationFlow 完全对应，不得添加计划外事实或角色认知变化。若存在 chapterFoundationDirective，正文必须落实其中裁剪后的角色、地点、势力、能力体系、世界规则、故事阶段、秘密/事实揭示和伏笔要求，同时遵守创作章程与文风规范，并原样复制 directiveHash。contextHash 必须原样复制 continuityContext.contextHash。`,
          JSON.stringify({
            chapterNumber,
            plan,
            continuityContext: writingContext,
            feedback: context.state.chapterWritingFeedback[String(chapterNumber)] ?? "",
            output: "ChapterWritingOutput",
            outputContract: CHAPTER_WRITING_CONTRACT,
          }),
          (text) => parseChapterWritingOutput(text, chapterNumber, continuityContext, plan),
        );
        const key = String(chapterNumber);
        const previous = context.state.chapterCandidates[key];
        const revision = (previous?.revision ?? 0) + 1;
        const revisionHistory = previous
          ? [
              ...previous.revisionHistory,
              {
                revision: previous.revision,
                contextHash: previous.contextHash,
                draft: previous.draft,
                polishedDraft: previous.polishedDraft,
                feedback: previous.humanFeedback,
                recordedAt: new Date().toISOString(),
              },
            ]
          : [];
        const candidate: CandidateChapter = {
          chapterNumber: output.chapterNumber,
          title: output.title,
          contextHash: output.contextHash,
          ...(output.foundationDirectiveHash ? { foundationDirectiveHash: output.foundationDirectiveHash } : {}),
          draft: output.draft,
          polishedDraft: output.draft,
          chapterHook: output.chapterHook,
          chapterSummary: output.chapterSummary,
          endingExcerpt: output.endingExcerpt,
          lastScene: output.lastScene,
          unresolvedActions: output.unresolvedActions,
          openThreads: output.openThreads,
          delta: {
            factsEstablished: output.factsEstablished.map((fact) => ({
              ...fact,
              establishedInChapter: chapterNumber,
            })),
            knowledgeChanges: output.knowledgeChanges.map((item) => ({
              ...item,
              learnedInChapter: chapterNumber,
            })),
            continuityChanges: output.continuityChanges,
          },
          revision,
          approved: false,
          humanFeedback: context.state.chapterWritingFeedback[key] ?? "",
          revisionHistory,
        };
        context.state.chapterCandidates[key] = candidate;
        context.state.pendingChapterNumber = chapterNumber;
        return { status: "completed" };
      },
    },
    {
      key: reviewNode,
      async run(context) {
        const candidate = context.state.chapterCandidates[String(chapterNumber)];
        if (!candidate) return { status: "failed", error: "Cannot review missing chapter candidate" };
        const continuityContext = buildContinuityContext(context.state, chapterNumber);
        if (candidate.contextHash !== continuityContext.contextHash) {
          return { status: "failed", error: "Chapter candidate context no longer matches current continuity state" };
        }
        const review = await runContractedNode(
          context,
          dependencies,
          reviewNode,
          `你负责章节一致性审查。只输出一个 JSON 对象，不要 Markdown 代码围栏、解释或额外文字。严格遵守以下完整输出契约：${JSON.stringify(CHAPTER_REVIEW_CONTRACT)}。必须核对前章承接、因果链、事实来源、角色认知和连续性。若存在 chapterFoundationDirective，还必须逐项核对题材承诺、角色行为与声音、地点、势力、能力边界、世界规则、故事阶段、秘密/事实揭示、伏笔和文风；任何违反写入 foundationViolations 并要求重写。原样复制 directiveHash；requiresRewrite 为 true 时 rewriteScope 必须具体。`,
          JSON.stringify({
            chapterNumber,
            continuityContext,
            candidate,
            output: "ChapterReviewOutput",
            outputContract: CHAPTER_REVIEW_CONTRACT,
          }),
          (text) => parseChapterReview(text, chapterNumber, continuityContext),
        );
        const key = String(chapterNumber);
        context.state.chapterReviews[key] = review;
        if (review.requiresRewrite) {
          const attempts = (context.state.chapterRewriteAttempts[key] ?? 0) + 1;
          context.state.chapterRewriteAttempts[key] = attempts;
          context.state.chapterWritingFeedback[key] = review.rewriteScope;
          if (attempts > MAX_CHAPTER_REWRITES) {
            return { status: "failed", error: `Chapter rewrite limit exceeded (${MAX_CHAPTER_REWRITES})` };
          }
        }
        return { status: "completed" };
      },
    },
    {
      key: `style_polish_${chapterNumber}`,
      async run(context) {
        const candidate = context.state.chapterCandidates[String(chapterNumber)];
        if (!candidate) return { status: "failed", error: "Cannot polish missing chapter candidate" };
        const continuityContext = buildContinuityContext(context.state, chapterNumber);
        const polishContext = directiveScopedContinuityContext(continuityContext);
        if (candidate.contextHash !== continuityContext.contextHash) {
          return { status: "failed", error: "Chapter candidate context no longer matches current continuity state" };
        }
        const expectedFactIds = candidate.delta.factsEstablished.map((fact) => fact.factId);
        const expectedKnowledgeSignatures = candidate.delta.knowledgeChanges.map(knowledgeSignature);
        const output = await runContractedNode(
          context,
          dependencies,
          `style_polish_${chapterNumber}`,
          `你负责章节文字润色。只输出一个 JSON 对象，不要 Markdown 代码围栏、解释或额外文字。严格遵守以下完整输出契约：${JSON.stringify(STYLE_POLISH_CONTRACT)}。只改善表达、节奏和可读性；若存在 chapterFoundationDirective，必须应用其中的全局文风规范和相关角色 voice，但不得新增、删除或改写任何事实、秘密揭示、伏笔、角色认知、事件顺序和结尾状态。原样复制 directiveHash；factIds 与 knowledgeSignatures 必须逐项复制保护列表。`,
          JSON.stringify({
            chapterNumber,
            continuityContext: polishContext,
            candidate,
            protectedFactIds: expectedFactIds,
            protectedKnowledgeSignatures: expectedKnowledgeSignatures,
            output: "StylePolishOutput",
            outputContract: STYLE_POLISH_CONTRACT,
          }),
          (text) => parseStylePolishOutput(
            text,
            chapterNumber,
            continuityContext,
            expectedFactIds,
            expectedKnowledgeSignatures,
          ),
        );
        candidate.polishedDraft = output.polishedDraft;
        return { status: "completed" };
      },
    },
    {
      key: gateNode,
      async run() {
        return { status: "awaiting_gate", gate: chapterWritingGateKey(chapterNumber) };
      },
    },
  ];
  return new GraphEngine(
    nodes,
    [
      { from: writingNode, to: reviewNode, reason: "chapter_review", when: completed },
      { from: reviewNode, to: writingNode, reason: "chapter_rewrite", when: (_outcome, state) => shouldRewrite(state, chapterNumber) },
      { from: reviewNode, to: `style_polish_${chapterNumber}`, reason: "style_polish", when: (_outcome, state) => !shouldRewrite(state, chapterNumber) },
      { from: `style_polish_${chapterNumber}`, to: gateNode, reason: "chapter_gate", when: completed },
    ],
    checkpoints,
  );
}

export async function runChapterWriting(
  state: GraphNovelState,
  chapterNumber: number,
  dependencies: ChapterWritingDependencies,
  checkpoints: CheckpointStore,
  sink?: GraphEventSink,
): Promise<GraphRunResult> {
  return createChapterWritingEngine(chapterNumber, dependencies, checkpoints)
    .run(state, chapterWritingResumeNode(state, chapterNumber), sink);
}

function chapterWritingResumeNode(state: GraphNovelState, chapterNumber: number): string {
  const key = String(chapterNumber);
  const writingNode = chapterWritingNodeKey(chapterNumber);
  const reviewNode = `consistency_review_${chapterNumber}`;
  const polishNode = `style_polish_${chapterNumber}`;
  const gateNode = `human_approval_${writingNode}`;
  if (state.nodes[gateNode]?.status === "pending" && state.chapterWritingFeedback[key]?.trim()) {
    return writingNode;
  }
  const interrupted = [writingNode, reviewNode, polishNode, gateNode]
    .find((nodeKey) => ["in_progress", "failed"].includes(state.nodes[nodeKey]?.status ?? ""));
  if (interrupted) return interrupted;
  if (state.nodes[polishNode]?.status === "completed") return gateNode;
  if (state.nodes[reviewNode]?.status === "completed" && state.chapterReviews[key]) {
    return state.chapterReviews[key].requiresRewrite ? writingNode : polishNode;
  }
  if (state.nodes[writingNode]?.status === "completed" && state.chapterCandidates[key]) return reviewNode;
  return writingNode;
}

export async function decideChapterWriting(
  state: GraphNovelState,
  chapterNumber: number,
  approved: boolean,
  checkpoints: CheckpointStore,
  feedback = "",
): Promise<void> {
  await checkpoints.withProjectLock(state.projectId, async () => {
    const gate = chapterWritingGateKey(chapterNumber);
    const key = String(chapterNumber);
    const candidate = state.chapterCandidates[key];
    if (state.pendingGate !== gate) {
      throw new Error(`Chapter ${chapterNumber} is not waiting for writing approval`);
    }
    if (!candidate) throw new Error("Cannot decide an incomplete chapter candidate");
    if (!state.chapterReviews[key] || state.chapterReviews[key].requiresRewrite) {
      throw new Error("Chapter candidate must pass consistency review before approval");
    }
    if (!approved && !feedback.trim()) throw new Error("Rejected chapter writing requires feedback");
    const normalizedFeedback = feedback.trim();
    if (approved) commitCandidate(state, candidate);
    candidate.approved = approved;
    candidate.humanFeedback = normalizedFeedback;
    state.chapterWritingFeedback[key] = normalizedFeedback;
    state.pendingGate = null;
    state.pendingChapterNumber = null;
    state.workflowPhase = "chapter_loop";
    const gateNode = `human_approval_chapter_writing_${chapterNumber}`;
    const gateRecord = state.nodes[gateNode];
    if (gateRecord) {
      gateRecord.status = approved ? "completed" : "pending";
      gateRecord.completedAt = approved ? new Date().toISOString() : undefined;
      state.nodes[gateNode] = gateRecord;
    }
    const timestamp = new Date().toISOString();
    state.executionEvents.push({
      type: "gate_decided",
      nodeKey: gateNode,
      gate,
      approved,
      feedback: normalizedFeedback,
      timestamp,
    });
    state.executionEvents.push({
      type: "route_selected",
      source: gate,
      target: approved ? nextChapterTarget(state, chapterNumber) : chapterWritingNodeKey(chapterNumber),
      reason: approved ? "chapter_writing_approved" : "chapter_writing_rejected_with_feedback",
      timestamp,
    });
    state.updatedAt = timestamp;
    await checkpoints.save(state);
  });
}

/** Reopen a chapter after an exhausted review budget without discarding its history. */
export async function reopenChapterWriting(
  state: GraphNovelState,
  chapterNumber: number,
  checkpoints: CheckpointStore,
  feedback: string,
): Promise<void> {
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
    throw new Error("chapterNumber must be a positive integer");
  }
  const normalizedFeedback = feedback.trim();
  if (!normalizedFeedback) throw new Error("人工修订后重新审查必须填写修订说明");
  await checkpoints.withProjectLock(state.projectId, async () => {
    const key = String(chapterNumber);
    const reviewNode = `consistency_review_${chapterNumber}`;
    const writingNode = chapterWritingNodeKey(chapterNumber);
    const candidate = state.chapterCandidates[key];
    const review = state.chapterReviews[key];
    const reviewRecord = state.nodes[reviewNode];
    if (!candidate || !review) throw new Error(`第${chapterNumber}章没有可恢复的候选稿或审稿记录`);
    if (!review.requiresRewrite) throw new Error(`第${chapterNumber}章当前不需要重写`);
    if (state.workflowPhase !== "failed" || state.lastError?.nodeKey !== reviewNode) {
      throw new Error(`第${chapterNumber}章当前不是重写上限失败状态`);
    }
    if (!reviewRecord || reviewRecord.status !== "failed") {
      throw new Error(`第${chapterNumber}章审稿节点没有失败记录`);
    }

    state.chapterRewriteAttempts[key] = 0;
    state.chapterWritingFeedback[key] = normalizedFeedback;
    candidate.humanFeedback = normalizedFeedback;
    reviewRecord.status = "pending";
    reviewRecord.error = undefined;
    state.nodes[reviewNode] = reviewRecord;
    const writingRecord = state.nodes[writingNode];
    if (writingRecord) {
      writingRecord.error = undefined;
      state.nodes[writingNode] = writingRecord;
    }
    state.lastError = null;
    state.pendingGate = null;
    state.pendingChapterNumber = chapterNumber;
    state.workflowPhase = "chapter_loop";
    const timestamp = new Date().toISOString();
    state.executionEvents.push({
      type: "route_selected",
      source: reviewNode,
      target: reviewNode,
      reason: "chapter_reopened_after_manual_revision",
      timestamp,
    });
    state.updatedAt = timestamp;
    await checkpoints.save(state);
  });
}

function commitCandidate(state: GraphNovelState, candidate: CandidateChapter): void {
  const existingFacts = new Map(state.narrativeFacts.map((fact) => [fact.factId, fact]));
  for (const fact of candidate.delta.factsEstablished) {
    const existing = existingFacts.get(fact.factId);
    if (existing) {
      if (existing.statement !== fact.statement) throw new Error(`Fact conflict: ${fact.factId}`);
      continue;
    }
    state.narrativeFacts.push({ ...fact });
    existingFacts.set(fact.factId, fact);
  }

  const existingKnowledge = new Set(
    state.characterKnowledge.map((item) => `${item.factId}\u0000${item.character}\u0000${item.knowledgeLevel}\u0000${item.learnedInChapter}`),
  );
  for (const item of candidate.delta.knowledgeChanges) {
    const signature = `${item.factId}\u0000${item.character}\u0000${item.knowledgeLevel}\u0000${item.learnedInChapter}`;
    if (existingKnowledge.has(signature)) continue;
    state.characterKnowledge.push({ ...item });
    existingKnowledge.add(signature);
  }

  const changes = candidate.delta.continuityChanges;
  if (changes.time) state.continuity.time = changes.time;
  for (const field of ["characterLocations", "characterConditions", "resources"] as const) {
    Object.assign(state.continuity[field], changes[field]);
  }
  const existingChapter = state.approvedChapters.findIndex((chapter) => chapter.chapterNumber === candidate.chapterNumber);
  const approvedChapter = {
    chapterNumber: candidate.chapterNumber,
    title: candidate.title,
    summary: candidate.chapterSummary,
    polishedDraft: candidate.polishedDraft,
    endingExcerpt: candidate.endingExcerpt,
    lastScene: candidate.lastScene,
    unresolvedActions: [...candidate.unresolvedActions],
    openThreads: [...candidate.openThreads],
  };
  if (existingChapter >= 0) state.approvedChapters[existingChapter] = approvedChapter;
  else state.approvedChapters.push(approvedChapter);
  state.approvedChapters.sort((left, right) => left.chapterNumber - right.chapterNumber);
}

function nextChapterTarget(state: GraphNovelState, chapterNumber: number): string {
  return state.targetTotalChapters > chapterNumber
    ? `chapter_planning_${chapterNumber + 1}`
    : "global_review";
}

function completed(outcome: { status: string }): boolean {
  return outcome.status === "completed";
}

function shouldRewrite(state: GraphNovelState, chapterNumber: number): boolean {
  return state.chapterReviews[String(chapterNumber)]?.requiresRewrite === true;
}

function knowledgeSignature(
  item: CandidateChapter["delta"]["knowledgeChanges"][number],
): string {
  return [item.factId, item.character, item.knowledgeLevel, item.sourceType, item.sourceCharacter].join("\u0000");
}
