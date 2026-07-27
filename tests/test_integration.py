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

TEST_PROJECTS_DIR = Path(tempfile.mkdtemp(prefix="graph_novel_web_tests_"))
os.environ["GRAPH_NOVEL_DIR"] = str(TEST_PROJECTS_DIR)

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from graph_novel.state import (
    GraphNovelState, NodeStatus, ApprovalStatus, ArcStage,
    WorldSetting, Character, CharacterArc, NovelOutline,
    ChapterOutline, Chapter, Foreshadowing, NarrativeFact,
    KnowledgeRecord,
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


def wait_for_task_status(client, project_id, expected, timeout=3.0):
    """Poll the Web task endpoint until it reaches one expected status."""
    expected_statuses = {expected} if isinstance(expected, str) else set(expected)
    deadline = time.monotonic() + timeout
    last_payload = {}
    while time.monotonic() < deadline:
        response = client.get(f"/api/{project_id}/task-status")
        assert response.status_code == 200
        last_payload = response.get_json()
        if last_payload["status"] in expected_statuses:
            return last_payload
        time.sleep(0.01)
    raise AssertionError(
        f"Task did not reach {sorted(expected_statuses)}: {last_payload}"
    )


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
    "hook_quality": "强钩子",
    "hook_review": "黑蜡封印有效制造悬念。",
    "shuangdian_delivery": "到位",
    "ai_disease_count": 0,
    "dialogue_ratio_estimate": "60%",
    "requires_rewrite": False,
    "logic_gate_passed": True,
    "narrative_audit": {
        "causality": "关键事件均有前置原因。",
        "knowledge_provenance": "角色新增认知均有目击或转述来源。",
        "continuity": "时间、位置、伤势和资源连续。",
    },
    "narrative_violations": [],
    "character_arc_updates": {
        "Aria": "rising_action",
    },
    "summary": "Solid chapter with minor consistency issues. Ready for polish.",
}


MOCK_GLOBAL_REVIEW = {
    "overall_score": 8,
    "golden_three_analysis": {
        "ch1_quality": "strong",
        "ch2_quality": "solid",
        "ch3_quality": "strong",
        "estimated_ch3_retention": "55%",
    },
    "shuangdian_analysis": {
        "density": "适中",
        "small_beats_count": 1,
        "big_beats_count": 1,
        "issues": [],
    },
    "hook_analysis": {
        "strong": 2,
        "weak": 1,
        "missing": 0,
        "problem_chapters": [],
    },
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
    "ai_disease_summary": {
        "total_found": 0,
        "high_risk_chapters": [],
        "overall_risk": "低",
    },
    "algorithm_fitness": {
        "estimated_ch10_retention": "50%",
        "estimated_10w_retention": "35%",
        "estimated_follow_rate": "15%",
        "shouxiu_ready": True,
    },
    "platform_competitiveness": {
        "strength": "Strong opening",
        "weakness": "Kael needs more depth",
        "differentiation": "The black wax conspiracy",
    },
    "structural_issues": [],
    "final_recommendations": ["Strengthen Kael's POV in chapter 2"],
    "ready_for_platform": False,
}


def mock_chapter_plan(title="Test", chapter_number=1):
    return json.dumps({
        "chapter_number": chapter_number,
        "title": title,
        "scene_plan": [{
            "scene_number": 1,
            "setting": "王座厅",
            "characters_present": ["Aria"],
            "action": "Aria 接受秘密任务",
            "emotional_beat": "警惕",
            "dialogue_focus": "任务的风险",
            "word_count_target": 2200,
        }],
        "pov_character": "Aria",
        "opening_hook": "刺客闯入",
        "closing_hook": "黑蜡封印裂开",
        "dialogue_highlights": [],
        "shuangdian_beat": "铺垫",
        "causal_chain": [{
            "cause": "国王需要调查秘密事件",
            "event": "Aria 接受密令",
            "effect": "Aria 离开王都调查",
        }],
        "required_fact_ids": [],
        "planned_facts": [],
        "information_flow": [],
        "continuity_notes": {
            "time": "清晨",
            "character_locations": {"Aria": "王座厅"},
            "character_conditions": {"Aria": "健康"},
            "resources": {"Aria": ["密封卷轴"]},
            "previous_chapter_end": "无",
        },
        "ai_taboos_check": [],
    })


def mock_chapter_response(prose=MOCK_CHAPTER_DRAFT):
    return prose + "\n\n---META---\n" + json.dumps({
        "chapter_hook": "黑蜡封印突然裂开",
        "shuangdian_beat": "铺垫",
        "foreshadowing_planted": [],
        "foreshadowing_paid": [],
        "character_moments": {},
        "chapter_summary": "Aria 接受密令并踏上调查之路。",
        "facts_established": [],
        "knowledge_changes": [],
        "continuity_changes": {
            "time": "清晨",
            "character_locations": {"Aria": "王城外"},
            "character_conditions": {"Aria": "健康"},
            "resources": {"Aria": ["密封卷轴"]},
        },
    })


# ======================================================================
# Tests
# ======================================================================


