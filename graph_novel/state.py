"""
GraphNovel State — the shared, persistent context that flows through every node.

This is the central data model that carries the novel's entire state across
the 9-node DAG. Every node reads from it and writes back to it.
"""

import json
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

CURRENT_STATE_VERSION = 2

# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class NodeStatus(Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


class ApprovalStatus(Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class ArcStage(Enum):
    INCITING_INCIDENT = "inciting_incident"
    RISING_ACTION = "rising_action"
    MIDPOINT = "midpoint"
    DARK_MOMENT = "dark_moment"
    CLIMAX = "climax"
    RESOLUTION = "resolution"


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


@dataclass
class Foreshadowing:
    id: str
    description: str
    planted_in_chapter: int
    payoff_chapter: Optional[int] = None
    payoff_description: Optional[str] = None
    status: str = "planted"  # planted | partially_paid | paid_off


@dataclass
class CharacterArc:
    character_name: str
    arc_description: str
    current_stage: ArcStage
    per_chapter_status: Dict[str, str] = field(default_factory=dict)


@dataclass
class Character:
    name: str
    role: str  # protagonist | antagonist | supporting | mentor | etc.
    background: str
    personality: str
    motivation: str
    arc: Optional[CharacterArc] = None
    relationships: Dict[str, str] = field(default_factory=dict)
    notes: str = ""


@dataclass
class WorldSetting:
    era: str
    location: str
    magic_system: Optional[str] = None
    technology_level: Optional[str] = None
    social_structure: str = ""
    key_locations: List[Dict[str, str]] = field(default_factory=list)
    rules_and_laws: str = ""
    history: str = ""
    notes: str = ""


@dataclass
class ChapterOutline:
    chapter_number: int
    title: str
    summary: str
    pov_character: Optional[str] = None
    key_events: List[str] = field(default_factory=list)
    foreshadowing_to_plant: List[str] = field(default_factory=list)
    foreshadowing_to_pay_off: List[str] = field(default_factory=list)
    shuangdian_beat: str = ""  # 本章爽点节奏: "" | "小爽点" | "大爽点" | "铺垫"
    chapter_hook_idea: str = ""  # 章末钩子构思


@dataclass
class Chapter:
    chapter_number: int
    title: str
    outline: Optional[ChapterOutline] = None
    draft: str = ""
    consistency_report: Dict[str, Any] = field(default_factory=dict)
    polished_draft: str = ""
    approval: ApprovalStatus = ApprovalStatus.PENDING
    human_feedback: str = ""
    word_count: int = 0
    chapter_hook: str = ""  # 章末钩子
    shuangdian_type: str = ""  # "" | "小爽点" | "大爽点" | "铺垫"


@dataclass
class NovelOutline:
    genre: str
    premise: str
    theme: str
    target_length: str  # e.g. "80,000 words / ~40 chapters"
    target_platform: str = "fanqie"  # fanqie | qidian | general
    shuangdian_map: List[Dict[str, Any]] = field(default_factory=list)  # 爽点排期表: [{chapter_range, type, description}]
    chapter_outlines: List[ChapterOutline] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Main state
# ---------------------------------------------------------------------------


@dataclass
class GraphNovelState:
    """The single shared state that flows through every node in the DAG."""

    # -- Project metadata
    project_id: str = ""
    novel_title: str = ""
    save_dir: Path = field(default_factory=Path.cwd)
    target_platform: str = "fanqie"  # fanqie | qidian | general
    creative_genre: str = ""
    creative_premise: str = ""
    creative_theme: str = ""
    genre_tags: List[str] = field(default_factory=list)  # e.g. ["都市", "脑洞", "系统流"]
    target_total_words: int = 500000  # total word count target for the novel
    target_total_chapters: int = 0
    creative_notes: str = ""  # user's creative direction notes from project creation

    # -- Phase 1: Foundation (human approval gate)
    world_setting: Optional[WorldSetting] = None
    characters: List[Character] = field(default_factory=list)
    novel_outline: Optional[NovelOutline] = None
    foundation_approval: ApprovalStatus = ApprovalStatus.PENDING
    foundation_feedback: str = ""

    # -- Persisted graph checkpoint
    workflow_phase: str = "foundation"
    pending_gate: Optional[str] = None
    last_error: Dict[str, Any] = field(default_factory=dict)

    # -- Phase 2: Chapter pipeline
    chapters: List[Chapter] = field(default_factory=list)
    current_chapter: int = 0
    total_chapters: int = 0

    # -- Active tracking (dynamic, updated per chapter)
    character_arc_tracker: Dict[str, CharacterArc] = field(default_factory=dict)
    foreshadowing_tracker: List[Foreshadowing] = field(default_factory=list)

    # -- Platform metrics (番茄算法指标)
    chapter_hooks: List[str] = field(default_factory=list)  # 每章钩子记录
    shuangdian_schedule: List[Dict[str, Any]] = field(default_factory=list)  # 爽点排期表

    # -- Node execution status
    node_status: Dict[str, NodeStatus] = field(default_factory=dict)

    # -- Final pass
    global_review_report: Dict[str, Any] = field(default_factory=dict)

    # -- Metadata
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    version: int = CURRENT_STATE_VERSION

    # ------------------------------------------------------------------
    # Serialization helpers
    # ------------------------------------------------------------------

    def to_dict(self) -> dict:
        return _serialize(self)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=2, default=str)

    def save(self, path: Optional[Path] = None) -> Path:
        target = path or self.save_dir / f"{self._safe_title()}_state.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(self.to_json(), encoding="utf-8")
        return target

    @classmethod
    def from_json(cls, path: Union[str, Path]) -> "GraphNovelState":
        source = Path(path)
        data = json.loads(source.read_text(encoding="utf-8"))
        state = _deserialize(data)
        if not isinstance(state, cls):
            raise ValueError(f"State file does not contain {cls.__name__}")
        return _migrate_state(state, source)

    def _safe_title(self) -> str:
        return self.project_id or "graph_novel"

    def log(self, message: str) -> None:
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"[GraphNovel {ts}] {message}")


