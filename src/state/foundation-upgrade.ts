import type { ChapterPlan } from "../contracts/chapter.js";
import type {
  ApprovedChapterRecord,
  CharacterKnowledgeRecord,
  ContinuityLedger,
  NarrativeFactRecord,
} from "./continuity.js";
import type { Character, NovelOutline, WorldSetting } from "./foundation.js";

export interface LegacyChapterCanon extends Omit<ApprovedChapterRecord, "polishedDraft"> {
  textSample: string;
}

export interface LegacyFoundationSource {
  worldSetting: WorldSetting;
  characters: Character[];
  novelOutline: NovelOutline;
  approvedChapters: LegacyChapterCanon[];
  firstChapterPlan: ChapterPlan | null;
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
}

export type FoundationUpgradeStatus =
  | "running"
  | "awaiting_approval"
  | "needs_revision"
  | "failed"
  | "completed";

export interface FoundationUpgradeRecord {
  status: FoundationUpgradeStatus;
  startedAt: string;
  completedAt?: string;
  backupFile: string;
  sourceHash: string;
  targetChapter: number;
  source: LegacyFoundationSource | null;
}