def test_state_serialization():
    """Test that state can be serialized and deserialized without data loss."""
    print("  Testing state serialization...", end=" ")
    state = make_sample_state()
    state.chapters[0].draft = MOCK_CHAPTER_DRAFT
    state.chapters[0].consistency_report = MOCK_CONSISTENCY_REPORT
    state.narrative_facts.append(NarrativeFact(
        id="fact.sealed_scroll",
        statement="黑蜡卷轴由国王亲手交给 Aria",
        category="线索",
        established_in_chapter=1,
    ))
    state.character_knowledge.append(KnowledgeRecord(
        fact_id="fact.sealed_scroll",
        character="Aria",
        knowledge_level="confirmed",
        learned_in_chapter=1,
        source_type="observed",
        evidence="Aria 亲手接过卷轴",
    ))
    state.continuity_state = {
        "time": "中午",
        "character_locations": {"Aria": "王城东部森林"},
    }

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
    assert loaded.narrative_facts[0].id == "fact.sealed_scroll"
    assert loaded.character_knowledge[0].source_type == "observed"
    assert loaded.continuity_state["character_locations"]["Aria"] == "王城东部森林"

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
        mock_plan.return_value = mock_chapter_plan("Chapter 1")
        mock_write.return_value = MOCK_CHAPTER_DRAFT + "\n\n---META---\n" + json.dumps({
            "chapter_hook": "黑蜡封印突然裂开",
            "shuangdian_beat": "铺垫",
            "foreshadowing_planted": [
                {"description": "Black seal on the scroll hints at conspiracy", "scene_context": "Throne room"},
            ],
            "foreshadowing_paid": [],
            "character_moments": {"Aria": "Called to secret mission — inciting incident"},
            "chapter_summary": "Aria 接受秘密任务，并在途中遭遇刺客。",
            "facts_established": [],
            "knowledge_changes": [],
            "continuity_changes": {
                "time": "中午",
                "character_locations": {"Aria": "王城东部森林"},
                "character_conditions": {"Aria": "健康"},
                "resources": {"Aria": ["密封卷轴"]},
            },
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
        "issues": [{
            "severity": "critical",
            "category": "ooc",
            "description": "Major OOC",
            "location_hint": "Opening scene",
            "suggested_fix": "",
        }],
        "hook_quality": "弱钩子",
        "hook_review": "悬念不足",
        "shuangdian_delivery": "未兑现",
        "ai_disease_count": 1,
        "dialogue_ratio_estimate": "40%",
        "requires_rewrite": True,
        "logic_gate_passed": True,
        "narrative_audit": {
            "causality": "已核对。",
            "knowledge_provenance": "已核对。",
            "continuity": "已核对。",
        },
        "narrative_violations": [],
        "character_arc_updates": {},
        "summary": "Bad",
    }

    good_review = {
        "overall_score": 7,
        "issues": [],
        "hook_quality": "强钩子",
        "hook_review": "悬念有效",
        "shuangdian_delivery": "到位",
        "ai_disease_count": 0,
        "dialogue_ratio_estimate": "60%",
        "requires_rewrite": False,
        "logic_gate_passed": True,
        "narrative_audit": {
            "causality": "已核对。",
            "knowledge_provenance": "已核对。",
            "continuity": "已核对。",
        },
        "narrative_violations": [],
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
        mock_plan.return_value = mock_chapter_plan()
        mock_write.return_value = mock_chapter_response()
        mock_review.side_effect = mock_review_fn
        mock_polish.return_value = MOCK_CHAPTER_DRAFT

        engine.run_single_chapter(1)

    # Should have triggered rewrite: first review score=3 → rewrite → second review score=7
    assert call_count["review"] >= 2, f"Expected at least 2 review calls, got {call_count['review']}"
    writing_prompts = [call.args[1] for call in mock_write.call_args_list]
    assert "Major OOC" in writing_prompts[1]
    assert len(state.chapters[0].revision_history) == 1

    print("✓ PASSED")


def test_chapter_plan_is_persisted_and_consumed():
    """Writing consumes the causal plan produced by chapter planning."""
    print("  Testing persisted causal chapter plan...", end=" ")
    from graph_novel.nodes import chapter_planning, writing

    state = make_sample_state()
    state.current_chapter = 1
    plan = json.loads(mock_chapter_plan("密室中的第二把钥匙"))
    plan["causal_chain"] = [{
        "cause": "档案柜的封条此前已被人替换",
        "event": "调查员比对封条编号",
        "effect": "确认内鬼接触过档案柜",
    }]

    with mock.patch(
        "graph_novel.nodes.chapter_planning.call_llm_sync",
        return_value=json.dumps(plan, ensure_ascii=False),
    ):
        chapter_planning.run_node(state)

    chapter = state.chapters[0]
    assert chapter.plan["causal_chain"][0]["cause"] == "档案柜的封条此前已被人替换"

    with mock.patch(
        "graph_novel.nodes.writing.call_llm_sync",
        return_value=mock_chapter_response(),
    ) as write_call:
        writing.run_node(state)

    writing_prompt = write_call.call_args.args[1]
    assert "调查员比对封条编号" in writing_prompt
    assert "确认内鬼接触过档案柜" in writing_prompt
    print("✓ PASSED")


def test_information_transfer_requires_a_valid_source():
    """A character cannot relay a fact they do not know."""
    print("  Testing information provenance guard...", end=" ")
    from graph_novel.narrative import validate_chapter_plan
    from graph_novel.output_contracts import OutputContractError

    state = make_sample_state()
    state.narrative_facts.append(NarrativeFact(
        id="fact.archive.code",
        statement="封存档案的开启码是 4317",
        category="秘密",
        established_in_chapter=1,
    ))
    state.character_knowledge.append(KnowledgeRecord(
        fact_id="fact.archive.code",
        character="Aria",
        knowledge_level="confirmed",
        learned_in_chapter=1,
        source_type="observed",
        evidence="Aria 亲眼看见开启码",
    ))
    plan = json.loads(mock_chapter_plan(chapter_number=2))
    plan["information_flow"] = [{
        "fact_id": "fact.archive.code",
        "character": "守卫",
        "knowledge_level": "confirmed",
        "source_type": "told",
        "source_character": "Kael",
        "evidence": "Kael 告诉守卫开启码",
    }]

    try:
        validate_chapter_plan(state, plan)
        raise AssertionError("Expected unsupported information source to fail")
    except OutputContractError as exc:
        assert "Kael 尚不知道" in str(exc)

    state.character_knowledge.append(KnowledgeRecord(
        fact_id="fact.archive.code",
        character="Kael",
        knowledge_level="suspected",
        learned_in_chapter=1,
        source_type="heard",
        evidence="Kael 只听到了不完整的传闻",
    ))
    try:
        validate_chapter_plan(state, plan)
        raise AssertionError("Expected knowledge escalation to fail")
    except OutputContractError as exc:
        assert "仅为 suspected" in str(exc)
    print("✓ PASSED")


def test_unplanned_writing_fact_retries_without_replanning():
    """Writer-only fact drift should take a bounded writing rewrite edge."""
    print("  Testing unplanned writing fact routing...", end=" ")

    state = make_sample_state()
    engine = GraphNovelEngine(state)

    invalid_meta = json.loads(
        mock_chapter_response().split("---META---", 1)[1]
    )
    invalid_meta["facts_established"] = [{
        "fact_id": "mysterious_superior",
        "statement": "一个从未规划的神秘上级在幕后发号施令",
        "category": "character_identity",
        "visibility": "private",
    }]
    invalid_response = (
        MOCK_CHAPTER_DRAFT
        + "\n\n---META---\n"
        + json.dumps(invalid_meta, ensure_ascii=False)
    )

    with mock.patch(
        "graph_novel.nodes.chapter_planning.call_llm_sync",
        return_value=mock_chapter_plan(),
    ) as plan_call, mock.patch(
        "graph_novel.nodes.writing.call_llm_sync",
        side_effect=[
            invalid_response,
            invalid_response,
            mock_chapter_response(),
        ],
    ) as write_call, mock.patch(
        "graph_novel.nodes.consistency_review.call_llm_sync",
        return_value=json.dumps(MOCK_CONSISTENCY_REPORT),
    ) as review_call, mock.patch(
        "graph_novel.nodes.style_polish.call_llm_sync",
        return_value=MOCK_CHAPTER_DRAFT,
    ):
        engine.run_chapter_generation(1)

    assert plan_call.call_count == 1
    assert write_call.call_count == 3
    assert review_call.call_count == 1
    assert len(state.chapters[0].revision_history) == 2
    assert all(
        item["source"] == "narrative_contract"
        for item in state.chapters[0].revision_history
    )
    assert "mysterious_superior" in write_call.call_args_list[1].args[1]
    assert state.pending_gate == "chapter:1"
    print("✓ PASSED")


def test_high_score_knowledge_leak_forces_rewrite():
    """A serious narrative violation rewrites even when the score is high."""
    print("  Testing high-score knowledge leak routing...", end=" ")

    state = make_sample_state()
    engine = GraphNovelEngine(state)
    engine.set_approval_callback(lambda *_args, **_kwargs: (True, ""))

    blocked_review = dict(MOCK_CONSISTENCY_REPORT)
    blocked_review.update({
        "overall_score": 8,
        "issues": [],
        "requires_rewrite": True,
        "logic_gate_passed": False,
        "narrative_violations": [{
            "severity": "严重",
            "category": "信息越权",
            "description": "未进入现场的调查员直接说出了密室密码。",
            "evidence": "正文没有目击、转述或推理过程。",
            "suggested_fix": "补充可靠的信息传播路径，或将确认降级为怀疑。",
        }],
        "summary": "文风合格，但存在严重信息泄漏。",
    })
    clean_review = dict(MOCK_CONSISTENCY_REPORT)

    with mock.patch(
        "graph_novel.nodes.chapter_planning.call_llm_sync",
        return_value=mock_chapter_plan(),
    ) as plan_call, mock.patch(
        "graph_novel.nodes.writing.call_llm_sync",
        return_value=mock_chapter_response(),
    ) as write_call, mock.patch(
        "graph_novel.nodes.consistency_review.call_llm_sync",
        side_effect=[
            json.dumps(blocked_review, ensure_ascii=False),
            json.dumps(clean_review, ensure_ascii=False),
        ],
    ) as review_call, mock.patch(
        "graph_novel.nodes.style_polish.call_llm_sync",
        return_value=MOCK_CHAPTER_DRAFT,
    ):
        engine.run_single_chapter(1)

    assert plan_call.call_count == 2
    assert write_call.call_count == 2
    assert review_call.call_count == 2
    assert "未进入现场的调查员" in plan_call.call_args_list[1].args[1]
    print("✓ PASSED")


def test_unresolved_narrative_violation_stops_graph():
    """The graph stops instead of polishing unresolved serious logic defects."""
    print("  Testing narrative rewrite limit...", end=" ")
    from graph_novel.engine import GraphExecutionError

    state = make_sample_state()
    engine = GraphNovelEngine(state)
    blocked_review = dict(MOCK_CONSISTENCY_REPORT)
    blocked_review.update({
        "overall_score": 8,
        "issues": [],
        "requires_rewrite": True,
        "logic_gate_passed": False,
        "narrative_violations": [{
            "severity": "严重",
            "category": "因果断裂",
            "description": "关键证物出现前没有获取过程。",
            "evidence": "前文和本章均未交代来源。",
            "suggested_fix": "补充获取证物的场景。",
        }],
    })

    with mock.patch(
        "graph_novel.nodes.chapter_planning.call_llm_sync",
        return_value=mock_chapter_plan(),
    ) as plan_call, mock.patch(
        "graph_novel.nodes.writing.call_llm_sync",
        return_value=mock_chapter_response(),
    ) as write_call, mock.patch(
        "graph_novel.nodes.consistency_review.call_llm_sync",
        return_value=json.dumps(blocked_review, ensure_ascii=False),
    ) as review_call, mock.patch(
        "graph_novel.nodes.style_polish.call_llm_sync",
    ) as polish_call:
        try:
            engine.run_chapter_generation(1)
            raise AssertionError("Expected unresolved logic to stop the graph")
        except GraphExecutionError as exc:
            assert exc.node_key == "narrative_gate_1"

    assert plan_call.call_count == 3
    assert write_call.call_count == 3
    assert review_call.call_count == 3
    polish_call.assert_not_called()
    assert state.workflow_phase == "failed"
    assert state.pending_gate is None
    assert len(state.chapters[0].revision_history) == 3
    assert "关键证物出现前没有获取过程" in state.chapters[0].rewrite_feedback
    print("✓ PASSED")


def test_narrative_delta_commits_only_after_approval():
    """Candidate facts and knowledge are transactional chapter side effects."""
    print("  Testing transactional narrative delta...", end=" ")

    state = make_sample_state()
    state.foundation_approval = ApprovalStatus.APPROVED
    engine = GraphNovelEngine(state)

    plan = json.loads(mock_chapter_plan("封存档案"))
    plan["planned_facts"] = [{
        "fact_id": "fact.archive.code",
        "statement": "封存档案的开启码是 4317",
        "category": "秘密",
        "visibility": "private",
    }]
    plan["information_flow"] = [{
        "fact_id": "fact.archive.code",
        "character": "Aria",
        "knowledge_level": "confirmed",
        "source_type": "observed",
        "source_character": "",
        "evidence": "Aria 亲眼看见国王输入开启码",
    }]

    response_meta = json.loads(
        mock_chapter_response().split("---META---", 1)[1]
    )
    response_meta["facts_established"] = plan["planned_facts"]
    response_meta["knowledge_changes"] = plan["information_flow"]
    write_response = (
        MOCK_CHAPTER_DRAFT
        + "\n\n---META---\n"
        + json.dumps(response_meta, ensure_ascii=False)
    )

    with mock.patch(
        "graph_novel.nodes.chapter_planning.call_llm_sync",
        return_value=json.dumps(plan, ensure_ascii=False),
    ), mock.patch(
        "graph_novel.nodes.writing.call_llm_sync",
        return_value=write_response,
    ), mock.patch(
        "graph_novel.nodes.consistency_review.call_llm_sync",
        return_value=json.dumps(MOCK_CONSISTENCY_REPORT),
    ), mock.patch(
        "graph_novel.nodes.style_polish.call_llm_sync",
        return_value=MOCK_CHAPTER_DRAFT,
    ):
        engine.run_chapter_generation(1)

    assert state.narrative_facts == []
    assert state.character_knowledge == []
    assert state.chapters[0].narrative_delta["facts_established"]

    engine.apply_chapter_decision(1, True, "")
    assert state.narrative_facts[0].id == "fact.archive.code"
    assert state.character_knowledge[0].character == "Aria"
    assert state.character_knowledge[0].source_type == "observed"
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
        assert response.status_code == 202
        payload = wait_for_task_status(client, project_id, "failed")

    assert payload["status"] == "failed"
    assert payload["current_node"] == "global_review"
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
    characters = json.dumps({
        "characters": [{
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
        }],
    }, ensure_ascii=False)
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


def test_output_contract_parsing_and_retry():
    """Structured output retries format errors once and rejects bad schemas."""
    print("  Testing output contracts + bounded retry...", end=" ")
    from graph_novel.output_contracts import (
        CONSISTENCY_REVIEW_CONTRACT,
        OutputContractError,
        WORLD_SETTING_CONTRACT,
        call_json_with_contract_sync,
        call_text_with_contract_sync,
        outline_contract,
        parse_chapter_response,
        parse_json_response,
    )

    world, _, _ = _foundation_llm_mocks()
    parsed = parse_json_response(
        f"模型说明\n```json\n{world}\n```\n结束",
        expected_type=dict,
    )
    assert parsed["era"] == "现代都市"

    try:
        parse_json_response(f"[{world}]", expected_type=dict)
        raise AssertionError("Expected wrong top-level JSON type")
    except OutputContractError as exc:
        assert "顶层类型错误" in str(exc)

    llm_call = mock.Mock(side_effect=["not-json", world])
    validated = call_json_with_contract_sync(
        llm_call,
        "输出 JSON 对象。",
        "生成世界观。",
        contract=WORLD_SETTING_CONTRACT,
        max_tokens=512,
        temperature=0.2,
        format_retries=1,
    )
    assert validated["location"] == "东海市"
    assert llm_call.call_count == 2
    assert "上一轮响应未通过" in llm_call.call_args_list[1].args[1]
    assert llm_call.call_args_list[0].kwargs["response_format"] == {
        "type": "json_object",
    }

    bad_score = {
        "overall_score": 11,
        "issues": [],
        "hook_quality": "强钩子",
        "hook_review": "有效",
        "shuangdian_delivery": "到位",
        "ai_disease_count": 0,
        "dialogue_ratio_estimate": "60%",
        "requires_rewrite": False,
        "logic_gate_passed": True,
        "narrative_audit": {
            "causality": "已核对。",
            "knowledge_provenance": "已核对。",
            "continuity": "已核对。",
        },
        "narrative_violations": [],
        "character_arc_updates": {},
        "summary": "非法分数",
    }
    try:
        CONSISTENCY_REVIEW_CONTRACT.validate(bad_score)
        raise AssertionError("Expected invalid score to fail")
    except OutputContractError as exc:
        assert "overall_score" in str(exc)

    wrong_world_type = json.loads(world)
    wrong_world_type["key_locations"] = "东海市"
    try:
        WORLD_SETTING_CONTRACT.validate(wrong_world_type)
        raise AssertionError("Expected wrong field type to fail")
    except OutputContractError as exc:
        assert "key_locations" in str(exc)

    _, _, two_chapter_outline = _foundation_llm_mocks(chapter_count=2)
    try:
        outline_contract(3).validate(json.loads(two_chapter_outline))
        raise AssertionError("Expected wrong chapter count to fail")
    except OutputContractError as exc:
        assert "章数不匹配" in str(exc)

    valid_chapter_response = mock_chapter_response()
    mixed_call = mock.Mock(side_effect=[
        MOCK_CHAPTER_DRAFT + "\n---META---\n{}",
        valid_chapter_response,
    ])
    prose, meta = call_text_with_contract_sync(
        mixed_call,
        "输出正文和 META。",
        "写第一章。",
        parser=parse_chapter_response,
        contract_name="章节正文与 META",
        format_retries=1,
    )
    assert prose == MOCK_CHAPTER_DRAFT
    assert meta["chapter_hook"] == "黑蜡封印突然裂开"
    assert mixed_call.call_count == 2
    assert "原始响应格式" in mixed_call.call_args_list[1].args[1]
    assert "只输出符合原始字段要求的 JSON" not in (
        mixed_call.call_args_list[1].args[1]
    )

    api_failure = mock.Mock(side_effect=RuntimeError("provider unavailable"))
    try:
        call_json_with_contract_sync(
            api_failure,
            "输出 JSON。",
            "生成。",
            contract=WORLD_SETTING_CONTRACT,
            format_retries=1,
        )
        raise AssertionError("Expected provider failure")
    except RuntimeError:
        pass
    assert api_failure.call_count == 1
    print("✓ PASSED")


def test_large_outline_generation_is_batched():
    """Large novels use one overview plus bounded chapter batches."""
    print("  Testing large outline batching...", end=" ")
    from graph_novel.nodes import outline_planning

    total_chapters = 200
    batch_size = 25
    overview = {
        "genre": "末世重生",
        "premise": "主角重生后建立生存基地",
        "theme": "秩序与人性",
        "target_length": "50万字",
        "suggested_chapter_count": total_chapters,
        "shuangdian_map": [],
    }

    responses = [json.dumps(overview, ensure_ascii=False)]
    for start in range(1, total_chapters + 1, batch_size):
        end = min(start + batch_size - 1, total_chapters)
        responses.append(json.dumps({
            "chapter_outlines": [
                {
                    "chapter_number": number,
                    "title": f"第{number}章 生存倒计时",
                    "summary": "主角推进基地建设与主线冲突。",
                    "pov_character": "主角",
                    "key_events": ["危机升级", "资源争夺"],
                    "shuangdian_beat": "铺垫",
                    "chapter_hook_idea": "新的威胁逼近",
                    "foreshadowing_to_plant": [],
                    "foreshadowing_to_pay_off": [],
                }
                for number in range(start, end + 1)
            ],
        }, ensure_ascii=False))

    state = make_sample_state()
    state.novel_title = "大型大纲测试"
    state.novel_outline = None
    state.target_total_chapters = total_chapters
    state.total_chapters = total_chapters

    with mock.patch(
        "graph_novel.nodes.outline_planning.call_llm_sync",
        side_effect=responses,
    ) as llm_call:
        outline_planning.run_node(state)

    assert state.node_status["outline_planning"] == NodeStatus.COMPLETED
    assert state.novel_outline is not None
    assert len(state.novel_outline.chapter_outlines) == total_chapters
    assert [
        chapter.chapter_number
        for chapter in state.novel_outline.chapter_outlines
    ] == list(range(1, total_chapters + 1))
    assert llm_call.call_count == 9
    assert "只生成全书总纲" in llm_call.call_args_list[0].args[1]
    assert "第1章到第25章" in llm_call.call_args_list[1].args[1]
    assert "第176章到第200章" in llm_call.call_args_list[-1].args[1]
    print("✓ PASSED")


def test_llm_provider_configuration():
    """Provider settings and DeepSeek-specific request parameters are centralized."""
    print("  Testing DeepSeek provider configuration...", end=" ")
    import asyncio
    from graph_novel import llm

    debug_path = Path(tempfile.mkdtemp()) / "llm-debug.jsonl"
    with mock.patch.dict(
        os.environ,
        {
            "DEEPSEEK_API_KEY": "test-key",
            "DEEPSEEK_BASE_URL": "https://api.deepseek.example",
            "DEEPSEEK_MODEL": "deepseek-v4-flash",
            "DEEPSEEK_TIMEOUT_SECONDS": "45",
            "DEEPSEEK_API_RETRIES": "1",
            "DEEPSEEK_FORMAT_RETRIES": "1",
            "DEEPSEEK_THINKING": "disabled",
            "GRAPH_NOVEL_LLM_DEBUG_FILE": str(debug_path),
            "GRAPH_NOVEL_LLM_DEBUG_MAX_CHARS": "200",
        },
    ), mock.patch("graph_novel.llm.OpenAI") as openai_cls:
        client = mock.Mock()
        response = mock.Mock()
        response.choices = [mock.Mock(message=mock.Mock(content='{"ok": true}'))]
        client.chat.completions.create.return_value = response
        openai_cls.return_value = client

        settings = llm.get_llm_settings()
        assert settings.model == "deepseek-v4-flash"
        assert settings.base_url == "https://api.deepseek.example"
        assert settings.timeout_seconds == 45
        assert settings.api_retries == 1
        assert settings.format_retries == 1

        result = asyncio.run(llm.call_llm(
            "请输出 JSON。",
            "测试，请勿记录 sk-sensitive-debug-secret",
            response_format={"type": "json_object"},
        ))
        assert result == '{"ok": true}'
        openai_cls.assert_called_once_with(
            api_key="test-key",
            base_url="https://api.deepseek.example",
            timeout=45,
            max_retries=1,
        )
        request = client.chat.completions.create.call_args.kwargs
        assert request["model"] == "deepseek-v4-flash"
        assert request["temperature"] == 0.7
        assert request["response_format"] == {"type": "json_object"}
        assert request["extra_body"] == {"thinking": {"type": "disabled"}}

        os.environ["DEEPSEEK_THINKING"] = "enabled"
        asyncio.run(llm.call_llm("系统", "思考模式测试"))
        thinking_request = client.chat.completions.create.call_args.kwargs
        assert thinking_request["reasoning_effort"] == "high"
        assert "temperature" not in thinking_request
        assert thinking_request["extra_body"] == {
            "thinking": {"type": "enabled"},
        }

        debug_entries = [
            json.loads(line)
            for line in debug_path.read_text(encoding="utf-8").splitlines()
        ]
        assert [entry["event"] for entry in debug_entries] == [
            "request",
            "response",
            "request",
            "response",
        ]
        debug_text = debug_path.read_text(encoding="utf-8")
        assert "test-key" not in debug_text
        assert "sk-sensitive-debug-secret" not in debug_text
        assert "[REDACTED]" in debug_text
    print("✓ PASSED")


def test_execution_trace_and_unified_export():
    """Node timing, route choices, and approved-only exports are persistent."""
    print("  Testing execution trace + unified export...", end=" ")
    from graph_novel.exporting import (
        approved_chapters,
        build_novel_markdown,
        export_filename,
    )

    state = make_sample_state()
    state.project_id = "trace_export"
    state.save_dir = Path(tempfile.mkdtemp())
    state.foundation_approval = ApprovalStatus.APPROVED
    state.workflow_phase = "chapter_loop"
    engine = GraphNovelEngine(state)
    plan, write, review, polish = _chapter_pipeline_mocks()

    with mock.patch(
        "graph_novel.nodes.chapter_planning.call_llm_sync",
        return_value=plan,
    ), mock.patch(
        "graph_novel.nodes.writing.call_llm_sync",
        return_value=write,
    ), mock.patch(
        "graph_novel.nodes.consistency_review.call_llm_sync",
        return_value=review,
    ), mock.patch(
        "graph_novel.nodes.style_polish.call_llm_sync",
        return_value=polish,
    ):
        engine.run_chapter_generation(1)

    node_finished = [
        event
        for event in state.execution_events
        if event["event"] == "node_finished"
    ]
    assert [event["node"] for event in node_finished] == [
        "chapter_planning_1",
        "writing_1",
        "consistency_review_1",
        "style_polish_1",
    ]
    assert all(event["status"] == "completed" for event in node_finished)
    assert all(event["duration_ms"] >= 0 for event in node_finished)
    assert any(
        event["event"] == "route_selected"
        and event["source"] == "consistency_review_1"
        and event["target"] == "style_polish_1"
        and event["reason"] == "review_passed"
        for event in state.execution_events
    )
    assert any(
        event["event"] == "route_selected"
        and event["target"] == "human_approval_1"
        and event["reason"] == "chapter_gate"
        for event in state.execution_events
    )

    engine.apply_chapter_decision(1, True, "")
    state.chapters[1].polished_draft = "未批准内容不得导出"
    state.chapters[1].word_count = 9
    exported = approved_chapters(state)
    assert [chapter.chapter_number for chapter in exported] == [1]
    markdown = build_novel_markdown(state)
    assert "已批准章节：1/3" in markdown
    assert f"总字数：{state.chapters[0].word_count}" in markdown
    assert "## 第1章：" in markdown
    assert "未批准内容不得导出" not in markdown
    assert "**Theme:**" not in markdown
    assert export_filename(state) == "trace_export_完整版.md"

    reloaded = GraphNovelState.from_json(state.save())
    assert reloaded.version == 6
    assert reloaded.execution_events == state.execution_events
    print("✓ PASSED")


def test_web_observability_and_export_contract():
    """Web surfaces graph labels, recent events, and the canonical export."""
    print("  Testing Web observability + export contract...", end=" ")
    from graph_novel.web.app import app as flask_app, _engines, _states

    project_id = "web_observability"
    state = make_sample_state()
    state.project_id = project_id
    state.novel_title = "可观测性测试"
    state.save_dir = TEST_PROJECTS_DIR / project_id
    state.foundation_approval = ApprovalStatus.APPROVED
    state.chapters[0].draft = "仅批准正文"
    state.chapters[0].word_count = 6
    state.chapters[0].approval = ApprovalStatus.APPROVED
    state.chapters[1].polished_draft = "未批准正文"
    state.chapters[1].word_count = 6
    state.node_status["writing_2"] = NodeStatus.IN_PROGRESS
    state.active_task = {
        "id": "observable-task",
        "kind": "chapter",
        "chapter": 2,
        "status": "running",
    }
    state.record_event(
        "route_selected",
        source="chapter_planning_2",
        target="writing_2",
        reason="plan_ready",
    )
    state.save()
    _states[project_id] = state
    _engines.pop(project_id, None)

    with flask_app.test_client() as client:
        task = client.get(
            f"/api/{project_id}/task-status"
        ).get_json()
        assert task["current_node"] == "writing_2"
        assert task["current_node_label"] == "第2章·章节写作"

        state_payload = client.get(f"/api/{project_id}/state").get_json()
        assert state_payload["approved_chapters"] == 1
        assert state_payload["execution_events"][-1]["reason"] == "plan_ready"

        dashboard = client.get(
            f"/project/{project_id}"
        ).get_data(as_text=True)
        assert "基础设定" in dashboard
        assert "诱发事件" in dashboard

        foundation_page = client.get(
            f"/project/{project_id}/foundation"
        ).get_data(as_text=True)
        assert "AI 智能体" in foundation_page
        assert "关键场景" in foundation_page
        assert "查看章节大纲" in foundation_page
        assert "Key Locations" not in foundation_page
        assert "View Chapter Outlines" not in foundation_page

        response = client.get(f"/download/{project_id}/novel")
        markdown = response.get_data(as_text=True)
        assert response.status_code == 200
        assert "已批准章节：1/3" in markdown
        assert "## 第1章：" in markdown
        assert "仅批准正文" in markdown
        assert "未批准正文" not in markdown
        assert "## Chapter 1:" not in markdown
        disposition = response.headers["Content-Disposition"]
        assert project_id in disposition
        assert ".md" in disposition
    print("✓ PASSED")


def test_node_contract_failures_are_observable():
    """A schema violation fails its node after one bounded format retry."""
    print("  Testing node contract failure state...", end=" ")
    from graph_novel.nodes import consistency_review, world_building

    invalid_world = {
        "era": "现代都市",
        "location": "东海市",
        "special_setting": "信息差兑换",
        "technology_level": "现代",
        "social_structure": "商业社会",
        "key_locations": [],
        "rules_and_laws": "兑换需要行动",
        "history": "主角刚重生",
        "golden_finger": "信息差系统",
        # notes is deliberately missing
    }
    state = GraphNovelState(novel_title="契约失败测试", total_chapters=1)
    with mock.patch.dict(
        os.environ,
        {"DEEPSEEK_FORMAT_RETRIES": "1"},
    ), mock.patch(
        "graph_novel.nodes.world_building.call_llm_sync",
        return_value=json.dumps(invalid_world, ensure_ascii=False),
    ) as world_call:
        world_building.run_node(state)
    assert world_call.call_count == 2
    assert state.node_status["world_building"] == NodeStatus.FAILED
    assert "notes" in state.last_error["message"]

    review_state = make_sample_state()
    review_state.current_chapter = 1
    review_state.chapters[0].draft = MOCK_CHAPTER_DRAFT
    invalid_review = {
        "overall_score": 0,
        "issues": [],
        "hook_quality": "无效",
        "hook_review": "无",
        "shuangdian_delivery": "未兑现",
        "ai_disease_count": 0,
        "dialogue_ratio_estimate": "0%",
        "requires_rewrite": True,
        "logic_gate_passed": True,
        "narrative_audit": {
            "causality": "已核对。",
            "knowledge_provenance": "已核对。",
            "continuity": "已核对。",
        },
        "narrative_violations": [],
        "character_arc_updates": {},
        "summary": "非法分数",
    }
    with mock.patch.dict(
        os.environ,
        {"DEEPSEEK_FORMAT_RETRIES": "1"},
    ), mock.patch(
        "graph_novel.nodes.consistency_review.call_llm_sync",
        return_value=json.dumps(invalid_review, ensure_ascii=False),
    ) as review_call:
        consistency_review.run_node(review_state)
    assert review_call.call_count == 2
    assert review_state.node_status["consistency_review_1"] == NodeStatus.FAILED
    assert "overall_score" in review_state.last_error["message"]
    print("✓ PASSED")


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


def test_foundation_retry_resumes_from_failed_outline():
    """A retry reuses completed upstream checkpoints after outline failure."""
    print("  Testing Foundation checkpoint resume...", end=" ")
    from graph_novel.engine import GraphExecutionError

    state = make_sample_state()
    state.project_id = "foundation_outline_resume"
    state.save_dir = Path(tempfile.mkdtemp())
    state.novel_outline = None
    state.target_total_chapters = 3
    state.node_status = {}
    engine = GraphNovelEngine(state)

    def complete_world(current):
        current.node_status["world_building"] = NodeStatus.COMPLETED
        return current

    def complete_characters(current):
        current.node_status["character_design"] = NodeStatus.COMPLETED
        return current

    def fail_outline(current):
        current.node_status["outline_planning"] = NodeStatus.FAILED
        current.last_error = {
            "node": "outline_planning",
            "message": "outline.genre 缺少必填字段",
        }
        return current

    def complete_outline(current):
        current.novel_outline = NovelOutline(
            genre="Fantasy",
            premise="Test",
            theme="Test",
            target_length="6000 words",
            chapter_outlines=[
                ChapterOutline(
                    chapter_number=number,
                    title=f"Chapter {number}",
                    summary="Test",
                )
                for number in range(1, 4)
            ],
        )
        current.node_status["outline_planning"] = NodeStatus.COMPLETED
        return current

    outline_runs = [fail_outline, complete_outline]
    with mock.patch(
        "graph_novel.nodes.world_building.run_node",
        side_effect=complete_world,
    ) as world_node, mock.patch(
        "graph_novel.nodes.character_design.run_node",
        side_effect=complete_characters,
    ) as character_node, mock.patch(
        "graph_novel.nodes.outline_planning.run_node",
        side_effect=lambda current: outline_runs.pop(0)(current),
    ) as outline_node:
        try:
            engine.run_foundation_generation()
            raise AssertionError("Expected GraphExecutionError")
        except GraphExecutionError:
            pass

        assert state.workflow_phase == "failed"
        engine.run_foundation_generation()

    world_node.assert_called_once()
    character_node.assert_called_once()
    assert outline_node.call_count == 2
    assert state.pending_gate == "foundation"
    assert state.workflow_phase == "foundation"
    print("✓ PASSED")


def test_failed_foundation_page_exposes_retry():
    """Partial Foundation data must not hide the retry action."""
    print("  Testing failed Foundation retry page...", end=" ")
    from graph_novel.web.app import app as flask_app, _states

    project_id = "failed_foundation_retry_page"
    state = make_sample_state()
    state.project_id = project_id
    state.novel_outline = None
    state.target_total_chapters = 200
    state.workflow_phase = "failed"
    state.pending_gate = None
    state.foundation_approval = ApprovalStatus.PENDING
    state.last_error = {
        "node": "outline_planning",
        "message": "outline.genre 缺少必填字段",
    }
    _states[project_id] = state

    with flask_app.test_client() as client:
        page = client.get(f"/project/{project_id}/foundation")

    assert page.status_code == 200
    html = page.get_data(as_text=True)
    assert "重试基础设定生成" in html
    assert "长篇大纲会分批生成" in html
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
        "active_task", "execution_events",
        "narrative_facts", "character_knowledge", "continuity_state",
    ):
        legacy_data.pop(key, None)
    legacy_data["version"] = 1
    legacy_path = Path(tempfile.mkdtemp()) / "legacy_state.json"
    legacy_path.write_text(json.dumps(legacy_data, ensure_ascii=False), encoding="utf-8")

    loaded = GraphNovelState.from_json(legacy_path)
    assert loaded.version == 6
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
    assert migrated.version == 6
    assert migrated.chapters[0].side_effects_committed
    assert migrated.pending_gate == "chapter:2"
    assert migrated.chapters[0].narrative_delta["chapter_summary"]

    version_five = make_sample_state()
    version_five.version = 5
    version_five.chapters[0].approval = ApprovalStatus.APPROVED
    version_five_data = version_five.to_dict()
    for key in (
        "narrative_facts",
        "character_knowledge",
        "continuity_state",
    ):
        version_five_data.pop(key, None)
    for chapter_data in version_five_data["chapters"]:
        chapter_data.pop("plan", None)
        chapter_data.pop("narrative_delta", None)
    version_five_path = Path(tempfile.mkdtemp()) / "version_five_state.json"
    version_five_path.write_text(
        json.dumps(version_five_data, ensure_ascii=False),
        encoding="utf-8",
    )
    migrated_five = GraphNovelState.from_json(version_five_path)
    assert migrated_five.version == 6
    assert migrated_five.chapters[0].plan == {}
    assert (
        migrated_five.chapters[0].narrative_delta["chapter_summary"]
        == migrated_five.chapters[0].title
    )
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
        assert client.get(
            f"/api/{project_id}/task-status"
        ).get_json()["status"] == "idle"
        response = client.post(f"/api/{project_id}/run-foundation")
        payload = response.get_json()
        assert response.status_code == 202
        assert payload["success"] is True
        assert payload["status"] == "running"
        payload = wait_for_task_status(
            client,
            project_id,
            "awaiting_approval",
        )
        assert payload["pending_gate"] == "foundation"

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
        assert client.get(
            f"/api/{project_id}/task-status"
        ).get_json()["status"] == "completed"

        page = client.get(f"/project/{project_id}/foundation")
        assert page.status_code == 200
        assert "加强规则压迫感" in page.get_data(as_text=True)

        response = client.post(f"/api/{project_id}/run-foundation")
        assert response.status_code == 202
        wait_for_task_status(client, project_id, "awaiting_approval")
        response = client.post(
            f"/api/{project_id}/approve-foundation",
            json={"approved": True, "feedback": ""},
        )
        payload = response.get_json()
        assert response.status_code == 200
        assert payload["next_action"] == "chapters"
        assert state.foundation_approval == ApprovalStatus.APPROVED
        assert len(state.chapters) == 2
        assert client.get(
            f"/api/{project_id}/task-status"
        ).get_json()["status"] == "completed"
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
        assert response.status_code == 202
        payload = wait_for_task_status(client, failure_id, "failed")
        assert payload["status"] == "failed"
        assert payload["current_node"] == "world_building"

    print("✓ PASSED")


def _chapter_pipeline_mocks():
    """Return deterministic chapter generation payloads."""
    plan = mock_chapter_plan("黑蜡封印")
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
        "chapter_summary": "Aria 接受密令并在途中遭遇刺客。",
        "facts_established": [],
        "knowledge_changes": [],
        "continuity_changes": {
            "time": "中午",
            "character_locations": {"Aria": "王城东部森林"},
            "character_conditions": {"Aria": "健康"},
            "resources": {"Aria": ["密封卷轴"]},
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
        assert response.status_code == 202
        assert payload["success"] is True
        assert payload["status"] == "running"
        payload = wait_for_task_status(
            client,
            project_id,
            "awaiting_approval",
        )
        assert payload["pending_gate"] == "chapter:1"

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
        assert response.status_code == 202
        wait_for_task_status(client, project_id, "awaiting_approval")
        response = client.post(
            f"/api/{project_id}/approve-chapter/1",
            json={"approved": True, "feedback": ""},
        )
        payload = response.get_json()
        assert response.status_code == 200
        assert payload["status"] == "approved"
        assert state.chapters[0].side_effects_committed
        assert client.get(
            f"/api/{project_id}/task-status"
        ).get_json()["status"] == "completed"

    print("✓ PASSED")


def test_complete_mock_web_workflow():
    """Create → both Gate types → five chapters → final review → export."""
    print("  Testing complete Mock Web workflow...", end=" ")
    from graph_novel.web.app import app as flask_app, _states

    project_id = "web_e2e_mock"
    world, characters, outline = _foundation_llm_mocks(chapter_count=5)
    _, write, review, polish = _chapter_pipeline_mocks()

    def plan_for_prompt(_system_prompt, user_prompt, **_kwargs):
        marker = user_prompt.split("规划第", 1)[1].split("章", 1)[0]
        chapter_number = int(marker)
        plan = json.loads(mock_chapter_plan(
            f"测试章节{chapter_number}",
            chapter_number,
        ))
        plan["pov_character"] = "林凡"
        return json.dumps(plan, ensure_ascii=False)

    with flask_app.test_client() as client, \
         mock.patch(
             "graph_novel.nodes.world_building.call_llm_sync",
             return_value=world,
         ), \
         mock.patch(
             "graph_novel.nodes.character_design.call_llm_sync",
             return_value=characters,
         ), \
         mock.patch(
             "graph_novel.nodes.outline_planning.call_llm_sync",
             return_value=outline,
         ), \
         mock.patch(
             "graph_novel.nodes.chapter_planning.call_llm_sync",
             side_effect=plan_for_prompt,
         ), \
         mock.patch(
             "graph_novel.nodes.writing.call_llm_sync",
             return_value=write,
         ), \
         mock.patch(
             "graph_novel.nodes.consistency_review.call_llm_sync",
             return_value=review,
         ), \
         mock.patch(
             "graph_novel.nodes.style_polish.call_llm_sync",
             return_value=polish,
         ), \
         mock.patch(
             "graph_novel.nodes.global_review.call_llm_sync",
             return_value=json.dumps(MOCK_GLOBAL_REVIEW),
         ):
        created = client.post("/create", data={
            "title": "Web E2E Mock",
            "genre": "都市脑洞",
            "genre_tags": "重生,信息差",
            "premise": "重生后靠信息差逆袭",
            "theme": "逆袭与责任",
            "target_chapters": "5",
            "target_words": "50000",
            "notes": "全流程 Mock 验证。",
        })
        assert created.status_code == 302
        assert created.headers["Location"].endswith(
            f"/project/{project_id}/foundation"
        )

        response = client.post(f"/api/{project_id}/run-foundation")
        assert response.status_code == 202
        foundation_task = wait_for_task_status(
            client,
            project_id,
            "awaiting_approval",
        )
        assert foundation_task["pending_gate_label"] == "基础设定审批"
        approved = client.post(
            f"/api/{project_id}/approve-foundation",
            json={"approved": True, "feedback": ""},
        )
        assert approved.status_code == 200

        for chapter_number in range(1, 6):
            response = client.post(
                f"/api/{project_id}/run-chapter/{chapter_number}"
            )
            assert response.status_code == 202
            chapter_task = wait_for_task_status(
                client,
                project_id,
                "awaiting_approval",
            )
            assert chapter_task["pending_gate_label"] == (
                f"第{chapter_number}章审批"
            )
            decision = client.post(
                f"/api/{project_id}/approve-chapter/{chapter_number}",
                json={"approved": True, "feedback": ""},
            )
            assert decision.status_code == 200

        state = _states[project_id]
        assert state.workflow_phase == "global_review"
        assert all(
            chapter.approval == ApprovalStatus.APPROVED
            for chapter in state.chapters
        )

        response = client.post(f"/api/{project_id}/run-global-review")
        assert response.status_code == 202
        final_task = wait_for_task_status(
            client,
            project_id,
            "completed",
        )
        assert final_task["workflow_phase"] == "done"
        assert state.global_review_report["overall_score"] == 8

        state_payload = client.get(
            f"/api/{project_id}/state"
        ).get_json()
        assert state_payload["approved_chapters"] == 5
        assert any(
            event["event"] == "route_selected"
            and event["source"] == "global_review"
            and event["target"] == "done"
            for event in state_payload["execution_events"]
        )

        download = client.get(f"/download/{project_id}/novel")
        markdown = download.get_data(as_text=True)
        assert download.status_code == 200
        assert "已批准章节：5/5" in markdown
        assert markdown.count("## 第") == 5
        assert "未批准" not in markdown

        review_page = client.get(
            f"/project/{project_id}/review"
        ).get_data(as_text=True)
        assert "8/10" in review_page
        assert "第三阶段" in review_page
    print("✓ PASSED")


def test_web_task_lock_and_restart_recovery():
    """One project runs one task; orphaned running tasks recover safely."""
    print("  Testing Web task lock + restart recovery...", end=" ")
    from graph_novel.web.app import (
        app as flask_app,
        _engines,
        _load_or_get_state,
        _states,
        _task_threads,
    )

    project_id = "web_task_lock"
    state = GraphNovelState(
        project_id=project_id,
        novel_title="Task Lock",
        save_dir=TEST_PROJECTS_DIR / project_id,
        target_total_chapters=2,
        total_chapters=2,
    )
    state.save()
    _states[project_id] = state
    _engines.pop(project_id, None)
    world, characters, outline = _foundation_llm_mocks(chapter_count=2)
    entered = threading.Event()
    release = threading.Event()

    def blocking_world(*args, **kwargs):
        entered.set()
        assert release.wait(timeout=2.0)
        return world

    with flask_app.test_client() as client, \
         mock.patch(
             "graph_novel.nodes.world_building.call_llm_sync",
             side_effect=blocking_world,
         ), \
         mock.patch(
             "graph_novel.nodes.character_design.call_llm_sync",
             return_value=characters,
         ), \
         mock.patch(
             "graph_novel.nodes.outline_planning.call_llm_sync",
             return_value=outline,
         ):
        response = client.post(f"/api/{project_id}/run-foundation")
        assert response.status_code == 202
        assert entered.wait(timeout=1.0)

        running = client.get(
            f"/api/{project_id}/task-status"
        ).get_json()
        assert running["status"] == "running"
        assert running["task"]["kind"] == "foundation"

        conflict = client.post(f"/api/{project_id}/run-foundation")
        assert conflict.status_code == 409
        assert conflict.get_json()["status"] == "busy"

        blocked_decision = client.post(
            f"/api/{project_id}/approve-foundation",
            json={"approved": False, "feedback": "等待当前任务"},
        )
        assert blocked_decision.status_code == 409
        assert blocked_decision.get_json()["status"] == "busy"

        release.set()
        completed = wait_for_task_status(
            client,
            project_id,
            "awaiting_approval",
        )
        assert completed["pending_gate"] == "foundation"
        deadline = time.monotonic() + 1.0
        while project_id in _task_threads and time.monotonic() < deadline:
            time.sleep(0.01)
        assert project_id not in _task_threads

    interrupted_id = "web_task_interrupted"
    interrupted = GraphNovelState(
        project_id=interrupted_id,
        novel_title="Interrupted Task",
        save_dir=TEST_PROJECTS_DIR / interrupted_id,
        target_total_chapters=2,
        total_chapters=2,
        active_task={
            "id": "orphan-task",
            "kind": "foundation",
            "status": "running",
            "started_at": "2026-07-27T00:00:00",
        },
    )
    interrupted.save()
    _states.pop(interrupted_id, None)
    _engines.pop(interrupted_id, None)

    recovered = _load_or_get_state(interrupted_id)
    assert recovered is not None
    assert recovered.active_task["status"] == "failed"
    assert recovered.active_task["error"]["code"] == "interrupted"
    assert recovered.workflow_phase == "failed"
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
        test_output_contract_parsing_and_retry,
        test_large_outline_generation_is_batched,
        test_llm_provider_configuration,
        test_execution_trace_and_unified_export,
        test_web_observability_and_export_contract,
        test_node_contract_failures_are_observable,
        test_chapter_pipeline_with_mocks,
        test_consistency_rewrite_loop,
        test_chapter_plan_is_persisted_and_consumed,
        test_information_transfer_requires_a_valid_source,
        test_unplanned_writing_fact_retries_without_replanning,
        test_high_score_knowledge_leak_forces_rewrite,
        test_unresolved_narrative_violation_stops_graph,
        test_narrative_delta_commits_only_after_approval,
        test_global_review,
        test_global_review_guards_and_failure,
        test_foreshadowing_tracker,
        test_web_app_config,
        test_web_api_state,
        test_project_inputs_and_legacy_state_migration,
        test_foundation_gate_and_feedback_edge,
        test_foundation_failure_stops_graph,
        test_foundation_retry_resumes_from_failed_outline,
        test_failed_foundation_page_exposes_retry,
        test_foundation_web_api_contract,
        test_chapter_gate_feedback_and_side_effect_commit,
        test_chapter_failure_stops_before_gate,
        test_chapter_web_api_contract,
        test_complete_mock_web_workflow,
        test_web_task_lock_and_restart_recovery,
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
