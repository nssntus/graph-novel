import type {
  Character,
  ContinuityBaseline,
  CreativeCharter,
  FoundationReview,
  FoundationRewriteTarget,
  NarrativePlan,
  NovelOutline,
  RelationshipMap,
  StoryArchitecture,
  StyleGuide,
  WorldSetting,
} from "../state/foundation.js";

export class OutputContractError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "OutputContractError";
    this.path = path;
  }
}

export function parseCreativeCharter(text: string): CreativeCharter {
  const value = recordFromJson(text, "creative_charter");
  return {
    targetAudience: requiredString(value.targetAudience, "creative_charter.targetAudience"),
    genrePromise: requiredString(value.genrePromise, "creative_charter.genrePromise"),
    coreAppeal: requiredString(value.coreAppeal, "creative_charter.coreAppeal"),
    emotionalPromise: requiredString(value.emotionalPromise, "creative_charter.emotionalPromise"),
    themes: requiredStringArray(value.themes, "creative_charter.themes", true),
    contentBoundaries: requiredStringArray(value.contentBoundaries, "creative_charter.contentBoundaries", true),
    successCriteria: requiredStringArray(value.successCriteria, "creative_charter.successCriteria", true),
  };
}

export function parseWorldSetting(text: string): WorldSetting {
  const value = recordFromJson(text, "world_setting");
  const base = {
    era: requiredString(value.era, "world_setting.era"),
    location: requiredString(value.location, "world_setting.location"),
    magicSystem: requiredString(value.magicSystem, "world_setting.magicSystem"),
    technologyLevel: requiredString(value.technologyLevel, "world_setting.technologyLevel"),
    socialStructure: requiredString(value.socialStructure, "world_setting.socialStructure"),
    rulesAndLaws: requiredString(value.rulesAndLaws, "world_setting.rulesAndLaws"),
    history: requiredString(value.history, "world_setting.history"),
  };
  const powerSystem = requiredRecord(value.powerSystem, "world_setting.powerSystem");
  return {
    ...base,
    keyLocations: requiredRecordArray(value.keyLocations, "world_setting.keyLocations", true).map((item, index) => ({
      locationId: requiredId(item.locationId, `world_setting.keyLocations[${index}].locationId`),
      name: requiredString(item.name, `world_setting.keyLocations[${index}].name`),
      roleInStory: requiredString(item.roleInStory, `world_setting.keyLocations[${index}].roleInStory`),
      distinguishingFeatures: requiredString(item.distinguishingFeatures, `world_setting.keyLocations[${index}].distinguishingFeatures`),
      accessConstraints: requiredString(item.accessConstraints, `world_setting.keyLocations[${index}].accessConstraints`),
    })),
    factions: requiredRecordArray(value.factions, "world_setting.factions", true).map((item, index) => ({
      factionId: requiredId(item.factionId, `world_setting.factions[${index}].factionId`),
      name: requiredString(item.name, `world_setting.factions[${index}].name`),
      goal: requiredString(item.goal, `world_setting.factions[${index}].goal`),
      resources: requiredString(item.resources, `world_setting.factions[${index}].resources`),
      relationshipToProtagonist: requiredString(item.relationshipToProtagonist, `world_setting.factions[${index}].relationshipToProtagonist`),
    })),
    powerSystem: {
      systemId: requiredId(powerSystem.systemId, "world_setting.powerSystem.systemId"),
      source: requiredString(powerSystem.source, "world_setting.powerSystem.source"),
      capabilities: requiredString(powerSystem.capabilities, "world_setting.powerSystem.capabilities"),
      limitations: requiredString(powerSystem.limitations, "world_setting.powerSystem.limitations"),
      costs: requiredString(powerSystem.costs, "world_setting.powerSystem.costs"),
      progression: requiredString(powerSystem.progression, "world_setting.powerSystem.progression"),
    },
    rules: requiredRecordArray(value.rules, "world_setting.rules", true).map((item, index) => ({
      ruleId: requiredId(item.ruleId, `world_setting.rules[${index}].ruleId`),
      statement: requiredString(item.statement, `world_setting.rules[${index}].statement`),
      consequence: requiredString(item.consequence, `world_setting.rules[${index}].consequence`),
    })),
  };
}

