import type { ContinuityContextPackage } from "../state/continuity.js";

export class ReviewContractError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ReviewContractError";
    this.path = path;
  }
}

export interface ChapterReviewOutput {
  contextHash: string;
  foundationDirectiveHash?: string;
  chapterNumber: number;
  score: number;
  requiresRewrite: boolean;
  rewriteScope: string;
  issues: string[];
  narrativeViolations: string[];
  foundationViolations: string[];
  summary: string;
}

export function parseChapterReview(
  text: string,
  expectedChapter: number,
  context: ContinuityContextPackage,
): ChapterReviewOutput {
  const value = parseJson(text);
  assertRecord(value, "chapter_review");
  const foundationDirectiveHash = parseFoundationDirectiveHash(value.foundationDirectiveHash, context);
  const output = {
    contextHash: requiredString(value.contextHash, "chapter_review.contextHash"),
    ...(foundationDirectiveHash ? { foundationDirectiveHash } : {}),
    chapterNumber: positiveInteger(value.chapterNumber, "chapter_review.chapterNumber"),
    score: boundedScore(value.score, "chapter_review.score"),
    requiresRewrite: requiredBoolean(value.requiresRewrite, "chapter_review.requiresRewrite"),
    rewriteScope: stringValue(value.rewriteScope, "chapter_review.rewriteScope"),
    issues: stringArray(value.issues, "chapter_review.issues"),
    narrativeViolations: stringArray(value.narrativeViolations, "chapter_review.narrativeViolations"),
    foundationViolations: context.chapterFoundationDirective
      ? stringArray(value.foundationViolations, "chapter_review.foundationViolations")
      : optionalStringArray(value.foundationViolations, "chapter_review.foundationViolations"),
    summary: requiredString(value.summary, "chapter_review.summary"),
  } satisfies ChapterReviewOutput;
  if (output.contextHash !== context.contextHash) throw new ReviewContractError("chapter_review.contextHash", "必须匹配写作使用的连续性上下文");
  if (output.chapterNumber !== expectedChapter) throw new ReviewContractError("chapter_review.chapterNumber", `应为 ${expectedChapter}`);
  if (output.requiresRewrite && !output.rewriteScope.trim()) throw new ReviewContractError("chapter_review.rewriteScope", "需要重写时必须说明范围");
  if (output.foundationViolations.length > 0 && !output.requiresRewrite) throw new ReviewContractError("chapter_review.requiresRewrite", "存在 Foundation 违反项时必须要求重写");
  return output;
}

function parseFoundationDirectiveHash(value: unknown, context: ContinuityContextPackage): string | undefined {
  const expected = context.chapterFoundationDirective?.directiveHash;
  if (!expected) {
    if (value === undefined) return undefined;
    return requiredString(value, "chapter_review.foundationDirectiveHash");
  }
  const actual = requiredString(value, "chapter_review.foundationDirectiveHash");
  if (actual !== expected) throw new ReviewContractError("chapter_review.foundationDirectiveHash", "必须匹配本章 Foundation 指令哈希");
  return actual;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch (error) {
    throw new ReviewContractError("chapter_review", `不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`);
  }
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReviewContractError(path, "必须是对象");
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ReviewContractError(path, "必须是非空字符串");
  return value.trim();
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ReviewContractError(path, "必须是字符串（不能为 null）");
  return value.trim();
}

function requiredBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ReviewContractError(path, "必须是布尔值");
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new ReviewContractError(path, "必须是正整数");
  return value;
}

function boundedScore(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10) throw new ReviewContractError(path, "必须是 1 到 10 的整数");
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new ReviewContractError(path, "必须是数组");
  return value.map((item, index) => requiredString(item, `${path}[${index}]`));
}

function optionalStringArray(value: unknown, path: string): string[] {
  return value === undefined ? [] : stringArray(value, path);
}
