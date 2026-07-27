"""
Node 3: 大纲规划 Agent
针对番茄小说平台：设计「黄金三章 + 爽点排期表」为核心的章节大纲。

番茄小说大纲核心要素：
- 黄金三章（前3章决定生死）：第1章立人设+抛悬念，第2章强化冲突，第3章反转打脸+兑现
- 爽点节奏：3章一小爽，10章一大爽
- 章末钩子：每章结尾必须有悬念截断
- 适合2000-2500字/章的节奏设计
"""

import json

from graph_novel.state import (
    GraphNovelState, NodeStatus, NovelOutline, ChapterOutline,
)
from graph_novel.llm import call_llm_sync
from graph_novel.output_contracts import (
    call_json_with_contract_sync,
    outline_contract,
    to_prompt_data,
)

SYSTEM_PROMPT = """你是一位番茄小说平台的资深大纲规划师。你的任务是设计一部网文的完整章节大纲，
核心原则：快节奏、爽点密集、章章有钩子、黄金三章定生死。

番茄小说平台规则：
- 每章2000-2500字
- 前300字必须出冲突（读者3秒决定去留）
- 黄金三章：Ch1立人设+抛悬念 → Ch2强化冲突 → Ch3反转打脸+小爽点兑现
- 爽点节奏：3章一小爽，10章一大爽
- 每章结尾必须留钩子（悬念截断）
- 对话驱动（60%对话+30%旁白+10%心理）
- 每段不超过3行，适配手机阅读
- 前30章是平台推荐算法的生死线

输出 JSON 对象：
- genre: 题材（如"都市脑洞"、"年代重生"、"玄幻爽文"）
- premise: 一句话卖点（钩子，让读者一看就想点开）
- theme: 核心主题
- target_length: 目标总字数（如"50万字"）
- suggested_chapter_count: 建议章数
- shuangdian_map: 爽点排期表 [{chapter_range, type(大爽点/小爽点), description}]
- chapter_outlines: 章节大纲数组，每章包含：
  - chapter_number: 章号
  - title: 章标题（必须有网感！吸引点击，如"第3章 谁说废柴不能打脸？"）
  - summary: 本章概要
  - pov_character: POV角色
  - key_events: 关键事件列表（3-5条）
  - shuangdian_beat: 本章爽点定位（"" | "小爽点" | "大爽点" | "铺垫" | "黄金三章之1/2/3"）
  - chapter_hook_idea: 章末钩子构思（怎么制造悬念让读者点下一章）
  - foreshadowing_to_plant: 要埋的伏笔
  - foreshadowing_to_pay_off: 要回收的伏笔

特别关注：
- 前3章必须按照黄金三章法则详细设计
- 第1章：300字内主角出场+冲突爆发
- 第10章左右安排第一个大爽点
- 前30章节奏紧凑，不能有任何水章
- 每章标题要有"网感"——吸引点击

请只输出 JSON 对象，不要其他文字。"""


def run_node(state: GraphNovelState) -> GraphNovelState:
    state.log("节点3: 大纲规划 — 生成章节大纲……")
    state.node_status["outline_planning"] = NodeStatus.IN_PROGRESS

    world_dict = to_prompt_data(state.world_setting) if state.world_setting else {}
    world_json = json.dumps(world_dict, ensure_ascii=False, indent=2)

    char_summary = []
    for c in state.characters:
        char_summary.append(f"{c.name}（{c.role}）：{c.motivation} | {c.notes[:80]}")
    chars_text = "\n".join(char_summary)

    genre_tags = ", ".join(state.genre_tags) if state.genre_tags else "未指定"
    total_chapters = state.target_total_chapters or state.total_chapters or 30
    foundation_feedback = state.foundation_feedback or "无"

    user_prompt = f"""为这部番茄小说创建完整大纲。

世界设定：
{world_json}

角色：
{chars_text}

书名：{state.novel_title}
用户指定题材：{state.creative_genre or '未指定'}
题材标签：{genre_tags}
用户的一句话卖点：{state.creative_premise or '未指定'}
用户的核心爽点方向：{state.creative_theme or '未指定'}
目标总字数：{state.target_total_words}
目标章数：{total_chapters}
上一轮 Foundation 修改意见：{foundation_feedback}

生成恰好 {total_chapters} 章的完整大纲 JSON。特别是前3章要严格按黄金三章法则设计。"""

    try:
        data = call_json_with_contract_sync(
            call_llm_sync,
            SYSTEM_PROMPT,
            user_prompt,
            contract=outline_contract(total_chapters),
            max_tokens=8192,
            temperature=0.7,
        )
        chapter_data = data["chapter_outlines"]

        chapters = []
        for co in chapter_data:
            chapters.append(ChapterOutline(
                chapter_number=co.get("chapter_number", 0),
                title=co.get("title", ""),
                summary=co.get("summary", ""),
                pov_character=co.get("pov_character"),
                key_events=co.get("key_events", []),
                foreshadowing_to_plant=co.get("foreshadowing_to_plant", []),
                foreshadowing_to_pay_off=co.get("foreshadowing_to_pay_off", []),
                shuangdian_beat=co.get("shuangdian_beat", ""),
                chapter_hook_idea=co.get("chapter_hook_idea", ""),
            ))

        state.novel_outline = NovelOutline(
            genre=data.get("genre", ""),
            premise=data.get("premise", ""),
            theme=data.get("theme", ""),
            target_length=data.get("target_length", ""),
            target_platform="fanqie",
            shuangdian_map=data.get("shuangdian_map", []),
            chapter_outlines=chapters,
        )
        state.total_chapters = len(chapters)
        state.node_status["outline_planning"] = NodeStatus.COMPLETED
        state.log(f"节点3: 大纲规划 — {len(chapters)} 章已规划 | 爽点排期已定。")
    except Exception as e:
        state.node_status["outline_planning"] = NodeStatus.FAILED
        state.last_error = {"node": "outline_planning", "message": str(e)}
        state.log(f"节点3: 大纲规划 — 失败: {e}")

    return state
