export interface CreativeCharter {
  targetAudience: string;
  genrePromise: string;
  coreAppeal: string;
  emotionalPromise: string;
  themes: string[];
  contentBoundaries: string[];
  successCriteria: string[];
}

export interface WorldLocation {
  locationId: string;
  name: string;
  roleInStory: string;
  distinguishingFeatures: string;
  accessConstraints: string;
}

export interface WorldFaction {
  factionId: string;
  name: string;
  goal: string;
  resources: string;
  relationshipToProtagonist: string;
}

export interface PowerSystem {
  systemId: string;
  source: string;
  capabilities: string;
  limitations: string;
  costs: string;
  progression: string;
}

export interface WorldRule {
  ruleId: string;
  statement: string;
  consequence: string;
}

export interface WorldSetting {
  era: string;
  location: string;
  magicSystem: string;
  technologyLevel: string;
  socialStructure: string;
  rulesAndLaws: string;
  history: string;
  keyLocations?: WorldLocation[];
  factions?: WorldFaction[];
  powerSystem?: PowerSystem;
  rules?: WorldRule[];
}

export interface Character {
  characterId?: string;
  name: string;
  role: string;
  background: string;
  personality: string;
  motivation: string;
  arcDescription: string;
  fear?: string;
  secret?: string;
  secrets?: Array<{
    secretId: string;
    content: string;
  }>;
  strengths?: string[];
  weaknesses?: string[];
  abilities?: string[];
  voice?: string;
  firstAppearance?: string;
}

export interface CharacterRelationship {
  fromCharacterId?: string;
  toCharacterId?: string;
  from?: string;
  to?: string;
  nature: string;
  currentState: string;
  tension: string;
  hiddenInformation: string;
}

export interface StorySecret {
  secretId: string;
  content?: string;
  holders: string[];
  affectedCharacters: string[];
  plannedReveal: string;
  plannedRevealChapter?: number;
}

export interface RelationshipMap {
  relationships: CharacterRelationship[];
  secrets: StorySecret[];
}

export interface StoryArc {
  arcId?: string;
  name: string;
  chapterRange: string;
  objective: string;
  opposition: string;
  turningPoint: string;
  outcome: string;
}

export interface CharacterArcMilestone {
  characterId?: string;
  character?: string;
  startingState: string;
  milestones: string[];
  endingState: string;
}

export interface StoryArchitecture {
  centralConflict: string;
  stakes: string;
  endingDirection: string;
  storyArcs: StoryArc[];
  characterArcMilestones: CharacterArcMilestone[];
}

export interface PayoffScheduleItem {
  chapterRange: string;
  type: string;
  setup: string;
  payoff: string;
}

export interface ForeshadowingPlanItem {
  id: string;
  description: string;
  plantChapter: number;
  reinforceChapters: number[];
  payoffChapter: number;
  payoff: string;
}

export interface RevelationPlanItem {
  factId: string;
  information: string;
  knownInitiallyBy: string[];
  revealTo: string[];
  earliestChapter: number;
  method: string;
}

export interface NarrativePlan {
  pacingPrinciples: string[];
  payoffSchedule: PayoffScheduleItem[];
  foreshadowingPlan: ForeshadowingPlanItem[];
  revelationPlan: RevelationPlanItem[];
}

export interface ChapterOutline {
  chapterNumber: number;
  title: string;
  summary: string;
  keyEvents: string[];
  foreshadowingToPlant: string[];
  foreshadowingToPayOff: string[];
  povCharacter?: string;
  povCharacterId?: string;
  chapterGoal?: string;
  conflict?: string;
  causalPrerequisites?: string[];
  turningPoint?: string;
  payoff?: string;
  chapterHook?: string;
  involvedCharacterIds?: string[];
  locationIds?: string[];
  factionIds?: string[];
  requiredSystemIds?: string[];
  requiredRuleIds?: string[];
  storyArcIds?: string[];
  revealedSecretIds?: string[];
  revealedFactIds?: string[];
}

export interface NovelOutline {
  genre: string;
  premise: string;
  theme: string;
  targetLength: string;
  chapterOutlines: ChapterOutline[];
}

export interface CharacterVoiceGuide {
  characterId?: string;
  character?: string;
  voice: string;
}

export interface StyleGuide {
  pointOfView: string;
  tense: string;
  tone: string;
  proseStyle: string;
  dialogueStyle: string;
  pacing: string;
  chapterOpening: string;
  chapterEnding: string;
  forbiddenPatterns: string[];
  characterVoices?: CharacterVoiceGuide[];
}

export interface BaselineFact {
  factId: string;
  statement: string;
  category: string;
  visibility: string;
}

export interface BaselineKnowledge {
  factId: string;
  characterId?: string;
  character?: string;
  knowledgeLevel: string;
  sourceType: string;
  sourceCharacterId?: string;
  sourceCharacter?: string;
  evidence: string;
}

export interface ContinuityBaseline {
  storyTime: string;
  characterLocations: Record<string, string>;
  characterConditions: Record<string, string>;
  resources: Record<string, string>;
  initialFacts: BaselineFact[];
  initialKnowledge: BaselineKnowledge[];
}

export type FoundationRewriteTarget =
  | "creative_charter"
  | "world_building"
  | "character_design"
  | "relationship_design"
  | "story_architecture"
  | "narrative_planning"
  | "outline_planning"
  | "style_design"
  | "continuity_baseline";

export interface FoundationReviewIssue {
  target: FoundationRewriteTarget;
  severity: string;
  message: string;
}

export interface FoundationReview {
  passed: boolean;
  score: number;
  summary: string;
  issues: FoundationReviewIssue[];
  rewriteTargets: FoundationRewriteTarget[];
}