# ---------------------------------------------------------------------------
# Internal serialization (handles dataclass nesting + enums)
# ---------------------------------------------------------------------------

_MODEL_REGISTRY: Dict[str, type] = {
    "WorldSetting": WorldSetting,
    "Character": Character,
    "CharacterArc": CharacterArc,
    "ChapterOutline": ChapterOutline,
    "Chapter": Chapter,
    "NovelOutline": NovelOutline,
    "Foreshadowing": Foreshadowing,
    "GraphNovelState": GraphNovelState,
}


def _serialize(obj: Any) -> Any:
    if isinstance(obj, Enum):
        return obj.value
    if isinstance(obj, Path):
        return str(obj)
    if isinstance(obj, datetime):
        return obj.isoformat()
    if hasattr(obj, "__dataclass_fields__"):
        result = {"__model__": type(obj).__name__}
        for k, v in obj.__dataclass_fields__.items():
            result[k] = _serialize(getattr(obj, k))
        return result
    if isinstance(obj, dict):
        return {k: _serialize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_serialize(v) for v in obj]
    return obj


def _deserialize(data: Any) -> Any:
    if isinstance(data, dict) and "__model__" in data:
        cls = _MODEL_REGISTRY.get(data["__model__"])
        if cls is None:
            return data
        kwargs = {}
        for k, v in data.items():
            if k == "__model__":
                continue
            field_info = cls.__dataclass_fields__.get(k)
            if field_info is None:
                kwargs[k] = _deserialize(v)
                continue
            field_type = field_info.type
            kwargs[k] = _deserialize_field(v, field_type)
        return cls(**kwargs)
    if isinstance(data, dict):
        return {k: _deserialize(v) for k, v in data.items()}
    if isinstance(data, list):
        return [_deserialize(v) for v in data]
    return data


def _deserialize_field(value: Any, field_type: Any) -> Any:
    """Reconstruct enums and nested models from serialized values."""
    if value is None:
        return None
    # Check for enum types
    origin = getattr(field_type, "__origin__", None)
    if isinstance(field_type, type) and issubclass(field_type, Enum):
        return field_type(value)
    if origin is list:
        args = getattr(field_type, "__args__", ())
        inner_type = args[0] if args else str
        return [_deserialize_field(v, inner_type) for v in value]
    if origin is dict:
        args = getattr(field_type, "__args__", ())
        value_type = args[1] if len(args) > 1 else Any
        return {
            k: _deserialize_field(v, value_type)
            for k, v in value.items()
        }
    if isinstance(field_type, type) and issubclass(field_type, Path):
        return Path(value)
    # Might be a nested dataclass
    if isinstance(value, dict) and "__model__" in value:
        return _deserialize(value)
    return value


def _migrate_state(state: GraphNovelState, source: Path) -> GraphNovelState:
    """Fill version-2 checkpoint fields when loading older project files."""
    if not state.project_id:
        stem = source.stem
        if stem.endswith("_state") and stem != "graph_novel_state":
            state.project_id = stem[:-6]

    if state.target_total_chapters <= 0:
        state.target_total_chapters = state.total_chapters

    if state.version < 2:
        foundation_status = state.node_status.get(
            "human_approval_foundation", NodeStatus.PENDING
        )
        if foundation_status == NodeStatus.COMPLETED:
            rejected = any(
                chapter.approval == ApprovalStatus.REJECTED
                for chapter in state.chapters
            )
            state.foundation_approval = (
                ApprovalStatus.REJECTED if rejected else ApprovalStatus.APPROVED
            )
        elif foundation_status == NodeStatus.IN_PROGRESS:
            state.pending_gate = "foundation"

        if state.node_status.get("global_review") == NodeStatus.COMPLETED:
            state.workflow_phase = "done"
        elif state.foundation_approval == ApprovalStatus.APPROVED:
            state.workflow_phase = "chapter_loop"
        else:
            state.workflow_phase = "foundation"

    state.version = CURRENT_STATE_VERSION
    return state
