"""
Integration tests for the GraphNovel system.

Tests the core data flow without calling the actual DeepSeek API
by mocking the LLM client. Also tests state serialization, graph
engine routing, and web API endpoints.
"""

import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest import mock

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from graph_novel.state import (
    GraphNovelState, NodeStatus, ApprovalStatus, ArcStage,
    WorldSetting, Character, CharacterArc, NovelOutline,
    ChapterOutline, Chapter, Foreshadowing,
)
from graph_novel.engine import GraphNovelEngine, GraphPhase


# ======================================================================
# Test fixtures
# ======================================================================

def make_sample_state() -> GraphNovelState:
    """Create a minimal state for testing."""
    state = GraphNovelState(
        novel_title="Test Novel",
        save_dir=Path(tempfile.mkdtemp()),
        total_chapters=3,
    )
    state.world_setting = WorldSetting(
        era="Medieval Fantasy",
        location="The Kingdom of Testia",
        magic_system="Elemental magic, rare",
        technology_level="Pre-industrial",
        social_structure="Feudal monarchy with guild influence",
        key_locations=[
            {"name": "Test Castle", "description": "The royal seat."},
            {"name": "Dark Forest", "description": "Where things go missing."},
        ],
        rules_and_laws="Magic is regulated by the Mage Guild.",
        history="A hundred years of peace, now ending.",
    )
    state.characters = [
        Character(
            name="Aria",
            role="protagonist",
            background="Orphan turned royal guard.",
            personality="Determined, loyal, but reckless.",
            motivation="Protect the kingdom she was raised in.",
            arc=CharacterArc(
                character_name="Aria",
                arc_description="From duty-bound soldier to independent leader.",
                current_stage=ArcStage.INCITING_INCIDENT,
            ),
            relationships={"Kael": "Rival turned ally"},
        ),
        Character(
            name="Kael",
            role="antagonist",
            background="Exiled prince seeking revenge.",
            personality="Cunning, charismatic, wounded.",
            motivation="Reclaim what was stolen from him.",
            arc=CharacterArc(
                character_name="Kael",
                arc_description="From vengeance seeker to understanding the cost.",
                current_stage=ArcStage.INCITING_INCIDENT,
            ),
        ),
    ]
    state.character_arc_tracker = {
        c.name: c.arc for c in state.characters if c.arc
    }
    state.novel_outline = NovelOutline(
        genre="Fantasy",
        premise="A young guard must choose between duty and truth.",
        theme="What is the price of loyalty?",
        target_length="60,000 words",
        chapter_outlines=[
            ChapterOutline(
                chapter_number=1, title="The Summons",
                summary="Aria is called to the throne room.",
                key_events=["Summons", "Mysterious message"],
            ),
            ChapterOutline(
                chapter_number=2, title="The Road East",
                summary="Aria sets out on her journey.",
                key_events=["Departure", "Ambush"],
            ),
            ChapterOutline(
                chapter_number=3, title="The Revelation",
                summary="Truth comes to light.",
                key_events=["Confrontation", "Choice"],
            ),
        ],
    )

    # Initialize empty chapters
    for i in range(1, 4):
        state.chapters.append(Chapter(chapter_number=i, title=f"Chapter {i}"))

    # Set node statuses
    state.node_status = {
        "world_building": NodeStatus.COMPLETED,
        "character_design": NodeStatus.COMPLETED,
        "outline_planning": NodeStatus.COMPLETED,
        "human_approval_foundation": NodeStatus.COMPLETED,
    }

    return state


# ======================================================================
# Mock LLM responses
# ======================================================================

MOCK_CHAPTER_DRAFT = """The morning sun cast long shadows across the throne room as Aria knelt before the king. The marble floor was cold against her knees, but she kept her eyes fixed on the ancient sigils carved into the dais.

"Rise," the king commanded. His voice carried the weight of decades.

Aria obeyed, her hand instinctively resting on the pommel of her sword. Something was wrong. The king's advisors were absent, and the usual hum of court activity had fallen silent.

"You've served the crown faithfully for seven years," the king said. "Now I need you for something different."

He handed her a scroll, sealed with black wax — the color of secrets.

***

The road east stretched before Aria like a wound through the forest. She had left at dawn, her only company the rhythmic beat of her horse's hooves and the weight of the scroll tucked inside her jerkin.

The trees grew denser as the sun climbed. Too dense. By midday, the birds had stopped singing.

The first arrow whistled past her ear before she heard the bowstring snap.

***

"Who sent you?" Aria demanded, her blade pressed against the assassin's throat.

The man smiled, blood staining his teeth. "The same people who will send you back."

Before she could react, he bit down on something in his mouth. His body convulsed once, then went still.

Aria searched him and found nothing but a single coin — minted with the king's own seal."""

