"""
Node 1: 世界观构建 Agent
针对番茄小说平台：生成适合快节奏脑洞网文的世界设定。
"""

import json
import re

from graph_novel.state import GraphNovelState, NodeStatus, WorldSetting
from graph_novel.llm import call_llm_sync

SYSTEM_PROMPT = """你是一位番茄小说平台的金牌世界观架构师。你的任务是为中文网络小说创建一个简洁、高辨识度、适合快节奏阅读的世界设定。

番茄小说平台规则：
- 读者耐心极短（30秒内决定去留），世界观必须在前3章内自然展现，不能有大段说明
- 黄金三章法则：第一章立人设+抛悬念，第二章强化冲突，第三章反转打脸
- 设定要"一句话能说清楚"，让读者瞬间理解核心规则
- 避免复杂的魔法体系、多势力政治格局——番茄读者要的是爽，不是烧脑

输出 JSON 对象，字段如下（全部用中文）：
- era: 时代背景（如"现代都市"、"近未来2045"、"架空古代"）
- location: 主要场景（如"东海市"、"天玄大陆"）
- special_setting: 核心设定（一句话说清这个世界哪里不一样，如"灵气复苏第三年，全民觉醒异能"、"主角绑定神豪系统，花钱就能变强"）
- technology_level: 科技水平
- social_structure: 社会结构（简洁，2-3句话）
- key_locations: 关键场景列表 [{name, description}]（3-5个，每个一句话说清）
- rules_and_laws: 世界观核心规则（3-5条，每条一行）
- history: 相关历史背景（2-3句话）
- golden_finger: 金手指设定（番茄平台必备！如"签到系统"、"重生记忆"、"SSS级天赋"等，必须具体描述）
- notes: 额外备注

核心原则：
1. 金手指必须清晰、好懂、有成长空间
2. 世界规则必须简单——"打破规则"才是爽点来源
3. 所有设定都要服务于"主角逆袭打脸"的核心爽点

请只输出 JSON 对象，不要其他文字。"""


def run_node(state: GraphNovelState) -> GraphNovelState:
    state.log("节点1: 世界观构建 — 生成中……")
    state.node_status["world_building"] = NodeStatus.IN_PROGRESS

    existing_notes = state.world_setting.notes if state.world_setting else ""
    # Also pick up user's creative notes if available
    creative_notes = getattr(state, 'creative_notes', '') or ''
    combined_notes = (existing_notes + '\n' + creative_notes).strip() or '写一部脑洞大开的爽文，主角拥有独特的金手指，节奏快，爽点密集。'
    genre_tags = ", ".join(state.genre_tags) if state.genre_tags else "未指定"
    target_platform = getattr(state, 'target_platform', 'fanqie')
    foundation_feedback = state.foundation_feedback or "无"

    user_prompt = f"""为一部番茄小说创建世界设定。

书名：{state.novel_title}
用户指定题材：{state.creative_genre or '未指定'}
题材标签：{genre_tags}
用户的一句话卖点：{state.creative_premise or '未指定'}
用户的核心爽点方向：{state.creative_theme or '未指定'}
目标平台：{target_platform}
目标总字数：{state.target_total_words}
目标章数：{state.target_total_chapters or state.total_chapters}
创作方向：{combined_notes}
上一轮 Foundation 修改意见：{foundation_feedback}

生成完整世界设定 JSON。"""

    try:
        raw = call_llm_sync(SYSTEM_PROMPT, user_prompt, max_tokens=4096, temperature=0.8)
        json_text = _extract_json(raw)
        data = json.loads(json_text)

        state.world_setting = WorldSetting(
            era=data.get("era", ""),
            location=data.get("location", ""),
            magic_system=data.get("special_setting") or data.get("magic_system"),
            technology_level=data.get("technology_level"),
            social_structure=data.get("social_structure", ""),
            key_locations=data.get("key_locations", []),
            rules_and_laws=data.get("rules_and_laws", ""),
            history=data.get("history", ""),
            notes=f"金手指：{data.get('golden_finger', '')} | {data.get('notes', '')}",
        )
        state.node_status["world_building"] = NodeStatus.COMPLETED
        state.log("节点1: 世界观构建 — 完成。")
    except Exception as e:
        state.node_status["world_building"] = NodeStatus.FAILED
        state.last_error = {"node": "world_building", "message": str(e)}
        state.log(f"节点1: 世界观构建 — 失败: {e}")

    return state


def _extract_json(text: str) -> str:
    match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if match:
        return match.group(1)
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        return match.group(0)
    return text
