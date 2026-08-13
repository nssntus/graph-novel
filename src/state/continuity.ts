import { createHash } from "node:crypto";
import type { GraphNovelState } from "./state.js";
import type {
  Character,
  ChapterOutline,
  ContinuityBaseline,
  CreativeCharter,
  NarrativePlan,
  RelationshipMap,
  StoryArchitecture,
  StyleGuide,
  WorldSetting,
} from "./foundation.js";
import {
  assertFoundationSnapshotCurrent,
  type FoundationRegistry,
  type FoundationSnapshot,
} from "./foundation-registry.js";
import { buildRollingChapterOutline } from "./rolling-outline.js";

export const CONTINUITY_CONTEXT_VERSION = 4;

export interface ChapterFoundationDirective {
  version: 1;
  sourceSnapshotHash: string;
  sourceDocuments: Record<string, string>;
  references: {
    characterIds: string[];
    locationIds: string[];
    factionIds: string[];
    systemIds: string[];
    ruleIds: string[];
    storyArcIds: string[];
    secretIds: string[];
    factIds: string[];
    foreshadowingIds: string[];
  };
  creativeCharter: CreativeCharter;
  worldSetting: WorldSetting;
  characters: Character[];
  relationshipMap: RelationshipMap;
  storyArchitecture: StoryArchitecture;
  narrativePlan: NarrativePlan;
  targetOutline: ChapterOutline;
  styleGuide: StyleGuide;
  continuityBaseline: ContinuityBaseline | null;
  directiveHash: string;
}

export interface LastSceneCheckpoint {
  time: string;
  location: string;
  povCharacter: string;
  charactersPresent: string[];
  finalAction: string;
  finalDialogue: string;
}

export interface ApprovedChapterRecord {
  chapterNumber: number;
  title: string;
  summary: string;
  polishedDraft: string;
  endingExcerpt: string;
  lastScene: LastSceneCheckpoint;
  unresolvedActions: string[];
  openThreads: string[];
}

export interface NarrativeFactRecord {
  factId: string;
  statement: string;
  category: string;
  establishedInChapter: number;
  visibility: string;
}

export interface CharacterKnowledgeRecord {
  factId: string;
  character: string;
  knowledgeLevel: string;
  learnedInChapter: number;
  sourceType: string;
  sourceCharacter: string;
  evidence: string;
}

export interface ContinuityLedger {
  time: string;
  characterLocations: Record<string, string>;
  characterConditions: Record<string, string>;
  resources: Record<string, string>;
}

export interface ContinuityContextPackage {
  contextVersion: number;
  contextHash: string;
  novelTitle: string;
  creativeGenre: string;
  creativePremise: string;
  creativeTheme: string;
  worldSetting: WorldSetting | null;
  characters: Character[];
  foundationContext?: {
    creativeCharter: CreativeCharter;
    relationshipMap: RelationshipMap;
    storyArchitecture: StoryArchitecture;
    narrativePlan: NarrativePlan;
    styleGuide: StyleGuide;
    continuityBaseline: ContinuityBaseline;
    registry: FoundationRegistry;
    snapshot: FoundationSnapshot;
  };
  chapterFoundationDirective?: ChapterFoundationDirective;
  targetChapter: number;
  immediatePredecessor: ApprovedChapterRecord | null;
  recentChapterSummaries: Array<{
    chapterNumber: number;
    title: string;
    summary: string;
    endingExcerpt: string;
  }>;
  facts: NarrativeFactRecord[];
  characterKnowledge: CharacterKnowledgeRecord[];
  characterArcs: Record<string, string>;
  activeForeshadowings: Array<{
    id: string;
    description: string;
    plantedInChapter: number;
  }>;
  continuity: ContinuityLedger;
  targetOutline: ChapterOutline | null;
  planningHorizon: Array<{
    chapterNumber: number;
    title: string;
    summary: string;
    chapterGoal: string;
    conflict: string;
    turningPoint: string;
    chapterHook: string;
    storyArcIds: string[];
    foreshadowingToPlant: string[];
    foreshadowingToReinforce: string[];
    foreshadowingToPayOff: string[];
    revealedSecretIds: string[];
    revealedFactIds: string[];
  }>;
}

