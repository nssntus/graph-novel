"""
Node 5: 章节写作 Agent
针对番茄小说平台：2000-2500字/章，对话驱动，手机阅读适配，章末强钩子。
"""

import re
from typing import Optional, Tuple

from graph_novel.state import GraphNovelState, NodeStatus, Foreshadowing
from graph_novel.llm import call_llm_sync

SYSTEM_PROMPT = """你是一位番茄小说平台的签约作者。你写快节奏爽文，擅长制造爽点和钩子。

番茄小说写作铁律：

【格式要求】
- 本章2000-2500字（严格控制）
- 每段不超过3行（手机屏幕适配，增加留白）
- 对话占60%以上——用对话推进情节，减少大段叙述
- 旁白不超过300字一段，心理描写不超过100字
- 场景切换用空行分隔

【内容要求】
- 前300字必须出冲突/钩子——读者3秒决定去留
- 对话要有"网感"：口语化、有情绪、有节奏
- 主角说话要符合人设（毒舌/冷静/热血/腹黑）
- 避免长段设定说明——把世界观揉进对话和动作里

【爽点要求】
- 如果是爽点章节：压抑→反转→打脸，节奏要快
- 打脸场景用动作+短句，不要大段心理描写
- 让"被打脸者"的反应成为爽点的放大器

【章末钩子】
- 每章结尾必须有强钩子
- 钩子类型：悬念截断（"他推开门，看到了那个不该出现的人"）、反转预告、危险降临、秘密揭露

【AI写作禁忌——必须避免】
- ❌ 打脸场景中加入大段心理独白
- ❌ 用"首先、其次、最后"说明文逻辑组织情节
- ❌ 对话结束后用旁白复述刚刚发生的事
- ❌ "不是……而是……"句式（AI指纹特征词）
- ❌ 正文出现"第X章""前文提到""且听下回分解"等元话语
- ❌ 连续三个以上相同情绪的词堆叠
- ❌ 大段风景/环境描写
- ❌ 主角行为毫无理由的"圣母"时刻

写完后在"---META---"分隔符后附 JSON：
{
  "chapter_hook": "章末钩子内容（30字以内）",
  "shuangdian_beat": "小爽点/大爽点/铺垫",
  "foreshadowing_planted": [{"description": "", "scene_context": ""}],
  "foreshadowing_paid": [{"id": "", "how_it_was_resolved": ""}],
  "character_moments": {"角色名": "本章弧线节拍"}
}

请写出完整的章节正文（2000-2500字），然后附上 META 数据。"""


def run_node(state: GraphNovelState) -> GraphNovelState:
    ch_num = state.current_chapter
    state.log(f"节点5: 章节写作 — 正在写第{ch_num}章……")
    state.node_status[f"writing_{ch_num}"] = NodeStatus.IN_PROGRESS

    chapter = state.chapters[ch_num - 1]
    world_text = _world_context(state)
    character_text = _character_context(state)
    prev_text = _previous_summary(state)
    fs_text = _foreshadowing_context(state, ch_num)

    outline = chapter.outline
    plan_text = f"""第{ch_num}章：{chapter.title}
大纲概要：{outline.summary if outline else '按大纲推进'}
POV角色：{outline.pov_character if outline else '主角'}
关键事件：{outline.key_events if outline else '自然推进'}
爽点节拍：{outline.shuangdian_beat if outline else '待定'}
章末钩子构思：{outline.chapter_hook_idea if outline else '制造悬念'}
待埋伏笔：{outline.foreshadowing_to_plant if outline else '无'}
待回收伏笔：{outline.foreshadowing_to_pay_off if outline else '无'}"""

    user_prompt = f"""请写第{ch_num}章正文。

== 章节规划 ==
{plan_text}

== 世界设定 ==
{world_text}

== 角色档案 ==
{character_text}

== 前文摘要 ==
{prev_text}

== 伏笔追踪 ==
{fs_text}

---
请写出2000-2500字的章节正文。记住：对话驱动、手机阅读适配、章末强钩子、避免AI写作禁忌。"""

    try:
        raw = call_llm_sync(SYSTEM_PROMPT, user_prompt, max_tokens=8192, temperature=0.85)
        prose, meta = _parse_response(raw)

        chapter.draft = prose
        chapter.word_count = len(prose.replace(' ', ''))  # 中文按字数算

        if meta:
            chapter.chapter_hook = meta.get("chapter_hook", "")
            chapter.shuangdian_type = meta.get("shuangdian_beat", "")
            _update_foreshadowing(state, meta, ch_num)
            _update_arcs(state, meta, ch_num)

        state.node_status[f"writing_{ch_num}"] = NodeStatus.COMPLETED
        state.log(f"节点5: 章节写作 — 第{ch_num}章完成（{chapter.word_count}字）| 钩子：{chapter.chapter_hook[:30]}")
    except Exception as e:
        state.node_status[f"writing_{ch_num}"] = NodeStatus.FAILED
        state.log(f"节点5: 章节写作 — 失败: {e}")
        if not chapter.draft:
            chapter.draft = f"[第{ch_num}章写作失败：{e}]"

    return state


