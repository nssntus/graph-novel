import type { NodeStatus } from "../runtime/types.js";
import type {
  Character,
  ContinuityBaseline,
  CreativeCharter,
  FoundationReview,
  FoundationOutlineProgress,
  NarrativePlan,
  NovelOutline,
  RelationshipMap,
  StoryArchitecture,
  StyleGuide,
  WorldSetting,
} from "./foundation.js";
import type {
  FoundationDocumentManifest,
  FoundationRegistry,
  FoundationSnapshot,
  FoundationValidationReport,
} from "./foundation-registry.js";
import type { ChapterPlan } from "../contracts/chapter.js";
import type { CandidateChapter, ChapterReview } from "./chapter.js";
import type { GlobalReview } from "./global.js";
import type {
  ApprovedChapterRecord,
  CharacterKnowledgeRecord,
  ContinuityLedger,
  NarrativeFactRecord,
} from "./continuity.js";
import type { FoundationUpgradeRecord } from "./foundation-upgrade.js";

export const CURRENT_STATE_VERSION = 1;

export type WorkflowPhase =
  | "foundation"
  | "chapter_loop"
  | "global_review"
  | "awaiting_approval"
  | "failed"
  | "done";

export type FoundationApproval = "pending" | "approved" | "rejected";

export interface NodeExecutionRecord {
  status: NodeStatus;
  attempts: number;
  sessionId?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface StateError {
  nodeKey: string;
  message: string;
  attempt: number;
  timestamp: string;
}

export interface GraphNovelState {
  schemaVersion: number;
  projectId: string;
  novelTitle: string;
  creativeGenre: string;
  creativePremise: string;
  creativeTheme: string;
  creativeNotes: string;
  targetTotalChapters: number;
  targetTotalWords: number;
  workflowPhase: WorkflowPhase;
  pendingGate: string | null;
  foundationApproval: FoundationApproval;
  foundationFeedback: string;
  creativeCharter: CreativeCharter | null;
  worldSetting: WorldSetting | null;
  characters: Character[];
  relationshipMap: RelationshipMap | null;
  storyArchitecture: StoryArchitecture | null;
  narrativePlan: NarrativePlan | null;
  novelOutline: NovelOutline | null;
  foundationOutlineProgress: FoundationOutlineProgress | null;
  styleGuide: StyleGuide | null;
  continuityBaseline: ContinuityBaseline | null;
  foundationReview: FoundationReview | null;
  foundationReviewAttempts: number;
  foundationRegistry: FoundationRegistry | null;
  foundationDocuments: Record<string, FoundationDocumentManifest>;
  foundationValidation: FoundationValidationReport | null;
  foundationSnapshot: FoundationSnapshot | null;
  foundationUpgrade: FoundationUpgradeRecord | null;
  approvedChapters: ApprovedChapterRecord[];
  narrativeFacts: NarrativeFactRecord[];
  characterKnowledge: CharacterKnowledgeRecord[];
  characterArcs: Record<string, string>;
  foreshadowings: Array<{
    id: string;
    description: string;
    plantedInChapter: number;
    status: string;
  }>;
  continuity: ContinuityLedger;
  chapterPlans: Record<string, ChapterPlan>;
  chapterCandidates: Record<string, CandidateChapter>;
  chapterReviews: Record<string, ChapterReview>;
  chapterRewriteAttempts: Record<string, number>;
  chapterWritingFeedback: Record<string, string>;
  pendingChapterNumber: number | null;
  chapterPlanApproval: FoundationApproval;
  chapterPlanFeedback: string;
  globalReview: GlobalReview | null;
  nodes: Record<string, NodeExecutionRecord>;
  lastError: StateError | null;
  executionEvents: ExecutionEvent[];
  createdAt: string;
  updatedAt: string;
}

export type ExecutionEvent =
  | {
      type: "node_started";
      nodeKey: string;
      attempt: number;
      sessionId?: string;
      timestamp: string;
    }
  | {
      type: "node_completed";
      nodeKey: string;
      attempt: number;
      timestamp: string;
    }
  | {
      type: "node_failed";
      nodeKey: string;
      attempt: number;
      error: string;
      timestamp: string;
    }
  | {
      type: "gate_reached";
      nodeKey: string;
      gate: string;
      attempt: number;
      timestamp: string;
    }
  | {
      type: "gate_decided";
      nodeKey: string;
      gate: string;
      approved: boolean;
      feedback: string;
      timestamp: string;
    }
  | {
      type: "route_selected";
      source: string;
      target: string | null;
      reason: string;
      timestamp: string;
    };

export function createInitialState(
  projectId: string,
  novelTitle: string,
  now = new Date().toISOString(),
): GraphNovelState {
  if (!projectId.trim()) throw new Error("projectId cannot be empty");
  if (!novelTitle.trim()) throw new Error("novelTitle cannot be empty");
  return {
    schemaVersion: CURRENT_STATE_VERSION,
    projectId,
    novelTitle,
    creativeGenre: "",
    creativePremise: "",
    creativeTheme: "",
    creativeNotes: "",
    targetTotalChapters: 0,
    targetTotalWords: 0,
    workflowPhase: "foundation",
    pendingGate: null,
    foundationApproval: "pending",
    foundationFeedback: "",
    creativeCharter: null,
    worldSetting: null,
    characters: [],
    relationshipMap: null,
    storyArchitecture: null,
    narrativePlan: null,
    novelOutline: null,
    foundationOutlineProgress: null,
    styleGuide: null,
    continuityBaseline: null,
    foundationReview: null,
    foundationReviewAttempts: 0,
    foundationRegistry: null,
    foundationDocuments: {},
    foundationValidation: null,
    foundationSnapshot: null,
    foundationUpgrade: null,
    approvedChapters: [],
    narrativeFacts: [],
    characterKnowledge: [],
    characterArcs: {},
    foreshadowings: [],
    continuity: {
      time: "",
      characterLocations: {},
      characterConditions: {},
      resources: {},
    },
    chapterPlans: {},
    chapterCandidates: {},
    chapterReviews: {},
    chapterRewriteAttempts: {},
    chapterWritingFeedback: {},
    pendingChapterNumber: null,
    chapterPlanApproval: "pending",
    chapterPlanFeedback: "",
    globalReview: null,
    nodes: {},
    lastError: null,
    executionEvents: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function parseState(serialized: string): GraphNovelState {
  const value: unknown = withContinuityDefaults(JSON.parse(serialized));
  if (!hasStateShape(value)) {
    throw new Error("Invalid GraphNovelState payload");
  }
  if (value.schemaVersion !== CURRENT_STATE_VERSION) {
    throw new Error(
      `Unsupported GraphNovelState schema version: ${value.schemaVersion}`,
    );
  }
  return value as GraphNovelState;
}

export function serializeState(state: GraphNovelState): string {
  if (!isGraphNovelState(state)) {
    throw new Error("Cannot serialize invalid GraphNovelState");
  }
  return `${JSON.stringify(state, null, 2)}\n`;
}

function isGraphNovelState(value: unknown): value is GraphNovelState {
  return hasStateShape(value) &&
    (value as GraphNovelState).schemaVersion === CURRENT_STATE_VERSION;
}

function hasStateShape(value: unknown): value is Omit<GraphNovelState, "schemaVersion"> & {
  schemaVersion: number;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GraphNovelState>;
  return (
    typeof candidate.schemaVersion === "number" &&
    typeof candidate.projectId === "string" &&
    typeof candidate.novelTitle === "string" &&
    typeof candidate.creativeGenre === "string" &&
    typeof candidate.creativePremise === "string" &&
    typeof candidate.creativeTheme === "string" &&
    typeof candidate.creativeNotes === "string" &&
    typeof candidate.targetTotalChapters === "number" &&
    typeof candidate.targetTotalWords === "number" &&
    typeof candidate.workflowPhase === "string" &&
    (candidate.pendingGate === null || typeof candidate.pendingGate === "string") &&
    typeof candidate.foundationApproval === "string" &&
    typeof candidate.foundationFeedback === "string" &&
    (candidate.creativeCharter === null || typeof candidate.creativeCharter === "object") &&
    (candidate.worldSetting === null || typeof candidate.worldSetting === "object") &&
    Array.isArray(candidate.characters) &&
    (candidate.relationshipMap === null || typeof candidate.relationshipMap === "object") &&
    (candidate.storyArchitecture === null || typeof candidate.storyArchitecture === "object") &&
    (candidate.narrativePlan === null || typeof candidate.narrativePlan === "object") &&
    (candidate.novelOutline === null || typeof candidate.novelOutline === "object") &&
    (candidate.foundationOutlineProgress === null || typeof candidate.foundationOutlineProgress === "object") &&
    (candidate.styleGuide === null || typeof candidate.styleGuide === "object") &&
    (candidate.continuityBaseline === null || typeof candidate.continuityBaseline === "object") &&
    (candidate.foundationReview === null || typeof candidate.foundationReview === "object") &&
    typeof candidate.foundationReviewAttempts === "number" &&
    (candidate.foundationRegistry === null || typeof candidate.foundationRegistry === "object") &&
    typeof candidate.foundationDocuments === "object" && candidate.foundationDocuments !== null &&
    (candidate.foundationValidation === null || typeof candidate.foundationValidation === "object") &&
    (candidate.foundationSnapshot === null || typeof candidate.foundationSnapshot === "object") &&
    (candidate.foundationUpgrade === null || typeof candidate.foundationUpgrade === "object") &&
    Array.isArray(candidate.approvedChapters) &&
    Array.isArray(candidate.narrativeFacts) &&
    Array.isArray(candidate.characterKnowledge) &&
    typeof candidate.characterArcs === "object" &&
    candidate.characterArcs !== null &&
    Array.isArray(candidate.foreshadowings) &&
    typeof candidate.continuity === "object" &&
    candidate.continuity !== null &&
    typeof candidate.chapterPlans === "object" &&
    candidate.chapterPlans !== null &&
    typeof candidate.chapterCandidates === "object" &&
    candidate.chapterCandidates !== null &&
    typeof candidate.chapterReviews === "object" &&
    candidate.chapterReviews !== null &&
    typeof candidate.chapterRewriteAttempts === "object" &&
    candidate.chapterRewriteAttempts !== null &&
    typeof candidate.chapterWritingFeedback === "object" &&
    candidate.chapterWritingFeedback !== null &&
    (candidate.pendingChapterNumber === null || typeof candidate.pendingChapterNumber === "number") &&
    typeof candidate.chapterPlanApproval === "string" &&
    typeof candidate.chapterPlanFeedback === "string" &&
    (candidate.globalReview === null || typeof candidate.globalReview === "object") &&
    typeof candidate.nodes === "object" &&
    candidate.nodes !== null &&
    Array.isArray(candidate.executionEvents) &&
    (candidate.lastError === null || typeof candidate.lastError === "object") &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

function withContinuityDefaults(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const candidate = value as Record<string, unknown>;
  return {
    ...candidate,
    creativeNotes: typeof candidate.creativeNotes === "string" ? candidate.creativeNotes : "",
    creativeCharter: candidate.creativeCharter && typeof candidate.creativeCharter === "object" ? candidate.creativeCharter : null,
    relationshipMap: candidate.relationshipMap && typeof candidate.relationshipMap === "object" ? candidate.relationshipMap : null,
    storyArchitecture: candidate.storyArchitecture && typeof candidate.storyArchitecture === "object" ? candidate.storyArchitecture : null,
    narrativePlan: candidate.narrativePlan && typeof candidate.narrativePlan === "object" ? candidate.narrativePlan : null,
    foundationOutlineProgress: candidate.foundationOutlineProgress && typeof candidate.foundationOutlineProgress === "object" ? candidate.foundationOutlineProgress : null,
    styleGuide: candidate.styleGuide && typeof candidate.styleGuide === "object" ? candidate.styleGuide : null,
    continuityBaseline: candidate.continuityBaseline && typeof candidate.continuityBaseline === "object" ? candidate.continuityBaseline : null,
    foundationReview: candidate.foundationReview && typeof candidate.foundationReview === "object" ? candidate.foundationReview : null,
    foundationReviewAttempts: typeof candidate.foundationReviewAttempts === "number" ? candidate.foundationReviewAttempts : 0,
    foundationRegistry: candidate.foundationRegistry && typeof candidate.foundationRegistry === "object" ? candidate.foundationRegistry : null,
    foundationDocuments: candidate.foundationDocuments && typeof candidate.foundationDocuments === "object" ? candidate.foundationDocuments : {},
    foundationValidation: candidate.foundationValidation && typeof candidate.foundationValidation === "object" ? candidate.foundationValidation : null,
    foundationSnapshot: candidate.foundationSnapshot && typeof candidate.foundationSnapshot === "object" ? candidate.foundationSnapshot : null,
    foundationUpgrade: candidate.foundationUpgrade && typeof candidate.foundationUpgrade === "object" ? candidate.foundationUpgrade : null,
    approvedChapters: normalizeApprovedChapters(candidate.approvedChapters),
    narrativeFacts: Array.isArray(candidate.narrativeFacts) ? candidate.narrativeFacts : [],
    characterKnowledge: Array.isArray(candidate.characterKnowledge) ? candidate.characterKnowledge : [],
    characterArcs: candidate.characterArcs && typeof candidate.characterArcs === "object" ? candidate.characterArcs : {},
    foreshadowings: Array.isArray(candidate.foreshadowings) ? candidate.foreshadowings : [],
    continuity: candidate.continuity && typeof candidate.continuity === "object"
      ? candidate.continuity
      : { time: "", characterLocations: {}, characterConditions: {}, resources: {} },
    chapterPlans: candidate.chapterPlans && typeof candidate.chapterPlans === "object" ? candidate.chapterPlans : {},
    chapterCandidates: candidate.chapterCandidates && typeof candidate.chapterCandidates === "object" ? candidate.chapterCandidates : {},
    chapterReviews: candidate.chapterReviews && typeof candidate.chapterReviews === "object" ? candidate.chapterReviews : {},
    chapterRewriteAttempts: candidate.chapterRewriteAttempts && typeof candidate.chapterRewriteAttempts === "object" ? candidate.chapterRewriteAttempts : {},
    chapterWritingFeedback: candidate.chapterWritingFeedback && typeof candidate.chapterWritingFeedback === "object" ? candidate.chapterWritingFeedback : {},
    pendingChapterNumber: typeof candidate.pendingChapterNumber === "number" ? candidate.pendingChapterNumber : null,
    chapterPlanApproval: typeof candidate.chapterPlanApproval === "string" ? candidate.chapterPlanApproval : "pending",
    chapterPlanFeedback: typeof candidate.chapterPlanFeedback === "string" ? candidate.chapterPlanFeedback : "",
    globalReview: candidate.globalReview && typeof candidate.globalReview === "object" ? candidate.globalReview : null,
  };
}

function normalizeApprovedChapters(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const chapter = item as Record<string, unknown>;
    return {
      ...chapter,
      polishedDraft: typeof chapter.polishedDraft === "string"
        ? chapter.polishedDraft
        : typeof chapter.endingExcerpt === "string" ? chapter.endingExcerpt : "",
    };
  });
}
