"""
Node 8: Human Approval Gate
Pauses the graph and waits for human input.
Used at key decision points: world setting approval, outline approval,
and per-chapter final review.
"""

from graph_novel.state import GraphNovelState, NodeStatus, ApprovalStatus


def request_foundation_decision(state: GraphNovelState, wait_callback=None):
    """Collect a Foundation decision without mutating graph state."""
    if wait_callback:
        return wait_callback(state, stage="foundation")
    return _cli_approval_foundation(state)


def request_chapter_decision(
    state: GraphNovelState,
    ch_num: int,
    wait_callback=None,
):
    """Collect a chapter decision without mutating graph state."""
    if wait_callback:
        return wait_callback(state, ch_num)
    return _cli_approval(state, ch_num)


def run_node(state: GraphNovelState, wait_callback=None) -> GraphNovelState:
    """
    Human approval gate.

    If wait_callback is provided, it's called with (state, chapter_num)
    and should return (approved: bool, feedback: str).

    In web mode, this pauses and waits for the user to interact.
    In CLI mode, this prompts on stdin.

    For the web UI, the callback is set by the Flask app.
    """
    ch_num = state.current_chapter
    node_key = f"human_approval_{ch_num}"
    state.log(f"Node 8: Human Approval — waiting for review of chapter {ch_num}...")
    state.node_status[node_key] = NodeStatus.IN_PROGRESS

    chapter = state.chapters[ch_num - 1]

    approved, feedback = request_chapter_decision(
        state,
        ch_num,
        wait_callback,
    )

    chapter.approval = ApprovalStatus.APPROVED if approved else ApprovalStatus.REJECTED
    chapter.human_feedback = feedback

    state.node_status[node_key] = NodeStatus.COMPLETED
    state.log(
        f"Node 8: Human Approval — {'APPROVED' if approved else 'REJECTED'} "
        f"for chapter {ch_num}"
    )

    return state


def approve_foundation(state: GraphNovelState, wait_callback=None) -> GraphNovelState:
    """Special approval for world setting + outline (foundation gate)."""
    state.log("Node 8 (Foundation): Human Approval — waiting for foundation review...")
    state.node_status["human_approval_foundation"] = NodeStatus.IN_PROGRESS

    approved, feedback = request_foundation_decision(state, wait_callback)

    state.node_status["human_approval_foundation"] = NodeStatus.COMPLETED
    state.foundation_approval = (
        ApprovalStatus.APPROVED if approved else ApprovalStatus.REJECTED
    )
    state.foundation_feedback = feedback
    state.pending_gate = None
    state.log(f"Node 8 (Foundation): {'APPROVED' if approved else 'REJECTED'}")

    # If rejected, set all chapters to rejected
    if not approved:
        for ch in state.chapters:
            ch.approval = ApprovalStatus.REJECTED
            ch.human_feedback = feedback

    return state


def _cli_approval(state: GraphNovelState, ch_num: int) -> tuple[bool, str]:
    chapter = state.chapters[ch_num - 1]
    print(f"\n{'='*60}")
    print(f"Chapter {ch_num}: {chapter.title}")
    print(f"Words: {chapter.word_count}")
    print(f"Consistency score: {chapter.consistency_report.get('overall_score', 'N/A')}/10")
    print(f"\n--- POLISHED DRAFT ---")
    print(chapter.polished_draft[:2000])
    if len(chapter.polished_draft) > 2000:
        print(f"\n... ({chapter.word_count} total words) ...")
    print(f"\n{'='*60}")

    while True:
        choice = input("\nApprove this chapter? (y/n/f=feedback): ").strip().lower()
        if choice == "y":
            return True, ""
        elif choice == "n":
            return False, "Rejected by author"
        elif choice == "f":
            fb = input("Feedback: ").strip()
            choice2 = input("Approve with feedback? (y/n): ").strip().lower()
            return choice2 == "y", fb
        print("Enter y (approve), n (reject), or f (feedback)")


def _cli_approval_foundation(state: GraphNovelState) -> tuple[bool, str]:
    print(f"\n{'='*60}")
    print("FOUNDATION REVIEW")
    print(f"Novel: {state.novel_title}")

    if state.world_setting:
        ws = state.world_setting
        print(f"\nWorld Setting: {ws.era} — {ws.location}")
        print(f"Magic: {ws.magic_system or 'None'}")
        print(f"Tech: {ws.technology_level or 'Standard'}")

    if state.novel_outline:
        no = state.novel_outline
        print(f"\nGenre: {no.genre}")
        print(f"Premise: {no.premise}")
        print(f"Theme: {no.theme}")
        print(f"Chapters: {len(no.chapter_outlines)}")

    if state.characters:
        print(f"\nCharacters:")
        for c in state.characters:
            print(f"  - {c.name} ({c.role}): {c.motivation[:80]}")

    print(f"\n{'='*60}")

    while True:
        choice = input("\nApprove foundation? (y/n/f=feedback): ").strip().lower()
        if choice == "y":
            return True, ""
        elif choice == "n":
            return False, "Foundation rejected by author"
        elif choice == "f":
            fb = input("Feedback: ").strip()
            choice2 = input("Approve with feedback? (y/n): ").strip().lower()
            return choice2 == "y", fb
