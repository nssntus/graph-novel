import type { ContinuityContextPackage } from "../state/continuity.js";

export class StyleContractError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "StyleContractError";
    this.path = path;
  }
}

export interface StylePolishOutput {
  contextHash: string;
  foundationDirectiveHash?: string;
  chapterNumber: number;
  polishedDraft: string;
  factIds: string[];
  knowledgeSignatures: string[];
}

export function parseStylePolishOutput(
  text: string,
  expectedChapter: number,
  context: ContinuityContextPackage,
  expectedFactIds: readonly string[],
  expectedKnowledgeSignatures: readonly string[],
): StylePolishOutput {
  const value = parseJson(text);
  assertRecord(value, "style_polish");
  const foundationDirectiveHash = parseFoundationDirectiveHash(value.foundationDirectiveHash, context);
  const output: StylePolishOutput = {
    contextHash: requiredString(value.contextHash, "style_polish.contextHash"),
    ...(foundationDirectiveHash ? { foundationDirectiveHash } : {}),
    chapterNumber: positiveInteger(value.chapterNumber, "style_polish.chapterNumber"),
    polishedDraft: requiredString(value.polishedDraft, "style_polish.polishedDraft"),
    factIds: stringArray(value.factIds, "style_polish.factIds"),
    knowledgeSignatures: stringArray(value.knowledgeSignatures, "style_polish.knowledgeSignatures"),
  };
  if (output.contextHash !== context.contextHash) {
    throw new StyleContractError("style_polish.contextHash", "必须匹配审查使用的连续性上下文");
  }
  if (output.chapterNumber !== expectedChapter) {
    throw new StyleContractError("style_polish.chapterNumber", `应为 ${expectedChapter}`);
  }
  assertExactSet(output.factIds, expectedFactIds, "style_polish.factIds");
  assertExactSet(output.knowledgeSignatures, expectedKnowledgeSignatures, "style_polish.knowledgeSignatures");
  return output;
}

function parseFoundationDirectiveHash(value: unknown, context: ContinuityContextPackage): string | undefined {
  const expected = context.chapterFoundationDirective?.directiveHash;
  if (!expected) {
    if (value === undefined) return undefined;
    return requiredString(value, "style_polish.foundationDirectiveHash");
  }
  const actual = requiredString(value, "style_polish.foundationDirectiveHash");
  if (actual !== expected) throw new StyleContractError("style_polish.foundationDirectiveHash", "必须匹配本章 Foundation 指令哈希");
  return actual;
}

function assertExactSet(actual: readonly string[], expected: readonly string[], path: string): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (actualSet.size !== actual.length) throw new StyleContractError(path, "不能包含重复项");
  if (actualSet.size !== expectedSet.size || actual.some((item) => !expectedSet.has(item))) {
    throw new StyleContractError(path, "必须与宿主保存的 narrative delta 签名完全一致");
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch (error) {
    throw new StyleContractError("style_polish", `不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`);
  }
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StyleContractError(path, "必须是对象");
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new StyleContractError(path, "必须是非空字符串");
  return value.trim();
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new StyleContractError(path, "必须是数组");
  return value.map((item, index) => requiredString(item, `${path}[${index}]`));
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new StyleContractError(path, "必须是正整数");
  return value;
}
