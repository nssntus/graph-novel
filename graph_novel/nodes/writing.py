"""
Node 5: 章节写作 Agent
针对番茄小说平台：2000-2500字/章，对话驱动，手机阅读适配，章末强钩子。
"""

import json

from graph_novel.state import GraphNovelState, NodeStatus, Foreshadowing
from graph_novel.llm import call_llm_sync
from graph_novel.output_contracts import (
    OutputContractError,
    call_text_with_contract_sync,
    parse_chapter_response,
)
from graph_novel.narrative import (
    build_narrative_context,
    commit_continuity_checkpoint,
    commit_narrative_delta,
    validate_narrative_delta,
)

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
- 前300字必须执行章节规划中的 opening_bridge，先承接上一章结束现场，再推进本章冲突
- 不得跳过 opening_bridge 中的过渡步骤；时间、地点或在场角色改变时必须写出移动、等待、到场或交接过程
- 不得用“此前已准备”“早就知道”等一句话补丁替代正文铺垫
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
  "character_moments": {"角色名": "本章弧线节拍"},
  "chapter_summary": "只记录本章实际发生的关键事实，不写文学评价",
  "facts_established": [{"fact_id": "", "statement": "", "category": "", "visibility": ""}],
  "knowledge_changes": [{
    "fact_id": "",
    "character": "",
    "knowledge_level": "heard/suspected/inferred/confirmed",
    "source_type": "observed/told/inferred/public/document",
    "source_character": "",
    "evidence": "正文中的信息来源"
  }],
  "continuity_changes": {
    "time": "",
    "character_locations": {},
    "character_conditions": {},
    "resources": {}
  },
  "continuity_checkpoint": {
    "last_scene": {
      "time": "本章最后场景的时间",
      "location": "本章最后场景的地点",
      "pov_character": "本章结尾视角角色",
      "characters_present": ["结尾仍在场的角色"],
      "final_action": "正文最后发生的动作",
      "final_dialogue": "正文最后一句对话，没有则为空字符串"
    },
    "active_goals": [{
      "character": "角色名",
      "goal": "章末仍在执行的目标",
      "next_action": "下一步尚未完成的动作"
    }],
    "unresolved_actions": ["本章已经启动但尚未完成的动作"],
    "open_threads": [{
      "thread_id": "稳定的线索ID",
      "description": "仍待处理的线索或危险",
      "urgency": "high/medium/low"
    }],
    "relationship_changes": {"角色关系": "本章实际发生的变化"}
  }
}

