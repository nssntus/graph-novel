"""
Node 6: 一致性审查 Agent
针对番茄小说：检查 OOC、逻辑漏洞、AI写作病、爽点兑现、节奏问题。
"""

import json
import re

from graph_novel.state import GraphNovelState, NodeStatus, ArcStage
from graph_novel.llm import call_llm_sync

SYSTEM_PROMPT = """你是一位番茄小说平台的"毒舌主编"，拥有15年网文审稿经验。你的任务是用挑剔的眼光审查章节，找出所有问题。

审查维度（番茄小说标准）：

1. 人设一致性（OOC检测）：
   - 角色行为是否符合其性格标签？
   - 对话风格是否前后一致？
   - 主角有没有"圣母时刻"？

2. AI写作病检测（高频禁忌）：
   - "不是……而是……"句式（AI指纹特征词）
   - 打脸场景中大段心理独白
   - 对话后用旁白复述刚发生的事
   - 用"首先、其次、最后"的结构组织情节
   - 连续三个以上相同情绪词堆叠
   - 正文出现"第X章""前文提到"等元话语

3. 爽点兑现检查：
   - 本章如果是爽点章节，爽点是否到位？
   - 打脸是否够狠？反转是否够意外？
   - 爽点节奏是否符合排期表？

4. 章末钩子质量：
   - 钩子是否够强？能不能让读者点下一章？
   - 是否属于"悬念截断""反转预告""秘密揭露"等有效类型？

5. 手机阅读适配：
   - 段落是否过长（超过3行）？
   - 对话比例是否够高（应占60%以上）？

6. 逻辑与节奏：
   - 事件是否合理推进？
   - 有没有注水段落？

输出 JSON：
{
  "overall_score": 1-10,
  "issues": [
    {
      "severity": "致命" | "严重" | "轻微",
      "category": "OOC" | "AI病" | "节奏" | "逻辑" | "钩子" | "手机适配",
      "description": "问题描述",
      "location_hint": "原文引用或场景参考",
      "suggested_fix": "具体修改建议"
    }
  ],
  "hook_quality": "强钩子" | "弱钩子" | "无效" | "无钩子",
  "hook_review": "对章末钩子的评价",
  "shuangdian_delivery": "到位" | "勉强" | "未兑现",
  "ai_disease_count": AI病检测到的数量,
  "dialogue_ratio_estimate": "估计对话占比",
  "requires_rewrite": true/false,
  "character_arc_updates": {"角色名": "新弧线阶段"},
  "summary": "总体评价（2-3句）"
}

如果评分低于6分，requires_rewrite 应为 true。
请只输出 JSON。"""


def run_node(state: GraphNovelState) -> GraphNovelState:
    ch_num = state.current_chapter
    state.log(f"节点6: 毒舌审稿 — 审查第{ch_num}章……")
    state.node_status[f"consistency_review_{ch_num}"] = NodeStatus.IN_PROGRESS

    chapter = state.chapters[ch_num - 1]
    if not chapter.draft:
        state.node_status[f"consistency_review_{ch_num}"] = NodeStatus.SKIPPED
        return state

    world_text = _world_context(state)
    character_text = _character_context(state)
    prev_text = _prev_summary(state)
    fs_text = _foreshadowing_status(state)

    user_prompt = f"""审查第{ch_num}章。

== 第{ch_num}章：{chapter.title}（{chapter.word_count}字）==
{chapter.draft[:10000]}

== 上下文 ==
世界：{world_text}
角色：{character_text}
前文：{prev_text}
伏笔：{fs_text}

请从毒舌主编视角严格审查，输出 JSON 报告。"""

    try:
        raw = call_llm_sync(SYSTEM_PROMPT, user_prompt, max_tokens=4096, temperature=0.3)
        json_text = _extract_json(raw)
        report = json.loads(json_text)

        chapter.consistency_report = report
        state.node_status[f"consistency_review_{ch_num}"] = NodeStatus.COMPLETED

        score = report.get("overall_score", "?")
        issues = len(report.get("issues", []))
        ai_diseases = report.get("ai_disease_count", 0)
        state.log(f"节点6: 毒舌审稿 — 评分{score}/10 | {issues}个问题 | AI病{ai_diseases}处")
    except Exception as e:
        state.node_status[f"consistency_review_{ch_num}"] = NodeStatus.FAILED
        state.last_error = {
            "node": f"consistency_review_{ch_num}",
            "message": str(e),
        }
        state.log(f"节点6: 毒舌审稿 — 失败: {e}")
        chapter.consistency_report = {"error": str(e), "overall_score": 0}

    return state


def commit_arc_updates(state: GraphNovelState, ch_num: int) -> None:
    """Idempotently apply accepted reviewer arc-stage updates."""
    report = state.chapters[ch_num - 1].consistency_report
    for name, new_stage in report.get("character_arc_updates", {}).items():
        if name in state.character_arc_tracker:
            try:
                state.character_arc_tracker[name].current_stage = ArcStage(new_stage)
            except ValueError:
                continue


def _world_context(state: GraphNovelState) -> str:
    if not state.world_setting:
        return "标准都市。"
    ws = state.world_setting
    return f"时代：{ws.era} | 地点：{ws.location} | 核心设定：{ws.magic_system or '无'}"


def _character_context(state: GraphNovelState) -> str:
    return "\n".join([
        f"{c.name}（{c.role}）：{c.personality[:60]} | 动机：{c.motivation[:60]}"
        for c in state.characters
    ])


def _prev_summary(state: GraphNovelState) -> str:
    parts = []
    for ch in state.chapters:
        if ch.chapter_number < state.current_chapter:
            parts.append(f"第{ch.chapter_number}章 {ch.title} [{ch.word_count}字]")
    return "\n".join(parts[-5:]) if parts else "无"


def _foreshadowing_status(state: GraphNovelState) -> str:
    items = [f"[{fs.id}] {fs.status}: {fs.description[:80]}（第{fs.planted_in_chapter}章）" for fs in state.foreshadowing_tracker]
    return "\n".join(items) if items else "无"


def _extract_json(text: str) -> str:
    match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if match:
        return match.group(1)
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        return match.group(0)
    return text
