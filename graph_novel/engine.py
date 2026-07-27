"""
Graph Engine — the DAG orchestrator that routes state through the 9 nodes.

The graph structure:

Phase 1 (Foundation — parallelizable):
  [World-Building] ──┐
                     ├──> [Outline Planning] ──> [Human Approval: Foundation]
  [Character Design]─┘
        │
        │ (if rejected, loop back to World-Building with feedback)
        │ (if approved, proceed)
        ▼

Phase 2 (Per-Chapter Pipeline — sequential loop):
  [Chapter Planning] ──> [Writing] ──> [Consistency Review]
                              ▲              │
                              │    (if rewrite needed)
                              └──────────────┘
                                              │
                                    [Style Polish]
                                              │
                                    [Human Approval: Chapter]
                                              │
                                    (if rejected → Chapter Planning w/feedback)
                                    (if approved → next chapter or Global Review)

Phase 3 (Final Pass):
  [Global Review] ──> DONE
"""

from __future__ import annotations

from enum import Enum, auto
from pathlib import Path
from typing import Optional

from graph_novel.state import GraphNovelState, NodeStatus, ApprovalStatus
from graph_novel.nodes import (
    world_building,
    character_design,
    outline_planning,
    chapter_planning,
    writing,
    consistency_review,
    style_polish,
    human_approval,
    global_review,
)


class GraphPhase(Enum):
    FOUNDATION = auto()
    CHAPTER_LOOP = auto()
    GLOBAL_REVIEW = auto()
    DONE = auto()


