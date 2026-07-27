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
import time
from pathlib import Path
from unittest import mock

TEST_PROJECTS_DIR = Path(tempfile.mkdtemp(prefix="graph_novel_web_tests_"))
os.environ["GRAPH_NOVEL_DIR"] = str(TEST_PROJECTS_DIR)

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
    assert loaded.node_status["world_building"] == NodeStatus.COMPLETED

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
    writing_prompts = [call.args[1] for call in mock_write.call_args_list]
    assert "Major OOC" in writing_prompts[1]
    assert len(state.chapters[0].revision_history) == 1

    print("✓ PASSED")


def test_global_review():
    """Test global review node with mocked LLM."""
    print("  Testing global review...", end=" ")

    state = make_sample_state()
    for ch in state.chapters:
        ch.draft = MOCK_CHAPTER_DRAFT
        ch.polished_draft = MOCK_CHAPTER_DRAFT
        ch.consistency_report = MOCK_CONSISTENCY_REPORT
        ch.approval = ApprovalStatus.APPROVED

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


def test_global_review_guards_and_failure():
    """Global review requires approved chapters and exposes node failure."""
    print("  Testing global review guards + failure...", end=" ")
    from graph_novel.engine import GraphExecutionError
    from graph_novel.web.app import app as flask_app, _engines, _states

    state = make_sample_state()
    engine = GraphNovelEngine(state)
    with mock.patch("graph_novel.nodes.global_review.call_llm_sync") as llm_call:
        try:
            engine.run_global_review_only()
            raise AssertionError("Expected unapproved chapters to block review")
        except GraphExecutionError as exc:
            assert exc.code == "invalid_transition"
            assert exc.node_key == "global_review"
    llm_call.assert_not_called()

    project_id = "global_review_failure"
    state.project_id = project_id
    state.save_dir = TEST_PROJECTS_DIR / project_id
    state.foundation_approval = ApprovalStatus.APPROVED
    for chapter in state.chapters:
        chapter.approval = ApprovalStatus.APPROVED
    state.save()
    _states[project_id] = state
    _engines[project_id] = engine

    with flask_app.test_client() as client, \
         mock.patch(
             "graph_novel.nodes.global_review.call_llm_sync",
             return_value="not-json",
         ):
        response = client.post(f"/api/{project_id}/run-global-review")
        payload = response.get_json()

    assert response.status_code == 422
    assert payload["success"] is False
    assert payload["status"] == "failed"
    assert payload["node"] == "global_review"
    assert state.workflow_phase == "failed"
    assert state.node_status["global_review"] == NodeStatus.FAILED
    assert state.last_error["node"] == "global_review"
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


def _foundation_llm_mocks(chapter_count=2):
    """Return deterministic LLM payloads for the three Foundation nodes."""
    world = json.dumps({
        "era": "现代都市",
        "location": "东海市",
        "special_setting": "信息差可以兑换现实资源",
        "technology_level": "现代",
        "social_structure": "现代商业社会",
        "key_locations": [],
        "rules_and_laws": "兑换必须付出行动成本",
        "history": "主角刚刚重生",
        "golden_finger": "信息差兑换系统",
        "notes": "",
    }, ensure_ascii=False)
    characters = json.dumps([{
        "name": "林凡",
        "role": "主角",
        "background": "重生前创业失败。",
        "personality": "冷静、果断",
        "motivation": "弥补遗憾并建立商业帝国",
        "golden_finger": "信息差兑换系统",
        "arc_stage": "inciting_incident",
        "arc_description": "从失败者成长为负责任的领导者。",
        "relationships": {},
        "first_appearance_hook": "当众指出所有人都不知道的商机",
        "notes": "",
    }], ensure_ascii=False)
    outlines = []
    for number in range(1, chapter_count + 1):
        outlines.append({
            "chapter_number": number,
            "title": f"第{number}章 测试标题",
            "summary": "推进主线",
            "pov_character": "林凡",
            "key_events": ["冲突发生"],
            "foreshadowing_to_plant": [],
            "foreshadowing_to_pay_off": [],
            "shuangdian_beat": "铺垫",
            "chapter_hook_idea": "新的危机出现",
        })
    outline = json.dumps({
        "genre": "都市脑洞",
        "premise": "重生后靠信息差逆袭",
        "theme": "逆袭与责任",
        "target_length": "10万字",
        "suggested_chapter_count": chapter_count,
        "shuangdian_map": [],
        "chapter_outlines": outlines,
    }, ensure_ascii=False)
    return world, characters, outline


