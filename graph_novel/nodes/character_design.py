"""
Node 2: 人物设计 Agent
针对番茄小说平台：快节奏爽文的人物体系——主角必须强辨识度 + 金手指，
反派要有层次感（不能纯工具人），配角服务于爽点节奏。
"""

import json
import re
from enum import Enum
from typing import Any, Dict, List, Optional

from graph_novel.state import (
    GraphNovelState, NodeStatus, Character, CharacterArc, ArcStage,
)
from graph_novel.llm import call_llm_sync

SYSTEM_PROMPT = """你是一位番茄小说平台的御用角色设计师。你为快节奏爽文创造让读者"一眼记住、立刻代入"的角色。

番茄小说角色设计铁律：
1. 主角：必须有金手指（系统/重生/特殊能力）+ 清晰欲望（逆袭/复仇/变强/搞钱）+ 底层身份反差（表面废柴/穷/被欺，实则有逆天底牌）
2. 主角性格标签不超过3个，让读者30秒内形成印象
3. 反派：不能纯蠢——要有实力/智力/资源，让主角的胜利显得有价值
4. 第一个被打脸的反派必须在开篇1000字内出现
5. 女频：大女主独立清醒，不圣母不恋爱脑
6. 男频：主角杀伐果断，不圣母不拖泥带水
7. 配角：每人一个记忆标签，服务于"黄金三章"节奏

输出 JSON 数组，每个角色包含：
- name: 角色名（中文）
- role: 角色定位（主角/反派/女主/男配/女配/导师/金手指载体）
- background: 背景故事（2-3句，突出与主线冲突的关联）
- personality: 性格标签（用关键词，如"冷静腹黑、杀伐果断、护短"）
- motivation: 核心驱动力（一句话，如"攒够100亿系统积分回到地球"）
- golden_finger: 金手指（如果是主角，必须详细描述；配角可选）
- arc_stage: 弧线阶段（inciting_incident/rising_action/midpoint/dark_moment/climax/resolution）
- arc_description: 角色成长弧线（2-3句）
- relationships: 与其他角色的关系 {角色名: 关系描述}
- first_appearance_hook: 首次出场怎么制造记忆点（一句话）
- notes: 补充说明

必须包含：
- 1个主角（有金手指、有明确欲望、有底层身份）
- 1个主要反派（聪明有实力的对手，不是蠢货）
- 1个女主/男主（如果涉及感情线）
- 2-4个配角（各有标签功能）

请只输出 JSON 数组，不要其他文字。"""


def run_node(state: GraphNovelState) -> GraphNovelState:
    state.log("节点2: 人物设计 — 生成角色阵容……")
    state.node_status["character_design"] = NodeStatus.IN_PROGRESS

    world_dict = _serialize_dataclass(state.world_setting) if state.world_setting else {}
    world_json = json.dumps(world_dict, ensure_ascii=False, indent=2)

    genre_tags = ", ".join(state.genre_tags) if state.genre_tags else "未指定"
    foundation_feedback = state.foundation_feedback or "无"

    user_prompt = f"""为这部番茄小说创角。

世界设定：
{world_json}

用户指定题材：{state.creative_genre or '未指定'}
题材标签：{genre_tags}
用户的一句话卖点：{state.creative_premise or '未指定'}
用户的核心爽点方向：{state.creative_theme or '未指定'}
书名：{state.novel_title}
上一轮 Foundation 修改意见：{foundation_feedback}

生成完整的角色阵容 JSON。"""

    try:
        raw = call_llm_sync(SYSTEM_PROMPT, user_prompt, max_tokens=4096, temperature=0.8)
        json_text = _extract_json(raw)
        data = json.loads(json_text)

        characters = []
        for c in data:
            arc_stage_str = c.get("arc_stage", "pre_story")
            try:
                arc_stage = ArcStage(arc_stage_str)
            except ValueError:
                arc_stage = ArcStage.INCITING_INCIDENT

            char = Character(
                name=c.get("name", ""),
                role=c.get("role", ""),
                background=c.get("background", ""),
                personality=c.get("personality", ""),
                motivation=c.get("motivation", ""),
                arc=CharacterArc(
                    character_name=c.get("name", ""),
                    arc_description=c.get("arc_description", ""),
                    current_stage=arc_stage,
                ),
                relationships=c.get("relationships", {}),
                notes=f"金手指：{c.get('golden_finger', '无')} | 首秀钩子：{c.get('first_appearance_hook', '')}",
            )
            characters.append(char)
            state.character_arc_tracker[char.name] = char.arc

        state.characters = characters
        state.node_status["character_design"] = NodeStatus.COMPLETED
        state.log(f"节点2: 人物设计 — {len(characters)} 个角色已创建。")
    except Exception as e:
        state.node_status["character_design"] = NodeStatus.FAILED
        state.last_error = {"node": "character_design", "message": str(e)}
        state.log(f"节点2: 人物设计 — 失败: {e}")

    return state


def _extract_json(text: str) -> str:
    match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if match:
        return match.group(1)
    match = re.search(r"\[[\s\S]*\]", text)
    if match:
        return match.group(0)
    return text


def _serialize_dataclass(obj):
    if obj is None:
        return None
    if hasattr(obj, 'to_dict'):
        return obj.to_dict()
    if hasattr(obj, '__dataclass_fields__'):
        return {k: _serialize_dataclass(getattr(obj, k)) for k in obj.__dataclass_fields__}
    if isinstance(obj, list):
        return [_serialize_dataclass(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _serialize_dataclass(v) for k, v in obj.items()}
    if isinstance(obj, Enum):
        return obj.value
    return obj
