import type { Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { PiAgentRuntime } from "../runtime/agent.js";
import type { CreativeChatMessage } from "./creative-chat.js";

export interface CreativeProjectDraft {
  novelTitle: string;
  creativeGenre: string;
  creativePremise: string;
  creativeTheme: string;
  creativeNotes: string;
  targetTotalChapters: number;
  targetTotalWords: number;
}

export interface CreativeProjectDraftInput {
  history: readonly CreativeChatMessage[];
}

export interface CreativeProjectDraftDependencies {
  runtime: PiAgentRuntime;
  model: Model<any>;
  streamFn: StreamFn;
}

export class CreativeProjectDraftContractError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "CreativeProjectDraftContractError";
    this.path = path;
  }
}

export async function runCreativeProjectDraft(
  input: CreativeProjectDraftInput,
  dependencies: CreativeProjectDraftDependencies,
): Promise<{ draft: CreativeProjectDraft; sessionId: string }> {
  const result = await dependencies.runtime.run({
    nodeKey: "creative_project_draft",
    attempt: 1,
    systemPrompt: buildSystemPrompt(),
    prompt: JSON.stringify({
      history: input.history,
      output: "只返回符合契约的 JSON，不要返回 Markdown、解释或普通聊天回复。",
    }),
    model: dependencies.model,
    streamFn: dependencies.streamFn,
  });
  return { draft: parseCreativeProjectDraft(result.text), sessionId: result.sessionId };
}

export function parseCreativeProjectDraft(text: string): CreativeProjectDraft {
  const value = parseJson(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CreativeProjectDraftContractError("project_draft", "必须是对象");
  }
  const record = value as Record<string, unknown>;
  return {
    novelTitle: boundedText(record.novelTitle, "novelTitle", 200),
    creativeGenre: boundedText(record.creativeGenre, "creativeGenre", 200),
    creativePremise: boundedText(record.creativePremise, "creativePremise", 2000),
    creativeTheme: boundedText(record.creativeTheme, "creativeTheme", 200),
    creativeNotes: boundedText(record.creativeNotes, "creativeNotes", 4000),
    targetTotalChapters: boundedInteger(record.targetTotalChapters, "targetTotalChapters", 12, 1, 200),
    targetTotalWords: boundedInteger(record.targetTotalWords, "targetTotalWords", 0, 0, 20_000_000),
  };
}

function buildSystemPrompt(): string {
  return `你是 GraphNovel 的项目草案整理 Agent。你的任务是把作者与项目外创意助手的有效对话整理成一个可编辑的新项目草案。

严格规则：
- 只根据提供的对话总结，不得声称已经创建项目、写入 State 或运行 Graph。
- 只输出 JSON 对象，字段只能使用 novelTitle、creativeGenre、creativePremise、creativeTheme、creativeNotes、targetTotalChapters、targetTotalWords。
- 不确定的文本字段输出空字符串；没有可靠依据的数字使用 targetTotalChapters=12、targetTotalWords=0。
- novelTitle、creativeGenre、creativeTheme 是简洁文本；creativePremise 描述主角、核心冲突和持续阅读体验；creativeNotes 保留重要约束和偏好。
- targetTotalChapters 必须是 1-200 的整数，targetTotalWords 必须是 0-20000000 的整数。
- 不要输出 projectId、creativeCharter、worldSetting、characters、chapterPlans 或任何 GraphNovelState 字段。`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch (error) {
    throw new CreativeProjectDraftContractError(
      "project_draft",
      `不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
}

function boundedText(value: unknown, path: string, max: number): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new CreativeProjectDraftContractError(path, "必须是字符串");
  const text = value.trim();
  if (text.length > max) throw new CreativeProjectDraftContractError(path, `长度不能超过 ${max} 个字符`);
  return text;
}

function boundedInteger(value: unknown, path: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new CreativeProjectDraftContractError(path, `必须是 ${min} 到 ${max} 的整数`);
  }
  return value;
}