def test_foundation_gate_and_feedback_edge():
    """Foundation generation must stop at a persisted gate and resume by decision."""
    print("  Testing Foundation gate + feedback edge...", end=" ")
    from graph_novel.engine import GraphExecutionError

    state = GraphNovelState(
        project_id="foundation_gate",
        novel_title="重生测试",
        save_dir=Path(tempfile.mkdtemp()),
        creative_genre="都市脑洞",
        creative_premise="重生后靠信息差逆袭",
        creative_theme="逆袭与责任",
        target_total_words=100000,
        target_total_chapters=2,
        total_chapters=2,
    )
    engine = GraphNovelEngine(state)
    engine.set_foundation_approval_callback(
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("generation must not wait for approval")
        )
    )
    world, characters, outline = _foundation_llm_mocks(chapter_count=2)

    with mock.patch("graph_novel.nodes.world_building.call_llm_sync", return_value=world), \
         mock.patch("graph_novel.nodes.character_design.call_llm_sync", return_value=characters), \
         mock.patch("graph_novel.nodes.outline_planning.call_llm_sync", return_value=outline) as outline_call:
        result = engine.run_foundation_generation()

        assert result.pending_gate == "foundation"
        assert result.foundation_approval == ApprovalStatus.PENDING
        assert result.workflow_phase == "foundation"
        assert result.node_status["human_approval_foundation"] == NodeStatus.IN_PROGRESS
        assert result.save().exists()

        engine.apply_foundation_decision(False, "反派需要更强，主角不要圣母")
        assert state.foundation_approval == ApprovalStatus.REJECTED
        assert state.foundation_feedback == "反派需要更强，主角不要圣母"
        assert state.pending_gate is None

        engine.run_foundation_generation()
        rerun_prompt = outline_call.call_args.args[1]
        assert "反派需要更强" in rerun_prompt
        assert state.pending_gate == "foundation"

        engine.apply_foundation_decision(True, "")
        assert state.foundation_approval == ApprovalStatus.APPROVED
        assert state.workflow_phase == "chapter_loop"
        assert state.pending_gate is None
        assert len(state.chapters) == 2

    try:
        engine.apply_foundation_decision(True, "")
        raise AssertionError("Expected invalid gate transition to fail")
    except GraphExecutionError:
        pass

    print("✓ PASSED")


def test_foundation_failure_stops_graph():
    """A failed Foundation node must stop downstream routing."""
    print("  Testing Foundation failure routing...", end=" ")
    from graph_novel.engine import GraphExecutionError

    state = GraphNovelState(
        project_id="foundation_failure",
        novel_title="失败测试",
        save_dir=Path(tempfile.mkdtemp()),
        target_total_chapters=2,
        total_chapters=2,
    )
    engine = GraphNovelEngine(state)

    with mock.patch(
            "graph_novel.nodes.world_building.run_node",
            side_effect=RuntimeError("unexpected node crash"),
         ), \
         mock.patch("graph_novel.nodes.character_design.run_node") as character_node:
        try:
            engine.run_foundation_generation()
            raise AssertionError("Expected GraphExecutionError")
        except GraphExecutionError as exc:
            assert exc.node_key == "world_building"

    character_node.assert_not_called()
    assert state.workflow_phase == "failed"
    assert state.pending_gate is None
    assert state.last_error["node"] == "world_building"
    print("✓ PASSED")