facts_established 必须逐项复制章节规划中的 planned_facts，不得新增、改名或遗漏。
knowledge_changes 只能记录章节规划中 information_flow 已经声明的变化。
knowledge_changes.source_character 仅在 source_type=told 时填写角色名，其他类型输出空字符串，禁止输出 null。
如果正文创作时想到规划外的新身份、组织、能力、物品或幕后关系，删除该内容，不要写入正文或 META。
角色不能凭空获得信息，也不能把怀疑直接写成确认。
continuity_checkpoint 必须忠实记录正文最后一个场景，供下一章直接承接；
不得记录正文尚未发生的动作，也不得用计划中的预期结尾代替实际结尾。
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
    if chapter.plan:
        plan_text = json.dumps(
            chapter.plan,
            ensure_ascii=False,
            indent=2,
        )
        allowed_delta_text = json.dumps(
            {
                "facts_established": chapter.plan.get(
                    "planned_facts",
                    [],
                ),
                "knowledge_changes": chapter.plan.get(
                    "information_flow",
                    [],
                ),
            },
            ensure_ascii=False,
            indent=2,
        )
    else:
        plan_text = f"""第{ch_num}章：{chapter.title}
大纲概要：{outline.summary if outline else '按大纲推进'}
关键事件：{outline.key_events if outline else '自然推进'}"""
        allowed_delta_text = json.dumps(
            {
                "facts_established": [],
                "knowledge_changes": [],
            },
            ensure_ascii=False,
            indent=2,
        )

    narrative_context = build_narrative_context(
        state,
        chapter_number=ch_num,
        focus_text=plan_text,
    )

    user_prompt = f"""请写第{ch_num}章正文。

== 章节规划 ==
{plan_text}

== 本章状态变化白名单 ==
{allowed_delta_text}

facts_established 必须与白名单完全一致；knowledge_changes 不得超出白名单。
白名单外的剧情设定必须从正文和 META 中删除。
章节开头必须逐步执行 chapter_plan.opening_bridge，并在前300字完成承接。
immediate_predecessor.ending_excerpt 是上一章批准正文的精确结尾，优先级高于概括性摘要。

== 世界设定 ==
{world_text}

== 角色档案 ==
{character_text}

== 前文摘要 ==
{prev_text}

== 伏笔追踪 ==
{fs_text}

== 分层章节上下文（immediate_predecessor 必须优先承接）==
{narrative_context}

== 本轮重写反馈 ==
{chapter.rewrite_feedback or '无'}

---
请写出2000-2500字的章节正文。记住：对话驱动、手机阅读适配、章末强钩子、避免AI写作禁忌。"""

    try:
        prose, meta = call_text_with_contract_sync(
            call_llm_sync,
            SYSTEM_PROMPT,
            user_prompt,
            parser=parse_chapter_response,
            contract_name="章节正文与 META",
            max_tokens=8192,
            temperature=0.85,
        )

        contract_violations = []
        try:
            validate_narrative_delta(
                state,
                chapter.plan,
                meta,
            )
        except OutputContractError as exc:
            contract_violations.append(str(exc))

        chapter.draft = prose
        chapter.word_count = len(prose.replace(' ', ''))  # 中文按字数算
        chapter.generation_meta = meta
        chapter.narrative_delta = {
            "chapter_summary": meta["chapter_summary"],
            "facts_established": meta["facts_established"],
            "knowledge_changes": meta["knowledge_changes"],
            "continuity_changes": meta["continuity_changes"],
            "continuity_checkpoint": meta["continuity_checkpoint"],
        }
        if contract_violations:
            chapter.narrative_delta[
                "contract_violations"
            ] = contract_violations

        if meta:
            chapter.chapter_hook = meta.get("chapter_hook", "")
            chapter.shuangdian_type = meta.get("shuangdian_beat", "")

        state.node_status[f"writing_{ch_num}"] = NodeStatus.COMPLETED
        if contract_violations:
            state.log(
                f"节点5: 章节写作 — 第{ch_num}章候选稿越过叙事规划，"
                "转入自动重写。"
            )
        else:
            state.log(
                f"节点5: 章节写作 — 第{ch_num}章完成"
                f"（{chapter.word_count}字）| 钩子："
                f"{chapter.chapter_hook[:30]}"
            )
    except Exception as e:
        state.node_status[f"writing_{ch_num}"] = NodeStatus.FAILED
        state.last_error = {"node": f"writing_{ch_num}", "message": str(e)}
        state.log(f"节点5: 章节写作 — 失败: {e}")

    return state


def commit_generation_meta(state: GraphNovelState, ch_num: int) -> None:
    """Idempotently commit accepted writing META into global trackers."""
    chapter = state.chapters[ch_num - 1]
    meta = chapter.generation_meta
    _update_foreshadowing(state, meta, ch_num)
    _update_arcs(state, meta, ch_num)
    commit_narrative_delta(state, ch_num, chapter.narrative_delta)
    commit_continuity_checkpoint(chapter)


def _update_foreshadowing(state: GraphNovelState, meta: dict, ch_num: int) -> None:
    for index, fp in enumerate(meta.get("foreshadowing_planted", []), start=1):
        fid = f"fs_ch{ch_num:02d}_{index:02d}"
        if any(existing.id == fid for existing in state.foreshadowing_tracker):
            continue
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