MOCK_CONSISTENCY_REPORT = {
    "overall_score": 8,
    "issues": [
        {
            "severity": "minor",
            "category": "timeline",
            "description": "Seven years of service mentioned, but Aria's backstory says orphan raised in the guard. Timeline needs clarification.",
            "location_hint": "Throne room scene, paragraph 1",
            "suggested_fix": "Add a line about when she was taken in.",
        },
        {
            "severity": "minor",
            "category": "ooc",
            "description": "Aria described as reckless but shows measured patience in throne room.",
            "location_hint": "Opening scene",
            "suggested_fix": "Add internal tension — she wants to speak out but holds back.",
        },
    ],
    "requires_rewrite": False,
    "character_arc_updates": {
        "Aria": "rising_action",
    },
    "summary": "Solid chapter with minor consistency issues. Ready for polish.",
}


MOCK_GLOBAL_REVIEW = {
    "overall_score": 8,
    "arc_review": {
        "Aria": {
            "arc_path": "Duty → Questioning → Independence — well-structured",
            "completeness": "complete",
            "issues": [],
        },
        "Kael": {
            "arc_path": "Vengeance → Understanding — satisfactory",
            "completeness": "complete",
            "issues": ["Motivations could be explored more deeply in chapter 2"],
        },
    },
    "foreshadowing_audit": {
        "unpaid": [],
        "orphaned_payoffs": [],
        "suggestions": ["The black wax seal could be referenced more in later chapters"],
    },
    "pacing_analysis": {
        "word_count_per_chapter": {"1": 2100, "2": 2500, "3": 2300},
        "sagging_sections": [],
        "rushed_sections": [],
        "recommendations": ["Good pacing overall"],
    },
    "thematic_assessment": "Loyalty theme is consistently explored.",
    "structural_issues": [],
    "final_recommendations": ["Strengthen Kael's POV in chapter 2"],
    "ready_for_publication": False,
}


# ======================================================================
# Tests
# ======================================================================


def test_state_serialization():
    """Test that state can be serialized and deserialized without data loss."""
    print("  Testing state serialization...", end=" ")
    state = make_sample_state()
    state.chapters[0].draft = MOCK_CHAPTER_DRAFT
    state.chapters[0].consistency_report = MOCK_CONSISTENCY_REPORT

    # Serialize
    json_str = state.to_json()
    assert len(json_str) > 1000, "JSON too short"

    # Save and reload from disk
    path = state.save()
    loaded = GraphNovelState.from_json(path)

    assert loaded.novel_title == state.novel_title
    assert loaded.world_setting.era == state.world_setting.era
    assert len(loaded.characters) == len(state.characters)
    assert loaded.characters[0].name == "Aria"
    assert loaded.characters[0].arc.current_stage == ArcStage.INCITING_INCIDENT
    assert loaded.chapters[0].draft == MOCK_CHAPTER_DRAFT
    assert loaded.chapters[0].consistency_report["overall_score"] == 8
    assert loaded.character_arc_tracker["Aria"].arc_description == state.character_arc_tracker["Aria"].arc_description

    print("✓ PASSED")


def test_graph_engine_routing():
    """Test that the engine routes through phases correctly."""
    print("  Testing graph engine routing...", end=" ")
    state = make_sample_state()
    engine = GraphNovelEngine(state)

    # Auto-approve everything
    engine.set_foundation_approval_callback(lambda s, **kw: (True, ""))
    engine.set_approval_callback(lambda s, c: (True, ""))

    # Phase 1: Foundation is already done in fixture
    # Simulate the post-foundation state
    assert engine._is_foundation_approved()

    # Check the state structure
    assert state.novel_title == "Test Novel"
    assert state.total_chapters == 3
    assert len(state.characters) == 2
    assert state.novel_outline is not None
    assert len(state.novel_outline.chapter_outlines) == 3
    assert state.world_setting is not None
    assert state.world_setting.era == "Medieval Fantasy"

    print("✓ PASSED")


