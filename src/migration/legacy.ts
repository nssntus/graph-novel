import { basename, dirname, extname } from "node:path";
import { buildContinuityContext } from "../state/continuity.js";
import { createInitialState, type ExecutionEvent, type GraphNovelState } from "../state/state.js";
import type { ChapterPlan, InformationFlow, PlannedFact } from "../contracts/chapter.js";
import type { CandidateChapter, ChapterReview } from "../state/chapter.js";

export type MigrationIssueSeverity = "warning" | "review";

export interface MigrationIssue {
  severity: MigrationIssueSeverity;
  path: string;
  message: string;
}

export interface MigrationReport {
  sourcePath: string;
  sourceVersion: number;
  projectId: string;
  status: "ready" | "requires_review";
  issues: MigrationIssue[];
  counts: {
    legacyChapters: number;
    approvedChapters: number;
    candidateChapters: number;
    narrativeFacts: number;
    characterKnowledge: number;
  };
}

export interface MigrationResult {
  state: GraphNovelState;
  report: MigrationReport;
}

export class MigrationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "MigrationError";
    this.path = path;
  }
}

type RecordValue = Record<string, unknown>;

const LEGACY_VERSIONS = new Set([1, 2, 3, 4, 5, 6, 7, 8]);

export function migrateLegacyState(input: unknown, sourcePath = "<memory>"): MigrationResult {
  const raw = asRecord(input, "state");
  const issues: MigrationIssue[] = [];
  const sourceVersion = readSourceVersion(raw, issues);
  if (!LEGACY_VERSIONS.has(sourceVersion)) {
    throw new MigrationError("state.version", `只支持旧 State v1-v8，实际为 ${sourceVersion}`);
  }

  const projectId = projectIdFrom(raw, sourcePath, issues);
  const novelTitle = requiredText(raw.novel_title, "state.novel_title", issues);
  const createdAt = text(raw.created_at, new Date(0).toISOString());
  const state = createInitialState(projectId, novelTitle, createdAt);
  state.creativeGenre = text(raw.creative_genre);
  state.creativePremise = text(raw.creative_premise);
  state.creativeTheme = text(raw.creative_theme);
  state.creativeNotes = text(raw.creative_notes);
  state.targetTotalWords = integer(raw.target_total_words, 0);

  const legacyChapters = arrayRecords(raw.chapters);
  const outline = asRecordOrNull(raw.novel_outline);
  const outlineChapters = arrayRecords(outline?.chapter_outlines);
  const chapterNumbers = legacyChapters
    .map((chapter) => integer(chapter.chapter_number, 0))
    .filter((number) => number > 0);
  state.targetTotalChapters = Math.max(
    integer(raw.target_total_chapters, 0),
    integer(raw.total_chapters, 0),
    outlineChapters.length,
    chapterNumbers.length ? Math.max(...chapterNumbers) : 0,
    1,
  );
  state.workflowPhase = normalizeWorkflowPhase(raw.workflow_phase, issues);
  state.foundationApproval = normalizeApproval(raw.foundation_approval, issues, "state.foundation_approval");
  state.foundationFeedback = text(raw.foundation_feedback);
  state.worldSetting = mapWorldSetting(asRecordOrNull(raw.world_setting));
  state.characters = arrayRecords(raw.characters).map((character, index) => mapCharacter(character, index, issues));
  state.novelOutline = mapNovelOutline(outline, outlineChapters, issues);

  state.narrativeFacts = arrayRecords(raw.narrative_facts)
    .map((fact, index) => mapNarrativeFact(fact, index, issues));
  state.characterKnowledge = arrayRecords(raw.character_knowledge)
    .map((knowledge, index) => mapKnowledge(knowledge, index, issues));
  state.characterArcs = mapCharacterArcs(asRecordOrNull(raw.character_arc_tracker));
  state.foreshadowings = arrayRecords(raw.foreshadowing_tracker)
    .map((item, index) => mapForeshadowing(item, index, issues));
  state.continuity = mapContinuity(asRecordOrNull(raw.continuity_state));
  if (!hasContinuity(state.continuity)) {
    state.continuity = continuityFromChapters(legacyChapters);
  }

  const approvedLegacy = legacyChapters
    .filter((chapter) => normalizeApprovalValue(chapter.approval) === "approved")
    .sort(byChapterNumber);
  state.approvedChapters = approvedLegacy.map((chapter) => mapApprovedChapter(chapter));

  const oldPending = text(raw.pending_gate);
  const activeTask = asRecordOrNull(raw.active_task);
  const pending = inferPendingGate(oldPending, activeTask, legacyChapters, issues);
  state.pendingGate = pending?.gate ?? null;
  state.pendingChapterNumber = pending?.chapterNumber ?? null;
  if (pending?.kind === "plan") state.chapterPlanApproval = "pending";
  else if (pending?.kind === "writing") state.chapterPlanApproval = "approved";
  else state.chapterPlanApproval = state.approvedChapters.length > 0 ? "approved" : "pending";
  if (pending?.chapterNumber) {
    const pendingChapter = legacyChapters.find((chapter) => integer(chapter.chapter_number, 0) === pending.chapterNumber);
    state.chapterPlanFeedback = text(pendingChapter?.rewrite_feedback) || text(pendingChapter?.human_feedback);
  }
  if (pending) state.workflowPhase = "awaiting_approval";

  const oldChaptersByNumber = new Map(
    legacyChapters.map((chapter) => [integer(chapter.chapter_number, 0), chapter]),
  );
  for (const chapter of legacyChapters) {
    const chapterNumber = integer(chapter.chapter_number, 0);
    if (chapterNumber < 1) {
      addIssue(issues, "review", "chapters", "跳过没有有效章节号的旧章节");
      continue;
    }
    const context = buildContinuityContext(state, chapterNumber);
    const plan = mapChapterPlan(chapter, chapterNumber, context.contextHash, state, issues);
    state.chapterPlans[String(chapterNumber)] = plan;
    const review = mapChapterReview(chapter, chapterNumber, context.contextHash);
    if (review) state.chapterReviews[String(chapterNumber)] = review;
    const approval = normalizeApprovalValue(chapter.approval);
    if (approval !== "approved" && hasChapterCandidate(chapter)) {
      state.chapterCandidates[String(chapterNumber)] = mapCandidate(
        chapter,
        chapterNumber,
        context.contextHash,
        plan,
        issues,
      );
    }
    const counters = asRecordOrNull(chapter.rewrite_counters);
    state.chapterRewriteAttempts[String(chapterNumber)] = integer(counters?.writing, 0);
    const feedback = text(chapter.rewrite_feedback) || text(chapter.human_feedback);
    if (feedback) state.chapterWritingFeedback[String(chapterNumber)] = feedback;
  }

  if (pending?.chapterNumber && !oldChaptersByNumber.has(pending.chapterNumber)) {
    addIssue(issues, "review", "pending_gate", `Gate 指向不存在的旧章节：${pending.chapterNumber}`);
  }
  state.globalReview = mapGlobalReview(asRecordOrNull(raw.global_review_report), state.approvedChapters.length);
  state.nodes = mapNodes(asRecordOrNull(raw.node_status), pending);
  state.lastError = mapLastError(asRecordOrNull(raw.last_error));
  state.executionEvents = mapExecutionEvents(arrayRecords(raw.execution_events), issues);
  state.updatedAt = latestTimestamp(raw, state.createdAt);

  const report: MigrationReport = {
    sourcePath,
    sourceVersion,
    projectId,
    status: issues.some((issue) => issue.severity === "review") ? "requires_review" : "ready",
    issues,
    counts: {
      legacyChapters: legacyChapters.length,
      approvedChapters: state.approvedChapters.length,
      candidateChapters: Object.keys(state.chapterCandidates).length,
      narrativeFacts: state.narrativeFacts.length,
      characterKnowledge: state.characterKnowledge.length,
    },
  };
  return { state, report };
}

