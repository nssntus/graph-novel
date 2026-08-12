export class GlobalReviewContractError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "GlobalReviewContractError";
    this.path = path;
  }
}

export interface GlobalReviewOutput {
  overallScore: number;
  readyForPlatform: boolean;
  summary: string;
  recommendations: string[];
}

export function parseGlobalReview(text: string): GlobalReviewOutput {
  const value = parseJson(text);
  assertRecord(value, "global_review");
  return {
    overallScore: score(value.overallScore, "global_review.overallScore"),
    readyForPlatform: booleanValue(value.readyForPlatform, "global_review.readyForPlatform"),
    summary: requiredString(value.summary, "global_review.summary"),
    recommendations: stringArray(value.recommendations, "global_review.recommendations"),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch (error) {
    throw new GlobalReviewContractError("global_review", `不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`);
  }
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GlobalReviewContractError(path, "必须是对象");
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new GlobalReviewContractError(path, "必须是非空字符串");
  return value.trim();
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new GlobalReviewContractError(path, "必须是数组");
  return value.map((item, index) => requiredString(item, `${path}[${index}]`));
}

function score(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10) throw new GlobalReviewContractError(path, "必须是 1 到 10 的整数");
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new GlobalReviewContractError(path, "必须是布尔值");
  return value;
}