def test_project_inputs_and_legacy_state_migration():
    """Creation inputs persist and version-1 State files gain safe defaults."""
    print("  Testing project inputs + legacy migration...", end=" ")
    from graph_novel.web.app import (
        app as flask_app, _engines, _load_or_get_state, _states,
    )

    project_id = "input_persistence_test"
    with flask_app.test_client() as client:
        response = client.post("/create", data={
            "title": "Input Persistence Test",
            "genre": "悬疑无限流",
            "genre_tags": "规则怪谈, 推理",
            "premise": "每破解一条规则，现实就会改写一次",
            "theme": "真相与代价",
            "target_chapters": "12",
            "target_words": "120000",
            "notes": "主角必须依靠推理，而不是无脑碾压。",
        })
    assert response.status_code == 302
    created = _states[project_id]
    assert created.project_id == project_id
    assert created.creative_genre == "悬疑无限流"
    assert created.creative_premise == "每破解一条规则，现实就会改写一次"
    assert created.creative_theme == "真相与代价"
    assert created.target_total_chapters == 12
    assert created.target_total_words == 120000
    state_path = TEST_PROJECTS_DIR / project_id / f"{project_id}_state.json"
    assert state_path.exists()

    _states.pop(project_id)
    _engines.pop(project_id, None)
    reloaded_project = _load_or_get_state(project_id)
    assert reloaded_project is not None
    assert reloaded_project.creative_premise == created.creative_premise

    legacy = make_sample_state()
    legacy_data = legacy.to_dict()
    for key in (
        "project_id", "creative_genre", "creative_premise", "creative_theme",
        "target_total_chapters", "workflow_phase", "pending_gate",
        "foundation_approval", "foundation_feedback", "last_error",
    ):
        legacy_data.pop(key, None)
    legacy_data["version"] = 1
    legacy_path = Path(tempfile.mkdtemp()) / "legacy_state.json"
    legacy_path.write_text(json.dumps(legacy_data, ensure_ascii=False), encoding="utf-8")

    loaded = GraphNovelState.from_json(legacy_path)
    assert loaded.version == 3
    assert loaded.target_total_chapters == loaded.total_chapters
    assert loaded.foundation_approval == ApprovalStatus.APPROVED
    assert loaded.workflow_phase == "chapter_loop"

    version_two = make_sample_state()
    version_two.version = 2
    version_two.foundation_approval = ApprovalStatus.APPROVED
    version_two.chapters[0].approval = ApprovalStatus.APPROVED
    version_two.node_status["human_approval_2"] = NodeStatus.IN_PROGRESS
    version_two_path = Path(tempfile.mkdtemp()) / "version_two_state.json"
    version_two_path.write_text(
        version_two.to_json(),
        encoding="utf-8",
    )

    migrated = GraphNovelState.from_json(version_two_path)
    assert migrated.version == 3
    assert migrated.chapters[0].side_effects_committed
    assert migrated.pending_gate == "chapter:2"
    print("✓ PASSED")


def test_foundation_web_api_contract():
    """Web API returns an approval gate or a truthful node failure."""
    print("  Testing Foundation Web API contract...", end=" ")
    from graph_novel.web.app import (
        app as flask_app, _engines, _list_projects, _states,
    )

    project_id = "foundation_web_api"
    state = GraphNovelState(
        project_id=project_id,
        novel_title="Web Foundation",
        save_dir=TEST_PROJECTS_DIR / project_id,
        target_total_chapters=2,
        total_chapters=2,
    )
    _states[project_id] = state
    _engines.pop(project_id, None)
    world, characters, outline = _foundation_llm_mocks(chapter_count=2)

    with flask_app.test_client() as client, \
         mock.patch("graph_novel.nodes.world_building.call_llm_sync", return_value=world), \
         mock.patch("graph_novel.nodes.character_design.call_llm_sync", return_value=characters), \
         mock.patch("graph_novel.nodes.outline_planning.call_llm_sync", return_value=outline):
        response = client.post(f"/api/{project_id}/run-foundation")
        payload = response.get_json()
        assert response.status_code == 200
        assert payload["success"] is True
        assert payload["status"] == "awaiting_approval"

        response = client.post(
            f"/api/{project_id}/approve-foundation",
            json={"approved": False, "feedback": ""},
        )
        assert response.status_code == 400

        response = client.post(
            f"/api/{project_id}/approve-foundation",
            json={"approved": False, "feedback": "加强规则压迫感"},
        )
        payload = response.get_json()
        assert response.status_code == 200
        assert payload["next_action"] == "regenerate_foundation"
        assert state.foundation_feedback == "加强规则压迫感"

        page = client.get(f"/project/{project_id}/foundation")
        assert page.status_code == 200
        assert "加强规则压迫感" in page.get_data(as_text=True)

        response = client.post(f"/api/{project_id}/run-foundation")
        assert response.status_code == 200
        response = client.post(
            f"/api/{project_id}/approve-foundation",
            json={"approved": True, "feedback": ""},
        )
        payload = response.get_json()
        assert response.status_code == 200
        assert payload["next_action"] == "chapters"
        assert state.foundation_approval == ApprovalStatus.APPROVED
        assert len(state.chapters) == 2
        project_summary = next(
            project for project in _list_projects()
            if project["id"] == project_id
        )
        assert project_summary["chapters"] == 0

    failure_id = "foundation_web_failure"
    failed_state = GraphNovelState(
        project_id=failure_id,
        novel_title="Web Failure",
        save_dir=TEST_PROJECTS_DIR / failure_id,
        target_total_chapters=2,
        total_chapters=2,
    )
    _states[failure_id] = failed_state
    _engines.pop(failure_id, None)
    with flask_app.test_client() as client, \
         mock.patch("graph_novel.nodes.world_building.call_llm_sync", return_value="not-json"):
        response = client.post(f"/api/{failure_id}/run-foundation")
        payload = response.get_json()
        assert response.status_code == 422
        assert payload["success"] is False
        assert payload["status"] == "failed"
        assert payload["node"] == "world_building"

    print("✓ PASSED")


