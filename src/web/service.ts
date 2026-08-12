import { randomUUID } from "node:crypto";
import type { GraphEvent, GraphEventSink } from "../runtime/types.js";
import { CheckpointStore } from "../checkpoint/store.js";
import {
  beginLegacyFoundationUpgrade,
  decideFoundation,
  isLegacyFoundationProject,
  runFoundationGeneration,
  runFoundationUpgrade,
  type FoundationAgentDependencies,
} from "../agents/foundation.js";
import {
  decideChapterPlan,
  runChapterPlanning,
  type ChapterPlanningDependencies,
} from "../agents/chapter-planning.js";
import {
  decideChapterWriting,
  reopenChapterWriting,
  runChapterWriting,
  type ChapterWritingDependencies,
} from "../agents/chapter-writing.js";
import {
  runCreativeChat,
  type CreativeChatInput,
} from "../agents/creative-chat.js";
import {
  runCreativeProjectDraft,
  CreativeProjectDraftContractError,
  type CreativeProjectDraft,
  type CreativeProjectDraftDependencies,
  type CreativeProjectDraftInput,
} from "../agents/creative-project-draft.js";
import { runGlobalReview, type GlobalReviewDependencies } from "../agents/global-review.js";
import { parseChapterPlan } from "../contracts/chapter.js";
import { buildContinuityContext } from "../state/continuity.js";
import { createInitialState, type GraphNovelState } from "../state/state.js";

export type ServiceStatus =
  | "idle"
  | "running"
  | "awaiting_approval"
  | "failed"
  | "completed"
  | "busy";

export interface GraphNovelAgentDependencies
  extends FoundationAgentDependencies,
    ChapterPlanningDependencies,
    ChapterWritingDependencies,
    CreativeProjectDraftDependencies {}

export interface CreateProjectInput {
  projectId?: string;
  novelTitle: string;
  creativeGenre?: string;
  creativePremise?: string;
  creativeTheme?: string;
  creativeNotes?: string;
  targetTotalChapters?: number;
  targetTotalWords?: number;
}

export type EditableChapterDocumentKind =
  | "chapter_plan"
  | "chapter_draft"
  | "chapter_polished"
  | "approved_chapter";

export interface UpdateChapterDocumentInput {
  kind: EditableChapterDocumentKind;
  chapterNumber: number;
  content?: unknown;
  value?: unknown;
}

export interface TrialReadingChapter {
  chapterNumber: number;
  title: string;
  summary: string;
  content: string;
}

export interface TrialReadingNovel {
  projectId: string;
  novelTitle: string;
  chapters: TrialReadingChapter[];
}

export interface TaskRecord {
  projectId: string;
  kind: string;
  status: ServiceStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export type ServiceEvent =
  | { type: "task"; task: TaskRecord }
  | { type: "graph"; event: GraphEvent }
  | { type: "state"; status: ServiceStatus };

export class ServiceError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

type TaskRunner = (sink: GraphEventSink) => Promise<{ status: string }>;
type EventListener = (event: ServiceEvent) => void;

export class TaskRegistry {
  private readonly records = new Map<string, TaskRecord>();
  private readonly active = new Set<string>();
  private readonly listeners = new Map<string, Set<EventListener>>();

  isActive(projectId: string): boolean {
    return this.active.has(projectId);
  }

  get(projectId: string): TaskRecord | undefined {
    return this.records.get(projectId);
  }

