"""
Node 9: 全局收束审查 Agent
针对番茄小说：逐章数据汇总 + 算法适配评估 + 完读率预估 + 全本质量报告。
"""

import json
import re

from graph_novel.state import GraphNovelState, NodeStatus
from graph_novel.llm import call_llm_sync

SYSTEM_PROMPT = """你是一位番茄小说平台的数据分析师兼总编辑。你审查一部已完成全部章节的网络小说，从算法推荐和读者留存的角度给出全局评估。

评估维度（番茄小说标准）：

1. 黄金三章达标检查：
   - 第1章：300字内出冲突了吗？主角立住了吗？悬念抛了吗？
   - 第2章：冲突是否升级？
   - 第3章：是否有反转打脸？前3章完读率预估（>50%为及格）

2. 爽点节奏分析：
   - 3章一小爽、10章一大爽的节奏是否兑现？
   - 爽点密度是否达标？
   - 爽点质量（打脸够不够狠？反转够不够意外？）

3. 章末钩子全检：
   - 每章是否都有有效钩子？
   - 强钩子/弱钩子/无钩子的分布

4. 角色弧线完整性：
   - 主角是否有清晰成长线？
   - 反派是否有层次（不是纯工具人）？
   - 配角是否有记忆点？

5. AI味残留检测：
   - 全书AI病出现频率
   - 是否有明显的AI写作痕迹

6. 算法适配评估：
   - 前10章完读率预估
   - 10万字完读率预估
   - 追更率预估
   - 是否适合进入首秀池

7. 平台竞争力：
   - 在番茄同类题材中的竞争力评估
   - 差异化亮点
   - 致命短板

输出 JSON：
{
  "overall_score": 1-10,
  "golden_three_analysis": { "ch1_quality": "", "ch2_quality": "", "ch3_quality": "", "estimated_ch3_retention": "" },
  "shuangdian_analysis": { "density": "密集/适中/稀疏", "small_beats_count": 0, "big_beats_count": 0, "issues": [] },
  "hook_analysis": { "strong": 0, "weak": 0, "missing": 0, "problem_chapters": [] },
  "arc_review": { "角色名": {"completeness": "完整/部分/缺失", "issues": []} },
  "ai_disease_summary": { "total_found": 0, "high_risk_chapters": [], "overall_risk": "低/中/高" },
  "algorithm_fitness": {
    "estimated_ch10_retention": "",
    "estimated_10w_retention": "",
    "estimated_follow_rate": "",
    "shouxiu_ready": true/false
  },
  "platform_competitiveness": { "strength": "", "weakness": "", "differentiation": "" },
  "structural_issues": [{ "severity": "", "description": "", "suggested_fix": "" }],
  "final_recommendations": ["具体建议列表"],
  "ready_for_platform": true/false
}

请只输出 JSON 对象。"""


def run_node(state: GraphNovelState) -> GraphNovelState:
    state.log("节点9: 全局收束审查 — 全书终审……")
    state.node_status["global_review"] = NodeStatus.IN_PROGRESS

    chapters_summary = _build_chapters_summary(state)
    characters_summary = _build_characters_summary(state)
    fs_summary = _build_foreshadowing_summary(state)
    genre_tags = ", ".join(state.genre_tags) if state.genre_tags else "未指定"

    user_prompt = f"""番茄小说全局审查报告。

书名：{state.novel_title}
题材标签：{genre_tags}
总章数：{state.total_chapters}

== 逐章数据 ==
{chapters_summary}

== 角色弧线 ==
{characters_summary}

== 伏笔追踪 ==
{fs_summary}

请执行全局审查，输出 JSON 报告。"""

    try:
        raw = call_llm_sync(SYSTEM_PROMPT, user_prompt, max_tokens=8192, temperature=0.4)
        json_text = _extract_json(raw)
        report = json.loads(json_text)
        state.global_review_report = report
        state.node_status["global_review"] = NodeStatus.COMPLETED
        score = report.get("overall_score", "?")
        ready = report.get("ready_for_platform", False)
        state.log(f"节点9: 全局收束审查 — 综合评分{score}/10 | 平台就绪：{'是' if ready else '否'}")
    except Exception as e:
        state.node_status["global_review"] = NodeStatus.FAILED
        state.log(f"节点9: 全局收束审查 — 失败: {e}")
        state.global_review_report = {"error": str(e)}

    return state


def _build_chapters_summary(state: GraphNovelState) -> str:
    parts = []
    for ch in state.chapters:
        review = ch.consistency_report
        score = review.get("overall_score", "?") if review else "?"
        ai_count = review.get("ai_disease_count", "?") if review else "?"
        hook = getattr(ch, 'chapter_hook', '') or '无钩子'
        shuangdian = getattr(ch, 'shuangdian_type', '') or '未标记'
        parts.append(
            f"第{ch.chapter_number}章 {ch.title} | {ch.word_count}字 | "
            f"审稿{score}/10 | AI病{ai_count}处 | 爽点：{shuangdian} | 钩子：{hook[:40]}"
        )
    return "\n".join(parts) if parts else "无章节数据。"


def _build_characters_summary(state: GraphNovelState) -> str:
    parts = []
    for name, arc in state.character_arc_tracker.items():
        parts.append(f"{name}：{arc.arc_description[:100]} | 最终阶段：{arc.current_stage.value}")
    return "\n".join(parts) if parts else "无角色数据。"


def _build_foreshadowing_summary(state: GraphNovelState) -> str:
    items = [f"[{fs.id}] {fs.status} — {fs.description[:80]}（第{fs.planted_in_chapter}章埋" +
             (f"，第{fs.payoff_chapter}章收）" if fs.payoff_chapter else "，未收）")
             for fs in state.foreshadowing_tracker]
    return "\n".join(items) if items else "无伏笔。"


def _extract_json(text: str) -> str:
    match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if match:
        return match.group(1)
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        return match.group(0)
    return text