def test_chapter_pipeline_with_mocks():
    """Test the full chapter pipeline with mocked LLM calls."""
    print("  Testing chapter pipeline (with mocks)...", end=" ")

    state = make_sample_state()
    engine = GraphNovelEngine(state)
    engine.set_approval_callback(lambda s, c: (True, ""))

    # Mock all LLM calls in the specific modules where they're called
    with mock.patch("graph_novel.nodes.chapter_planning.call_llm_sync") as mock_plan, \
         mock.patch("graph_novel.nodes.writing.call_llm_sync") as mock_write, \
         mock.patch("graph_novel.nodes.consistency_review.call_llm_sync") as mock_review, \
         mock.patch("graph_novel.nodes.style_polish.call_llm_sync") as mock_polish:
        mock_plan.return_value = json.dumps({"chapter_number": 1, "title": "Chapter 1"})
        mock_write.return_value = MOCK_CHAPTER_DRAFT + "\n\n---META---\n" + json.dumps({
            "foreshadowing_planted": [
                {"description": "Black seal on the scroll hints at conspiracy", "scene_context": "Throne room"},
            ],
            "foreshadowing_paid": [],
            "character_moments": {"Aria": "Called to secret mission — inciting incident"},
        })
        mock_review.return_value = json.dumps(MOCK_CONSISTENCY_REPORT)
        mock_polish.return_value = MOCK_CHAPTER_DRAFT

        # Run single chapter
        engine.run_single_chapter(1)

    # Assertions
    ch1 = state.chapters[0]
    assert ch1.draft == MOCK_CHAPTER_DRAFT
    assert ch1.word_count > 0
    assert ch1.consistency_report["overall_score"] == 8
    assert ch1.polished_draft == MOCK_CHAPTER_DRAFT
    assert ch1.approval == ApprovalStatus.APPROVED

    # Check foreshadowing tracker
    assert len(state.foreshadowing_tracker) == 1
    assert state.foreshadowing_tracker[0].description == "Black seal on the scroll hints at conspiracy"

    # Check arc tracker update
    assert state.character_arc_tracker["Aria"].current_stage == ArcStage.RISING_ACTION

    print("✓ PASSED")


def test_consistency_rewrite_loop():
    """Test that rewrite loop triggers when score is below threshold."""
    print("  Testing consistency rewrite loop...", end=" ")

    state = make_sample_state()
    engine = GraphNovelEngine(state)
    engine.set_approval_callback(lambda s, c: (True, ""))

    bad_review = {
        "overall_score": 3,
        "issues": [{"severity": "critical", "category": "ooc", "description": "Major OOC", "suggested_fix": ""}],
        "requires_rewrite": True,
        "character_arc_updates": {},
        "summary": "Bad",
    }

    good_review = {
        "overall_score": 7,
        "issues": [],
        "requires_rewrite": False,
        "character_arc_updates": {},
        "summary": "Good",
    }

    call_count = {"review": 0}

    def mock_review_fn(*args, **kwargs):
        call_count["review"] += 1
        if call_count["review"] == 1:
            return json.dumps(bad_review)
        return json.dumps(good_review)

    with mock.patch("graph_novel.nodes.chapter_planning.call_llm_sync") as mock_plan, \
         mock.patch("graph_novel.nodes.writing.call_llm_sync") as mock_write, \
         mock.patch("graph_novel.nodes.consistency_review.call_llm_sync") as mock_review, \
         mock.patch("graph_novel.nodes.style_polish.call_llm_sync") as mock_polish:
        mock_plan.return_value = json.dumps({"chapter_number": 1, "title": "Test"})
        mock_write.return_value = MOCK_CHAPTER_DRAFT
        mock_review.side_effect = mock_review_fn
        mock_polish.return_value = MOCK_CHAPTER_DRAFT

        engine.run_single_chapter(1)

    # Should have triggered rewrite: first review score=3 → rewrite → second review score=7
    assert call_count["review"] >= 2, f"Expected at least 2 review calls, got {call_count['review']}"

    print("✓ PASSED")


def test_global_review():
    """Test global review node with mocked LLM."""
    print("  Testing global review...", end=" ")

    state = make_sample_state()
    for ch in state.chapters:
        ch.draft = MOCK_CHAPTER_DRAFT
        ch.polished_draft = MOCK_CHAPTER_DRAFT
        ch.consistency_report = MOCK_CONSISTENCY_REPORT

    engine = GraphNovelEngine(state)

    with mock.patch("graph_novel.nodes.global_review.call_llm_sync") as mock_gr:
        mock_gr.return_value = json.dumps(MOCK_GLOBAL_REVIEW)
        engine.run_global_review_only()

    assert state.global_review_report is not None
    assert state.global_review_report["overall_score"] == 8
    assert "Aria" in state.global_review_report["arc_review"]
    assert state.node_status["global_review"] == NodeStatus.COMPLETED

    # Test save
    state_path = state.save()
    assert state_path.exists()
    reloaded = GraphNovelState.from_json(state_path)
    assert reloaded.global_review_report["overall_score"] == 8

    print("✓ PASSED")