function mapWorldSetting(value: RecordValue | null): GraphNovelState["worldSetting"] {
  if (!value) return null;
  return {
    era: text(value.era),
    location: text(value.location),
    magicSystem: text(value.magic_system),
    technologyLevel: text(value.technology_level),
    socialStructure: text(value.social_structure),
    rulesAndLaws: text(value.rules_and_laws),
    history: text(value.history),
  };
}

function mapCharacter(value: RecordValue, index: number, issues: MigrationIssue[]): GraphNovelState["characters"][number] {
  const arc = asRecordOrNull(value.arc);
  return {
    name: requiredText(value.name, `characters[${index}].name`, issues),
    role: text(value.role, "supporting"),
    background: text(value.background),
    personality: text(value.personality),
    motivation: text(value.motivation),
    arcDescription: text(arc?.arc_description),
  };
}

function mapNovelOutline(
  value: RecordValue | null,
  chapters: RecordValue[],
  issues: MigrationIssue[],
): GraphNovelState["novelOutline"] {
  if (!value) return null;
  return {
    genre: text(value.genre),
    premise: text(value.premise),
    theme: text(value.theme),
    targetLength: text(value.target_length),
    chapterOutlines: chapters.map((chapter, index) => ({
      chapterNumber: positiveChapter(chapter.chapter_number, `novel_outline.chapter_outlines[${index}]`, issues),
      title: requiredText(chapter.title, `novel_outline.chapter_outlines[${index}].title`, issues),
      summary: text(chapter.summary),
      keyEvents: strings(chapter.key_events),
      foreshadowingToPlant: strings(chapter.foreshadowing_to_plant),
      foreshadowingToPayOff: strings(chapter.foreshadowing_to_pay_off),
    })),
  };
}