class GraphNovelEngine:
    """Orchestrates the full novel-writing graph from start to finish."""

    def __init__(self, state: GraphNovelState):
        self.state = state
        self.phase = GraphPhase.FOUNDATION
        self._approval_callback = None
        self._foundation_approval_callback = None
        self._chapter_output_dir: Optional[Path] = None

    # ------------------------------------------------------------------
    # Callback registration (for web UI integration)
    # ------------------------------------------------------------------

    def set_approval_callback(self, callback):
        """Set the callback for per-chapter human approval.
        callback(state, chapter_num) -> (approved: bool, feedback: str)
        """
        self._approval_callback = callback

    def set_foundation_approval_callback(self, callback):
        """Set the callback for foundation human approval.
        callback(state, stage="foundation") -> (approved: bool, feedback: str)
        """
        self._foundation_approval_callback = callback

    def set_output_dir(self, path: Path):
        self._chapter_output_dir = path

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    def run(self) -> GraphNovelState:
        """Run the entire graph to completion."""
        self.state.log(f"GraphNovel Engine starting — '{self.state.novel_title}'")
        self.state.log(f"Target: {self.state.total_chapters} chapters")

        # Phase 1: Foundation
        self._run_foundation()

        if not self._is_foundation_approved():
            self.state.log("Foundation rejected. Restart with feedback.")
            return self.state

        # Phase 2: Chapter pipeline
        for ch_num in range(1, self.state.total_chapters + 1):
            self.state.current_chapter = ch_num
            self._run_chapter_pipeline(ch_num)

        # Phase 3: Global review
        self._run_global_review()

        self.phase = GraphPhase.DONE
        self.state.log("GraphNovel Engine — COMPLETE.")
        self._save_outputs()
        return self.state

    def run_single_chapter(self, ch_num: int) -> GraphNovelState:
        """Run the pipeline for a single chapter (for web-based step-by-step execution)."""
        self.state.current_chapter = ch_num
        self._run_chapter_pipeline(ch_num)
        self._save_outputs()
        return self.state

    def run_global_review_only(self) -> GraphNovelState:
        self._run_global_review()
        self._save_outputs()
        return self.state

    # ------------------------------------------------------------------
    # Phase 1: Foundation
    # ------------------------------------------------------------------

    def _run_foundation(self) -> None:
        self.phase = GraphPhase.FOUNDATION
        self.state.log("="*50)
        self.state.log("PHASE 1: Foundation")

        # Node 1: World-Building
        self.state = world_building.run_node(self.state)

        # Node 2: Character Design (can run after world-building)
        self.state = character_design.run_node(self.state)

        # Node 3: Outline Planning (needs world + characters)
        self.state = outline_planning.run_node(self.state)

        # Node 8: Foundation Approval
        self.state = human_approval.approve_foundation(
            self.state,
            wait_callback=self._foundation_approval_callback,
        )

    def _is_foundation_approved(self) -> bool:
        status = self.state.node_status.get(
            "human_approval_foundation", NodeStatus.PENDING
        )
        if status != NodeStatus.COMPLETED:
            return False

        # Check if any chapter has been explicitly rejected
        for ch in self.state.chapters:
            if ch.approval == ApprovalStatus.REJECTED:
                return False
        return True

    # ------------------------------------------------------------------
    # Phase 2: Chapter Pipeline
    # ------------------------------------------------------------------

    def _run_chapter_pipeline(self, ch_num: int) -> None:
        self.phase = GraphPhase.CHAPTER_LOOP
        self.state.log("="*50)
        self.state.log(f"PHASE 2: Chapter {ch_num}/{self.state.total_chapters}")

        max_rewrites = 2  # Maximum rewrite attempts per chapter
        rewrite_count = 0

        while True:
            # Node 4: Chapter Planning
            self.state = chapter_planning.run_node(self.state)

            # Node 5: Chapter Writing
            self.state = writing.run_node(self.state)

            if not self.state.chapters[ch_num - 1].draft:
                self.state.log(f"Chapter {ch_num} writing produced no draft, aborting.")
                break

            # Node 6: Consistency Review
            self.state = consistency_review.run_node(self.state)

            # Check if rewrite is needed
            chapter = self.state.chapters[ch_num - 1]
            review = chapter.consistency_report
            needs_rewrite = review.get("requires_rewrite", False) if review else False
            score = review.get("overall_score", 10) if review else 10

            if needs_rewrite and rewrite_count < max_rewrites and score < 6:
                rewrite_count += 1
                self.state.log(
                    f"Chapter {ch_num} needs rewrite (score {score}/10). "
                    f"Attempt {rewrite_count}/{max_rewrites}"
                )
                # Feed issues back into planning for rewrite
                continue
            else:
                if rewrite_count > 0:
                    self.state.log(
                        f"Chapter {ch_num} rewrite complete after {rewrite_count} attempts."
                    )
                break

        # Node 7: Style Polish
        self.state = style_polish.run_node(self.state)

        # Node 8: Human Approval (per chapter)
        self.state = human_approval.run_node(
            self.state,
            wait_callback=self._approval_callback,
        )

    # ------------------------------------------------------------------
    # Phase 3: Global Review
    # ------------------------------------------------------------------

    def _run_global_review(self) -> None:
        self.phase = GraphPhase.GLOBAL_REVIEW
        self.state.log("="*50)
        self.state.log("PHASE 3: Global Review")
        self.state = global_review.run_node(self.state)

    # ------------------------------------------------------------------
    # Output
    # ------------------------------------------------------------------

    def _save_outputs(self) -> None:
        """Save state and individual chapter files."""
        # Save full state
        state_path = self.state.save()
        self.state.log(f"State saved to: {state_path}")

        # Save individual chapters
        out_dir = self._chapter_output_dir or (self.state.save_dir / "output")
        out_dir.mkdir(parents=True, exist_ok=True)

        for ch in self.state.chapters:
            if ch.polished_draft:
                shuangdian = getattr(ch, 'shuangdian_type', '') or ''
                hook = getattr(ch, 'chapter_hook', '') or ''
                review_score = ch.consistency_report.get('overall_score', 'N/A') if ch.consistency_report else 'N/A'
                ch_path = out_dir / f"第{ch.chapter_number:02d}章.md"
                content = f"# 第{ch.chapter_number}章：{ch.title}\n\n"
                content += ch.polished_draft
                content += f"\n\n---\n"
                content += f"字数：{ch.word_count} | 审稿评分：{review_score}/10"
                if shuangdian:
                    content += f" | 爽点：{shuangdian}"
                if hook:
                    content += f"\n章末钩子：{hook}"
                ch_path.write_text(content, encoding="utf-8")
                self.state.log(f"Chapter saved: {ch_path}")

        # Save complete novel
        novel_path = out_dir / f"{self.state.novel_title.lower().replace(' ', '_')[:50]}_完整版.md"
        novel_text = f"# {self.state.novel_title}\n\n"
        if self.state.novel_outline:
            novel_text += f"🍅 番茄小说 | *{self.state.novel_outline.genre}*\n\n"
            novel_text += f"> {self.state.novel_outline.premise}\n\n"
            novel_text += f"**主题：**{self.state.novel_outline.theme}\n\n"
            # 爽点排期表
            if self.state.novel_outline.shuangdian_map:
                novel_text += "## 爽点排期表\n\n"
                for item in self.state.novel_outline.shuangdian_map:
                    novel_text += f"- {item.get('chapter_range', '')} | {item.get('type', '')} | {item.get('description', '')}\n"
                novel_text += "\n---\n\n"

        for ch in self.state.chapters:
            if ch.polished_draft:
                shuangdian = getattr(ch, 'shuangdian_type', '')
                hook = getattr(ch, 'chapter_hook', '')
                novel_text += f"## 第{ch.chapter_number}章：{ch.title}\n\n"
                novel_text += ch.polished_draft
                novel_text += "\n\n"

        novel_path.write_text(novel_text, encoding="utf-8")
        self.state.log(f"Complete novel saved: {novel_path}")