def _chapter_pipeline_mocks():
    """Return deterministic chapter generation payloads."""
    plan = json.dumps({
        "chapter_number": 1,
        "title": "黑蜡封印",
        "scene_plan": [],
        "pov_character": "Aria",
        "opening_hook": "刺客闯入",
        "closing_hook": "黑蜡封印裂开",
        "dialogue_highlights": [],
        "shuangdian_beat": "小爽点",
        "continuity_notes": {},
        "ai_taboos_check": [],
    })
    write = MOCK_CHAPTER_DRAFT + "\n\n---META---\n" + json.dumps({
        "chapter_hook": "黑蜡封印突然裂开",
        "shuangdian_beat": "小爽点",
        "foreshadowing_planted": [{
            "description": "黑蜡封印隐藏王室秘密",
            "scene_context": "王座厅",
        }],
        "foreshadowing_paid": [],
        "character_moments": {
            "Aria": "第一次公开质疑国王",
        },
    })
    review = dict(MOCK_CONSISTENCY_REPORT)
    review["character_arc_updates"] = {"Aria": "rising_action"}
    return plan, write, json.dumps(review), MOCK_CHAPTER_DRAFT


def test_chapter_gate_feedback_and_side_effect_commit():
    """Chapter generation pauses at Gate; only approval commits global effects."""
    print("  Testing Chapter gate + delayed side effects...", end=" ")
    from graph_novel.engine import GraphExecutionError

    state = make_sample_state()
    state.project_id = "chapter_gate"
    state.foundation_approval = ApprovalStatus.APPROVED
    state.workflow_phase = "chapter_loop"
    engine = GraphNovelEngine(state)
    engine.set_approval_callback(
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("generation must not wait for chapter approval")
        )
    )
    plan, write, review, polish = _chapter_pipeline_mocks()

    with mock.patch("graph_novel.nodes.chapter_planning.call_llm_sync", return_value=plan) as plan_call, \
         mock.patch("graph_novel.nodes.writing.call_llm_sync", return_value=write) as write_call, \
         mock.patch("graph_novel.nodes.consistency_review.call_llm_sync", return_value=review), \
         mock.patch("graph_novel.nodes.style_polish.call_llm_sync", return_value=polish):
        engine.run_chapter_generation(1)
        chapter = state.chapters[0]

        assert state.pending_gate == "chapter:1"
        assert chapter.approval == ApprovalStatus.PENDING
        assert chapter.generation_meta["chapter_hook"] == "黑蜡封印突然裂开"
        assert not state.foreshadowing_tracker
        assert state.character_arc_tracker["Aria"].current_stage == ArcStage.INCITING_INCIDENT
        assert not chapter.side_effects_committed

        engine.apply_chapter_decision(1, False, "主角反击不够果断")
        assert chapter.approval == ApprovalStatus.REJECTED
        assert chapter.human_feedback == "主角反击不够果断"
        assert not state.foreshadowing_tracker

        engine.run_chapter_generation(1)
        assert "主角反击不够果断" in plan_call.call_args.args[1]
        assert "主角反击不够果断" in write_call.call_args.args[1]
        assert len(chapter.revision_history) == 1

        engine.apply_chapter_decision(1, True, "")
        assert chapter.approval == ApprovalStatus.APPROVED
        assert chapter.side_effects_committed
        assert len(state.foreshadowing_tracker) == 1
        assert state.foreshadowing_tracker[0].id == "fs_ch01_01"
        assert state.character_arc_tracker["Aria"].current_stage == ArcStage.RISING_ACTION
        assert state.character_arc_tracker["Aria"].per_chapter_status["1"] == "第一次公开质疑国王"
        assert state.chapter_hooks[0] == "黑蜡封印突然裂开"

    try:
        engine.apply_chapter_decision(1, True, "")
        raise AssertionError("Expected duplicate chapter decision to fail")
    except GraphExecutionError:
        pass

    print("✓ PASSED")


