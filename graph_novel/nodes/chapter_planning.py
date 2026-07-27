"""
Node 4: 章节规划 Agent
针对番茄小说：每章写作前的详细规划——对话节奏、爽点节奏、手机阅读适配。
"""

import json

from graph_novel.state import GraphNovelState, NodeStatus, Chapter, ChapterOutline
from graph_novel.llm import call_llm_sync
from graph_novel.output_contracts import (
    call_json_with_contract_sync,
    chapter_plan_contract,
)

SYSTEM_PROMPT = """你是一位番茄小说平台的章节规划师。在每章写作前，你制定详细的叙事计划。

番茄小说章节标准：
- 每章2000-2500字
- 对话占60%，旁白占30%，心理描写占10%
- 每段不超过3行（适配手机阅读，增加留白）
- 前300字必须出冲突或钩子
- 章末必须有强钩子（悬念截断、反转预告、冲突升级）
- 多用短句，少用长段描写
- 场景转换用空行分隔

输出 JSON 对象：
- chapter_number: 章号
- title: 章标题（有网感）
- scene_plan: 场景计划 [{scene_number, setting, characters_present, action, emotional_beat, dialogue_focus, word_count_target}]
- pov_character: POV角色
- opening_hook: 开篇钩子（本章前300字怎么抓人）
- closing_hook: 章末钩子（怎么让读者必须点下一章）
- dialogue_highlights: 本章对话亮点（至少1个高燃/高虐/反转对话场景）
- shuangdian_beat: 本章爽点节奏说明
- continuity_notes: 承接上文 {time_of_day, character_positions, previous_chapter_end}
- ai_taboos_check: 本章要避免的AI病（列出3个具体要避开的AI写作禁忌）

请只输出 JSON 对象，不要其他文字。"""


def run_node(state: GraphNovelState) -> GraphNovelState:
    ch_num = state.current_chapter
    state.log(f"节点4: 章节规划 — 规划第{ch_num}章……")
    state.node_status[f"chapter_planning_{ch_num}"] = NodeStatus.IN_PROGRESS

    outline = None
    if state.novel_outline and ch_num <= len(state.novel_outline.chapter_outlines):
        outline = state.novel_outline.chapter_outlines[ch_num - 1]

    prev_context = _build_previous_context(state)
    arc_text = _build_arc_status_text(state)
    outline_text = json.dumps(_serialize_outline(outline), ensure_ascii=False, indent=2) if outline else "无大纲。"

    # 爽点排期上下文
    shuangdian_context = ""
    if state.novel_outline and state.novel_outline.shuangdian_map:
        shuangdian_context = "爽点排期表：\n" + json.dumps(state.novel_outline.shuangdian_map, ensure_ascii=False, indent=2)

    rewrite_feedback = (
        state.chapters[ch_num - 1].rewrite_feedback
        if ch_num <= len(state.chapters)
        else ""
    ) or "无"

    user_prompt = f"""规划第{ch_num}章的详细写作方案。

章节大纲：
{outline_text}

{shuangdian_context}

前文章节摘要：
{prev_context}

角色弧线状态：
{arc_text}

本轮重写反馈：
{rewrite_feedback}

字数目标：2000-2500字 | 对话驱动 | 手机阅读适配

生成详细的章节规划 JSON。"""

    try:
        data = call_json_with_contract_sync(
            call_llm_sync,
            SYSTEM_PROMPT,
            user_prompt,
            contract=chapter_plan_contract(ch_num),
            max_tokens=4096,
            temperature=0.7,
        )

        while len(state.chapters) < ch_num:
            state.chapters.append(Chapter(chapter_number=len(state.chapters) + 1, title=""))
        chapter = state.chapters[ch_num - 1]
        chapter.title = data.get("title", f"第{ch_num}章")
        chapter.outline = outline

        state.node_status[f"chapter_planning_{ch_num}"] = NodeStatus.COMPLETED
        state.log(f"节点4: 章节规划 — 第{ch_num}章已规划。")
    except Exception as e:
        state.node_status[f"chapter_planning_{ch_num}"] = NodeStatus.FAILED
        state.last_error = {
            "node": f"chapter_planning_{ch_num}",
            "message": str(e),
        }
        state.log(f"节点4: 章节规划 — 失败: {e}")
        if len(state.chapters) < ch_num:
            state.chapters.append(Chapter(chapter_number=ch_num, title=f"第{ch_num}章"))
        elif not state.chapters[ch_num - 1].title:
            state.chapters[ch_num - 1].title = f"第{ch_num}章"

    return state


def _build_previous_context(state: GraphNovelState) -> str:
    if not state.chapters:
        return "第一章，无前文。"
    parts = []
    for ch in state.chapters:
        if ch.chapter_number < state.current_chapter:
            hook = getattr(ch, 'chapter_hook', '')
            parts.append(f"第{ch.chapter_number}章 {ch.title} [{ch.word_count}字] | 章末钩子：{hook[:80]}")
    return "\n".join(parts) if parts else "第一章，无前文。"


def _build_arc_status_text(state: GraphNovelState) -> str:
    parts = []
    for name, arc in state.character_arc_tracker.items():
        parts.append(f"{name}：阶段={arc.current_stage.value}, 弧线={arc.arc_description[:80]}")
    return "\n".join(parts)


def _serialize_outline(outline: ChapterOutline) -> dict:
    if not outline:
        return {}
    return {
        "chapter_number": outline.chapter_number,
        "title": outline.title,
        "summary": outline.summary,
        "pov_character": outline.pov_character,
        "key_events": outline.key_events,
        "shuangdian_beat": outline.shuangdian_beat,
        "chapter_hook_idea": outline.chapter_hook_idea,
        "foreshadowing_to_plant": outline.foreshadowing_to_plant,
        "foreshadowing_to_pay_off": outline.foreshadowing_to_pay_off,
    }
