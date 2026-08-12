import type { Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { PiAgentRuntime } from "../runtime/agent.js";
import type { GraphNovelState } from "../state/state.js";

export interface CreativeChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CreativeChatInput {
  message: string;
  history: readonly CreativeChatMessage[];
}

export interface CreativeChatDependencies {
  runtime: PiAgentRuntime;
  model: Model<any>;
  streamFn: StreamFn;
}

export async function runCreativeChat(
  input: CreativeChatInput,
  dependencies: CreativeChatDependencies,
  state?: GraphNovelState,
): Promise<{ reply: string; sessionId: string }> {
  const result = await dependencies.runtime.run({
    nodeKey: "creative_chat",
    attempt: 1,
    systemPrompt: buildSystemPrompt(state),
    prompt: JSON.stringify({
      history: input.history,
      message: input.message,
      output: "只返回给作者的中文自然语言回复，不要返回 JSON，不要修改项目 State。",
    }),
    model: dependencies.model,
    streamFn: dependencies.streamFn,
  });
  const reply = result.text.trim();
  if (!reply) throw new Error("创意助手没有返回有效内容");
  return { reply, sessionId: result.sessionId };
}

function buildSystemPrompt(state?: GraphNovelState): string {
  const context = state ? buildProjectContext(state) : "尚无小说项目信息，作者正在构思阶段。";
  const creativeMode = !state;
  return `你是「番茄小说工坊」的创意助手，名叫「小番」。
你是作者的网文创作搭档，帮助讨论创意、情节因果、人物动机、爽点节奏、章末钩子和写作策略。

当前项目上下文（只读）：
${context}

${creativeMode ? "作者还没有创建项目。不要催促作者填表或创建项目，先自然地帮作者把想法聊清楚。" : "项目上下文只用于建议，不要擅自声称已经修改了世界观、人物、大纲或章节 State。需要落地的内容应建议作者通过对应 Graph command 和审批 Gate 完成。"}

回答规则：
- 使用中文，热情但具体，避免空泛鼓励。
- 讨论情节时检查因果、铺垫、角色认知和信息来源，不让角色无理由知道新信息。
- 作者卡文时给出 3-5 个可执行方向，并说明各自代价。
- 发现上下文不足时明确指出缺口，不要编造已发生的事实。
- 回复简洁，每段不超过 3 行；只输出自然语言，不输出 JSON。`;
}

function buildProjectContext(state: GraphNovelState): string {
  const blocks: string[] = [
    `小说书名：《${state.novelTitle}》`,
    `题材：${state.creativeGenre || "未填写"}`,
    `故事前提：${state.creativePremise || "未填写"}`,
    `主题：${state.creativeTheme || "未填写"}`,
    `章节进度：${state.approvedChapters.length}/${state.targetTotalChapters} 章已批准`,
  ];
  if (state.worldSetting) {
    blocks.push(`世界背景：${state.worldSetting.era} / ${state.worldSetting.location}`);
    blocks.push(`核心设定：${state.worldSetting.magicSystem || state.worldSetting.technologyLevel || "未填写"}`);
  }
  if (state.characters.length) {
    blocks.push(`主要角色：${state.characters.slice(0, 5).map((character) => `${character.name}（${character.role}）：${character.motivation}`).join("；")}`);
  }
  if (state.novelOutline) {
    blocks.push(`大纲卖点：${state.novelOutline.premise}`);
    blocks.push(`大纲主题：${state.novelOutline.theme}`);
  }
  const latest = state.approvedChapters[state.approvedChapters.length - 1];
  if (latest) blocks.push(`最近章节：第${latest.chapterNumber}章《${latest.title}》；结尾：${latest.endingExcerpt}`);
  return blocks.join("\n");
}
