"""Shared parsing, validation, and bounded format retry for node outputs."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Tuple, Type

from graph_novel.llm import get_llm_settings


class OutputContractError(ValueError):
    """An LLM response did not satisfy its node output contract."""


@dataclass(frozen=True)
class ResponseContract:
    """Runtime schema for one structured node response."""

    name: str
    expected_type: Type[Any]
    validator: Callable[[Any], None]

    def validate(self, value: Any) -> Any:
        if not isinstance(value, self.expected_type):
            raise OutputContractError(
                f"{self.name} 必须是 JSON {self.expected_type.__name__}"
            )
        self.validator(value)
        return value


def parse_json_response(text: str, *, expected_type: Type[Any]) -> Any:
    """Decode the first top-level JSON value of the expected type."""
    if not isinstance(text, str) or not text.strip():
        raise OutputContractError("模型响应为空，无法解析 JSON")

    candidates = [
        match.group(1)
        for match in re.finditer(
            r"```(?:json)?\s*([\s\S]*?)\s*```",
            text,
            flags=re.IGNORECASE,
        )
    ]
    candidates.append(text)

    decoder = json.JSONDecoder()
    decoded_types: List[str] = []
    last_error: Optional[Exception] = None
    for candidate in candidates:
        stripped = candidate.strip()
        cursor = 0
        while cursor < len(stripped):
            if cursor == 0 and stripped[0] in "[{":
                start = 0
            else:
                positions = [
                    position
                    for position in (
                        stripped.find("{", cursor),
                        stripped.find("[", cursor),
                    )
                    if position >= 0
                ]
                if not positions:
                    break
                start = min(positions)
            try:
                value, end = decoder.raw_decode(stripped[start:])
            except json.JSONDecodeError as exc:
                last_error = exc
                cursor = start + 1
                continue
            if isinstance(value, expected_type):
                return value
            decoded_types.append(type(value).__name__)
            # Never treat an object nested inside a wrong top-level list as
            # the actual response.
            cursor = start + end

    if decoded_types:
        found = ", ".join(sorted(set(decoded_types)))
        raise OutputContractError(
            f"JSON 顶层类型错误：期望 {expected_type.__name__}，实际 {found}"
        )
    detail = str(last_error) if last_error else "未找到 JSON 值"
    raise OutputContractError(f"无法解析模型 JSON 响应：{detail}")


def call_json_with_contract_sync(
    llm_call: Callable[..., str],
    system_prompt: str,
    user_message: str,
    *,
    contract: ResponseContract,
    max_tokens: int = 4096,
    temperature: float = 0.7,
    format_retries: Optional[int] = None,
) -> Any:
    """Call an LLM and retry only bounded output-format errors."""
    retries = _resolve_format_retries(format_retries)
    prompt = user_message
    for attempt in range(retries + 1):
        raw = llm_call(
            system_prompt,
            prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            response_format={"type": "json_object"},
        )
        try:
            parsed = parse_json_response(
                raw,
                expected_type=contract.expected_type,
            )
            return contract.validate(parsed)
        except OutputContractError as exc:
            if attempt >= retries:
                raise
            prompt = _format_retry_prompt(
                user_message,
                contract.name,
                exc,
                json_only=True,
            )
    raise AssertionError("unreachable")


def call_text_with_contract_sync(
    llm_call: Callable[..., str],
    system_prompt: str,
    user_message: str,
    *,
    parser: Callable[[str], Any],
    contract_name: str,
    max_tokens: int = 4096,
    temperature: float = 0.7,
    format_retries: Optional[int] = None,
) -> Any:
    """Apply the bounded format policy to mixed or plain text responses."""
    retries = _resolve_format_retries(format_retries)
    prompt = user_message
    for attempt in range(retries + 1):
        raw = llm_call(
            system_prompt,
            prompt,
            max_tokens=max_tokens,
            temperature=temperature,
        )
        try:
            return parser(raw)
        except OutputContractError as exc:
            if attempt >= retries:
                raise
            prompt = _format_retry_prompt(
                user_message,
                contract_name,
                exc,
                json_only=False,
            )
    raise AssertionError("unreachable")


def require_nonempty_text(text: str, *, name: str) -> str:
    if not isinstance(text, str) or not text.strip():
        raise OutputContractError(f"{name}响应没有正文")
    return text.strip()


def parse_chapter_response(text: str) -> Tuple[str, Dict[str, Any]]:
    if "---META---" not in text:
        raise OutputContractError("章节写作响应缺少 ---META--- 分隔符")
    prose_text, meta_text = text.split("---META---", 1)
    prose = require_nonempty_text(prose_text, name="章节写作")
    meta = parse_json_response(meta_text, expected_type=dict)
    WRITING_META_CONTRACT.validate(meta)
    return prose, meta


def to_prompt_data(value: Any) -> Any:
    """Convert dataclasses and enums to plain JSON-ready prompt data."""
    if isinstance(value, Enum):
        return value.value
    if hasattr(value, "__dataclass_fields__"):
        return {
            field_name: to_prompt_data(getattr(value, field_name))
            for field_name in value.__dataclass_fields__
        }
    if isinstance(value, list):
        return [to_prompt_data(item) for item in value]
    if isinstance(value, dict):
        return {
            key: to_prompt_data(item)
            for key, item in value.items()
        }
    return value


def outline_contract(expected_chapters: int) -> ResponseContract:
    def validate(value: Dict[str, Any]) -> None:
        _validate_schema(value, OUTLINE_SCHEMA, path="outline")
        chapters = value["chapter_outlines"]
        if len(chapters) != expected_chapters:
            raise OutputContractError(
                f"outline.chapter_outlines 章数不匹配："
                f"期望 {expected_chapters}，实际 {len(chapters)}"
            )
        if value["suggested_chapter_count"] != expected_chapters:
            raise OutputContractError(
                "outline.suggested_chapter_count 与目标章数不一致"
            )
        for index, chapter in enumerate(chapters):
            expected_number = index + 1
            if chapter["chapter_number"] != expected_number:
                raise OutputContractError(
                    f"outline.chapter_outlines[{index}].chapter_number "
                    f"应为 {expected_number}"
                )

    return ResponseContract("章节大纲", dict, validate)


def outline_overview_contract(expected_chapters: int) -> ResponseContract:
    """Validate the stable, book-level portion of a large outline."""

    def validate(value: Dict[str, Any]) -> None:
        _validate_schema(value, OUTLINE_OVERVIEW_SCHEMA, path="outline")
        if value["suggested_chapter_count"] != expected_chapters:
            raise OutputContractError(
                "outline.suggested_chapter_count 与目标章数不一致"
            )

    return ResponseContract("全书总纲", dict, validate)


def outline_batch_contract(
    start_chapter: int,
    end_chapter: int,
) -> ResponseContract:
    """Validate one contiguous batch of chapter outlines."""

    def validate(value: Dict[str, Any]) -> None:
        _validate_schema(value, OUTLINE_BATCH_SCHEMA, path="outline_batch")
        chapters = value["chapter_outlines"]
        expected_count = end_chapter - start_chapter + 1
        if len(chapters) != expected_count:
            raise OutputContractError(
                "outline_batch.chapter_outlines 章数不匹配："
                f"期望 {expected_count}，实际 {len(chapters)}"
            )
        for index, chapter in enumerate(chapters):
            expected_number = start_chapter + index
            if chapter["chapter_number"] != expected_number:
                raise OutputContractError(
                    "outline_batch.chapter_outlines"
                    f"[{index}].chapter_number 应为 {expected_number}"
                )

    return ResponseContract(
        f"第{start_chapter}章到第{end_chapter}章大纲",
        dict,
        validate,
    )


def chapter_plan_contract(
    expected_chapter: int,
    state_validator: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> ResponseContract:
    def validate(value: Dict[str, Any]) -> None:
        _normalize_optional_source_characters(
            value.get("information_flow", []),
        )
        _validate_schema(value, CHAPTER_PLAN_SCHEMA, path="chapter_plan")
        if value["chapter_number"] != expected_chapter:
            raise OutputContractError(
                f"chapter_plan.chapter_number 应为 {expected_chapter}"
            )
        bridge = value["opening_bridge"]
        expected_previous = max(0, expected_chapter - 1)
        if bridge["previous_chapter"] != expected_previous:
            raise OutputContractError(
                "chapter_plan.opening_bridge.previous_chapter 应为 "
                f"{expected_previous}"
            )
        if not bridge["inherited_endpoint"].strip():
            raise OutputContractError(
                "chapter_plan.opening_bridge.inherited_endpoint 不能为空"
            )
        if not bridge["first_scene_start"].strip():
            raise OutputContractError(
                "chapter_plan.opening_bridge.first_scene_start 不能为空"
            )
        if not bridge["transition_steps"] or any(
            not step.strip() for step in bridge["transition_steps"]
        ):
            raise OutputContractError(
                "chapter_plan.opening_bridge.transition_steps "
                "至少需要一个非空过渡步骤"
            )
        if not value["causal_chain"]:
            raise OutputContractError(
                "chapter_plan.causal_chain 至少需要一条因果链"
            )
        for index, link in enumerate(value["causal_chain"]):
            if not all(
                link[key].strip()
                for key in ("cause", "event", "effect")
            ):
                raise OutputContractError(
                    f"chapter_plan.causal_chain[{index}] 不能包含空因果项"
                )
        if state_validator:
            state_validator(value)

    return ResponseContract("章节规划", dict, validate)


def _resolve_format_retries(value: Optional[int]) -> int:
    retries = (
        get_llm_settings().format_retries
        if value is None
        else value
    )
    if (
        not isinstance(retries, int)
        or isinstance(retries, bool)
        or not 0 <= retries <= 3
    ):
        raise ValueError("format_retries 必须是 0 到 3 的整数")
    return retries


def _format_retry_prompt(
    original_message: str,
    contract_name: str,
    error: Exception,
    *,
    json_only: bool,
) -> str:
    correction = (
        "只输出符合原始字段要求的 JSON，不要解释、不要 Markdown 代码块、"
        "不要省略必填字段。"
        if json_only
        else "请严格按照原始响应格式重新生成完整内容，不要省略分隔符或必填字段。"
    )
    return (
        f"{original_message}\n\n"
        "【结构纠错重试】\n"
        f"上一轮响应未通过“{contract_name}”输出契约：{error}\n"
        f"{correction}"
    )


def _validate_schema(value: Any, schema: Any, *, path: str) -> None:
    """Validate a small declarative schema made of dict/list/Python types."""
    if isinstance(schema, dict):
        _require_type(value, dict, path=path)
        for key, child_schema in schema.items():
            child_path = f"{path}.{key}"
            if key not in value:
                raise OutputContractError(f"{child_path} 缺少必填字段")
            _validate_schema(value[key], child_schema, path=child_path)
        return
    if isinstance(schema, list):
        _require_type(value, list, path=path)
        if schema:
            for index, item in enumerate(value):
                _validate_schema(item, schema[0], path=f"{path}[{index}]")
        return
    _require_type(value, schema, path=path)


def _require_type(value: Any, expected_type: Any, *, path: str) -> None:
    if expected_type is int:
        valid = isinstance(value, int) and not isinstance(value, bool)
    else:
        valid = isinstance(value, expected_type)
    if valid:
        return
    if isinstance(expected_type, tuple):
        type_name = "/".join(item.__name__ for item in expected_type)
    else:
        type_name = expected_type.__name__
    raise OutputContractError(
        f"{path} 类型错误：期望 {type_name}，实际 {type(value).__name__}"
    )


WORLD_SETTING_SCHEMA = {
    "era": str,
    "location": str,
    "special_setting": str,
    "technology_level": str,
    "social_structure": str,
    "key_locations": [{"name": str, "description": str}],
    "rules_and_laws": str,
    "history": str,
    "golden_finger": str,
    "notes": str,
}

CHARACTER_DESIGN_SCHEMA = {
    "characters": [{
        "name": str,
        "role": str,
        "background": str,
        "personality": str,
        "motivation": str,
        "golden_finger": (str, type(None)),
        "arc_stage": str,
        "arc_description": str,
        "relationships": dict,
        "first_appearance_hook": str,
        "notes": str,
    }],
}

OUTLINE_CHAPTER_SCHEMA = {
    "chapter_number": int,
    "title": str,
    "summary": str,
    "pov_character": str,
    "key_events": [str],
    "shuangdian_beat": str,
    "chapter_hook_idea": str,
    "foreshadowing_to_plant": [str],
    "foreshadowing_to_pay_off": [str],
}

OUTLINE_OVERVIEW_SCHEMA = {
    "genre": str,
    "premise": str,
    "theme": str,
    "target_length": str,
    "suggested_chapter_count": int,
    "shuangdian_map": [{
        "chapter_range": str,
        "type": str,
        "description": str,
    }],
}

OUTLINE_BATCH_SCHEMA = {
    "chapter_outlines": [OUTLINE_CHAPTER_SCHEMA],
}

OUTLINE_SCHEMA = {
    **OUTLINE_OVERVIEW_SCHEMA,
    **OUTLINE_BATCH_SCHEMA,
}

CHAPTER_PLAN_SCHEMA = {
    "chapter_number": int,
    "title": str,
    "scene_plan": [{
        "scene_number": int,
        "setting": str,
        "characters_present": [str],
        "action": str,
        "emotional_beat": str,
        "dialogue_focus": str,
        "word_count_target": int,
    }],
    "pov_character": str,
    "opening_bridge": {
        "previous_chapter": int,
        "inherited_endpoint": str,
        "transition_steps": [str],
        "first_scene_start": str,
        "carry_over_threads": [str],
    },
    "opening_hook": str,
    "closing_hook": str,
    "dialogue_highlights": [str],
    "shuangdian_beat": str,
    "causal_chain": [{
        "cause": str,
        "event": str,
        "effect": str,
    }],
    "required_fact_ids": [str],
    "planned_facts": [{
        "fact_id": str,
        "statement": str,
        "category": str,
        "visibility": str,
    }],
    "information_flow": [{
        "fact_id": str,
        "character": str,
        "knowledge_level": str,
        "source_type": str,
        "source_character": str,
        "evidence": str,
    }],
    "continuity_notes": {
        "time": str,
        "character_locations": dict,
        "character_conditions": dict,
        "resources": dict,
        "previous_chapter_end": str,
    },
    "ai_taboos_check": [str],
}

CONSISTENCY_REVIEW_SCHEMA = {
    "overall_score": int,
    "issues": [{
        "severity": str,
        "category": str,
        "description": str,
        "location_hint": str,
        "suggested_fix": str,
    }],
    "hook_quality": str,
    "hook_review": str,
    "shuangdian_delivery": str,
    "ai_disease_count": int,
    "dialogue_ratio_estimate": str,
    "requires_rewrite": bool,
    "rewrite_scope": str,
    "logic_gate_passed": bool,
    "bridge_gate_passed": bool,
    "narrative_audit": {
        "chapter_bridge": str,
        "causality": str,
        "knowledge_provenance": str,
        "continuity": str,
    },
    "narrative_violations": [{
        "severity": str,
        "category": str,
        "description": str,
        "evidence": str,
        "suggested_fix": str,
    }],
    "character_arc_updates": dict,
    "summary": str,
}

GLOBAL_REVIEW_SCHEMA = {
    "overall_score": int,
    "golden_three_analysis": {
        "ch1_quality": str,
        "ch2_quality": str,
        "ch3_quality": str,
        "estimated_ch3_retention": str,
    },
    "shuangdian_analysis": {
        "density": str,
        "small_beats_count": int,
        "big_beats_count": int,
        "issues": [str],
    },
    "hook_analysis": {
        "strong": int,
        "weak": int,
        "missing": int,
        "problem_chapters": list,
    },
    "arc_review": dict,
    "ai_disease_summary": {
        "total_found": int,
        "high_risk_chapters": list,
        "overall_risk": str,
    },
    "algorithm_fitness": {
        "estimated_ch10_retention": str,
        "estimated_10w_retention": str,
        "estimated_follow_rate": str,
        "shouxiu_ready": bool,
    },
    "platform_competitiveness": {
        "strength": str,
        "weakness": str,
        "differentiation": str,
    },
    "structural_issues": [{
        "severity": str,
        "description": str,
        "suggested_fix": str,
    }],
    "final_recommendations": [str],
    "ready_for_platform": bool,
}

WRITING_META_SCHEMA = {
    "chapter_hook": str,
    "shuangdian_beat": str,
    "foreshadowing_planted": [{
        "description": str,
        "scene_context": str,
    }],
    "foreshadowing_paid": [{
        "id": str,
        "how_it_was_resolved": str,
    }],
    "character_moments": dict,
    "chapter_summary": str,
    "facts_established": [{
        "fact_id": str,
        "statement": str,
        "category": str,
        "visibility": str,
    }],
    "knowledge_changes": [{
        "fact_id": str,
        "character": str,
        "knowledge_level": str,
        "source_type": str,
        "source_character": str,
        "evidence": str,
    }],
    "continuity_changes": {
        "time": str,
        "character_locations": dict,
        "character_conditions": dict,
        "resources": dict,
    },
    "continuity_checkpoint": {
        "last_scene": {
            "time": str,
            "location": str,
            "pov_character": str,
            "characters_present": [str],
            "final_action": str,
            "final_dialogue": str,
        },
        "active_goals": [{
            "character": str,
            "goal": str,
            "next_action": str,
        }],
        "unresolved_actions": [str],
        "open_threads": [{
            "thread_id": str,
            "description": str,
            "urgency": str,
        }],
        "relationship_changes": dict,
    },
}


def _validate_world_setting(value: Dict[str, Any]) -> None:
    _validate_schema(value, WORLD_SETTING_SCHEMA, path="world_setting")


def _validate_character_design(value: Dict[str, Any]) -> None:
    _validate_schema(value, CHARACTER_DESIGN_SCHEMA, path="character_design")
    characters = value["characters"]
    if not characters:
        raise OutputContractError("character_design.characters 不能为空")
    valid_stages = {
        "inciting_incident",
        "rising_action",
        "midpoint",
        "dark_moment",
        "climax",
        "resolution",
    }
    if not any(
        "主角" in character["role"]
        or character["role"].lower() == "protagonist"
        for character in characters
    ):
        raise OutputContractError("character_design.characters 缺少主角")
    for index, character in enumerate(characters):
        path = f"character_design.characters[{index}]"
        if character["arc_stage"] not in valid_stages:
            raise OutputContractError(
                f"{path}.arc_stage 不是有效的角色弧线阶段"
            )
        for name, relationship in character["relationships"].items():
            _require_type(name, str, path=f"{path}.relationships key")
            _require_type(
                relationship,
                str,
                path=f"{path}.relationships[{name}]",
            )


def _validate_consistency_review(value: Dict[str, Any]) -> None:
    _validate_schema(
        value,
        CONSISTENCY_REVIEW_SCHEMA,
        path="consistency_review",
    )
    score = value["overall_score"]
    if not 1 <= score <= 10:
        raise OutputContractError(
            "consistency_review.overall_score 必须在 1 到 10 之间"
        )
    if score < 6 and not value["requires_rewrite"]:
        raise OutputContractError(
            "consistency_review 低于 6 分时 requires_rewrite 必须为 true"
        )
    rewrite_scope = value["rewrite_scope"]
    valid_rewrite_scopes = {"none", "plan", "writing", "polish"}
    if rewrite_scope not in valid_rewrite_scopes:
        raise OutputContractError(
            "consistency_review.rewrite_scope 必须是 "
            "none、plan、writing 或 polish"
        )
    if value["requires_rewrite"] and rewrite_scope == "none":
        raise OutputContractError(
            "consistency_review 要求重写时 rewrite_scope 不能为 none"
        )
    if not value["requires_rewrite"] and rewrite_scope != "none":
        raise OutputContractError(
            "consistency_review 无需重写时 rewrite_scope 必须为 none"
        )
    for key, audit in value["narrative_audit"].items():
        if not audit.strip():
            raise OutputContractError(
                f"consistency_review.narrative_audit.{key} 不能为空"
            )
    blocking_severities = {"致命", "严重", "critical", "fatal", "serious"}
    blocking_violation = any(
        item["severity"].strip().lower() in blocking_severities
        for item in value["narrative_violations"]
    )
    if blocking_violation and value["logic_gate_passed"]:
        raise OutputContractError(
            "consistency_review 存在严重叙事违规时 logic_gate_passed 必须为 false"
        )
    if (
        (
            blocking_violation
            or not value["logic_gate_passed"]
            or not value["bridge_gate_passed"]
        )
        and not value["requires_rewrite"]
    ):
        raise OutputContractError(
            "consistency_review 逻辑门未通过时 requires_rewrite 必须为 true"
        )
    if (
        (
            blocking_violation
            or not value["logic_gate_passed"]
            or not value["bridge_gate_passed"]
        )
        and rewrite_scope == "polish"
    ):
        raise OutputContractError(
            "consistency_review 逻辑门或章节衔接门未通过时 "
            "rewrite_scope 至少必须为 writing"
        )
    if not value["bridge_gate_passed"] and value["logic_gate_passed"]:
        raise OutputContractError(
            "consistency_review 章节衔接门未通过时 "
            "logic_gate_passed 必须为 false"
        )
    if not value["bridge_gate_passed"] and not any(
        item["category"].strip().lower()
        in {"章节衔接", "chapter_bridge", "chapter bridge"}
        for item in value["narrative_violations"]
    ):
        raise OutputContractError(
            "consistency_review 章节衔接门未通过时必须记录章节衔接违规"
        )
    if value["ai_disease_count"] < 0:
        raise OutputContractError(
            "consistency_review.ai_disease_count 不能为负数"
        )
    for name, stage in value["character_arc_updates"].items():
        _require_type(name, str, path="consistency_review.character_arc_updates key")
        _require_type(
            stage,
            str,
            path=f"consistency_review.character_arc_updates[{name}]",
        )


def _validate_global_review(value: Dict[str, Any]) -> None:
    _validate_schema(value, GLOBAL_REVIEW_SCHEMA, path="global_review")
    if not 1 <= value["overall_score"] <= 10:
        raise OutputContractError(
            "global_review.overall_score 必须在 1 到 10 之间"
        )
    for key in ("small_beats_count", "big_beats_count"):
        if value["shuangdian_analysis"][key] < 0:
            raise OutputContractError(
                f"global_review.shuangdian_analysis.{key} 不能为负数"
            )
    for key in ("strong", "weak", "missing"):
        if value["hook_analysis"][key] < 0:
            raise OutputContractError(
                f"global_review.hook_analysis.{key} 不能为负数"
            )
    if value["ai_disease_summary"]["total_found"] < 0:
        raise OutputContractError(
            "global_review.ai_disease_summary.total_found 不能为负数"
        )
    arc_schema = {"completeness": str, "issues": [str]}
    for character_name, review in value["arc_review"].items():
        _require_type(character_name, str, path="global_review.arc_review key")
        _validate_schema(
            review,
            arc_schema,
            path=f"global_review.arc_review[{character_name}]",
        )


def _validate_writing_meta(value: Dict[str, Any]) -> None:
    _normalize_optional_source_characters(
        value.get("knowledge_changes", []),
    )
    _validate_schema(value, WRITING_META_SCHEMA, path="writing_meta")
    if not value["chapter_hook"].strip():
        raise OutputContractError("writing_meta.chapter_hook 不能为空")
    if not value["chapter_summary"].strip():
        raise OutputContractError("writing_meta.chapter_summary 不能为空")
    last_scene = value["continuity_checkpoint"]["last_scene"]
    for key in ("time", "location", "pov_character", "final_action"):
        if not last_scene[key].strip():
            raise OutputContractError(
                "writing_meta.continuity_checkpoint.last_scene"
                f".{key} 不能为空"
            )
    if not last_scene["characters_present"]:
        raise OutputContractError(
            "writing_meta.continuity_checkpoint.last_scene"
            ".characters_present 不能为空"
        )
    for name, moment in value["character_moments"].items():
        _require_type(name, str, path="writing_meta.character_moments key")
        _require_type(
            moment,
            str,
            path=f"writing_meta.character_moments[{name}]",
        )


def _normalize_optional_source_characters(
    items: Any,
) -> None:
    if not isinstance(items, list):
        return
    for item in items:
        if (
            isinstance(item, dict)
            and "source_character" in item
            and item["source_character"] is None
        ):
            item["source_character"] = ""


WORLD_SETTING_CONTRACT = ResponseContract(
    "世界观",
    dict,
    _validate_world_setting,
)
CHARACTER_DESIGN_CONTRACT = ResponseContract(
    "人物设计",
    dict,
    _validate_character_design,
)
CONSISTENCY_REVIEW_CONTRACT = ResponseContract(
    "一致性审查",
    dict,
    _validate_consistency_review,
)
GLOBAL_REVIEW_CONTRACT = ResponseContract(
    "全局终审",
    dict,
    _validate_global_review,
)
WRITING_META_CONTRACT = ResponseContract(
    "章节 META",
    dict,
    _validate_writing_meta,
)
