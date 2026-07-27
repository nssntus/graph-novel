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
            if self.state.chapters[ch_num - 1].approval != ApprovalStatus.APPROVED:
                self.state.log(
                    f"Chapter {ch_num} rejected. Restart with feedback."
                )
                return self.state

        # Phase 3: Global review
        self._run_global_review()

        self.phase = GraphPhase.DONE
        self.state.log("GraphNovel Engine — COMPLETE.")
        self._save_outputs()
        return self.state

    def run_single_chapter(self, ch_num: int) -> GraphNovelState:
        """Generate one chapter and collect its decision (CLI/test compatibility)."""
        self._run_chapter_pipeline(ch_num)
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
        self.validate_foundation_generation()

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

    def validate_foundation_generation(self) -> None:
        """Validate a Foundation generation transition without mutating State."""
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
        """Execute one required node and normalize unexpected exceptions."""
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
        """CLI/full-run wrapper: generate, collect a decision, then transition."""
        self.run_chapter_generation(ch_num)
        approved, feedback = human_approval.request_chapter_decision(
            self.state,
            ch_num,
            wait_callback=self._approval_callback,
        )
        self.apply_chapter_decision(ch_num, approved, feedback)

    def run_chapter_generation(self, ch_num: int) -> GraphNovelState:
        """Run nodes 4-7 and stop at the persisted chapter approval Gate."""
        self.validate_chapter_generation(ch_num)
        self._ensure_chapter_slots()
        self.phase = GraphPhase.CHAPTER_LOOP
        self.state.workflow_phase = "chapter_loop"
        self.state.pending_gate = None
        self.state.current_chapter = ch_num
        self.state.last_error = {}
        self.state.log("="*50)
        self.state.log(f"PHASE 2: Chapter {ch_num}/{self.state.total_chapters}")

        chapter = self.state.chapters[ch_num - 1]
        if chapter.approval == ApprovalStatus.REJECTED:
            self._prepare_chapter_revision(
                chapter,
                chapter.human_feedback or "人工驳回后重写",
                source="human",
            )

        max_rewrites = 2  # Maximum rewrite attempts per chapter
        rewrite_count = 0

        while True:
            # Node 4: Chapter Planning
            self._execute_required_node(
                f"chapter_planning_{ch_num}",
                chapter_planning.run_node,
            )

            # Node 5: Chapter Writing
            self._execute_required_node(f"writing_{ch_num}", writing.run_node)

            if not self.state.chapters[ch_num - 1].draft:
                message = f"Chapter {ch_num} writing produced no draft."
                self.state.node_status[f"writing_{ch_num}"] = NodeStatus.FAILED
                self.state.last_error = {
                    "node": f"writing_{ch_num}",
                    "message": message,
                }
                self._require_completed(f"writing_{ch_num}")

            # Node 6: Consistency Review
            self._execute_required_node(
                f"consistency_review_{ch_num}",
                consistency_review.run_node,
            )

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
                self._prepare_chapter_revision(
                    chapter,
                    self._format_review_feedback(review),
                    source="consistency_review",
                )
                continue
            else:
                if rewrite_count > 0:
                    self.state.log(
                        f"Chapter {ch_num} rewrite complete after {rewrite_count} attempts."
                    )
                break

        # Node 7: Style Polish
        self._execute_required_node(
            f"style_polish_{ch_num}",
            style_polish.run_node,
        )

        # Node 8 is a persisted Gate. A separate decision resumes the graph.
        chapter = self.state.chapters[ch_num - 1]
        chapter.approval = ApprovalStatus.PENDING
        self.state.node_status[f"human_approval_{ch_num}"] = NodeStatus.IN_PROGRESS
        self.state.pending_gate = f"chapter:{ch_num}"
        self.state.save()
        self.state.log(
            f"Chapter {ch_num} generated — awaiting human approval."
        )
        return self.state

    def apply_chapter_decision(
        self,
        ch_num: int,
        approved: bool,
        feedback: str = "",
    ) -> GraphNovelState:
        """Resume the graph from one chapter approval Gate."""
        node_key = f"human_approval_{ch_num}"
        if (
            self.state.pending_gate != f"chapter:{ch_num}"
            or self.state.node_status.get(node_key) != NodeStatus.IN_PROGRESS
        ):
            raise GraphExecutionError(
                node_key,
                f"Chapter {ch_num} is not waiting for approval.",
                code="invalid_transition",
            )

        chapter = self.state.chapters[ch_num - 1]
        chapter.approval = (
            ApprovalStatus.APPROVED if approved else ApprovalStatus.REJECTED
        )
        chapter.human_feedback = feedback.strip()
        self.state.node_status[node_key] = NodeStatus.COMPLETED
        self.state.pending_gate = None

        if approved:
            self._commit_chapter_side_effects(ch_num)
            all_approved = all(
                item.approval == ApprovalStatus.APPROVED
                for item in self.state.chapters[:self.state.total_chapters]
            )
            self.state.workflow_phase = (
                "global_review" if all_approved else "chapter_loop"
            )
            self.state.log(f"Chapter {ch_num} approved.")
            self._save_outputs()
        else:
            self.state.workflow_phase = "chapter_loop"
            self.state.log(
                f"Chapter {ch_num} rejected — feedback saved for rewrite."
            )
            self.state.save()

        return self.state

    def validate_chapter_generation(self, ch_num: int) -> None:
        """Validate a chapter generation transition without mutating State."""
        if not self._is_foundation_approved():
            raise GraphExecutionError(
                "human_approval_foundation",
                "Foundation must be approved before writing chapters.",
                code="invalid_transition",
            )
        if ch_num < 1 or ch_num > self.state.total_chapters:
            raise GraphExecutionError(
                f"chapter_{ch_num}",
                f"Chapter number must be between 1 and {self.state.total_chapters}.",
                code="invalid_transition",
            )
        if self.state.pending_gate:
            raise GraphExecutionError(
                self.state.pending_gate,
                f"Graph is already waiting at {self.state.pending_gate}.",
                code="invalid_transition",
            )

        if (
            ch_num <= len(self.state.chapters)
            and self.state.chapters[ch_num - 1].approval
            == ApprovalStatus.APPROVED
        ):
            raise GraphExecutionError(
                f"human_approval_{ch_num}",
                f"Approved chapter {ch_num} cannot be regenerated.",
                code="invalid_transition",
            )

    def _ensure_chapter_slots(self) -> None:
        while len(self.state.chapters) < self.state.total_chapters:
            number = len(self.state.chapters) + 1
            self.state.chapters.append(
                Chapter(chapter_number=number, title=f"第{number}章")
            )

    @staticmethod
    def _format_review_feedback(review: dict) -> str:
        issues = review.get("issues", [])
        if not issues:
            return review.get("summary", "一致性审查要求重写")
        lines = ["一致性审查要求重写："]
        for issue in issues:
            description = issue.get("description", "")
            suggestion = issue.get("suggested_fix", "")
            line = f"- {description}"
            if suggestion:
                line += f"；修改建议：{suggestion}"
            lines.append(line)
        return "\n".join(lines)

    @staticmethod
    def _prepare_chapter_revision(
        chapter: Chapter,
        feedback: str,
        source: str,
    ) -> None:
        if chapter.draft or chapter.polished_draft or chapter.consistency_report:
            chapter.revision_history.append({
                "revision": chapter.revision_count,
                "source": source,
                "feedback": feedback,
                "title": chapter.title,
                "draft": chapter.draft,
                "polished_draft": chapter.polished_draft,
                "consistency_report": chapter.consistency_report,
                "generation_meta": chapter.generation_meta,
                "human_feedback": chapter.human_feedback,
            })
            chapter.revision_count += 1

        chapter.rewrite_feedback = feedback
        chapter.draft = ""
        chapter.polished_draft = ""
        chapter.consistency_report = {}
        chapter.generation_meta = {}
        chapter.word_count = 0
        chapter.chapter_hook = ""
        chapter.shuangdian_type = ""
        chapter.approval = ApprovalStatus.PENDING
        chapter.human_feedback = ""
        chapter.side_effects_committed = False

    def _commit_chapter_side_effects(self, ch_num: int) -> None:
        chapter = self.state.chapters[ch_num - 1]
        if chapter.side_effects_committed:
            return

        writing.commit_generation_meta(self.state, ch_num)
        consistency_review.commit_arc_updates(self.state, ch_num)
        while len(self.state.chapter_hooks) < ch_num:
            self.state.chapter_hooks.append("")
        self.state.chapter_hooks[ch_num - 1] = chapter.chapter_hook
        chapter.side_effects_committed = True

    # ------------------------------------------------------------------
    # Phase 3: Global Review
    # ------------------------------------------------------------------

    def _run_global_review(self) -> None:
        self.validate_global_review()
        self.phase = GraphPhase.GLOBAL_REVIEW
        self.state.workflow_phase = "global_review"
        self.state.last_error = {}
        self.state.log("="*50)
        self.state.log("PHASE 3: Global Review")
        self._execute_required_node("global_review", global_review.run_node)
        self.state.workflow_phase = "done"

    def validate_global_review(self) -> None:
        """Validate the Node 9 transition without mutating State."""
        if self.state.pending_gate:
            raise GraphExecutionError(
                self.state.pending_gate,
                f"Graph is already waiting at {self.state.pending_gate}.",
                code="invalid_transition",
            )
        if (
            self.state.total_chapters <= 0
            or len(self.state.chapters) < self.state.total_chapters
            or any(
                chapter.approval != ApprovalStatus.APPROVED
                for chapter in self.state.chapters[:self.state.total_chapters]
            )
        ):
            raise GraphExecutionError(
                "global_review",
                "All chapters must be approved before global review.",
                code="invalid_transition",
            )

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
            if ch.approval == ApprovalStatus.APPROVED and ch.polished_draft:
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
            if ch.approval == ApprovalStatus.APPROVED and ch.polished_draft:
                shuangdian = getattr(ch, 'shuangdian_type', '')
                hook = getattr(ch, 'chapter_hook', '')
                novel_text += f"## 第{ch.chapter_number}章：{ch.title}\n\n"
                novel_text += ch.polished_draft
                novel_text += "\n\n"

        novel_path.write_text(novel_text, encoding="utf-8")
        self.state.log(f"Complete novel saved: {novel_path}")
