"""
GraphNovel Agent Nodes — 9 specialized nodes for the novel-writing DAG.

Each module exports a `run_node` function.
For mockability in tests, access run_node functions through the module:
    from graph_novel.nodes import world_building
    world_building.run_node(state)
"""

from graph_novel.nodes import world_building
from graph_novel.nodes import character_design
from graph_novel.nodes import outline_planning
from graph_novel.nodes import chapter_planning
from graph_novel.nodes import writing
from graph_novel.nodes import consistency_review
from graph_novel.nodes import style_polish
from graph_novel.nodes import human_approval
from graph_novel.nodes import global_review

__all__ = [
    "world_building",
    "character_design",
    "outline_planning",
    "chapter_planning",
    "writing",
    "consistency_review",
    "style_polish",
    "human_approval",
    "global_review",
]