def test_foreshadowing_tracker():
    """Test foreshadowing tracking across chapters."""
    print("  Testing foreshadowing tracking...", end=" ")

    state = make_sample_state()
    tracker = state.foreshadowing_tracker

    # Plant some
    tracker.append(Foreshadowing(id="fs_001", description="Strange mark on arm", planted_in_chapter=1, status="planted"))
    tracker.append(Foreshadowing(id="fs_002", description="Whispers in the library", planted_in_chapter=2, status="planted"))
    tracker.append(Foreshadowing(id="fs_003", description="Broken sword prophecy", planted_in_chapter=1, status="planted"))

    # Pay one off
    tracker[0].status = "paid_off"
    tracker[0].payoff_chapter = 3
    tracker[0].payoff_description = "The mark glowed when the enemy approached"

    assert len(tracker) == 3
    planted = [fs for fs in tracker if fs.status == "planted"]
    paid = [fs for fs in tracker if fs.status == "paid_off"]
    assert len(planted) == 2
    assert len(paid) == 1
    assert paid[0].payoff_chapter == 3

    print("✓ PASSED")


def test_web_app_config():
    """Test that the Flask app can be created."""
    print("  Testing web app creation...", end=" ")

    from graph_novel.web.app import app as flask_app

    assert flask_app is not None
    assert flask_app.secret_key is not None

    # Test basic routes
    with flask_app.test_client() as client:
        resp = client.get("/")
        assert resp.status_code == 200, f"Got {resp.status_code}"

        resp = client.get("/create")
        assert resp.status_code == 200

    print("✓ PASSED")


def test_web_api_state():
    """Test the state API endpoint."""
    print("  Testing web state API...", end=" ")

    from graph_novel.web.app import app as flask_app, _states

    state = make_sample_state()
    _states["test_novel"] = state

    with flask_app.test_client() as client:
        resp = client.get("/api/test_novel/state")
        assert resp.status_code == 200
        data = json.loads(resp.data)
        assert data["title"] == "Test Novel"
        assert data["total_chapters"] == 3
        assert len(data["chapters"]) == 3

    print("✓ PASSED")


def test_data_models():
    """Test that data models work correctly."""
    print("  Testing data models...", end=" ")

    # WorldSetting
    ws = WorldSetting(
        era="Modern",
        location="New York",
        magic_system=None,
        technology_level="Current day",
    )
    assert ws.era == "Modern"
    assert ws.magic_system is None

    # Character
    char = Character(
        name="Test",
        role="protagonist",
        background="Test background",
        personality="Brave",
        motivation="Save the world",
        arc=CharacterArc(
            character_name="Test",
            arc_description="Growth arc",
            current_stage=ArcStage.MIDPOINT,
        ),
        relationships={"Villain": "Enemy"},
    )
    assert char.name == "Test"
    assert char.arc.current_stage == ArcStage.MIDPOINT
    assert char.relationships["Villain"] == "Enemy"

    # Foreshadowing
    fs = Foreshadowing(id="fs_001", description="Hint", planted_in_chapter=1)
    assert fs.status == "planted"

    # ChapterOutline
    co = ChapterOutline(
        chapter_number=1,
        title="Beginning",
        summary="It starts.",
        key_events=["Event 1", "Event 2"],
        foreshadowing_to_plant=["Hint about betrayal"],
    )
    assert len(co.key_events) == 2

    # Chapter
    ch = Chapter(chapter_number=1, title="Beginning")
    assert ch.approval == ApprovalStatus.PENDING
    assert ch.word_count == 0

    # NovelOutline
    no = NovelOutline(
        genre="Sci-Fi",
        premise="What if...",
        theme="Identity",
        target_length="100k words",
    )
    assert no.genre == "Sci-Fi"

    print("✓ PASSED")


# ======================================================================
# Main
# ======================================================================

def run_all_tests():
    print("\n GraphNovel Integration Tests\n")
    print("=" * 55)

    tests = [
        test_data_models,
        test_state_serialization,
        test_graph_engine_routing,
        test_chapter_pipeline_with_mocks,
        test_consistency_rewrite_loop,
        test_global_review,
        test_foreshadowing_tracker,
        test_web_app_config,
        test_web_api_state,
    ]

    passed = 0
    failed = 0

    for test in tests:
        try:
            test()
            passed += 1
        except Exception as e:
            print(f"  ✗ FAILED: {e}")
            failed += 1
            import traceback
            traceback.print_exc()

    print("=" * 55)
    print(f"Results: {passed} passed, {failed} failed")
    print("=" * 55)

    return failed == 0


if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)