export function buildContinuityContext(
  state: GraphNovelState,
  targetChapter: number,
): ContinuityContextPackage {
  if (!Number.isInteger(targetChapter) || targetChapter < 1) {
    throw new Error("targetChapter must be a positive integer");
  }
  assertFoundationSnapshotCurrent(state);

  const approved = state.approvedChapters
    .filter((chapter) => chapter.chapterNumber < targetChapter)
    .slice()
    .sort((left, right) => left.chapterNumber - right.chapterNumber);
  const predecessor = approved.at(-1) ?? null;
  const outline = state.novelOutline?.chapterOutlines.find(
    (chapter) => chapter.chapterNumber === targetChapter,
  ) ?? buildRollingChapterOutline(state, targetChapter) ?? undefined;
  const enhancedFoundation = state.foundationSnapshot && state.foundationRegistry
    && state.creativeCharter && state.relationshipMap
    && state.storyArchitecture && state.narrativePlan && state.styleGuide
    && state.continuityBaseline
    ? {
        creativeCharter: state.creativeCharter,
        relationshipMap: state.relationshipMap,
        storyArchitecture: state.storyArchitecture,
        narrativePlan: state.narrativePlan,
        styleGuide: state.styleGuide,
        continuityBaseline: state.continuityBaseline,
        registry: state.foundationRegistry,
        snapshot: state.foundationSnapshot,
      }
    : null;
  const chapterFoundationDirective = enhancedFoundation && outline
    ? buildChapterFoundationDirective(enhancedFoundation, outline, targetChapter, state.worldSetting!, state.characters)
    : null;
  const planningHorizon = Array.from(
    { length: Math.min(8, Math.max(0, state.targetTotalChapters - targetChapter + 1)) },
    (_, index) => targetChapter + index,
  ).map((chapterNumber) => state.novelOutline?.chapterOutlines.find((chapter) => chapter.chapterNumber === chapterNumber)
      ?? buildRollingChapterOutline(state, chapterNumber))
    .filter((chapter): chapter is ChapterOutline => Boolean(chapter))
    .map((chapter) => ({
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      summary: chapter.summary,
      chapterGoal: chapter.chapterGoal ?? "",
      conflict: chapter.conflict ?? "",
      turningPoint: chapter.turningPoint ?? "",
      chapterHook: chapter.chapterHook ?? "",
      storyArcIds: [...(chapter.storyArcIds ?? [])],
      foreshadowingToPlant: [...chapter.foreshadowingToPlant],
      foreshadowingToReinforce: [...(chapter.foreshadowingToReinforce ?? [])],
      foreshadowingToPayOff: [...chapter.foreshadowingToPayOff],
      revealedSecretIds: [...(chapter.revealedSecretIds ?? [])],
      revealedFactIds: [...(chapter.revealedFactIds ?? [])],
    }));
  const payload: Omit<ContinuityContextPackage, "contextHash"> = {
    contextVersion: enhancedFoundation ? CONTINUITY_CONTEXT_VERSION : 1,
    novelTitle: state.novelTitle,
    creativeGenre: state.creativeGenre,
    creativePremise: state.creativePremise,
    creativeTheme: state.creativeTheme,
    worldSetting: state.worldSetting,
    characters: state.characters.map((character) => ({ ...character })),
    ...(enhancedFoundation ? { foundationContext: enhancedFoundation } : {}),
    ...(chapterFoundationDirective ? { chapterFoundationDirective } : {}),
    targetChapter,
    immediatePredecessor: predecessor,
    recentChapterSummaries: approved.slice(-8).map((chapter) => ({
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      summary: chapter.summary,
      endingExcerpt: chapter.endingExcerpt,
    })),
    facts: state.narrativeFacts.slice(-120),
    characterKnowledge: state.characterKnowledge.slice(-180),
    characterArcs: { ...state.characterArcs },
    activeForeshadowings: state.foreshadowings
      .filter((item) => item.status !== "paid_off")
      .slice(-50),
    continuity: {
      time: state.continuity.time,
      characterLocations: { ...state.continuity.characterLocations },
      characterConditions: { ...state.continuity.characterConditions },
      resources: { ...state.continuity.resources },
    },
    targetOutline: outline ? cloneChapterOutline(outline) : null,
    planningHorizon,
  };

  return {
    ...payload,
    contextHash: hashContinuityContext(payload),
  };
}

export function directiveScopedContinuityContext(
  context: ContinuityContextPackage,
): Omit<ContinuityContextPackage, "foundationContext"> {
  const { foundationContext: _foundationContext, ...scoped } = context;
  return scoped;
}

