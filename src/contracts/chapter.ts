import type { ContinuityContextPackage } from "../state/continuity.js";

export class ChapterContractError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ChapterContractError";
    this.path = path;
  }
}

export type KnowledgeLevel = "heard" | "suspected" | "inferred" | "confirmed";
export type SourceType = "observed" | "told" | "inferred" | "public" | "document";

export interface OpeningBridge {
  previousChapter: number;
  inheritedEndpoint: string;
  transitionSteps: string[];
  firstSceneStart: string;
  carryOverThreads: string[];
}

export interface CausalLink {
  cause: string;
  event: string;
  effect: string;
}

export interface PlannedFact {
  factId: string;
  statement: string;
  category: string;
  visibility: string;
}

export interface InformationFlow {
  factId: string;
  character: string;
  knowledgeLevel: KnowledgeLevel;
  sourceType: SourceType;
  sourceCharacter: string;
  evidence: string;
}

export interface FoundationObligations {
  revealedSecretIds: string[];
  revealedFactIds: string[];
  foreshadowingToPlant: string[];
  foreshadowingToReinforce: string[];
  foreshadowingToPayOff: string[];
}

export interface ChapterPlan {
  contextHash: string;
  foundationDirectiveHash?: string;
  chapterNumber: number;
  title: string;
  openingBridge: OpeningBridge;
  causalChain: CausalLink[];
  requiredFactIds: string[];
  plannedFacts: PlannedFact[];
  informationFlow: InformationFlow[];
  foundationObligations?: FoundationObligations;
}

const KNOWLEDGE_RANK: Record<KnowledgeLevel, number> = {
  heard: 1,
  suspected: 2,
  inferred: 3,
  confirmed: 4,
};

export function parseChapterPlan(
  text: string,
  expectedChapter: number,
  context: ContinuityContextPackage,
): ChapterPlan {
  const value = parseJson(text);
  assertRecord(value, "chapter_plan");
  return parseChapterPlanValue(value, expectedChapter, context, false);
}

export function parseGeneratedChapterPlan(
  text: string,
  expectedChapter: number,
  context: ContinuityContextPackage,
): ChapterPlan {
  const value = parseJson(text);
  assertRecord(value, "chapter_plan");
  return parseChapterPlanValue({
    ...value,
    contextHash: context.contextHash,
    foundationDirectiveHash: context.chapterFoundationDirective?.directiveHash,
    chapterNumber: expectedChapter,
  }, expectedChapter, context, true);
}

function parseChapterPlanValue(
  value: Record<string, unknown>,
  expectedChapter: number,
  context: ContinuityContextPackage,
  generated: boolean,
): ChapterPlan {
  const foundationDirectiveHash = parseFoundationDirectiveHash(value.foundationDirectiveHash, context);
  let plan: ChapterPlan = {
    contextHash: requiredString(value.contextHash, "chapter_plan.contextHash"),
    ...(foundationDirectiveHash ? { foundationDirectiveHash } : {}),
    chapterNumber: positiveInteger(value.chapterNumber, "chapter_plan.chapterNumber"),
    title: requiredString(value.title, "chapter_plan.title"),
    openingBridge: parseOpeningBridge(value.openingBridge),
    causalChain: parseCausalChain(value.causalChain),
    requiredFactIds: stringArray(value.requiredFactIds, "chapter_plan.requiredFactIds"),
    plannedFacts: parsePlannedFacts(value.plannedFacts),
    informationFlow: parseInformationFlow(value.informationFlow),
    foundationObligations: foundationObligations(context),
  };
  if (generated) plan = normalizeGeneratedFoundationFacts(plan, context);

  if (plan.contextHash !== context.contextHash) {
    throw new ChapterContractError(
      "chapter_plan.contextHash",
      "必须匹配本次规划使用的连续性上下文",
    );
  }
  if (plan.chapterNumber !== expectedChapter) {
    throw new ChapterContractError(
      "chapter_plan.chapterNumber",
      `应为 ${expectedChapter}`,
    );
  }
  const expectedPrevious = Math.max(0, expectedChapter - 1);
  if (plan.openingBridge.previousChapter !== expectedPrevious) {
    throw new ChapterContractError(
      "chapter_plan.openingBridge.previousChapter",
      `应为 ${expectedPrevious}`,
    );
  }
  if (expectedChapter > 1 && !context.immediatePredecessor) {
    throw new ChapterContractError(
      "chapter_plan.openingBridge",
      "后续章节必须有已批准的直接前章 checkpoint",
    );
  }
  validateNarrativeReferences(plan, context);
  validateFoundationReferences(plan, context);
  return plan;
}

