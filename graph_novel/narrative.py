"""Narrative facts, character knowledge, and continuity helpers."""

import json
from typing import Any, Dict, List

from graph_novel.output_contracts import OutputContractError
from graph_novel.state import (
    ApprovalStatus,
    GraphNovelState,
    KnowledgeRecord,
    NarrativeFact,
)


VALID_KNOWLEDGE_LEVELS = {"heard", "suspected", "inferred", "confirmed"}
VALID_SOURCE_TYPES = {"observed", "told", "inferred", "public", "document"}
KNOWLEDGE_RANK = {
    "heard": 1,
    "suspected": 2,
    "inferred": 3,
    "confirmed": 4,
}


def build_narrative_context(state: GraphNovelState) -> str:
    """Build compact approved-story context for planning and review."""
    approved_summaries = []
    legacy_excerpts = []
    for chapter in state.chapters:
        if chapter.approval != ApprovalStatus.APPROVED:
            continue
        summary = chapter.narrative_delta.get("chapter_summary", "")
        if not summary and chapter.outline:
            summary = chapter.outline.summary
        approved_summaries.append({
            "chapter_number": chapter.chapter_number,
            "summary": summary or chapter.chapter_hook or chapter.title,
        })
        if (
            not chapter.narrative_delta.get("facts_established")
            and not chapter.narrative_delta.get("knowledge_changes")
        ):
            chapter_text = chapter.polished_draft or chapter.draft
            if chapter_text:
                legacy_excerpts.append({
                    "chapter_number": chapter.chapter_number,
                    "text": chapter_text[:6000],
                })

    payload = {
        "facts": [
            {
                "fact_id": fact.id,
                "statement": fact.statement,
                "category": fact.category,
                "visibility": fact.visibility,
                "status": fact.status,
                "established_in_chapter": fact.established_in_chapter,
            }
            for fact in state.narrative_facts
        ],
        "character_knowledge": [
            {
                "fact_id": record.fact_id,
                "character": record.character,
                "knowledge_level": record.knowledge_level,
                "learned_in_chapter": record.learned_in_chapter,
                "source_type": record.source_type,
                "source_character": record.source_character,
                "evidence": record.evidence,
            }
            for record in state.character_knowledge
        ],
        "continuity": state.continuity_state,
        "approved_chapter_summaries": approved_summaries[-20:],
        "legacy_approved_excerpts": legacy_excerpts[-3:],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


def validate_chapter_plan(
    state: GraphNovelState,
    plan: Dict[str, Any],
) -> None:
    """Reject plans that reference unavailable facts or unsupported sources."""
    existing_facts = {fact.id: fact for fact in state.narrative_facts}
    planned_facts = _fact_map(plan["planned_facts"], path="chapter_plan")
    available_ids = set(existing_facts) | set(planned_facts)

    missing = [
        fact_id
        for fact_id in plan["required_fact_ids"]
        if fact_id not in existing_facts
    ]
    if missing:
        raise OutputContractError(
            "chapter_plan.required_fact_ids 引用了尚未建立的事实："
            + ", ".join(missing)
        )

    for fact_id, planned in planned_facts.items():
        existing = existing_facts.get(fact_id)
        if existing and existing.statement != planned["statement"]:
            raise OutputContractError(
                f"chapter_plan.planned_facts 的 {fact_id} 与既有事实冲突"
            )

    knowledge_levels = {
        (record.fact_id, record.character): record.knowledge_level
        for record in state.character_knowledge
    }
    for index, transfer in enumerate(plan["information_flow"]):
        fact_id = transfer["fact_id"]
        if not transfer["character"].strip():
            raise OutputContractError(
                "chapter_plan.information_flow"
                f"[{index}].character 不能为空"
            )
        if fact_id not in available_ids:
            raise OutputContractError(
                "chapter_plan.information_flow"
                f"[{index}] 引用了未知事实 {fact_id}"
            )
        if transfer["knowledge_level"] not in VALID_KNOWLEDGE_LEVELS:
            raise OutputContractError(
                "chapter_plan.information_flow"
                f"[{index}].knowledge_level 无效"
            )
        if transfer["source_type"] not in VALID_SOURCE_TYPES:
            raise OutputContractError(
                "chapter_plan.information_flow"
                f"[{index}].source_type 无效"
            )
        if not transfer["evidence"].strip():
            raise OutputContractError(
                "chapter_plan.information_flow"
                f"[{index}].evidence 不能为空"
            )
        source_character = transfer["source_character"]
        if transfer["source_type"] == "told" and not source_character.strip():
            raise OutputContractError(
                "chapter_plan.information_flow"
                f"[{index}] 转述信息必须提供 source_character"
            )
        if (
            transfer["source_type"] == "told"
            and fact_id in existing_facts
            and (fact_id, source_character) not in knowledge_levels
        ):
            raise OutputContractError(
                f"{source_character} 尚不知道 {fact_id}，不能向其他角色转述"
            )
        source_level = knowledge_levels.get((fact_id, source_character))
        if (
            transfer["source_type"] == "told"
            and source_level
            and KNOWLEDGE_RANK[transfer["knowledge_level"]]
            > KNOWLEDGE_RANK[source_level]
        ):
            raise OutputContractError(
                f"{source_character} 对 {fact_id} 仅为 {source_level}，"
                f"不能让 {transfer['character']} 直接达到"
                f" {transfer['knowledge_level']}"
            )
        current_level = knowledge_levels.get(
            (fact_id, transfer["character"]),
        )
        if (
            current_level
            and KNOWLEDGE_RANK[transfer["knowledge_level"]]
            < KNOWLEDGE_RANK[current_level]
        ):
            raise OutputContractError(
                f"{transfer['character']} 对 {fact_id} 的认知不能从"
                f" {current_level} 降级为 {transfer['knowledge_level']}"
            )
        knowledge_levels[
            (fact_id, transfer["character"])
        ] = transfer["knowledge_level"]


def validate_narrative_delta(
    state: GraphNovelState,
    plan: Dict[str, Any],
    delta: Dict[str, Any],
) -> None:
    """Ensure writing only commits facts and knowledge authorized by its plan."""
    existing_facts = {fact.id: fact for fact in state.narrative_facts}
    planned_facts = _fact_map(plan["planned_facts"], path="chapter_plan")
    delta_facts = _fact_map(delta["facts_established"], path="writing_meta")

    unplanned_facts = set(delta_facts) - set(planned_facts)
    missing_facts = set(planned_facts) - set(delta_facts)
    if unplanned_facts:
        raise OutputContractError(
            "writing_meta.facts_established 包含未规划事实："
            + ", ".join(sorted(unplanned_facts))
        )
    if missing_facts:
        raise OutputContractError(
            "writing_meta.facts_established 遗漏已规划事实："
            + ", ".join(sorted(missing_facts))
        )
    for fact_id, fact in delta_facts.items():
        planned = planned_facts[fact_id]
        if fact["statement"] != planned["statement"]:
            raise OutputContractError(
                f"writing_meta 中 {fact_id} 的事实描述偏离章节计划"
            )
        existing = existing_facts.get(fact_id)
        if existing and existing.statement != fact["statement"]:
            raise OutputContractError(
                f"writing_meta 中 {fact_id} 与已批准事实冲突"
            )

    planned_knowledge = {
        (
            transfer["fact_id"],
            transfer["character"],
            transfer["knowledge_level"],
            transfer["source_type"],
            transfer["source_character"],
        )
        for transfer in plan["information_flow"]
    }
    available_ids = set(existing_facts) | set(delta_facts)
    for index, change in enumerate(delta["knowledge_changes"]):
        signature = (
            change["fact_id"],
            change["character"],
            change["knowledge_level"],
            change["source_type"],
            change["source_character"],
        )
        if change["fact_id"] not in available_ids:
            raise OutputContractError(
                "writing_meta.knowledge_changes"
                f"[{index}] 引用了未知事实 {change['fact_id']}"
            )
        if not change["evidence"].strip():
            raise OutputContractError(
                "writing_meta.knowledge_changes"
                f"[{index}].evidence 不能为空"
            )
        if signature not in planned_knowledge:
            raise OutputContractError(
                "writing_meta.knowledge_changes"
                f"[{index}] 未在章节 information_flow 中规划"
            )
    actual_knowledge = {
        (
            change["fact_id"],
            change["character"],
            change["knowledge_level"],
            change["source_type"],
            change["source_character"],
        )
        for change in delta["knowledge_changes"]
    }
    missing_knowledge = planned_knowledge - actual_knowledge
    if missing_knowledge:
        raise OutputContractError(
            "writing_meta.knowledge_changes 遗漏已规划的信息变化"
        )


def commit_narrative_delta(
    state: GraphNovelState,
    chapter_number: int,
    delta: Dict[str, Any],
) -> None:
    """Idempotently commit one approved chapter's narrative state changes."""
    existing_fact_ids = {fact.id for fact in state.narrative_facts}
    for item in delta.get("facts_established", []):
        if item["fact_id"] in existing_fact_ids:
            continue
        state.narrative_facts.append(NarrativeFact(
            id=item["fact_id"],
            statement=item["statement"],
            category=item["category"],
            established_in_chapter=chapter_number,
            visibility=item["visibility"],
        ))
        existing_fact_ids.add(item["fact_id"])

    existing_knowledge = {
        (
            record.fact_id,
            record.character,
            record.knowledge_level,
            record.learned_in_chapter,
        )
        for record in state.character_knowledge
    }
    for item in delta.get("knowledge_changes", []):
        signature = (
            item["fact_id"],
            item["character"],
            item["knowledge_level"],
            chapter_number,
        )
        if signature in existing_knowledge:
            continue
        state.character_knowledge.append(KnowledgeRecord(
            fact_id=item["fact_id"],
            character=item["character"],
            knowledge_level=item["knowledge_level"],
            learned_in_chapter=chapter_number,
            source_type=item["source_type"],
            source_character=item["source_character"],
            evidence=item["evidence"],
        ))
        existing_knowledge.add(signature)

    changes = delta.get("continuity_changes", {})
    if changes.get("time"):
        state.continuity_state["time"] = changes["time"]
    for key in (
        "character_locations",
        "character_conditions",
        "resources",
    ):
        target = state.continuity_state.setdefault(key, {})
        target.update(changes.get(key, {}))


def has_blocking_narrative_violations(report: Dict[str, Any]) -> bool:
    """Return whether a review must take the rewrite edge."""
    if not report.get("logic_gate_passed", True):
        return True
    blocking = {"致命", "严重", "critical", "fatal", "serious"}
    return any(
        violation.get("severity", "").strip().lower() in blocking
        for violation in report.get("narrative_violations", [])
    )


def _fact_map(items: List[Dict[str, Any]], *, path: str) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for item in items:
        fact_id = item["fact_id"]
        if not fact_id.strip():
            raise OutputContractError(f"{path}.fact_id 不能为空")
        if not item["statement"].strip():
            raise OutputContractError(
                f"{path} 中 {fact_id}.statement 不能为空"
            )
        if fact_id in result:
            raise OutputContractError(
                f"{path} 包含重复 fact_id：{fact_id}"
            )
        result[fact_id] = item
    return result
