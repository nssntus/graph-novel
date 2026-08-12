import type {
  CharacterKnowledgeRecord,
  ContinuityLedger,
  LastSceneCheckpoint,
  NarrativeFactRecord,
} from "./continuity.js";

export interface NarrativeDelta {
  factsEstablished: NarrativeFactRecord[];
  knowledgeChanges: CharacterKnowledgeRecord[];
  continuityChanges: Partial<ContinuityLedger>;
}

export interface CandidateChapter {
  chapterNumber: number;
  title: string;
  contextHash: string;
  foundationDirectiveHash?: string;
  draft: string;
  polishedDraft: string;
  chapterHook: string;
  chapterSummary: string;
  endingExcerpt: string;
  lastScene: LastSceneCheckpoint;
  unresolvedActions: string[];
  openThreads: string[];
  delta: NarrativeDelta;
  revision: number;
  approved: boolean;
  humanFeedback: string;
  revisionHistory: Array<{
    revision: number;
    contextHash: string;
    draft: string;
    polishedDraft: string;
    feedback: string;
    recordedAt: string;
  }>;
}

export interface ChapterReview {
  contextHash: string;
  foundationDirectiveHash?: string;
  chapterNumber: number;
  score: number;
  requiresRewrite: boolean;
  rewriteScope: string;
  issues: string[];
  narrativeViolations: string[];
  foundationViolations?: string[];
  summary: string;
}