function mapNarrativeFact(value: RecordValue, index: number, issues: MigrationIssue[]): GraphNovelState["narrativeFacts"][number] {
  return {
    factId: requiredText(value.id ?? value.fact_id, `narrative_facts[${index}].id`, issues),
    statement: requiredText(value.statement, `narrative_facts[${index}].statement`, issues),
    category: text(value.category, "uncategorized"),
    establishedInChapter: positiveChapter(value.established_in_chapter, `narrative_facts[${index}].established_in_chapter`, issues),
    visibility: text(value.visibility, "private"),
  };
}

function mapKnowledge(value: RecordValue, index: number, issues: MigrationIssue[]): GraphNovelState["characterKnowledge"][number] {
  const sourceType = normalizeSourceType(text(value.source_type), issues, `character_knowledge[${index}].source_type`);
  return {
    factId: requiredText(value.fact_id, `character_knowledge[${index}].fact_id`, issues),
    character: requiredText(value.character, `character_knowledge[${index}].character`, issues),
    knowledgeLevel: normalizeKnowledgeLevel(text(value.knowledge_level), issues, `character_knowledge[${index}].knowledge_level`),
    learnedInChapter: positiveChapter(value.learned_in_chapter, `character_knowledge[${index}].learned_in_chapter`, issues),
    sourceType,
    sourceCharacter: text(value.source_character),
    evidence: text(value.evidence),
  };
}

function mapCharacterArcs(value: RecordValue | null): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).map(([name, item]) => {
    const arc = asRecordOrNull(item);
    return [name, text(arc?.arc_description)];
  }).filter(([, description]) => Boolean(description)));
}

function mapForeshadowing(value: RecordValue, index: number, issues: MigrationIssue[]): GraphNovelState["foreshadowings"][number] {
  return {
    id: requiredText(value.id, `foreshadowing_tracker[${index}].id`, issues),
    description: text(value.description),
    plantedInChapter: positiveChapter(value.planted_in_chapter, `foreshadowing_tracker[${index}].planted_in_chapter`, issues),
    status: text(value.status, "planted"),
  };
}

function mapContinuity(value: RecordValue | null): GraphNovelState["continuity"] {
  return {
    time: text(value?.time),
    characterLocations: stringRecord(value?.character_locations),
    characterConditions: stringRecord(value?.character_conditions),
    resources: stringRecord(value?.resources),
  };
}

function continuityFromChapters(chapters: RecordValue[]): GraphNovelState["continuity"] {
  const last = chapters.slice().sort(byChapterNumber).at(-1);
  const delta = asRecordOrNull(asRecordOrNull(last?.narrative_delta)?.continuity_changes);
  return mapContinuity(delta);
}

function mapApprovedChapter(value: RecordValue): GraphNovelState["approvedChapters"][number] {
  const number = integer(value.chapter_number, 0);
  const outline = asRecordOrNull(value.outline);
  const delta = asRecordOrNull(value.narrative_delta);
  const checkpoint = asRecordOrNull(value.continuity_checkpoint);
  const summary = text(delta?.chapter_summary) || text(outline?.summary) || text(value.title, `第${number}章`);
  const polishedDraft = text(value.polished_draft) || text(value.draft);
  return {
    chapterNumber: number,
    title: text(value.title, `第${number}章`),
    summary,
    polishedDraft,
    endingExcerpt: text(value.ending_excerpt) || polishedDraft.slice(-1600),
    lastScene: mapLastScene(value, summary),
    unresolvedActions: strings(value.unresolved_actions),
    openThreads: strings(value.open_threads) || strings(checkpoint?.open_questions),
  };
}

