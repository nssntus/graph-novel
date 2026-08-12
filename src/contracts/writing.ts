import type { ChapterPlan, InformationFlow, PlannedFact } from "./chapter.js";
import type { ContinuityContextPackage } from "../state/continuity.js";
import type { LastSceneCheckpoint } from "../state/continuity.js";

export class WritingContractError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "WritingContractError";
    this.path = path;
  }
}

export interface ChapterWritingOutput {
  contextHash: string;
  foundationDirectiveHash?: string;
  chapterNumber: number;
  title: string;
  draft: string;
  chapterHook: string;
  chapterSummary: string;
  endingExcerpt: string;
  lastScene: LastSceneCheckpoint;
  unresolvedActions: string[];
  openThreads: string[];
  factsEstablished: PlannedFact[];
  knowledgeChanges: InformationFlow[];
  continuityChanges: {
    time: string;
    characterLocations: Record<string, string>;
    characterConditions: Record<string, string>;
    resources: Record<string, string>;
  };
}

export function parseChapterWritingOutput(
  text: string,
  expectedChapter: number,
  context: ContinuityContextPackage,
  plan: ChapterPlan,
): ChapterWritingOutput {
  const value = parseJson(text);
  assertRecord(value, "chapter_writing");
  const foundationDirectiveHash = parseFoundationDirectiveHash(value.foundationDirectiveHash, context);
  const output: ChapterWritingOutput = {
    contextHash: requiredString(value.contextHash, "chapter_writing.contextHash"),
    ...(foundationDirectiveHash ? { foundationDirectiveHash } : {}),
    chapterNumber: positiveInteger(value.chapterNumber, "chapter_writing.chapterNumber"),
    title: requiredString(value.title, "chapter_writing.title"),
    draft: requiredString(value.draft, "chapter_writing.draft"),
    chapterHook: requiredString(value.chapterHook, "chapter_writing.chapterHook"),
    chapterSummary: requiredString(value.chapterSummary, "chapter_writing.chapterSummary"),
    endingExcerpt: requiredString(value.endingExcerpt, "chapter_writing.endingExcerpt"),
    lastScene: parseLastScene(value.lastScene),
    unresolvedActions: stringArray(value.unresolvedActions, "chapter_writing.unresolvedActions"),
    openThreads: stringArray(value.openThreads, "chapter_writing.openThreads"),
    factsEstablished: parsePlannedFacts(value.factsEstablished),
    knowledgeChanges: parseInformationFlow(value.knowledgeChanges),
    continuityChanges: parseContinuityChanges(value.continuityChanges),
  };
  if (output.contextHash !== context.contextHash) {
    throw new WritingContractError("chapter_writing.contextHash", "必须匹配规划使用的连续性上下文");
  }
  if (output.chapterNumber !== expectedChapter) {
    throw new WritingContractError("chapter_writing.chapterNumber", `应为 ${expectedChapter}`);
  }
  validateNarrativeDelta(output, plan);
  if (context.chapterFoundationDirective && plan.foundationDirectiveHash !== context.chapterFoundationDirective.directiveHash) {
    throw new WritingContractError("chapter_writing.foundationDirectiveHash", "已批准章节规划未引用当前 Foundation 指令");
  }
  return output;
}

function parseFoundationDirectiveHash(value: unknown, context: ContinuityContextPackage): string | undefined {
  const expected = context.chapterFoundationDirective?.directiveHash;
  if (!expected) {
    if (value === undefined) return undefined;
    return requiredString(value, "chapter_writing.foundationDirectiveHash");
  }
  const actual = requiredString(value, "chapter_writing.foundationDirectiveHash");
  if (actual !== expected) throw new WritingContractError("chapter_writing.foundationDirectiveHash", "必须匹配本章 Foundation 指令哈希");
  return actual;
}

function validateNarrativeDelta(output: ChapterWritingOutput, plan: ChapterPlan): void {
  const planned = new Map(plan.plannedFacts.map((fact) => [fact.factId, fact]));
  const established = new Map<string, PlannedFact>();
  for (const [index, fact] of output.factsEstablished.entries()) {
    if (established.has(fact.factId)) throw new WritingContractError(`chapter_writing.factsEstablished[${index}].factId`, `重复 factId：${fact.factId}`);
    const expected = planned.get(fact.factId);
    if (!expected) throw new WritingContractError("chapter_writing.factsEstablished", `包含未规划事实：${fact.factId}`);
    if (expected.statement !== fact.statement) throw new WritingContractError(`chapter_writing.factsEstablished[${index}].statement`, `偏离章节规划中的 ${fact.factId}`);
    established.set(fact.factId, fact);
  }
  for (const factId of planned.keys()) {
    if (!established.has(factId)) throw new WritingContractError("chapter_writing.factsEstablished", `遗漏已规划事实：${factId}`);
  }

  const plannedKnowledge = new Set(plan.informationFlow.map(signature));
  const actualKnowledge = new Set(output.knowledgeChanges.map(signature));
  for (const item of actualKnowledge) {
    if (!plannedKnowledge.has(item)) throw new WritingContractError("chapter_writing.knowledgeChanges", `包含未规划的信息变化：${item}`);
  }
  for (const item of plannedKnowledge) {
    if (!actualKnowledge.has(item)) throw new WritingContractError("chapter_writing.knowledgeChanges", `遗漏已规划的信息变化：${item}`);
  }
}