export function parseCharacters(text: string): Character[] {
  const value = parseJson(text, "characters");
  if (!Array.isArray(value) || value.length === 0) {
    throw new OutputContractError("characters", "必须是非空数组");
  }
  const characters = value.map((item, index) => {
    const path = `characters[${index}]`;
    assertRecord(item, path);
    return {
      characterId: requiredId(item.characterId, `${path}.characterId`),
      name: requiredString(item.name, `${path}.name`),
      role: requiredString(item.role, `${path}.role`),
      background: requiredString(item.background, `${path}.background`),
      personality: requiredString(item.personality, `${path}.personality`),
      motivation: requiredString(item.motivation, `${path}.motivation`),
      arcDescription: requiredString(item.arcDescription, `${path}.arcDescription`),
      fear: requiredString(item.fear, `${path}.fear`),
      secrets: requiredRecordArray(item.secrets, `${path}.secrets`).map((secret, secretIndex) => ({
        secretId: requiredId(secret.secretId, `${path}.secrets[${secretIndex}].secretId`),
        content: requiredString(secret.content, `${path}.secrets[${secretIndex}].content`),
      })),
      strengths: requiredStringArray(item.strengths, `${path}.strengths`, true),
      weaknesses: requiredStringArray(item.weaknesses, `${path}.weaknesses`, true),
      abilities: requiredStringArray(item.abilities, `${path}.abilities`, true),
      voice: requiredString(item.voice, `${path}.voice`),
      firstAppearance: requiredString(item.firstAppearance, `${path}.firstAppearance`),
    };
  });
  if (new Set(characters.map((item) => item.name)).size !== characters.length) {
    throw new OutputContractError("characters", "角色姓名不得重复");
  }
  return characters;
}

export function parseRelationshipMap(text: string): RelationshipMap {
  const value = recordFromJson(text, "relationship_map");
  return {
    relationships: requiredRecordArray(value.relationships, "relationship_map.relationships").map((item, index) => {
      const path = `relationship_map.relationships[${index}]`;
      return {
        fromCharacterId: requiredId(item.fromCharacterId, `${path}.fromCharacterId`),
        toCharacterId: requiredId(item.toCharacterId, `${path}.toCharacterId`),
        nature: requiredString(item.nature, `${path}.nature`),
        currentState: requiredString(item.currentState, `${path}.currentState`),
        tension: requiredString(item.tension, `${path}.tension`),
        hiddenInformation: requiredString(item.hiddenInformation, `${path}.hiddenInformation`),
      };
    }),
    secrets: requiredRecordArray(value.secrets, "relationship_map.secrets").map((item, index) => {
      const path = `relationship_map.secrets[${index}]`;
      return {
        secretId: requiredId(item.secretId, `${path}.secretId`),
        holders: requiredIdArray(item.holders, `${path}.holders`, true),
        affectedCharacters: requiredIdArray(item.affectedCharacters, `${path}.affectedCharacters`, true),
        plannedReveal: requiredString(item.plannedReveal, `${path}.plannedReveal`),
        plannedRevealChapter: requiredPositiveInteger(item.plannedRevealChapter, `${path}.plannedRevealChapter`),
      };
    }),
  };
}

export function parseStoryArchitecture(text: string): StoryArchitecture {
  const value = recordFromJson(text, "story_architecture");
  return {
    centralConflict: requiredString(value.centralConflict, "story_architecture.centralConflict"),
    stakes: requiredString(value.stakes, "story_architecture.stakes"),
    endingDirection: requiredString(value.endingDirection, "story_architecture.endingDirection"),
    storyArcs: requiredRecordArray(value.storyArcs, "story_architecture.storyArcs", true).map((item, index) => {
      const path = `story_architecture.storyArcs[${index}]`;
      return {
        arcId: requiredId(item.arcId, `${path}.arcId`),
        name: requiredString(item.name, `${path}.name`),
        chapterRange: requiredString(item.chapterRange, `${path}.chapterRange`),
        objective: requiredString(item.objective, `${path}.objective`),
        opposition: requiredString(item.opposition, `${path}.opposition`),
        turningPoint: requiredString(item.turningPoint, `${path}.turningPoint`),
        outcome: requiredString(item.outcome, `${path}.outcome`),
      };
    }),
    characterArcMilestones: requiredRecordArray(value.characterArcMilestones, "story_architecture.characterArcMilestones", true).map((item, index) => {
      const path = `story_architecture.characterArcMilestones[${index}]`;
      return {
        characterId: requiredId(item.characterId, `${path}.characterId`),
        startingState: requiredString(item.startingState, `${path}.startingState`),
        milestones: requiredStringArray(item.milestones, `${path}.milestones`, true),
        endingState: requiredString(item.endingState, `${path}.endingState`),
      };
    }),
  };
}