function mapChapterPlan(
  value: RecordValue,
  chapterNumber: number,
  contextHash: string,
  state: GraphNovelState,
  issues: MigrationIssue[],
): ChapterPlan {
  const oldPlan = asRecordOrNull(value.plan);
  const outline = asRecordOrNull(value.outline);
  const causal = strings(oldPlan?.causal_chain);
  const summary = text(oldPlan?.chapter_goal) || text(outline?.summary) || text(value.title, `第${chapterNumber}章`);
  const previous = state.approvedChapters.find((chapter) => chapter.chapterNumber === chapterNumber - 1);
  const plannedFacts = arrayRecords(oldPlan?.planned_facts).map((fact, index) => mapPlannedFact(fact, index, chapterNumber, issues));
  const fallbackFacts = arrayRecords(asRecordOrNull(value.narrative_delta)?.facts_established)
    .map((fact, index) => mapPlannedFact(fact, index, chapterNumber, issues));
  const informationFlow = arrayRecords(oldPlan?.information_flow)
    .map((item, index) => mapInformationFlow(item, index, chapterNumber, issues));
  return {
    contextHash,
    chapterNumber,
    title: text(value.title) || text(outline?.title, `第${chapterNumber}章`),
    openingBridge: {
      previousChapter: Math.max(0, chapterNumber - 1),
      inheritedEndpoint: previous?.endingExcerpt || "首章无直接前章承接。",
      transitionSteps: causal.length ? causal : ["承接已批准状态并推动本章目标"],
      firstSceneStart: text(oldPlan?.opening_bridge) || summary,
      carryOverThreads: previous?.openThreads ?? [],
    },
    causalChain: causal.length
      ? causal.map((event, index) => ({
          cause: index === 0 ? "上一章已批准状态" : causal[index - 1] ?? summary,
          event,
          effect: causal[index + 1] ?? summary,
        }))
      : [{ cause: "上一章已批准状态", event: summary, effect: text(value.chapter_hook) || summary }],
    requiredFactIds: strings(oldPlan?.required_fact_ids),
    plannedFacts: plannedFacts.length ? plannedFacts : fallbackFacts,
    informationFlow,
  };
}

function mapPlannedFact(value: RecordValue, index: number, chapterNumber: number, issues: MigrationIssue[]): PlannedFact {
  return {
    factId: requiredText(value.fact_id ?? value.id, `chapters[${chapterNumber}].planned_facts[${index}].id`, issues),
    statement: requiredText(value.statement, `chapters[${chapterNumber}].planned_facts[${index}].statement`, issues),
    category: text(value.category, "uncategorized"),
    visibility: text(value.visibility, "private"),
  };
}

function mapInformationFlow(value: RecordValue, index: number, chapterNumber: number, issues: MigrationIssue[]): InformationFlow {
  let sourceType = normalizeSourceType(text(value.source_type), issues, `chapters[${chapterNumber}].information_flow[${index}].source_type`);
  const sourceCharacter = text(value.source_character);
  if (sourceType === "told" && !sourceCharacter) {
    addIssue(issues, "warning", `chapters[${chapterNumber}].information_flow[${index}].source_character`, "旧记录没有转述者，降级为 document 来源");
    sourceType = "document";
  }
  return {
    factId: requiredText(value.fact_id, `chapters[${chapterNumber}].information_flow[${index}].fact_id`, issues),
    character: requiredText(value.character, `chapters[${chapterNumber}].information_flow[${index}].character`, issues),
    knowledgeLevel: normalizeKnowledgeLevel(text(value.knowledge_level), issues, `chapters[${chapterNumber}].information_flow[${index}].knowledge_level`),
    sourceType,
    sourceCharacter,
    evidence: requiredText(value.evidence, `chapters[${chapterNumber}].information_flow[${index}].evidence`, issues),
  };
}

