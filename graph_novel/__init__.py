"""
GraphNovel — a graph-engineering approach to novel writing.

9 specialized nodes × conditional routing edges × shared persistent State.
"""

from graph_novel.state import (
    GraphNovelState,
    NodeStatus,
    ApprovalStatus,
    ArcStage,
    WorldSetting,
    Character,
    CharacterArc,
    NovelOutline,
    ChapterOutline,
    Chapter,
    Foreshadowing,
)

__all__ = [
    "GraphNovelState",
    "NodeStatus",
    "ApprovalStatus",
    "ArcStage",
    "WorldSetting",
    "Character",
    "CharacterArc",
    "NovelOutline",
    "ChapterOutline",
    "Chapter",
    "Foreshadowing",
]