export function parseNarrativePlan(text: string): NarrativePlan {
  const value = recordFromJson(text, "narrative_plan");
  return {
    pacingPrinciples: requiredStringArray(value.pacingPrinciples, "narrative_plan.pacingPrinciples", true),
    payoffSchedule: requiredRecordArray(value.payoffSchedule, "narrative_plan.payoffSchedule", true).map((item, index) => {
      const path = `narrative_plan.payoffSchedule[${index}]`;
      return {
        chapterRange: requiredString(item.chapterRange, `${path}.chapterRange`),
        type: requiredString(item.type, `${path}.type`),
        setup: requiredString(item.setup, `${path}.setup`),
        payoff: requiredString(item.payoff, `${path}.payoff`),
      };
    }),
    foreshadowingPlan: requiredRecordArray(value.foreshadowingPlan, "narrative_plan.foreshadowingPlan").map((item, index) => {
      const path = `narrative_plan.foreshadowingPlan[${index}]`;
      return {
        id: requiredId(item.id, `${path}.id`),
        description: requiredString(item.description, `${path}.description`),
        plantChapter: requiredPositiveInteger(item.plantChapter, `${path}.plantChapter`),
        reinforceChapters: requiredPositiveIntegerArray(item.reinforceChapters, `${path}.reinforceChapters`),
        payoffChapter: requiredPositiveInteger(item.payoffChapter, `${path}.payoffChapter`),
        payoff: requiredString(item.payoff, `${path}.payoff`),
      };
    }),
    revelationPlan: requiredRecordArray(value.revelationPlan, "narrative_plan.revelationPlan").map((item, index) => {
      const path = `narrative_plan.revelationPlan[${index}]`;
      return {
        factId: requiredId(item.factId, `${path}.factId`),
        information: requiredString(item.information, `${path}.information`),
        knownInitiallyBy: requiredIdArray(item.knownInitiallyBy, `${path}.knownInitiallyBy`),
        revealTo: requiredIdArray(item.revealTo, `${path}.revealTo`, true),
        earliestChapter: requiredPositiveInteger(item.earliestChapter, `${path}.earliestChapter`),
        method: requiredString(item.method, `${path}.method`),
      };
    }),
  };
}

export function parseNovelOutline(text: string): NovelOutline {
  const value = recordFromJson(text, "novel_outline");
  const chapters = requiredRecordArray(value.chapterOutlines, "novel_outline.chapterOutlines");
  return {
    genre: requiredString(value.genre, "novel_outline.genre"),
    premise: requiredString(value.premise, "novel_outline.premise"),
    theme: requiredString(value.theme, "novel_outline.theme"),
    targetLength: requiredString(value.targetLength, "novel_outline.targetLength"),
    chapterOutlines: chapters.map((item, index) => parseChapterOutline(item, index)),
  };
}

export function parseStyleGuide(text: string): StyleGuide {
  const value = recordFromJson(text, "style_guide");
  return {
    pointOfView: requiredString(value.pointOfView, "style_guide.pointOfView"),
    tense: requiredString(value.tense, "style_guide.tense"),
    tone: requiredString(value.tone, "style_guide.tone"),
    proseStyle: requiredString(value.proseStyle, "style_guide.proseStyle"),
    dialogueStyle: requiredString(value.dialogueStyle, "style_guide.dialogueStyle"),
    pacing: requiredString(value.pacing, "style_guide.pacing"),
    chapterOpening: requiredString(value.chapterOpening, "style_guide.chapterOpening"),
    chapterEnding: requiredString(value.chapterEnding, "style_guide.chapterEnding"),
    forbiddenPatterns: requiredStringArray(value.forbiddenPatterns, "style_guide.forbiddenPatterns", true),
  };
}