function mapCandidate(
  value: RecordValue,
  chapterNumber: number,
  contextHash: string,
  plan: ChapterPlan,
  issues: MigrationIssue[],
): CandidateChapter {
  const delta = asRecordOrNull(value.narrative_delta);
  const revision = Math.max(1, integer(value.revision_count, 0), integer(asRecordOrNull(value.rewrite_counters)?.writing, 0) + 1);
  return {
    chapterNumber,
    title: text(value.title, plan.title),
    contextHash,
    draft: requiredText(value.draft, `chapters[${chapterNumber}].draft`, issues),
    polishedDraft: text(value.polished_draft) || text(value.draft),
    chapterHook: text(value.chapter_hook, "待补充章节钩子"),
    chapterSummary: text(delta?.chapter_summary) || text(asRecordOrNull(value.outline)?.summary, plan.title),
    endingExcerpt: text(value.ending_excerpt) || text(value.polished_draft) .slice(-1600) || text(value.draft).slice(-1600),
    lastScene: mapLastScene(value, plan.title),
    unresolvedActions: strings(value.unresolved_actions),
    openThreads: strings(value.open_threads),
    delta: {
      factsEstablished: arrayRecords(delta?.facts_established).map((fact, index) => ({
        ...mapPlannedFact(fact, index, chapterNumber, issues),
        establishedInChapter: chapterNumber,
      })),
      knowledgeChanges: arrayRecords(delta?.knowledge_changes).map((item, index) => ({
        ...mapInformationFlow(item, index, chapterNumber, issues),
        learnedInChapter: chapterNumber,
      })),
      continuityChanges: mapContinuity(asRecordOrNull(delta?.continuity_changes)),
    },
    revision,
    approved: false,
    humanFeedback: text(value.human_feedback) || text(value.rewrite_feedback),
    revisionHistory: arrayRecords(value.revision_history).map((item) => ({
      revision: integer(item.revision, 1),
      contextHash,
      draft: text(item.draft),
      polishedDraft: text(item.polished_draft),
      feedback: text(item.reason) || text(item.result),
      recordedAt: text(item.recorded_at, new Date(0).toISOString()),
    })),
  };
}

function mapLastScene(value: RecordValue, summary: string): GraphNovelState["approvedChapters"][number]["lastScene"] {
  const checkpoint = asRecordOrNull(value.continuity_checkpoint);
  const delta = asRecordOrNull(asRecordOrNull(value.narrative_delta)?.continuity_changes);
  const outline = asRecordOrNull(value.outline);
  const locations = stringRecord(delta?.character_locations);
  return {
    time: text(checkpoint?.time) || text(delta?.time),
    location: text(checkpoint?.location) || Object.values(locations)[0] || "",
    povCharacter: text(outline?.pov_character),
    charactersPresent: Object.keys(locations),
    finalAction: text(value.chapter_hook) || summary,
    finalDialogue: "",
  };
}

function mapChapterReview(value: RecordValue, chapterNumber: number, contextHash: string): ChapterReview | null {
  const report = asRecordOrNull(value.consistency_report);
  if (!report) return null;
  const issues = strings(report.issues);
  const requiresRewrite = Boolean(report.continuity_passed === false || issues.length > 0);
  return {
    contextHash,
    chapterNumber,
    score: integer(report.overall_score, requiresRewrite ? 0 : 10),
    requiresRewrite,
    rewriteScope: issues.join("；"),
    issues,
    narrativeViolations: [],
    summary: text(report.summary),
  };
}

function mapGlobalReview(value: RecordValue | null, count: number): GraphNovelState["globalReview"] {
  if (!value || Object.keys(value).length === 0) return null;
  return {
    overallScore: integer(value.overall_score, 0),
    readyForPlatform: Boolean(value.ready_for_platform),
    summary: text(value.summary) || text(value.platform_competitiveness),
    recommendations: strings(value.final_recommendations),
    reviewedChapterCount: count,
  };
}

function mapNodes(value: RecordValue | null, pending: PendingGate | null): GraphNovelState["nodes"] {
  const nodes: GraphNovelState["nodes"] = {};
  for (const [key, status] of Object.entries(value ?? {})) {
    nodes[key] = { status: normalizeNodeStatusValue(status), attempts: 1 };
  }
  if (pending) {
    const key = pending.kind === "foundation"
      ? "human_approval_foundation"
      : pending.kind === "plan"
        ? `human_approval_chapter_planning_${pending.chapterNumber}`
        : `human_approval_chapter_writing_${pending.chapterNumber}`;
    nodes[key] ??= { status: "in_progress", attempts: 1 };
  }
  return nodes;
}

