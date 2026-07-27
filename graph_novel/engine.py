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

from graph_novel.state import (
    GraphNovelState, NodeStatus, ApprovalStatus, Chapter,
)
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


class GraphExecutionError(RuntimeError):
    """Raised when a node fails or an invalid graph transition is requested."""

    def __init__(
        self,
        node_key: str,
        message: str,
        code: str = "execution_failed",
    ):
        super().__init__(message)
        self.node_key = node_key
        self.code = code


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
        """CLI/full-run wrapper: generate, collect a decision, then transition."""
        self.run_foundation_generation()
        approved, feedback = human_approval.request_foundation_decision(
            self.state,
            wait_callback=self._foundation_approval_callback,
        )
        self.apply_foundation_decision(approved, feedback)

    def run_foundation_generation(self) -> GraphNovelState:
        """Run Foundation nodes and stop at the persisted human approval gate."""
        if (
            self.state.pending_gate == "foundation"
            and self.state.foundation_approval == ApprovalStatus.PENDING
        ):
            raise GraphExecutionError(
                "human_approval_foundation",
                "Foundation is already waiting for approval.",
                code="invalid_transition",
            )
        if self.state.foundation_approval == ApprovalStatus.APPROVED:
            raise GraphExecutionError(
                "human_approval_foundation",
                "Approved Foundation cannot be regenerated.",
                code="invalid_transition",
            )

        self.phase = GraphPhase.FOUNDATION
        self.state.workflow_phase = "foundation"
        self.state.pending_gate = None
        self.state.foundation_approval = ApprovalStatus.PENDING
        self.state.last_error = {}
        self.state.log("="*50)
        self.state.log("PHASE 1: Foundation")

        # Node 1: World-Building
        self._execute_required_node("world_building", world_building.run_node)

        # Node 2: Character Design (can run after world-building)
        self._execute_required_node("character_design", character_design.run_node)

        # Node 3: Outline Planning (needs world + characters)
        self._execute_required_node("outline_planning", outline_planning.run_node)

        # Node 8 is now a persisted Gate. A separate decision resumes the graph.
        self.state.node_status["human_approval_foundation"] = NodeStatus.IN_PROGRESS
        self.state.pending_gate = "foundation"
        self.state.save()
        self.state.log("Foundation generated — awaiting human approval.")
        return self.state

    def apply_foundation_decision(
        self,
        approved: bool,
        feedback: str = "",
    ) -> GraphNovelState:
        """Resume the graph from the Foundation approval gate."""
        if (
            self.state.pending_gate != "foundation"
            or self.state.node_status.get("human_approval_foundation")
            != NodeStatus.IN_PROGRESS
        ):
            raise GraphExecutionError(
                "human_approval_foundation",
                "Foundation is not waiting for approval.",
                code="invalid_transition",
            )

        self.state.foundation_approval = (
            ApprovalStatus.APPROVED if approved else ApprovalStatus.REJECTED
        )
        self.state.foundation_feedback = feedback.strip()
        self.state.node_status["human_approval_foundation"] = NodeStatus.COMPLETED
        self.state.pending_gate = None

        if approved:
            self.state.workflow_phase = "chapter_loop"
            for ch_num in range(1, self.state.total_chapters + 1):
                if len(self.state.chapters) < ch_num:
                    self.state.chapters.append(
                        Chapter(chapter_number=ch_num, title=f"第{ch_num}章")
                    )
            self.state.log("Foundation approved — chapter pipeline is ready.")
        else:
            self.state.workflow_phase = "foundation"
            self.state.log(
                "Foundation rejected — feedback saved for regeneration."
            )

        self.state.save()
        return self.state

    def _is_foundation_approved(self) -> bool:
        if self.state.foundation_approval == ApprovalStatus.APPROVED:
            return True
        if self.state.foundation_approval == ApprovalStatus.REJECTED:
            return False

        # Backward-compatible fallback for version-1 in-memory fixtures.
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

    def _require_completed(self, node_key: str) -> None:
        """Stop routing immediately when a required node did not complete."""
        if self.state.node_status.get(node_key) == NodeStatus.COMPLETED:
            return

        previous_error = self.state.last_error
        if previous_error.get("node") == node_key:
            message = previous_error.get("message", f"Node {node_key} failed.")
        else:
            message = f"Required node {node_key} did not complete."
            self.state.last_error = {"node": node_key, "message": message}

        self.state.workflow_phase = "failed"
        self.state.pending_gate = None
        self.state.save()
        raise GraphExecutionError(node_key, message)

    def _execute_required_node(self, node_key: str, runner) -> None:
        """Execute one Foundation node and normalize unexpected exceptions."""
        try:
            self.state = runner(self.state)
        except Exception as exc:
            self.state.node_status[node_key] = NodeStatus.FAILED
            self.state.last_error = {"node": node_key, "message": str(exc)}
        self._require_completed(node_key)

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