export function parseContinuityBaseline(text: string): ContinuityBaseline {
  const value = recordFromJson(text, "continuity_baseline");
  return {
    storyTime: requiredString(value.storyTime, "continuity_baseline.storyTime"),
    characterLocations: requiredStringRecord(value.characterLocations, "continuity_baseline.characterLocations"),
    characterConditions: requiredStringRecord(value.characterConditions, "continuity_baseline.characterConditions"),
    resources: requiredStringRecord(value.resources, "continuity_baseline.resources"),
    initialFacts: requiredRecordArray(value.initialFacts, "continuity_baseline.initialFacts", true).map((item, index) => {
      const path = `continuity_baseline.initialFacts[${index}]`;
      return {
        factId: requiredId(item.factId, `${path}.factId`),
        statement: requiredString(item.statement, `${path}.statement`),
        category: requiredString(item.category, `${path}.category`),
        visibility: requiredString(item.visibility, `${path}.visibility`),
      };
    }),
    initialKnowledge: requiredRecordArray(value.initialKnowledge, "continuity_baseline.initialKnowledge").map((item, index) => {
      const path = `continuity_baseline.initialKnowledge[${index}]`;
      return {
        factId: requiredId(item.factId, `${path}.factId`),
        characterId: requiredId(item.characterId, `${path}.characterId`),
        knowledgeLevel: requiredString(item.knowledgeLevel, `${path}.knowledgeLevel`),
        sourceType: requiredString(item.sourceType, `${path}.sourceType`),
        sourceCharacterId: optionalId(item.sourceCharacterId, `${path}.sourceCharacterId`),
        evidence: requiredString(item.evidence, `${path}.evidence`),
      };
    }),
  };
}

export function parseFoundationReview(text: string): FoundationReview {
  const value = recordFromJson(text, "foundation_review");
  const passed = requiredBoolean(value.passed, "foundation_review.passed");
  const issues = requiredRecordArray(value.issues, "foundation_review.issues").map((item, index) => ({
    target: rewriteTarget(item.target, `foundation_review.issues[${index}].target`),
    severity: requiredString(item.severity, `foundation_review.issues[${index}].severity`),
    message: requiredString(item.message, `foundation_review.issues[${index}].message`),
  }));
  const rewriteTargets = requiredStringArray(value.rewriteTargets, "foundation_review.rewriteTargets")
    .map((item, index) => rewriteTarget(item, `foundation_review.rewriteTargets[${index}]`));
  if (passed && (issues.length > 0 || rewriteTargets.length > 0)) {
    throw new OutputContractError("foundation_review", "通过时 issues 和 rewriteTargets 必须为空");
  }
  if (!passed && (issues.length === 0 || rewriteTargets.length === 0)) {
    throw new OutputContractError("foundation_review", "未通过时必须给出问题和重写节点");
  }
  return {
    passed,
    score: boundedNumber(value.score, 0, 100, "foundation_review.score"),
    summary: requiredString(value.summary, "foundation_review.summary"),
    issues,
    rewriteTargets: [...new Set(rewriteTargets)],
  };
}