function signature(item: InformationFlow): string {
  return [item.factId, item.character, item.knowledgeLevel, item.sourceType, item.sourceCharacter].join("\u0000");
}

function parseLastScene(value: unknown): LastSceneCheckpoint {
  assertRecord(value, "chapter_writing.lastScene");
  return {
    time: requiredString(value.time, "chapter_writing.lastScene.time"),
    location: requiredString(value.location, "chapter_writing.lastScene.location"),
    povCharacter: requiredString(value.povCharacter, "chapter_writing.lastScene.povCharacter"),
    charactersPresent: stringArray(value.charactersPresent, "chapter_writing.lastScene.charactersPresent", true),
    finalAction: requiredString(value.finalAction, "chapter_writing.lastScene.finalAction"),
    finalDialogue: stringValue(value.finalDialogue, "chapter_writing.lastScene.finalDialogue"),
  };
}

function parsePlannedFacts(value: unknown): PlannedFact[] {
  if (!Array.isArray(value)) throw new WritingContractError("chapter_writing.factsEstablished", "必须是数组");
  return value.map((item, index) => {
    const path = `chapter_writing.factsEstablished[${index}]`;
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
  if (!Array.isArray(value)) throw new WritingContractError("chapter_writing.knowledgeChanges", "必须是数组");
  return value.map((item, index) => {
    const path = `chapter_writing.knowledgeChanges[${index}]`;
    assertRecord(item, path);
    const knowledgeLevel = requiredString(item.knowledgeLevel, `${path}.knowledgeLevel`);
    const sourceType = requiredString(item.sourceType, `${path}.sourceType`);
    if (!["heard", "suspected", "inferred", "confirmed"].includes(knowledgeLevel)) throw new WritingContractError(`${path}.knowledgeLevel`, "无效认知等级");
    if (!["observed", "told", "inferred", "public", "document"].includes(sourceType)) throw new WritingContractError(`${path}.sourceType`, "无效信息来源类型");
    return {
      factId: requiredString(item.factId, `${path}.factId`),
      character: requiredString(item.character, `${path}.character`),
      knowledgeLevel: knowledgeLevel as InformationFlow["knowledgeLevel"],
      sourceType: sourceType as InformationFlow["sourceType"],
      sourceCharacter: stringValue(item.sourceCharacter, `${path}.sourceCharacter`),
      evidence: requiredString(item.evidence, `${path}.evidence`),
    };
  });
}

function parseContinuityChanges(value: unknown): ChapterWritingOutput["continuityChanges"] {
  assertRecord(value, "chapter_writing.continuityChanges");
  return {
    time: requiredString(value.time, "chapter_writing.continuityChanges.time"),
    characterLocations: stringRecord(value.characterLocations, "chapter_writing.continuityChanges.characterLocations"),
    characterConditions: stringRecord(value.characterConditions, "chapter_writing.continuityChanges.characterConditions"),
    resources: stringRecord(value.resources, "chapter_writing.continuityChanges.resources"),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch (error) {
    throw new WritingContractError("chapter_writing", `不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`);
  }
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WritingContractError(path, "必须是对象");
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new WritingContractError(path, "必须是非空字符串");
  return value.trim();
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") throw new WritingContractError(path, "必须是字符串（不能为 null）");
  return value.trim();
}

function stringArray(value: unknown, path: string, nonEmpty = false): string[] {
  if (!Array.isArray(value)) throw new WritingContractError(path, "必须是数组");
  if (nonEmpty && value.length === 0) throw new WritingContractError(path, "至少需要一项");
  return value.map((item, index) => requiredString(item, `${path}[${index}]`));
}

function stringRecord(value: unknown, path: string): Record<string, string> {
  assertRecord(value, path);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, requiredString(item, `${path}.${key}`)]));
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new WritingContractError(path, "必须是正整数");
  return value;
}
