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

Phase 2 (Per-Chapter Pipeline — conditional loops):
  [Chapter Planning] ──> [Writing] ──> [Style Polish]
          ▲                  ▲                ▲
          └── plan issue ────┤                │
                             └─ writing issue ┤
                                      polish issue
                                               │
                                  [Final Consistency Review]
                                               │
                                  [Human Approval: Chapter]

Phase 3 (Final Pass):
  [Global Review] ──> DONE
"""

from __future__ import annotations

import time
from enum import Enum, auto
from pathlib import Path
from typing import Optional

from graph_novel.exporting import (
    approved_chapters,
    build_novel_markdown,
    export_filename,
)
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
from graph_novel.narrative import has_blocking_narrative_violations


REWRITE_LIMITS = {
    "writing_contract": 2,
    "plan": 2,
    "writing": 2,
    "polish": 2,
}
MAX_TOTAL_REWRITES = 4
REVISION_SCOPES = {"plan", "writing", "polish"}


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

        resume_outline = (
            self.state.workflow_phase == "failed"
            and self.state.last_error.get("node") == "outline_planning"
            and self.state.node_status.get("world_building")
            == NodeStatus.COMPLETED
            and self.state.node_status.get("character_design")
            == NodeStatus.COMPLETED
            and bool(self.state.world_setting)
            and bool(self.state.characters)
        )
        self.phase = GraphPhase.FOUNDATION
        self.state.workflow_phase = "foundation"
        self.state.pending_gate = None
        self.state.foundation_approval = ApprovalStatus.PENDING
        self.state.last_error = {}
        self.state.log("="*50)
        self.state.log("PHASE 1: Foundation")

        if resume_outline:
            self.state.log(
                "Foundation checkpoint — 复用已完成的世界观和角色，"
                "从大纲规划恢复。"
            )
        else:
            # Node 1: World-Building
            self._execute_required_node("world_building", world_building.run_node)
            self._record_route(
                "world_building",
                "character_design",
                "world_ready",
            )

            # Node 2: Character Design (can run after world-building)
            self._execute_required_node(
                "character_design",
                character_design.run_node,
            )
            self._record_route(
                "character_design",
                "outline_planning",
                "characters_ready",
            )

        # Node 3: Outline Planning (needs world + characters)
        self._execute_required_node("outline_planning", outline_planning.run_node)
        self._record_route(
            "outline_planning",
            "human_approval_foundation",
            "foundation_gate",
        )

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
            self._record_route(
                "human_approval_foundation",
                "chapter_planning_1",
                "approved",
            )
        else:
            self.state.workflow_phase = "foundation"
            self.state.log(
                "Foundation rejected — feedback saved for regeneration."
            )
            self._record_route(
                "human_approval_foundation",
                "world_building",
                "rejected",
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
        """Execute one required node and persist its lifecycle."""
        started = time.perf_counter()
        self.state.node_status[node_key] = NodeStatus.IN_PROGRESS
        self.state.record_event(
            "node_started",
            node=node_key,
            workflow_phase=self.state.workflow_phase,
        )
        self.state.save()

        try:
            self.state = runner(self.state)
        except Exception as exc:
            self.state.node_status[node_key] = NodeStatus.FAILED
            self.state.last_error = {"node": node_key, "message": str(exc)}

        status = self.state.node_status.get(node_key)
        completed = status == NodeStatus.COMPLETED
        if not completed and status != NodeStatus.FAILED:
            self.state.node_status[node_key] = NodeStatus.FAILED
        event_details = {
            "node": node_key,
            "status": "completed" if completed else "failed",
            "duration_ms": round((time.perf_counter() - started) * 1000, 3),
        }
        if not completed:
            event_details["error"] = self.state.last_error.get(
                "message",
                f"Required node {node_key} did not complete.",
            )
        self.state.record_event("node_finished", **event_details)
        self.state.save()
        self._require_completed(node_key)

    def _record_route(
        self,
        source: str,
        target: str,
        reason: str,
        **details,
    ) -> None:
        """Persist one graph edge selection and its reason."""
        self.state.record_event(
            "route_selected",
            source=source,
            target=target,
            reason=reason,
            **details,
        )
        self.state.save()

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
        """Run the scoped chapter graph and stop at its approval Gate."""
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
            start_scope = self._normalize_revision_scope(
                chapter.human_revision_scope,
            )
            self._reset_rewrite_counters(chapter)
            self._prepare_chapter_revision(
                chapter,
                chapter.human_feedback or "人工驳回后重写",
                source="human",
                scope=start_scope,
            )
        elif not chapter.rewrite_counters:
            self._reset_rewrite_counters(chapter)
        else:
            self._ensure_rewrite_counters(chapter)

        needs_plan = self._node_requires_run(
            f"chapter_planning_{ch_num}",
            bool(chapter.plan),
        )
        needs_writing = needs_plan or self._node_requires_run(
            f"writing_{ch_num}",
            bool(chapter.draft),
        )
        needs_polish = needs_writing or self._node_requires_run(
            f"style_polish_{ch_num}",
            bool(chapter.polished_draft),
        )
        needs_review = needs_polish or self._node_requires_run(
            f"consistency_review_{ch_num}",
            bool(chapter.consistency_report),
        )

        while True:
            if needs_plan:
                self._execute_required_node(
                    f"chapter_planning_{ch_num}",
                    chapter_planning.run_node,
                )
                self._record_route(
                    f"chapter_planning_{ch_num}",
                    f"writing_{ch_num}",
                    "plan_ready",
                )
                needs_plan = False
                needs_writing = True
                needs_polish = True

            if needs_writing:
                self._execute_required_node(
                    f"writing_{ch_num}",
                    writing.run_node,
                )
                chapter = self.state.chapters[ch_num - 1]
                if not chapter.draft:
                    message = f"Chapter {ch_num} writing produced no draft."
                    self.state.node_status[
                        f"writing_{ch_num}"
                    ] = NodeStatus.FAILED
                    self.state.last_error = {
                        "node": f"writing_{ch_num}",
                        "message": message,
                    }
                    self._require_completed(f"writing_{ch_num}")

                contract_violations = chapter.narrative_delta.get(
                    "contract_violations",
                    [],
                )
                if contract_violations:
                    feedback = self._format_narrative_contract_feedback(
                        contract_violations,
                    )
                    if self._consume_rewrite(
                        chapter,
                        "writing_contract",
                    ):
                        attempt = chapter.rewrite_counters[
                            "writing_contract"
                        ]
                        self.state.log(
                            f"Chapter {ch_num} writing exceeded its "
                            f"narrative plan. Attempt {attempt}/"
                            f"{REWRITE_LIMITS['writing_contract']}"
                        )
                        self._prepare_chapter_revision(
                            chapter,
                            feedback,
                            source="narrative_contract",
                            scope="writing",
                        )
                        needs_writing = True
                        needs_polish = True
                        needs_review = True
                        self._record_route(
                            f"writing_{ch_num}",
                            f"writing_{ch_num}",
                            "narrative_contract_failed",
                            rewrite_scope="writing_contract",
                            rewrite_attempt=attempt,
                        )
                        continue

                    node_key = f"narrative_gate_{ch_num}"
                    message = (
                        f"Chapter {ch_num} 连续生成了章节规划之外的"
                        "剧情事实，已达到自动重写上限。"
                    )
                    self._prepare_chapter_revision(
                        chapter,
                        feedback,
                        source="narrative_contract",
                        scope="writing",
                    )
                    self._mark_rewrite_limit_failure(
                        node_key,
                        message,
                        source=f"writing_{ch_num}",
                        reason="narrative_rewrite_limit_reached",
                        chapter=chapter,
                    )
                    raise GraphExecutionError(node_key, message)

                needs_writing = False
                needs_polish = True
                needs_review = True
                self._record_route(
                    f"writing_{ch_num}",
                    f"style_polish_{ch_num}",
                    "draft_ready",
                )

            if needs_polish:
                self._execute_required_node(
                    f"style_polish_{ch_num}",
                    style_polish.run_node,
                )
                needs_polish = False
                needs_review = True
                self._record_route(
                    f"style_polish_{ch_num}",
                    f"consistency_review_{ch_num}",
                    "polished_draft_ready",
                )

            if needs_review:
                self._execute_required_node(
                    f"consistency_review_{ch_num}",
                    consistency_review.run_node,
                )
                needs_review = False

            chapter = self.state.chapters[ch_num - 1]
            review = chapter.consistency_report
            needs_rewrite = (
                review.get("requires_rewrite", False)
                if review else False
            )
            score = review.get("overall_score", 10) if review else 10
            narrative_blocked = has_blocking_narrative_violations(review)
            if not needs_rewrite and not narrative_blocked:
                if chapter.rewrite_counters.get("total", 0) > 0:
                    self.state.log(
                        f"Chapter {ch_num} rewrite complete after "
                        f"{chapter.rewrite_counters['total']} attempts."
                    )
                break

            scope = self._normalize_revision_scope(
                review.get("rewrite_scope", "writing")
            )
            if narrative_blocked and scope == "polish":
                scope = "writing"
                self.state.log(
                    f"Chapter {ch_num} hard narrative gate escalated "
                    "rewrite scope from polish to writing."
                )
            feedback = self._format_review_feedback(review)
            if self._consume_rewrite(chapter, scope):
                attempt = chapter.rewrite_counters[scope]
                self.state.log(
                    f"Chapter {ch_num} needs {scope} rewrite "
                    f"(score {score}/10). Attempt {attempt}/"
                    f"{REWRITE_LIMITS[scope]}"
                )
                self._prepare_chapter_revision(
                    chapter,
                    feedback,
                    source="consistency_review",
                    scope=scope,
                )
                needs_plan = scope == "plan"
                needs_writing = scope in {"plan", "writing"}
                needs_polish = True
                needs_review = True
                target = {
                    "plan": f"chapter_planning_{ch_num}",
                    "writing": f"writing_{ch_num}",
                    "polish": f"style_polish_{ch_num}",
                }[scope]
                self._record_route(
                    f"consistency_review_{ch_num}",
                    target,
                    f"review_{scope}_failed",
                    score=score,
                    rewrite_scope=scope,
                    rewrite_attempt=attempt,
                )
                continue

            node_prefix = "narrative_gate" if narrative_blocked else "quality_gate"
            node_key = f"{node_prefix}_{ch_num}"
            message = (
                f"Chapter {ch_num} 的 {scope} 修订仍未通过最终审查，"
                "已达到自动重写上限。"
            )
            self._prepare_chapter_revision(
                chapter,
                feedback,
                source=node_prefix,
                scope=scope,
            )
            self._mark_rewrite_limit_failure(
                node_key,
                message,
                source=f"consistency_review_{ch_num}",
                reason=f"{node_prefix}_rewrite_limit_reached",
                chapter=chapter,
                score=score,
            )
            raise GraphExecutionError(node_key, message)

        chapter = self.state.chapters[ch_num - 1]
        chapter.approval = ApprovalStatus.PENDING
        self.state.node_status[f"human_approval_{ch_num}"] = NodeStatus.IN_PROGRESS
        self.state.pending_gate = f"chapter:{ch_num}"
        self._record_route(
            f"consistency_review_{ch_num}",
            f"human_approval_{ch_num}",
            "final_review_passed",
            score=chapter.consistency_report.get("overall_score", 0),
        )
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
        revision_scope: str = "plan",
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
        if approved and (
            not chapter.polished_draft
            or not chapter.consistency_report
            or chapter.consistency_report.get("requires_rewrite", False)
            or has_blocking_narrative_violations(
                chapter.consistency_report,
            )
            or self.state.node_status.get(
                f"consistency_review_{ch_num}"
            ) != NodeStatus.COMPLETED
        ):
            raise GraphExecutionError(
                node_key,
                f"Chapter {ch_num} final candidate has not passed review.",
                code="invalid_transition",
            )

        normalized_scope = (
            "none"
            if approved
            else self._normalize_revision_scope(revision_scope)
        )
        chapter.approval = (
            ApprovalStatus.APPROVED if approved else ApprovalStatus.REJECTED
        )
        chapter.human_feedback = feedback.strip()
        chapter.human_revision_scope = normalized_scope
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
            next_target = (
                "global_review"
                if all_approved
                else f"chapter_planning_{ch_num + 1}"
            )
            self._record_route(node_key, next_target, "approved")
            self.state.log(f"Chapter {ch_num} approved.")
            self._save_outputs()
        else:
            self.state.workflow_phase = "chapter_loop"
            next_target = {
                "plan": f"chapter_planning_{ch_num}",
                "writing": f"writing_{ch_num}",
                "polish": f"style_polish_{ch_num}",
            }[normalized_scope]
            self._record_route(
                node_key,
                next_target,
                f"rejected_{normalized_scope}",
                revision_scope=normalized_scope,
            )
            self.state.log(
                f"Chapter {ch_num} rejected — {normalized_scope} "
                "feedback saved."
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
        if (
            ch_num > 1
            and (
                len(self.state.chapters) < ch_num - 1
                or self.state.chapters[ch_num - 2].approval
                != ApprovalStatus.APPROVED
            )
        ):
            raise GraphExecutionError(
                f"human_approval_{ch_num - 1}",
                f"Chapter {ch_num - 1} must be approved before "
                f"generating chapter {ch_num}.",
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
        issues = list(review.get("issues", []))
        issues.extend(review.get("narrative_violations", []))
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
    def _format_narrative_contract_feedback(violations: list) -> str:
        lines = [
            "正文违反章节规划中的叙事状态白名单，必须重写正文。",
            "不要修改章节规划来吸收这些临时添加的设定；"
            "请直接删除或改写越界内容：",
        ]
        lines.extend(f"- {violation}" for violation in violations)
        return "\n".join(lines)

    def _prepare_chapter_revision(
        self,
        chapter: Chapter,
        feedback: str,
        source: str,
        scope: str,
    ) -> None:
        if scope not in REVISION_SCOPES:
            raise ValueError(f"Unsupported revision scope: {scope}")
        if chapter.draft or chapter.polished_draft or chapter.consistency_report:
            chapter.revision_history.append({
                "revision": chapter.revision_count,
                "source": source,
                "feedback": feedback,
                "title": chapter.title,
                "plan": chapter.plan,
                "draft": chapter.draft,
                "polished_draft": chapter.polished_draft,
                "consistency_report": chapter.consistency_report,
                "generation_meta": chapter.generation_meta,
                "narrative_delta": chapter.narrative_delta,
                "human_feedback": chapter.human_feedback,
                "revision_scope": scope,
                "rewrite_counters": dict(chapter.rewrite_counters),
            })
            chapter.revision_count += 1

        chapter.rewrite_feedback = feedback
        chapter.human_revision_scope = scope
        chapter.consistency_report = {}
        if scope in {"plan", "writing"}:
            if scope == "plan":
                chapter.plan = {}
            chapter.draft = ""
            chapter.polished_draft = ""
            chapter.generation_meta = {}
            chapter.narrative_delta = {}
            chapter.word_count = 0
            chapter.chapter_hook = ""
            chapter.shuangdian_type = ""
        else:
            current_candidate = chapter.polished_draft or chapter.draft
            chapter.word_count = len(current_candidate.replace(" ", ""))
        chapter.approval = ApprovalStatus.PENDING
        chapter.human_feedback = ""
        chapter.side_effects_committed = False

        invalidated_nodes = {
            "plan": (
                "chapter_planning",
                "writing",
                "style_polish",
                "consistency_review",
            ),
            "writing": (
                "writing",
                "style_polish",
                "consistency_review",
            ),
            "polish": (
                "style_polish",
                "consistency_review",
            ),
        }[scope]
        for node_name in invalidated_nodes:
            self.state.node_status[
                f"{node_name}_{chapter.chapter_number}"
            ] = NodeStatus.PENDING

    @staticmethod
    def _normalize_revision_scope(scope: str) -> str:
        if scope not in REVISION_SCOPES:
            raise GraphExecutionError(
                "chapter_revision",
                "revision_scope must be plan, writing, or polish.",
                code="invalid_transition",
            )
        return scope

    @staticmethod
    def _reset_rewrite_counters(chapter: Chapter) -> None:
        chapter.rewrite_counters = {
            **{scope: 0 for scope in REWRITE_LIMITS},
            "total": 0,
        }

    @staticmethod
    def _ensure_rewrite_counters(chapter: Chapter) -> None:
        for scope in REWRITE_LIMITS:
            chapter.rewrite_counters.setdefault(scope, 0)
        chapter.rewrite_counters.setdefault(
            "total",
            sum(
                chapter.rewrite_counters.get(scope, 0)
                for scope in REWRITE_LIMITS
            ),
        )

    def _node_requires_run(self, node_key: str, has_output: bool) -> bool:
        if not has_output:
            return True
        return self.state.node_status.get(node_key) in {
            NodeStatus.PENDING,
            NodeStatus.IN_PROGRESS,
            NodeStatus.FAILED,
            NodeStatus.SKIPPED,
        }

    @staticmethod
    def _consume_rewrite(chapter: Chapter, scope: str) -> bool:
        limit = REWRITE_LIMITS[scope]
        current = chapter.rewrite_counters.get(scope, 0)
        total = chapter.rewrite_counters.get("total", 0)
        if current >= limit or total >= MAX_TOTAL_REWRITES:
            return False
        chapter.rewrite_counters[scope] = current + 1
        chapter.rewrite_counters["total"] = total + 1
        return True

    def _mark_rewrite_limit_failure(
        self,
        node_key: str,
        message: str,
        source: str,
        reason: str,
        chapter: Chapter,
        **details,
    ) -> None:
        self.state.node_status[node_key] = NodeStatus.FAILED
        self.state.last_error = {
            "node": node_key,
            "message": message,
        }
        self.state.workflow_phase = "failed"
        self.state.pending_gate = None
        self._record_route(
            source,
            node_key,
            reason,
            rewrite_counters=dict(chapter.rewrite_counters),
            **details,
        )

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
        self._record_route("global_review", "done", "review_completed")

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

        for ch in approved_chapters(self.state):
            chapter_text = ch.polished_draft or ch.draft
            if chapter_text:
                shuangdian = getattr(ch, 'shuangdian_type', '') or ''
                hook = getattr(ch, 'chapter_hook', '') or ''
                review_score = ch.consistency_report.get('overall_score', 'N/A') if ch.consistency_report else 'N/A'
                ch_path = out_dir / f"第{ch.chapter_number:02d}章.md"
                content = f"# 第{ch.chapter_number}章：{ch.title}\n\n"
                content += chapter_text
                content += f"\n\n---\n"
                content += f"字数：{ch.word_count} | 审稿评分：{review_score}/10"
                if shuangdian:
                    content += f" | 爽点：{shuangdian}"
                if hook:
                    content += f"\n章末钩子：{hook}"
                ch_path.write_text(content, encoding="utf-8")
                self.state.log(f"Chapter saved: {ch_path}")

        # Save complete novel
        novel_path = out_dir / export_filename(self.state)
        novel_path.write_text(
            build_novel_markdown(self.state),
            encoding="utf-8",
        )
        self.state.log(f"Complete novel saved: {novel_path}")