def _parse_response(text: str) -> Tuple[str, Optional[dict]]:
    if "---META---" in text:
        parts = text.split("---META---", 1)
        prose = parts[0].strip()
        meta_text = parts[1].strip()
        import json as _json
        try:
            match = re.search(r"\{[\s\S]*\}", meta_text)
            if match:
                meta = _json.loads(match.group(0))
            else:
                meta = None
        except _json.JSONDecodeError:
            meta = None
        return prose, meta
    return text.strip(), None


def _update_foreshadowing(state: GraphNovelState, meta: dict, ch_num: int) -> None:
    for fp in meta.get("foreshadowing_planted", []):
        fid = f"fs_{len(state.foreshadowing_tracker) + 1:03d}"
        state.foreshadowing_tracker.append(Foreshadowing(
            id=fid,
            description=fp.get("description", ""),
            planted_in_chapter=ch_num,
            status="planted",
        ))
    for paid in meta.get("foreshadowing_paid", []):
        for fs in state.foreshadowing_tracker:
            if fs.id == paid.get("id", ""):
                fs.status = "paid_off"
                fs.payoff_chapter = ch_num
                fs.payoff_description = paid.get("how_it_was_resolved", "")


def _update_arcs(state: GraphNovelState, meta: dict, ch_num: int) -> None:
    for name, beat in meta.get("character_moments", {}).items():
        if name in state.character_arc_tracker:
            state.character_arc_tracker[name].per_chapter_status[str(ch_num)] = beat


def _world_context(state: GraphNovelState) -> str:
    if not state.world_setting:
        return "标准都市背景。"
    ws = state.world_setting
    return f"时代：{ws.era} | 地点：{ws.location} | 核心设定：{ws.magic_system or '无'} | 金手指：{ws.notes[:100]}"


def _character_context(state: GraphNovelState) -> str:
    parts = []
    for c in state.characters:
        arc = state.character_arc_tracker.get(c.name)
        stage = arc.current_stage.value if arc else "未知"
        parts.append(f"{c.name}（{c.role}）：{c.personality[:80]} | 动机：{c.motivation} | 弧线阶段：{stage}")
    return "\n".join(parts)


def _previous_summary(state: GraphNovelState) -> str:
    if not state.chapters:
        return "第一章。"
    parts = []
    for ch in state.chapters:
        if ch.chapter_number < state.current_chapter:
            hook = getattr(ch, 'chapter_hook', '')
            parts.append(f"第{ch.chapter_number}章 {ch.title} [{ch.word_count}字] 末钩：{hook[:60]}")
    return "\n".join(parts[-5:]) if parts else "第一章。"


def _foreshadowing_context(state: GraphNovelState, ch_num: int) -> str:
    active = [fs for fs in state.foreshadowing_tracker if fs.status == "planted"]
    if not active:
        return "无待回收伏笔。"
    return "\n".join([f"[{fs.id}] 第{fs.planted_in_chapter}章埋：{fs.description[:80]}" for fs in active])