function foundationObligations(context: ContinuityContextPackage): FoundationObligations {
  const outline = context.targetOutline;
  return {
    revealedSecretIds: [...(outline?.revealedSecretIds ?? [])],
    revealedFactIds: [...(outline?.revealedFactIds ?? [])],
    foreshadowingToPlant: [...(outline?.foreshadowingToPlant ?? [])],
    foreshadowingToReinforce: [...(outline?.foreshadowingToReinforce ?? [])],
    foreshadowingToPayOff: [...(outline?.foreshadowingToPayOff ?? [])],
  };
}

function normalizeGeneratedFoundationFacts(
  plan: ChapterPlan,
  context: ContinuityContextPackage,
): ChapterPlan {
  const scheduledFacts = new Map(
    context.chapterFoundationDirective?.narrativePlan.revelationPlan
      .map((fact) => [fact.factId, fact.information]) ?? [],
  );
  return {
    ...plan,
    plannedFacts: plan.plannedFacts.map((fact) => {
      const statement = scheduledFacts.get(fact.factId);
      return statement ? { ...fact, statement } : fact;
    }),
  };
}

function parseFoundationDirectiveHash(value: unknown, context: ContinuityContextPackage): string | undefined {
  const expected = context.chapterFoundationDirective?.directiveHash;
  if (!expected) {
    if (value === undefined) return undefined;
    return requiredString(value, "chapter_plan.foundationDirectiveHash");
  }
  const actual = requiredString(value, "chapter_plan.foundationDirectiveHash");
  if (actual !== expected) {
    throw new ChapterContractError("chapter_plan.foundationDirectiveHash", "必须匹配本章批准 Foundation 生成的指令哈希");
  }
  return actual;
}

function validateFoundationReferences(plan: ChapterPlan, context: ContinuityContextPackage): void {
  const directive = context.chapterFoundationDirective;
  if (!directive) return;
  const existingFacts = new Set(context.facts.map((fact) => fact.factId));
  const plannedFacts = new Map(plan.plannedFacts.map((fact) => [fact.factId, fact]));
  const scheduledFacts = new Map(directive.narrativePlan.revelationPlan.map((fact) => [fact.factId, fact]));
  for (const [factId, fact] of scheduledFacts) {
    if (existingFacts.has(factId)) continue;
    const planned = plannedFacts.get(factId);
    if (!planned) {
      throw new ChapterContractError("chapter_plan.plannedFacts", `遗漏 Foundation 本章计划揭示的事实：${factId}`);
    }
    if (planned.statement !== fact.information) {
      throw new ChapterContractError("chapter_plan.plannedFacts", `${factId} 必须使用 Foundation 中批准的事实内容`);
    }
  }
  const foundationFactIds = new Set(
    context.foundationContext?.registry.entries
      .filter((entry) => entry.kind === "fact")
      .map((entry) => entry.id) ?? [],
  );
  for (const fact of plan.plannedFacts) {
    if (foundationFactIds.has(fact.factId) && !scheduledFacts.has(fact.factId) && !existingFacts.has(fact.factId)) {
      throw new ChapterContractError("chapter_plan.plannedFacts", `Foundation 事实 ${fact.factId} 未安排在本章揭示`);
    }
  }
}

function validateNarrativeReferences(
  plan: ChapterPlan,
  context: ContinuityContextPackage,
): void {
  const existingFacts = new Map(context.facts.map((fact) => [fact.factId, fact]));
  const plannedFacts = new Map<string, PlannedFact>();
  for (const [index, fact] of plan.plannedFacts.entries()) {
    if (plannedFacts.has(fact.factId)) {
      throw new ChapterContractError(
        `chapter_plan.plannedFacts[${index}].factId`,
        `重复 factId：${fact.factId}`,
      );
    }
    const existing = existingFacts.get(fact.factId);
    if (existing && existing.statement !== fact.statement) {
      throw new ChapterContractError(
        `chapter_plan.plannedFacts[${index}].statement`,
        `与既有事实 ${fact.factId} 冲突`,
      );
    }
    plannedFacts.set(fact.factId, fact);
  }

  for (const [index, factId] of plan.requiredFactIds.entries()) {
    if (!existingFacts.has(factId)) {
      throw new ChapterContractError(
        `chapter_plan.requiredFactIds[${index}]`,
        `引用了尚未建立的事实：${factId}`,
      );
    }
  }

  const knowledge = new Map(
    context.characterKnowledge.map((item) => [`${item.factId}\u0000${item.character}`, item]),
  );
  for (const [index, transfer] of plan.informationFlow.entries()) {
    if (!existingFacts.has(transfer.factId) && !plannedFacts.has(transfer.factId)) {
      throw new ChapterContractError(
        `chapter_plan.informationFlow[${index}].factId`,
        `引用了未知事实：${transfer.factId}`,
      );
    }
    if (transfer.sourceType === "told") {
      if (!transfer.sourceCharacter.trim()) {
        throw new ChapterContractError(
          `chapter_plan.informationFlow[${index}].sourceCharacter`,
          "转述信息必须提供 sourceCharacter",
        );
      }
      const source = knowledge.get(`${transfer.factId}\u0000${transfer.sourceCharacter}`);
      if (existingFacts.has(transfer.factId) && !source) {
        throw new ChapterContractError(
          `chapter_plan.informationFlow[${index}].sourceCharacter`,
          `${transfer.sourceCharacter} 尚不知道 ${transfer.factId}，不能转述`,
        );
      }
      if (source && KNOWLEDGE_RANK[transfer.knowledgeLevel] > KNOWLEDGE_RANK[asKnowledgeLevel(source.knowledgeLevel)]) {
        throw new ChapterContractError(
          `chapter_plan.informationFlow[${index}].knowledgeLevel`,
          `不能超过 ${transfer.sourceCharacter} 已有认知等级`,
        );
      }
    }
  }
}