def test_chapter_failure_stops_before_gate():
    """A failed chapter node persists FAILED state and never opens the Gate."""
    print("  Testing Chapter failure routing...", end=" ")
    from graph_novel.engine import GraphExecutionError

    state = make_sample_state()
    state.foundation_approval = ApprovalStatus.APPROVED
    state.workflow_phase = "chapter_loop"
    engine = GraphNovelEngine(state)
    plan, write, review, _ = _chapter_pipeline_mocks()

    with mock.patch("graph_novel.nodes.chapter_planning.call_llm_sync", return_value=plan), \
         mock.patch("graph_novel.nodes.writing.call_llm_sync", return_value=write), \
         mock.patch("graph_novel.nodes.consistency_review.call_llm_sync", return_value=review), \
         mock.patch("graph_novel.nodes.style_polish.call_llm_sync", return_value=""):
        try:
            engine.run_chapter_generation(1)
            raise AssertionError("Expected style polish failure")
        except GraphExecutionError as exc:
            assert exc.node_key == "style_polish_1"

    assert state.workflow_phase == "failed"
    assert state.pending_gate is None
    assert state.node_status["style_polish_1"] == NodeStatus.FAILED
    assert state.last_error["node"] == "style_polish_1"
    assert state.chapters[0].approval == ApprovalStatus.PENDING
    assert not state.chapters[0].side_effects_committed
    print("✓ PASSED")


def test_chapter_web_api_contract():
    """Chapter Web API exposes a persisted Gate and truthful decision edge."""
    print("  Testing Chapter Web API contract...", end=" ")
    from graph_novel.web.app import app as flask_app, _engines, _states

    project_id = "chapter_web_api"
    state = make_sample_state()
    state.project_id = project_id
    state.save_dir = TEST_PROJECTS_DIR / project_id
    state.foundation_approval = ApprovalStatus.APPROVED
    state.workflow_phase = "chapter_loop"
    state.save()
    _states[project_id] = state
    _engines.pop(project_id, None)
    plan, write, review, polish = _chapter_pipeline_mocks()

    with flask_app.test_client() as client, \
         mock.patch("graph_novel.nodes.chapter_planning.call_llm_sync", return_value=plan), \
         mock.patch("graph_novel.nodes.writing.call_llm_sync", return_value=write), \
         mock.patch("graph_novel.nodes.consistency_review.call_llm_sync", return_value=review), \
         mock.patch("graph_novel.nodes.style_polish.call_llm_sync", return_value=polish):
        response = client.post(f"/api/{project_id}/run-chapter/1")
        payload = response.get_json()
        assert response.status_code == 200
        assert payload["success"] is True
        assert payload["status"] == "awaiting_approval"

        response = client.post(
            f"/api/{project_id}/approve-chapter/1",
            json={"approved": False, "feedback": ""},
        )
        assert response.status_code == 400

        response = client.post(
            f"/api/{project_id}/approve-chapter/1",
            json={"approved": False, "feedback": "增强章末反转"},
        )
        payload = response.get_json()
        assert response.status_code == 200
        assert payload["next_action"] == "rewrite_chapter"

        response = client.post(f"/api/{project_id}/run-chapter/1")
        assert response.status_code == 200
        response = client.post(
            f"/api/{project_id}/approve-chapter/1",
            json={"approved": True, "feedback": ""},
        )
        payload = response.get_json()
        assert response.status_code == 200
        assert payload["status"] == "approved"
        assert state.chapters[0].side_effects_committed

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
        test_global_review_guards_and_failure,
        test_foreshadowing_tracker,
        test_web_app_config,
        test_web_api_state,
        test_project_inputs_and_legacy_state_migration,
        test_foundation_gate_and_feedback_edge,
        test_foundation_failure_stops_graph,
        test_foundation_web_api_contract,
        test_chapter_gate_feedback_and_side_effect_commit,
        test_chapter_failure_stops_before_gate,
        test_chapter_web_api_contract,
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