function mapLastError(value: RecordValue | null): GraphNovelState["lastError"] {
  if (!value || !text(value.message)) return null;
  return {
    nodeKey: text(value.node_key) || text(value.node) || "legacy",
    message: text(value.message),
    attempt: integer(value.attempt, 1),
    timestamp: text(value.timestamp, new Date(0).toISOString()),
  };
}

function mapExecutionEvents(values: RecordValue[], issues: MigrationIssue[]): ExecutionEvent[] {
  const events: ExecutionEvent[] = [];
  for (const [index, value] of values.entries()) {
    const type = text(value.event ?? value.type);
    const timestamp = text(value.timestamp, new Date(0).toISOString());
    if (type === "route_selected") {
      events.push({ type: "route_selected", source: text(value.source), target: text(value.target) || null, reason: text(value.reason, "legacy"), timestamp });
    } else if (type === "gate_decision") {
      const gate = text(value.gate);
      events.push({ type: "gate_decided", nodeKey: gate || "legacy_gate", gate, approved: text(value.decision) === "approved", feedback: text(value.feedback), timestamp });
    } else if (type === "rewrite_requested") {
      events.push({ type: "route_selected", source: text(value.node) || "legacy_rewrite", target: text(value.target) || null, reason: "legacy_rewrite_requested", timestamp });
    } else if (type) {
      addIssue(issues, "warning", `execution_events[${index}]`, `旧事件 ${type} 没有等价的新事件类型，已保留迁移记录但跳过`);
    }
  }
  return events;
}

interface PendingGate {
  kind: "foundation" | "plan" | "writing";
  gate: string;
  chapterNumber?: number;
}

function inferPendingGate(
  value: string,
  activeTask: RecordValue | null,
  chapters: RecordValue[],
  issues: MigrationIssue[],
): PendingGate | null {
  if (!value) return null;
  if (value === "foundation") return { kind: "foundation", gate: "foundation" };
  const match = /^(?:chapter:|chapter_writing:|chapter_plan:)(\d+)$/.exec(value);
  if (!match) {
    addIssue(issues, "review", "pending_gate", `无法识别旧 Gate：${value}`);
    return null;
  }
  const chapterNumber = Number(match[1]);
  const currentNode = text(activeTask?.current_node);
  const kind: PendingGate["kind"] = value.startsWith("chapter_plan:") || currentNode.includes("planning") ? "plan" : "writing";
  const oldChapter = chapters.find((chapter) => integer(chapter.chapter_number, 0) === chapterNumber);
  if (!oldChapter) addIssue(issues, "review", "pending_gate", `Gate 指向的章节不存在：${chapterNumber}`);
  else if (kind === "writing" && !hasChapterCandidate(oldChapter)) {
    addIssue(issues, "review", `chapters[${chapterNumber}]`, "写作 Gate 没有可恢复的旧候选稿");
  }
  return { kind, chapterNumber, gate: kind === "plan" ? `chapter_plan:${chapterNumber}` : `chapter_writing:${chapterNumber}` };
}

function readSourceVersion(value: RecordValue, issues: MigrationIssue[]): number {
  const raw = value.version ?? value.schema_version;
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  addIssue(issues, "warning", "state.version", "旧存档没有整数 version，按 v8 兼容读取");
  return 8;
}

function projectIdFrom(value: RecordValue, sourcePath: string, issues: MigrationIssue[]): string {
  const explicit = text(value.project_id);
  if (explicit) return explicit;
  const file = basename(sourcePath, extname(sourcePath));
  const fromFile = file.endsWith("_state") ? file.slice(0, -6) : file;
  const fromDirectory = basename(dirname(sourcePath));
  const candidate = fromFile && fromFile !== "graph_novel_state" ? fromFile : fromDirectory;
  if (!candidate || candidate === "." || candidate === "<memory>") {
    throw new MigrationError("state.project_id", "无法从旧存档或文件名确定 projectId");
  }
  addIssue(issues, "warning", "state.project_id", `缺少 project_id，使用文件名推断为 ${candidate}`);
  return candidate;
}