  subscribe(projectId: string, listener: EventListener): () => void {
    const listeners = this.listeners.get(projectId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(projectId, listeners);
    return () => listeners.delete(listener);
  }

  async start(projectId: string, kind: string, runner: TaskRunner): Promise<TaskRecord> {
    if (this.active.has(projectId)) {
      throw new ServiceError(409, "busy", "项目已有任务正在运行");
    }
    const task: TaskRecord = {
      projectId,
      kind,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.active.add(projectId);
    this.records.set(projectId, task);
    this.emit(projectId, { type: "task", task: { ...task } });
    void runner(async (event) => {
      this.emit(projectId, { type: "graph", event });
    }).then(
      (result) => {
        task.status = result.status === "awaiting_approval"
          ? "awaiting_approval"
          : result.status === "failed" ? "failed" : "completed";
        task.finishedAt = new Date().toISOString();
        this.active.delete(projectId);
        this.emit(projectId, { type: "task", task: { ...task } });
      },
      (error: unknown) => {
        task.status = "failed";
        task.error = error instanceof Error ? error.message : String(error);
        task.finishedAt = new Date().toISOString();
        this.active.delete(projectId);
        this.emit(projectId, { type: "task", task: { ...task } });
      },
    );
    return { ...task };
  }

  private emit(projectId: string, event: ServiceEvent): void {
    for (const listener of this.listeners.get(projectId) ?? []) listener(event);
  }
}

export class GraphNovelService {
  readonly tasks: TaskRegistry;

  constructor(
    readonly checkpoints: CheckpointStore,
    private readonly agentDependencies?: GraphNovelAgentDependencies,
    tasks = new TaskRegistry(),
  ) {
    this.tasks = tasks;
  }

  async listProjects(): Promise<GraphNovelState[]> {
    return this.checkpoints.list();
  }

  async listTrialReadingNovels(): Promise<TrialReadingNovel[]> {
    const projects = await this.checkpoints.list();
    return projects
      .map((state) => {
        const chapters = state.approvedChapters
          .map((chapter) => ({
            chapterNumber: chapter.chapterNumber,
            title: chapter.title,
            summary: chapter.summary,
            content: chapter.polishedDraft,
          }))
          .filter((chapter) => chapter.content.trim())
          .sort((left, right) => left.chapterNumber - right.chapterNumber);
        return chapters.length > 0 ? { projectId: state.projectId, novelTitle: state.novelTitle, chapters } : null;
      })
      .filter((novel): novel is TrialReadingNovel => novel !== null)
      .sort((left, right) => left.novelTitle.localeCompare(right.novelTitle, "zh-CN"));
  }

  async createProject(input: CreateProjectInput): Promise<GraphNovelState> {
    const title = requiredText(input.novelTitle, "novelTitle");
    const projectId = validateProjectId(input.projectId ?? slugFor(title));
    if (await this.checkpoints.load(projectId)) {
      throw new ServiceError(409, "exists", "项目 ID 已存在");
    }
    const targetTotalChapters = boundedInteger(input.targetTotalChapters ?? 12, 1, 200, "targetTotalChapters");
    const targetTotalWords = boundedInteger(input.targetTotalWords ?? 0, 0, 20_000_000, "targetTotalWords");
    const state = createInitialState(projectId, title);
    state.creativeGenre = optionalText(input.creativeGenre);
    state.creativePremise = optionalText(input.creativePremise);
    state.creativeTheme = optionalText(input.creativeTheme);
    state.creativeNotes = optionalText(input.creativeNotes);
    state.targetTotalChapters = targetTotalChapters;
    state.targetTotalWords = targetTotalWords;
    await this.checkpoints.save(state);
    return state;
  }

  async getState(projectId: string): Promise<GraphNovelState> {
    const state = await this.loadProject(projectId);
    return state;
  }

  async getStatus(projectId: string): Promise<{ status: ServiceStatus; task?: TaskRecord; state: GraphNovelState }> {
    const state = await this.loadProject(projectId);
    const task = this.tasks.get(projectId);
    if (this.tasks.isActive(projectId)) return { status: "running", task, state };
    if (state.workflowPhase === "failed" || (task?.status === "failed" && state.lastError)) return { status: "failed", task, state };
    if (state.pendingGate) return { status: "awaiting_approval", task, state };
    if (task?.status === "completed" || state.workflowPhase === "done") return { status: "completed", task, state };
    return { status: "idle", task, state };
  }

  async updateChapterDocumentFor(projectId: string, input: UpdateChapterDocumentInput): Promise<GraphNovelState> {
    this.ensureNotBusy(projectId);
    this.ensureProjectId(projectId);
    const kind = editableChapterDocumentKind(input.kind);
    return this.checkpoints.withProjectLock(projectId, async () => {
      const state = await this.loadProject(projectId);
      const chapterNumber = boundedInteger(input.chapterNumber, 1, Math.max(1, state.targetTotalChapters), "chapterNumber");
      const key = String(chapterNumber);
      try {
        if (kind === "chapter_plan") {
          if (!state.chapterPlans[key]) throw new ServiceError(404, "document_not_found", "章节规划不存在");
          state.chapterPlans[key] = parseChapterPlan(
            JSON.stringify(input.value),
            chapterNumber,
            buildContinuityContext(state, chapterNumber),
          );
        } else if (kind === "approved_chapter") {
          const chapter = state.approvedChapters.find((item) => item.chapterNumber === chapterNumber);
          if (!chapter) throw new ServiceError(404, "document_not_found", "审批后正文不存在");
          chapter.polishedDraft = editableDocumentText(input.content);
        } else {
          const candidate = state.chapterCandidates[key];
          if (!candidate) throw new ServiceError(404, "document_not_found", "章节候选文稿不存在");
          const content = editableDocumentText(input.content);
          if (kind === "chapter_draft") candidate.draft = content;
          else candidate.polishedDraft = content;
        }
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        throw new ServiceError(400, "invalid_document", error instanceof Error ? error.message : String(error));
      }
      state.updatedAt = new Date().toISOString();
      await this.checkpoints.save(state);
      return state;
    });
  }

  async startFoundationFor(projectId: string): Promise<TaskRecord> {
    const dependencies = this.requireAgents();
    const state = await this.loadProjectForCommand(projectId);
    return this.startTask(state, "foundation", (sink) => runFoundationGeneration(state, dependencies, this.checkpoints, sink));
  }

  async startFoundationUpgradeFor(projectId: string): Promise<TaskRecord> {
    const dependencies = this.requireAgents();
    this.ensureNotBusy(projectId);
    this.ensureProjectId(projectId);
    let resumeInterrupted = false;
    const state = await this.checkpoints.withProjectLock(projectId, async () => {
      const current = await this.loadProject(projectId);
      const existing = current.foundationUpgrade;
      if (existing) {
        if (existing.status === "completed") {
          throw new ServiceError(409, "foundation_already_upgraded", "Foundation 已完成升级");
        }
        if (existing.status === "awaiting_approval" || current.pendingGate === "foundation") {
          throw new ServiceError(409, "approval_required", "Foundation 升级结果正在等待审批");
        }
        if (!existing.source) {
          throw new ServiceError(409, "upgrade_source_missing", "Foundation 升级来源不可用，请从备份恢复");
        }
        resumeInterrupted = existing.status === "running" || existing.status === "failed";
      } else {
        if (!isLegacyFoundationProject(current)) {
          throw new ServiceError(409, "legacy_foundation_required", "只有已批准的旧版 Foundation 可以执行升级");
        }
        const backupFile = await this.checkpoints.backup(current, "pre-foundation-upgrade");
        beginLegacyFoundationUpgrade(current, backupFile);
        await this.checkpoints.save(current);
      }
      return current;
    });
    return this.startTask(state, "foundation_upgrade", (sink) => runFoundationUpgrade(
      state,
      dependencies,
      this.checkpoints,
      sink,
      resumeInterrupted,
    ));
  }

  async decideFoundationFor(projectId: string, approved: boolean, feedback = ""): Promise<GraphNovelState> {
    this.ensureNotBusy(projectId);
    const state = await this.loadProjectForCommand(projectId);
    await decideFoundation(state, approved, this.checkpoints, feedback);
    return state;
  }

  async startChapterPlanningFor(projectId: string, chapterNumber: number): Promise<TaskRecord> {
    const dependencies = this.requireAgents();
    const state = await this.loadProjectForCommand(projectId);
    assertChapterNumber(state, chapterNumber);
    return this.startTask(state, `chapter_planning:${chapterNumber}`, (sink) => runChapterPlanning(state, chapterNumber, dependencies, this.checkpoints, sink));
  }

  async decideChapterPlanFor(projectId: string, chapterNumber: number, approved: boolean, feedback = ""): Promise<GraphNovelState> {
    this.ensureNotBusy(projectId);
    const state = await this.loadProjectForCommand(projectId);
    assertChapterNumber(state, chapterNumber);
    await decideChapterPlan(state, chapterNumber, approved, this.checkpoints, feedback);
    return state;
  }

  async startChapterWritingFor(projectId: string, chapterNumber: number): Promise<TaskRecord> {
    const dependencies = this.requireAgents();
    const state = await this.loadProjectForCommand(projectId);
    assertChapterNumber(state, chapterNumber);
    return this.startTask(state, `chapter_writing:${chapterNumber}`, (sink) => runChapterWriting(state, chapterNumber, dependencies, this.checkpoints, sink));
  }

  async decideChapterWritingFor(projectId: string, chapterNumber: number, approved: boolean, feedback = ""): Promise<GraphNovelState> {
    this.ensureNotBusy(projectId);
    const state = await this.loadProjectForCommand(projectId);
    assertChapterNumber(state, chapterNumber);
    await decideChapterWriting(state, chapterNumber, approved, this.checkpoints, feedback);
    return state;
  }

  async reopenChapterWritingFor(projectId: string, chapterNumber: number, feedback: string): Promise<GraphNovelState> {
    this.ensureNotBusy(projectId);
    const state = await this.loadProjectForCommand(projectId);
    assertChapterNumber(state, chapterNumber);
    await reopenChapterWriting(state, chapterNumber, this.checkpoints, feedback);
    return state;
  }

  async startGlobalReviewFor(projectId: string): Promise<TaskRecord> {
    const dependencies = this.requireAgents() as GraphNovelAgentDependencies & GlobalReviewDependencies;
    const state = await this.loadProjectForCommand(projectId);
    return this.startTask(state, "global_review", (sink) => runGlobalReview(state, dependencies, this.checkpoints, sink));
  }

  async chatFor(projectId: string, input: CreativeChatInput): Promise<{ reply: string; sessionId: string }> {
    const state = await this.loadProject(projectId);
    return this.runChat(input, state);
  }

  async chatCreatively(input: CreativeChatInput): Promise<{ reply: string; sessionId: string }> {
    return this.runChat(input);
  }

  async draftProjectFromCreativeChat(input: CreativeProjectDraftInput): Promise<{ draft: CreativeProjectDraft; sessionId: string }> {
    const dependencies = this.requireAgents();
    try {
      return await runCreativeProjectDraft(input, dependencies);
    } catch (error) {
      if (error instanceof CreativeProjectDraftContractError) {
        throw new ServiceError(502, "invalid_agent_output", error.message);
      }
      throw error;
    }
  }

  exportState(state: GraphNovelState): string {
    return `${JSON.stringify(state, null, 2)}\n`;
  }

  exportNovel(state: GraphNovelState): string {
    const chapters = state.approvedChapters
      .slice()
      .sort((left, right) => left.chapterNumber - right.chapterNumber);
    return chapters.map((chapter) => `# 第${chapter.chapterNumber}章：${chapter.title}\n\n${chapter.polishedDraft || chapter.endingExcerpt}`)
      .join("\n\n");
  }

  subscribe(projectId: string, listener: EventListener): () => void {
    return this.tasks.subscribe(projectId, listener);
  }

  private async startTask(state: GraphNovelState, kind: string, runner: TaskRunner): Promise<TaskRecord> {
    return this.tasks.start(state.projectId, kind, runner);
  }

  private async runChat(input: CreativeChatInput, state?: GraphNovelState): Promise<{ reply: string; sessionId: string }> {
    const dependencies = this.requireAgents();
    return runCreativeChat(input, dependencies, state);
  }

  private requireAgents(): GraphNovelAgentDependencies {
    if (!this.agentDependencies) {
      throw new ServiceError(503, "agent_unavailable", "未配置 Pi Agent 模型运行时");
    }
    return this.agentDependencies;
  }

  private ensureNotBusy(projectId: string): void {
    if (this.tasks.isActive(projectId)) throw new ServiceError(409, "busy", "项目已有任务正在运行");
  }

  private async loadProjectForCommand(projectId: string): Promise<GraphNovelState> {
    this.ensureProjectId(projectId);
    return this.loadProject(projectId);
  }

  private async loadProject(projectId: string): Promise<GraphNovelState> {
    this.ensureProjectId(projectId);
    const state = await this.checkpoints.load(projectId);
    if (!state) throw new ServiceError(404, "not_found", "项目不存在");
    return state;
  }

  private ensureProjectId(projectId: string): void {
    validateProjectId(projectId);
  }

}

function assertChapterNumber(state: GraphNovelState, chapterNumber: number): void {
  boundedInteger(chapterNumber, 1, Math.max(1, state.targetTotalChapters), "chapterNumber");
  if (state.foundationApproval !== "approved") {
    throw new ServiceError(409, "foundation_required", "Foundation 必须先批准");
  }
}

function validateProjectId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) {
    throw new ServiceError(400, "invalid_project_id", "projectId 只能包含字母、数字、点、下划线和连字符，长度 1-80");
  }
  return value;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ServiceError(400, "invalid_input", `${field} 必须是非空字符串`);
  return value.trim();
}

function optionalText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ServiceError(400, "invalid_input", `${field} 必须是 ${min} 到 ${max} 的整数`);
  }
  return value;
}

function editableChapterDocumentKind(value: unknown): EditableChapterDocumentKind {
  if (!["chapter_plan", "chapter_draft", "chapter_polished", "approved_chapter"].includes(String(value))) {
    throw new ServiceError(400, "invalid_document", "不支持的章节文稿类型");
  }
  return value as EditableChapterDocumentKind;
}

function editableDocumentText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ServiceError(400, "invalid_document", "文稿内容必须是非空字符串");
  }
  return value;
}

function slugFor(title: string): string {
  const ascii = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return validateProjectId(ascii || `project-${randomUUID().slice(0, 12)}`);
}