function parseChapterOutline(value: Record<string, unknown>, index: number) {
  const path = `novel_outline.chapterOutlines[${index}]`;
  return {
    chapterNumber: requiredPositiveInteger(value.chapterNumber, `${path}.chapterNumber`),
    title: requiredString(value.title, `${path}.title`),
    summary: requiredString(value.summary, `${path}.summary`),
    keyEvents: requiredStringArray(value.keyEvents, `${path}.keyEvents`, true),
    foreshadowingToPlant: requiredIdArray(value.foreshadowingToPlant, `${path}.foreshadowingToPlant`),
    foreshadowingToPayOff: requiredIdArray(value.foreshadowingToPayOff, `${path}.foreshadowingToPayOff`),
    povCharacter: requiredString(value.povCharacter, `${path}.povCharacter`),
    povCharacterId: requiredId(value.povCharacterId, `${path}.povCharacterId`),
    chapterGoal: requiredString(value.chapterGoal, `${path}.chapterGoal`),
    conflict: requiredString(value.conflict, `${path}.conflict`),
    causalPrerequisites: requiredStringArray(value.causalPrerequisites, `${path}.causalPrerequisites`),
    turningPoint: requiredString(value.turningPoint, `${path}.turningPoint`),
    payoff: requiredString(value.payoff, `${path}.payoff`),
    chapterHook: requiredString(value.chapterHook, `${path}.chapterHook`),
    involvedCharacterIds: requiredIdArray(value.involvedCharacterIds, `${path}.involvedCharacterIds`, true),
    locationIds: requiredIdArray(value.locationIds, `${path}.locationIds`, true),
    factionIds: requiredIdArray(value.factionIds, `${path}.factionIds`),
    requiredSystemIds: requiredIdArray(value.requiredSystemIds, `${path}.requiredSystemIds`),
    requiredRuleIds: requiredIdArray(value.requiredRuleIds, `${path}.requiredRuleIds`, true),
    storyArcIds: requiredIdArray(value.storyArcIds, `${path}.storyArcIds`, true),
    revealedSecretIds: requiredIdArray(value.revealedSecretIds, `${path}.revealedSecretIds`),
    revealedFactIds: requiredIdArray(value.revealedFactIds, `${path}.revealedFactIds`),
  };
}

function recordFromJson(text: string, name: string): Record<string, unknown> {
  const value = parseJson(text, name);
  assertRecord(value, name);
  return value;
}

function parseJson(text: string, contractName: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new OutputContractError(contractName, `不是合法 JSON（${detail}）`);
  }
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OutputContractError(path, "必须是对象");
  }
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  assertRecord(value, path);
  return value;
}

function requiredRecordArray(value: unknown, path: string, nonEmpty = false): Record<string, unknown>[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new OutputContractError(path, nonEmpty ? "必须是非空数组" : "必须是数组");
  }
  return value.map((item, index) => requiredRecord(item, `${path}[${index}]`));
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new OutputContractError(path, "必须是非空字符串");
  }
  return value.trim();
}

function requiredId(value: unknown, path: string): string {
  const id = requiredString(value, path);
  if (!/^[a-z][a-z0-9_:-]*$/.test(id)) {
    throw new OutputContractError(path, "必须是稳定的 ASCII ID（小写字母开头）");
  }
  return id;
}

function optionalId(value: unknown, path: string): string {
  if (value === "") return "";
  return requiredId(value, path);
}

function requiredIdArray(value: unknown, path: string, nonEmpty = false): string[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new OutputContractError(path, nonEmpty ? "必须是非空数组" : "必须是数组");
  }
  return value.map((item, index) => requiredId(item, `${path}[${index}]`));
}

function requiredStringArray(value: unknown, path: string, nonEmpty = false): string[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new OutputContractError(path, nonEmpty ? "必须是非空数组" : "必须是数组");
  }
  return value.map((item, index) => requiredString(item, `${path}[${index}]`));
}

function requiredPositiveIntegerArray(value: unknown, path: string): number[] {
  if (!Array.isArray(value)) throw new OutputContractError(path, "必须是数组");
  return value.map((item, index) => requiredPositiveInteger(item, `${path}[${index}]`));
}

function requiredStringRecord(value: unknown, path: string): Record<string, string> {
  const record = requiredRecord(value, path);
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, requiredString(item, `${path}.${key}`)]));
}

function requiredPositiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new OutputContractError(path, "必须是正整数");
  }
  return value;
}

function requiredBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new OutputContractError(path, "必须是布尔值");
  return value;
}

function boundedNumber(value: unknown, minimum: number, maximum: number, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new OutputContractError(path, `必须是 ${minimum}-${maximum} 之间的数字`);
  }
  return value;
}

const FOUNDATION_REWRITE_TARGETS = new Set<FoundationRewriteTarget>([
  "creative_charter", "world_building", "character_design", "relationship_design",
  "story_architecture", "narrative_planning", "outline_planning", "style_design",
  "continuity_baseline",
]);

function rewriteTarget(value: unknown, path: string): FoundationRewriteTarget {
  const target = requiredString(value, path) as FoundationRewriteTarget;
  if (!FOUNDATION_REWRITE_TARGETS.has(target)) {
    throw new OutputContractError(path, "不是允许的 Foundation 重写节点");
  }
  return target;
}
