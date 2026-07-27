"""
Node 7: 风格润色 Agent
针对番茄小说：优化网感、消除AI味、强化爽点表达、适配手机阅读。
"""

import re

from graph_novel.state import GraphNovelState, NodeStatus
from graph_novel.llm import call_llm_sync

SYSTEM_PROMPT = """你是一位番茄小说平台的文字润色师。你专门消除AI写作痕迹，提升"网感"，让文字更符合手机阅读习惯。

润色范围（只优化文字，不改变剧情）：

1. 消除AI味：
   - 删除"不是……而是……"句式
   - 删除"首先、其次、最后"的说明文结构
   - 删除对话后重复叙述的旁白
   - 删除连续堆叠的同情绪词汇
   - 把"他感到愤怒"改成"他一拳砸在桌上"
   - 把抽象描写改成具体动作

2. 增强网感：
   - 对话加上语气词（"卧槽""淦""啧""呵"等符合人设的口语）
   - 打脸场景加"反讽""毒舌"对话
   - 内心OS改成简短有力的独白

3. 手机阅读适配：
   - 超过3行的段落强制拆分
   - 长句改短句
   - 增加段落间空行

4. 爽点强化：
   - 打脸段落增加短句节奏感
   - 高潮段落加快节奏（短句+动作）

5. 章末钩子优化：
   - 确保钩子有力、有悬念
   - 钩子不要解释，要留白

润色后完整输出正文。如有编辑建议，放在 "---编辑建议---" 分隔符后（可选）。
只输出润色后的正文。"""


def run_node(state: GraphNovelState) -> GraphNovelState:
    ch_num = state.current_chapter
    state.log(f"节点7: 风格润色 — 润色第{ch_num}章……")
    state.node_status[f"style_polish_{ch_num}"] = NodeStatus.IN_PROGRESS

    chapter = state.chapters[ch_num - 1]
    if not chapter.draft:
        state.node_status[f"style_polish_{ch_num}"] = NodeStatus.SKIPPED
        return state

    consistency_notes = ""
    if chapter.consistency_report:
        issues = chapter.consistency_report.get("issues", [])
        ai_issues = [i for i in issues if i.get("category") == "AI病"]
        if ai_issues:
            consistency_notes = "审查发现的AI病问题：\n"
            for i in ai_issues[:3]:
                consistency_notes += f"- {i.get('description', '')[:100]}\n"

    user_prompt = f"""润色以下章节的文字。

{consistency_notes}

== 第{ch_num}章：{chapter.title}（{chapter.word_count}字）==
{chapter.draft[:12000]}

请润色并输出完整正文。"""

    try:
        raw = call_llm_sync(SYSTEM_PROMPT, user_prompt, max_tokens=8192, temperature=0.5)
        polished, notes = _parse_response(raw)
        if not polished:
            raise ValueError("风格润色响应没有正文")
        chapter.polished_draft = polished
        chapter.word_count = len(polished.replace(' ', ''))

        if notes:
            chapter.consistency_report["润色建议"] = notes

        state.node_status[f"style_polish_{ch_num}"] = NodeStatus.COMPLETED
        state.log(f"节点7: 风格润色 — 第{ch_num}章已润色（{chapter.word_count}字）。")
    except Exception as e:
        state.node_status[f"style_polish_{ch_num}"] = NodeStatus.FAILED
        state.last_error = {
            "node": f"style_polish_{ch_num}",
            "message": str(e),
        }
        state.log(f"节点7: 风格润色 — 失败: {e}")

    return state


def _parse_response(text: str):
    if "---编辑建议---" in text:
        parts = text.split("---编辑建议---", 1)
        return parts[0].strip(), parts[1].strip()
    return text.strip(), ""