function buildChapterFoundationDirective(
  foundation: NonNullable<ContinuityContextPackage["foundationContext"]>,
  outline: ChapterOutline,
  targetChapter: number,
  worldSetting: WorldSetting,
  characters: Character[],
): ChapterFoundationDirective {
  const unique = (values: Array<string | undefined>): string[] => [...new Set(values.filter((value): value is string => Boolean(value)))];
  const characterIds = unique([outline.povCharacterId, ...(outline.involvedCharacterIds ?? [])]);
  const locationIds = unique(outline.locationIds ?? []);
  const factionIds = unique(outline.factionIds ?? []);
  const systemIds = unique(outline.requiredSystemIds ?? []);
  const ruleIds = unique(outline.requiredRuleIds ?? []);
  const storyArcIds = unique(outline.storyArcIds ?? []);
  const secretIds = unique(outline.revealedSecretIds ?? []);
  const factIds = unique(outline.revealedFactIds ?? []);
  const foreshadowingIds = unique([
    ...outline.foreshadowingToPlant,
    ...(outline.foreshadowingToReinforce ?? []),
    ...outline.foreshadowingToPayOff,
  ]);
  const characterSet = new Set(characterIds);
  const references = {
    characterIds, locationIds, factionIds, systemIds, ruleIds, storyArcIds,
    secretIds, factIds, foreshadowingIds,
  };
  const payload: Omit<ChapterFoundationDirective, "directiveHash"> = {
    version: 1,
    sourceSnapshotHash: foundation.snapshot.snapshotHash,
    sourceDocuments: { ...foundation.snapshot.documentHashes },
    references,
    creativeCharter: foundation.creativeCharter,
    worldSetting: {
      ...worldSetting,
      keyLocations: (worldSetting.keyLocations ?? []).filter((item) => locationIds.includes(item.locationId)),
      factions: (worldSetting.factions ?? []).filter((item) => factionIds.includes(item.factionId)),
      powerSystem: worldSetting.powerSystem && systemIds.includes(worldSetting.powerSystem.systemId)
        ? worldSetting.powerSystem
        : undefined,
      rules: (worldSetting.rules ?? []).filter((item) => ruleIds.includes(item.ruleId)),
    },
    characters: characters.filter((item) => item.characterId && characterSet.has(item.characterId)),
    relationshipMap: {
      relationships: foundation.relationshipMap.relationships.filter((item) =>
        Boolean(item.fromCharacterId && item.toCharacterId && characterSet.has(item.fromCharacterId) && characterSet.has(item.toCharacterId))),
      secrets: foundation.relationshipMap.secrets.filter((item) => secretIds.includes(item.secretId)),
    },
    storyArchitecture: {
      ...foundation.storyArchitecture,
      storyArcs: foundation.storyArchitecture.storyArcs.filter((item) => item.arcId && storyArcIds.includes(item.arcId)),
      characterArcMilestones: foundation.storyArchitecture.characterArcMilestones.filter((item) => item.characterId && characterSet.has(item.characterId)),
    },
    narrativePlan: {
      ...foundation.narrativePlan,
      foreshadowingPlan: foundation.narrativePlan.foreshadowingPlan.filter((item) => foreshadowingIds.includes(item.id)),
      revelationPlan: foundation.narrativePlan.revelationPlan.filter((item) => factIds.includes(item.factId)),
    },
    targetOutline: cloneChapterOutline(outline),
    styleGuide: foundation.styleGuide,
    continuityBaseline: targetChapter === 1 ? foundation.continuityBaseline : null,
  };
  return { ...payload, directiveHash: hashValue(payload) };
}

function cloneChapterOutline(outline: ChapterOutline): ChapterOutline {
  return {
    ...outline,
    keyEvents: [...outline.keyEvents],
    foreshadowingToPlant: [...outline.foreshadowingToPlant],
    foreshadowingToReinforce: [...(outline.foreshadowingToReinforce ?? [])],
    foreshadowingToPayOff: [...outline.foreshadowingToPayOff],
    causalPrerequisites: [...(outline.causalPrerequisites ?? [])],
    involvedCharacterIds: [...(outline.involvedCharacterIds ?? [])],
    locationIds: [...(outline.locationIds ?? [])],
    factionIds: [...(outline.factionIds ?? [])],
    requiredSystemIds: [...(outline.requiredSystemIds ?? [])],
    requiredRuleIds: [...(outline.requiredRuleIds ?? [])],
    storyArcIds: [...(outline.storyArcIds ?? [])],
    revealedSecretIds: [...(outline.revealedSecretIds ?? [])],
    revealedFactIds: [...(outline.revealedFactIds ?? [])],
  };
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function hashContinuityContext(
  context: Omit<ContinuityContextPackage, "contextHash">,
): string {
  return hashValue(context);
}