function normalizeWorkflowPhase(value: unknown, issues: MigrationIssue[]): GraphNovelState["workflowPhase"] {
  const phase = text(value).toLowerCase();
  if (["foundation", "chapter_loop", "global_review", "awaiting_approval", "failed", "done"].includes(phase)) {
    return phase as GraphNovelState["workflowPhase"];
  }
  if (phase === "writing" || phase === "chapter") return "chapter_loop";
  addIssue(issues, "review", "state.workflow_phase", `未知 workflow_phase：${phase || "空"}`);
  return "foundation";
}

function normalizeApproval(value: unknown, issues: MigrationIssue[], path: string): GraphNovelState["foundationApproval"] {
  const approval = normalizeApprovalValue(value);
  if (approval === "pending" && text(value) && text(value).toLowerCase() !== "pending") {
    addIssue(issues, "review", path, `未知审批状态：${text(value)}`);
  }
  return approval;
}

function normalizeApprovalValue(value: unknown): "pending" | "approved" | "rejected" {
  const normalized = text(value).toLowerCase();
  if (normalized === "approved" || normalized === "approve") return "approved";
  if (normalized === "rejected" || normalized === "reject") return "rejected";
  return "pending";
}

function normalizeNodeStatusValue(value: unknown): GraphNovelState["nodes"][string]["status"] {
  const normalized = text(value).toLowerCase();
  if (["pending", "in_progress", "completed", "failed", "skipped"].includes(normalized)) {
    return normalized as GraphNovelState["nodes"][string]["status"];
  }
  return "pending";
}

function normalizeSourceType(value: string, issues: MigrationIssue[], path: string): InformationFlow["sourceType"] {
  const mapping: Record<string, InformationFlow["sourceType"]> = {
    observed: "observed", told: "told", inferred: "inferred", public: "public", document: "document",
    recording: "document", terminal: "document", archive: "document", shared_evidence: "told", direct_action: "observed",
  };
  const result = mapping[value.toLowerCase()];
  if (result) return result;
  addIssue(issues, "review", path, `未知 source_type：${value || "空"}`);
  return "document";
}

function normalizeKnowledgeLevel(value: string, issues: MigrationIssue[], path: string): InformationFlow["knowledgeLevel"] {
  if (["heard", "suspected", "inferred", "confirmed"].includes(value.toLowerCase())) {
    return value.toLowerCase() as InformationFlow["knowledgeLevel"];
  }
  addIssue(issues, "review", path, `未知 knowledge_level：${value || "空"}`);
  return "heard";
}

function hasChapterCandidate(value: RecordValue): boolean {
  return Boolean(text(value.draft) || text(value.polished_draft) || text(value.chapter_hook));
}

function latestTimestamp(value: RecordValue, fallback: string): string {
  const timestamps = [value.updated_at, value.created_at, ...arrayRecords(value.execution_events).map((event) => event.timestamp)]
    .map((item) => text(item))
    .filter(Boolean)
    .sort();
  return timestamps.at(-1) || fallback;
}

function byChapterNumber(left: RecordValue, right: RecordValue): number {
  return integer(left.chapter_number, 0) - integer(right.chapter_number, 0);
}

function asRecord(value: unknown, path: string): RecordValue {
  const record = asRecordOrNull(value);
  if (!record) throw new MigrationError(path, "必须是 JSON 对象");
  return record;
}

function asRecordOrNull(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

function arrayRecords(value: unknown): RecordValue[] {
  if (!Array.isArray(value)) return [];
  return value.map(asRecordOrNull).filter((item): item is RecordValue => item !== null);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function requiredText(value: unknown, path: string, issues: MigrationIssue[]): string {
  const result = text(value);
  if (result) return result;
  addIssue(issues, "review", path, "缺少必填文本，使用空值");
  return "";
}

function integer(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function positiveChapter(value: unknown, path: string, issues: MigrationIssue[]): number {
  const result = integer(value, 0);
  if (result > 0) return result;
  addIssue(issues, "review", path, "章节号必须是正整数，使用 1");
  return 1;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "string" ? item : String(item)]));
}

function hasContinuity(value: GraphNovelState["continuity"]): boolean {
  return Boolean(value.time || Object.keys(value.characterLocations).length || Object.keys(value.characterConditions).length || Object.keys(value.resources).length);
}

function addIssue(issues: MigrationIssue[], severity: MigrationIssueSeverity, path: string, message: string): void {
  issues.push({ severity, path, message });
}