function parseOpeningBridge(value: unknown): OpeningBridge {
  assertRecord(value, "chapter_plan.openingBridge");
  return {
    previousChapter: nonNegativeInteger(value.previousChapter, "chapter_plan.openingBridge.previousChapter"),
    inheritedEndpoint: requiredString(value.inheritedEndpoint, "chapter_plan.openingBridge.inheritedEndpoint"),
    transitionSteps: stringArray(value.transitionSteps, "chapter_plan.openingBridge.transitionSteps", true),
    firstSceneStart: requiredString(value.firstSceneStart, "chapter_plan.openingBridge.firstSceneStart"),
    carryOverThreads: stringArray(value.carryOverThreads, "chapter_plan.openingBridge.carryOverThreads"),
  };
}

function parseCausalChain(value: unknown): CausalLink[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ChapterContractError("chapter_plan.causalChain", "至少需要一条因果链");
  }
  return value.map((item, index) => {
    const path = `chapter_plan.causalChain[${index}]`;
    assertRecord(item, path);
    return {
      cause: requiredString(item.cause, `${path}.cause`),
      event: requiredString(item.event, `${path}.event`),
      effect: requiredString(item.effect, `${path}.effect`),
    };
  });
}

function parsePlannedFacts(value: unknown): PlannedFact[] {
  if (!Array.isArray(value)) throw new ChapterContractError("chapter_plan.plannedFacts", "必须是数组");
  return value.map((item, index) => {
    const path = `chapter_plan.plannedFacts[${index}]`;
    assertRecord(item, path);
    return {
      factId: requiredString(item.factId, `${path}.factId`),
      statement: requiredString(item.statement, `${path}.statement`),
      category: requiredString(item.category, `${path}.category`),
      visibility: requiredString(item.visibility, `${path}.visibility`),
    };
  });
}

function parseInformationFlow(value: unknown): InformationFlow[] {
  if (!Array.isArray(value)) throw new ChapterContractError("chapter_plan.informationFlow", "必须是数组");
  return value.map((item, index) => {
    const path = `chapter_plan.informationFlow[${index}]`;
    assertRecord(item, path);
    const knowledgeLevel = requiredString(item.knowledgeLevel, `${path}.knowledgeLevel`);
    const sourceType = requiredString(item.sourceType, `${path}.sourceType`);
    if (!(knowledgeLevel in KNOWLEDGE_RANK)) throw new ChapterContractError(`${path}.knowledgeLevel`, "无效认知等级");
    if (!["observed", "told", "inferred", "public", "document"].includes(sourceType)) {
      throw new ChapterContractError(`${path}.sourceType`, "无效信息来源类型");
    }
    return {
      factId: requiredString(item.factId, `${path}.factId`),
      character: requiredString(item.character, `${path}.character`),
      knowledgeLevel: knowledgeLevel as KnowledgeLevel,
      sourceType: sourceType as SourceType,
      sourceCharacter: stringValue(item.sourceCharacter, `${path}.sourceCharacter`),
      evidence: requiredString(item.evidence, `${path}.evidence`),
    };
  });
}

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new ChapterContractError(
      "chapter_plan",
      `不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChapterContractError(path, "必须是对象");
  }
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ChapterContractError(path, "必须是非空字符串");
  }
  return value.trim();
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ChapterContractError(path, "必须是字符串（不能为 null）");
  }
  return value.trim();
}

function stringArray(value: unknown, path: string, nonEmpty = false): string[] {
  if (!Array.isArray(value)) throw new ChapterContractError(path, "必须是数组");
  if (nonEmpty && value.length === 0) throw new ChapterContractError(path, "至少需要一项");
  return value.map((item, index) => requiredString(item, `${path}[${index}]`));
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ChapterContractError(path, "必须是正整数");
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ChapterContractError(path, "必须是非负整数");
  }
  return value;
}

function asKnowledgeLevel(value: string): KnowledgeLevel {
  if (!(value in KNOWLEDGE_RANK)) return "heard";
  return value as KnowledgeLevel;
}
