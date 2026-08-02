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
    "rewrite_scope": "none",
    "logic_gate_passed": True,
    "bridge_gate_passed": True,
    "narrative_audit": {
        "chapter_bridge": "本章开场直接承接上一章结束状态。",
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
        "opening_bridge": {
            "previous_chapter": max(0, chapter_number - 1),
            "inherited_endpoint": (
                "第一章，无前文"
                if chapter_number == 1
                else "上一章结束时 Aria 仍在现场"
            ),
            "transition_steps": [
                "直接承接上一章结束状态"
                if chapter_number > 1
                else "从故事起点开始"
            ],
            "first_scene_start": "Aria 在王座厅接到命令",
            "carry_over_threads": [],
        },
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
        "continuity_checkpoint": {
            "last_scene": {
                "time": "中午",
                "location": "王城东部森林",
                "pov_character": "Aria",
                "characters_present": ["Aria"],
                "final_action": "Aria 找到带有王室印记的硬币",
                "final_dialogue": "",
            },
            "active_goals": [{
                "character": "Aria",
                "goal": "查明刺客的幕后主使",
                "next_action": "检查王室硬币的来源",
            }],
            "unresolved_actions": ["确认王室硬币为何在刺客身上"],
            "open_threads": [{
                "thread_id": "thread.black_wax_conspiracy",
                "description": "黑蜡密令与王室刺客之间的联系",
                "urgency": "high",
            }],
            "relationship_changes": {},
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
            "continuity_checkpoint": {
                "last_scene": {
                    "time": "中午",
                    "location": "王城东部森林",
                    "pov_character": "Aria",
                    "characters_present": ["Aria"],
                    "final_action": "Aria 找到带有王室印记的硬币",
                    "final_dialogue": "",
                },
                "active_goals": [],
                "unresolved_actions": ["检查硬币来源"],
                "open_threads": [],
                "relationship_changes": {},
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
        "rewrite_scope": "polish",
        "logic_gate_passed": True,
        "bridge_gate_passed": True,
        "narrative_audit": {
            "chapter_bridge": "已核对。",
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
        "rewrite_scope": "none",
        "logic_gate_passed": True,
        "bridge_gate_passed": True,
        "narrative_audit": {
            "chapter_bridge": "已核对。",
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

    # A style-only failure should return to polish without rewriting prose.
    assert call_count["review"] >= 2, f"Expected at least 2 review calls, got {call_count['review']}"
    assert mock_plan.call_count == 1
    assert mock_write.call_count == 1
    assert mock_polish.call_count == 2
    polish_prompts = [call.args[1] for call in mock_polish.call_args_list]
    assert "Major OOC" in polish_prompts[1]
    assert len(state.chapters[0].revision_history) == 1

    print("✓ PASSED")


def test_consistency_reviews_final_polished_candidate():
    """The approval Gate must receive a polished draft already reviewed."""
    print("  Testing final polished candidate review...", end=" ")

    state = make_sample_state()
    engine = GraphNovelEngine(state)
    final_text = MOCK_CHAPTER_DRAFT + "\n\nFINAL_POLISHED_MARKER"

    with mock.patch(
        "graph_novel.nodes.chapter_planning.call_llm_sync",
        return_value=mock_chapter_plan(),
    ), mock.patch(
        "graph_novel.nodes.writing.call_llm_sync",
        return_value=mock_chapter_response(),
    ), mock.patch(
        "graph_novel.nodes.style_polish.call_llm_sync",
        return_value=final_text,
    ), mock.patch(
        "graph_novel.nodes.consistency_review.call_llm_sync",
        return_value=json.dumps(MOCK_CONSISTENCY_REPORT),
    ) as review_call:
        engine.run_chapter_generation(1)

    assert "FINAL_POLISHED_MARKER" in review_call.call_args.args[1]
    finished = [
        event["node"]
        for event in state.execution_events
        if event["event"] == "node_finished"
    ]
    assert finished == [
        "chapter_planning_1",
        "writing_1",
        "style_polish_1",
        "consistency_review_1",
    ]
    assert state.pending_gate == "chapter:1"
    print("✓ PASSED")


def test_review_scope_selects_the_smallest_rewrite_edge():
    """Plan, prose and style failures return to different graph nodes."""
    print("  Testing scoped review edges...", end=" ")

    expected = {
        "plan": (2, 2, 2),
        "writing": (1, 2, 2),
        "polish": (1, 1, 2),
    }
    for scope, counts in expected.items():
        state = make_sample_state()
        engine = GraphNovelEngine(state)
        blocked = dict(MOCK_CONSISTENCY_REPORT)
        blocked.update({
            "overall_score": 3,
            "issues": [{
                "severity": "严重",
                "category": "节奏",
                "description": f"需要返回 {scope} 节点修复",
                "location_hint": "本章",
                "suggested_fix": "按指定范围修复",
            }],
            "requires_rewrite": True,
            "rewrite_scope": scope,
            "summary": f"{scope} scope failure",
        })

        with mock.patch(
            "graph_novel.nodes.chapter_planning.call_llm_sync",
            return_value=mock_chapter_plan(),
        ) as plan_call, mock.patch(
            "graph_novel.nodes.writing.call_llm_sync",
            return_value=mock_chapter_response(),
        ) as write_call, mock.patch(
            "graph_novel.nodes.style_polish.call_llm_sync",
            return_value=MOCK_CHAPTER_DRAFT,
        ) as polish_call, mock.patch(
            "graph_novel.nodes.consistency_review.call_llm_sync",
            side_effect=[
                json.dumps(blocked, ensure_ascii=False),
                json.dumps(MOCK_CONSISTENCY_REPORT, ensure_ascii=False),
            ],
        ):
            engine.run_chapter_generation(1)

        assert (
            plan_call.call_count,
            write_call.call_count,
            polish_call.call_count,
        ) == counts
    print("✓ PASSED")


def test_rewrite_budgets_are_independent_and_persisted():
    """Writer contract retries must not consume review rewrite capacity."""
    print("  Testing independent rewrite budgets...", end=" ")

    state = make_sample_state()
    engine = GraphNovelEngine(state)
    invalid_meta = json.loads(
        mock_chapter_response().split("---META---", 1)[1]
    )
    invalid_meta["facts_established"] = [{
        "fact_id": "fact.unplanned",
        "statement": "规划外事实",
        "category": "logic",
        "visibility": "private",
    }]
    invalid_response = (
        MOCK_CHAPTER_DRAFT
        + "\n\n---META---\n"
        + json.dumps(invalid_meta, ensure_ascii=False)
    )
    blocked = dict(MOCK_CONSISTENCY_REPORT)
    blocked.update({
        "overall_score": 3,
        "requires_rewrite": True,
        "rewrite_scope": "writing",
        "summary": "正文执行需要重写",
    })

    with mock.patch(
        "graph_novel.nodes.chapter_planning.call_llm_sync",
        return_value=mock_chapter_plan(),
    ) as plan_call, mock.patch(
        "graph_novel.nodes.writing.call_llm_sync",
        side_effect=[
            invalid_response,
            mock_chapter_response(),
            mock_chapter_response(),
        ],
    ), mock.patch(
        "graph_novel.nodes.style_polish.call_llm_sync",
        return_value=MOCK_CHAPTER_DRAFT,
    ), mock.patch(
        "graph_novel.nodes.consistency_review.call_llm_sync",
        side_effect=[
            json.dumps(blocked, ensure_ascii=False),
            json.dumps(MOCK_CONSISTENCY_REPORT, ensure_ascii=False),
        ],
    ):
        engine.run_chapter_generation(1)

    counters = state.chapters[0].rewrite_counters
    assert plan_call.call_count == 1
    assert counters["writing_contract"] == 1
    assert counters["writing"] == 1
    assert counters["total"] == 2
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


def test_context_keeps_immediate_predecessor_ending():
    """Structured chapters must still expose their exact ending downstream."""
    print("  Testing immediate predecessor context...", end=" ")
    from graph_novel.narrative import build_narrative_context

    state = make_sample_state()
    state.current_chapter = 2
    previous = state.chapters[0]
    previous.approval = ApprovalStatus.APPROVED
    previous.polished_draft = (
        "Aria crossed the eastern forest.\n\n"
        "Kael lowered his sword and said the truce would last until dawn."
    )
    previous.narrative_delta = {
        "chapter_summary": "Aria and Kael agreed to a temporary truce.",
        "facts_established": [{
            "fact_id": "fact.temporary_truce",
            "statement": "Aria and Kael agreed to a truce until dawn",
            "category": "relationship",
            "visibility": "private",
        }],
        "knowledge_changes": [{
            "fact_id": "fact.temporary_truce",
            "character": "Aria",
            "knowledge_level": "confirmed",
            "source_type": "told",
            "source_character": "Kael",
            "evidence": "Kael stated the deadline directly",
        }],
        "continuity_changes": {
            "time": "before dawn",
            "character_locations": {
                "Aria": "eastern forest",
                "Kael": "eastern forest",
            },
            "character_conditions": {},
            "resources": {},
        },
    }

    context = json.loads(build_narrative_context(state))
    immediate = context["immediate_predecessor"]
    assert immediate["chapter_number"] == 1
    assert immediate["ending_excerpt"].endswith(
        "the truce would last until dawn."
    )
    print("✓ PASSED")


def test_chapter_plan_requires_an_opening_bridge():
    """Every non-opening chapter must anchor its first scene to the prior end."""
    print("  Testing opening bridge contract...", end=" ")
    from graph_novel.output_contracts import (
        OutputContractError,
        chapter_plan_contract,
    )

    plan = json.loads(mock_chapter_plan(chapter_number=2))
    plan.pop("opening_bridge")
    try:
        chapter_plan_contract(2).validate(plan)
        raise AssertionError("Expected a missing opening bridge to fail")
    except OutputContractError as exc:
        assert "opening_bridge" in str(exc)
    print("✓ PASSED")


def test_optional_source_character_null_is_normalized():
    """Non-transfer knowledge sources may use JSON null for no source actor."""
    print("  Testing nullable source character normalization...", end=" ")
    from graph_novel.output_contracts import (
        OutputContractError,
        chapter_plan_contract,
        parse_chapter_response,
    )
    from graph_novel.narrative import (
        validate_chapter_plan,
        validate_narrative_delta,
    )

    transfer = {
        "fact_id": "fact.observed.coin",
        "character": "Aria",
        "knowledge_level": "confirmed",
        "source_type": "observed",
        "source_character": None,
        "evidence": "Aria 亲眼看见硬币上的王室印记",
    }
    plan = json.loads(mock_chapter_plan())
    plan["planned_facts"] = [{
        "fact_id": transfer["fact_id"],
        "statement": "硬币带有王室印记",
        "category": "evidence",
        "visibility": "private",
    }]
    plan["information_flow"] = [dict(transfer)]
    state = make_sample_state()
    validated_plan = chapter_plan_contract(
        1,
        state_validator=lambda item: validate_chapter_plan(state, item),
    ).validate(plan)
    assert validated_plan["information_flow"][0]["source_character"] == ""

    meta = json.loads(mock_chapter_response().split("---META---", 1)[1])
    meta["facts_established"] = plan["planned_facts"]
    meta["knowledge_changes"] = [dict(transfer)]
    response = (
        MOCK_CHAPTER_DRAFT
        + "\n\n---META---\n"
        + json.dumps(meta, ensure_ascii=False)
    )
    _, validated_meta = parse_chapter_response(response)
    assert validated_meta["knowledge_changes"][0]["source_character"] == ""
    validate_narrative_delta(state, validated_plan, validated_meta)

    told_plan = json.loads(mock_chapter_plan())
    told_plan["planned_facts"] = plan["planned_facts"]
    told_plan["information_flow"] = [{
        **transfer,
        "source_type": "told",
    }]
    normalized_told = chapter_plan_contract(1).validate(told_plan)
    try:
        validate_chapter_plan(make_sample_state(), normalized_told)
        raise AssertionError("Expected told source without a character to fail")
    except OutputContractError as exc:
        assert "转述信息必须提供 source_character" in str(exc)
    print("✓ PASSED")


def test_continuity_context_reaches_all_chapter_nodes():
    """Planning, writing and review receive the exact prior approved ending."""
    print("  Testing continuity context propagation...", end=" ")
    from graph_novel.nodes import (
        chapter_planning,
        consistency_review,
        writing,
    )

    marker = "UNIQUE_APPROVED_ENDING: Kael still held the eastern gate lever."
    state = make_sample_state()
    state.current_chapter = 2
    previous = state.chapters[0]
    previous.approval = ApprovalStatus.APPROVED
    previous.polished_draft = "Earlier approved prose.\n\n" + marker
    previous.chapter_hook = "The gate had not opened yet."

    with mock.patch(
        "graph_novel.nodes.chapter_planning.call_llm_sync",
        return_value=mock_chapter_plan(chapter_number=2),
    ) as plan_call:
        chapter_planning.run_node(state)

    with mock.patch(
        "graph_novel.nodes.writing.call_llm_sync",
        return_value=mock_chapter_response(),
    ) as write_call:
        writing.run_node(state)

    with mock.patch(
        "graph_novel.nodes.consistency_review.call_llm_sync",
        return_value=json.dumps(MOCK_CONSISTENCY_REPORT),
    ) as review_call:
        consistency_review.run_node(state)

    assert marker in plan_call.call_args.args[1]
    assert marker in write_call.call_args.args[1]
    assert marker in review_call.call_args.args[1]
    print("✓ PASSED")


def test_narrative_context_is_bounded_for_long_projects():
    """Large fact stores stay bounded while retaining recent facts."""
    print("  Testing bounded long-project context...", end=" ")
    from graph_novel.narrative import build_narrative_context

    state = make_sample_state()
    state.current_chapter = 251
    for index in range(250):
        fact_id = f"fact.long.{index:03d}"
        state.narrative_facts.append(NarrativeFact(
            id=fact_id,
            statement=f"Aria long-running fact {index}",
            category="continuity",
            established_in_chapter=index + 1,
        ))
        state.character_knowledge.append(KnowledgeRecord(
            fact_id=fact_id,
            character="Aria",
            knowledge_level="confirmed",
            learned_in_chapter=index + 1,
            source_type="observed",
            evidence=f"Observed in chapter {index + 1}",
        ))

    context = json.loads(build_narrative_context(state, focus_text="Aria"))
    assert len(context["facts"]) == 120
    assert len(context["character_knowledge"]) <= 180
    assert context["facts"][-1]["fact_id"] == "fact.long.249"
    assert context["context_selection"]["facts_total"] == 250
    assert context["context_selection"]["knowledge_total"] == 250
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
        "rewrite_scope": "writing",
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

    assert plan_call.call_count == 1
    assert write_call.call_count == 2
    assert review_call.call_count == 2
    assert "未进入现场的调查员" in write_call.call_args_list[1].args[1]
    print("✓ PASSED")


def test_unresolved_bridge_violation_stops_graph():
    """Repeated bridge failures stop after bounded final-candidate reviews."""
    print("  Testing chapter bridge rewrite limit...", end=" ")
    from graph_novel.engine import GraphExecutionError

    state = make_sample_state()
    engine = GraphNovelEngine(state)
    blocked_review = dict(MOCK_CONSISTENCY_REPORT)
    blocked_review.update({
        "overall_score": 8,
        "issues": [],
        "requires_rewrite": True,
        "rewrite_scope": "writing",
        "logic_gate_passed": False,
        "bridge_gate_passed": False,
        "narrative_audit": {
            "chapter_bridge": "上一章仍在城门，本章开场却已在森林深处。",
            "causality": "本章内部因果成立。",
            "knowledge_provenance": "信息来源成立。",
            "continuity": "缺少城门到森林的移动过程。",
        },
        "narrative_violations": [{
            "severity": "严重",
            "category": "章节衔接",
            "description": "开场跳过上一章未完成动作并直接换到新地点。",
            "evidence": "前章结束在城门，本章首段已位于森林。",
            "suggested_fix": "从城门动作继续，写出离开和抵达森林的过程。",
        }],
        "summary": "文字质量合格，但章节衔接不成立。",
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
        return_value=MOCK_CHAPTER_DRAFT,
    ) as polish_call:
        try:
            engine.run_chapter_generation(1)
            raise AssertionError("Expected bridge gate to stop the graph")
        except GraphExecutionError as exc:
            assert exc.node_key == "narrative_gate_1"

    assert plan_call.call_count == 1
    assert write_call.call_count == 3
    assert review_call.call_count == 3
    assert polish_call.call_count == 3
    assert state.workflow_phase == "failed"
    assert "开场跳过上一章" in state.chapters[0].rewrite_feedback
    print("✓ PASSED")


def test_unresolved_narrative_violation_stops_graph():
    """The graph stops after bounded plan rewrites fail final review."""
    print("  Testing narrative rewrite limit...", end=" ")
    from graph_novel.engine import GraphExecutionError

    state = make_sample_state()
    engine = GraphNovelEngine(state)
    blocked_review = dict(MOCK_CONSISTENCY_REPORT)
    blocked_review.update({
        "overall_score": 8,
        "issues": [],
        "requires_rewrite": True,
        "rewrite_scope": "plan",
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
        return_value=MOCK_CHAPTER_DRAFT,
    ) as polish_call:
        try:
            engine.run_chapter_generation(1)
            raise AssertionError("Expected unresolved logic to stop the graph")
        except GraphExecutionError as exc:
            assert exc.node_key == "narrative_gate_1"

    assert plan_call.call_count == 3
    assert write_call.call_count == 3
    assert review_call.call_count == 3
    assert polish_call.call_count == 3
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
    assert state.chapters[0].narrative_delta["continuity_checkpoint"]
    assert state.chapters[0].continuity_checkpoint == {}

    engine.apply_chapter_decision(1, True, "")
    assert state.narrative_facts[0].id == "fact.archive.code"
    assert state.character_knowledge[0].character == "Aria"
    assert state.character_knowledge[0].source_type == "observed"
    checkpoint = state.chapters[0].continuity_checkpoint
    assert checkpoint["source"] == "approved_meta"
    assert checkpoint["ending_excerpt"] == MOCK_CHAPTER_DRAFT[-1600:]
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
    from graph_novel.web.app import (
        app as flask_app,
        _engines,
        _states,
    )

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
        "rewrite_scope": "none",
        "logic_gate_passed": True,
        "bridge_gate_passed": True,
        "narrative_audit": {
            "chapter_bridge": "已核对。",
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
        "style_polish_1",
        "consistency_review_1",
    ]
    assert all(event["status"] == "completed" for event in node_finished)
    assert all(event["duration_ms"] >= 0 for event in node_finished)
    assert any(
        event["event"] == "route_selected"
        and event["source"] == "consistency_review_1"
        and event["target"] == "human_approval_1"
        and event["reason"] == "final_review_passed"
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
    assert reloaded.version == 8
    assert reloaded.execution_events == state.execution_events
    print("✓ PASSED")


def test_web_observability_and_export_contract():
    """Web surfaces graph labels, recent events, and the canonical export."""
    print("  Testing Web observability + export contract...", end=" ")
    from graph_novel.web.app import (
        app as flask_app,
        _engines,
        _node_label,
        _states,
    )

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

        chapters_page = client.get(
            f"/project/{project_id}/chapters"
        ).get_data(as_text=True)
        assert "轻改文字" in chapters_page
        assert "重写正文" in chapters_page
        assert "重做规划" in chapters_page
        assert _node_label("quality_gate_2") == "第2章·成稿质量门"

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
        "rewrite_scope": "polish",
        "logic_gate_passed": True,
        "bridge_gate_passed": True,
        "narrative_audit": {
            "chapter_bridge": "已核对。",
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
    assert loaded.version == 8
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
    assert migrated.version == 8
    assert migrated.chapters[0].side_effects_committed
    assert migrated.pending_gate == "chapter:2"
    assert migrated.chapters[0].narrative_delta["chapter_summary"]

    version_five = make_sample_state()
    version_five.version = 5
    version_five.chapters[0].approval = ApprovalStatus.APPROVED
    version_five.chapters[0].polished_draft = (
        "Legacy approved chapter.\n\nUNIQUE LEGACY ENDING"
    )
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
    assert migrated_five.version == 8
    assert migrated_five.chapters[0].plan == {}
    assert (
        migrated_five.chapters[0].narrative_delta["chapter_summary"]
        == migrated_five.chapters[0].title
    )
    legacy_checkpoint = migrated_five.chapters[0].continuity_checkpoint
    assert legacy_checkpoint["source"] == "legacy_backfill"
    assert legacy_checkpoint["ending_excerpt"].endswith(
        "UNIQUE LEGACY ENDING"
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
        "continuity_checkpoint": {
            "last_scene": {
                "time": "中午",
                "location": "王城东部森林",
                "pov_character": "Aria",
                "characters_present": ["Aria"],
                "final_action": "Aria 找到带有王室印记的硬币",
                "final_dialogue": "",
            },
            "active_goals": [{
                "character": "Aria",
                "goal": "查明刺客的幕后主使",
                "next_action": "检查王室硬币的来源",
            }],
            "unresolved_actions": ["确认王室硬币为何在刺客身上"],
            "open_threads": [{
                "thread_id": "thread.black_wax_conspiracy",
                "description": "黑蜡密令与王室刺客之间的联系",
                "urgency": "high",
            }],
            "relationship_changes": {},
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


def test_human_rejection_scope_routes_to_selected_node():
    """Human rejection can request polish, prose rewrite or replanning."""
    print("  Testing human revision scope edges...", end=" ")

    state = make_sample_state()
    state.foundation_approval = ApprovalStatus.APPROVED
    engine = GraphNovelEngine(state)
    plan, write, review, polish = _chapter_pipeline_mocks()

    with mock.patch(
        "graph_novel.nodes.chapter_planning.call_llm_sync",
        return_value=plan,
    ) as plan_call, mock.patch(
        "graph_novel.nodes.writing.call_llm_sync",
        return_value=write,
    ) as write_call, mock.patch(
        "graph_novel.nodes.style_polish.call_llm_sync",
        return_value=polish,
    ) as polish_call, mock.patch(
        "graph_novel.nodes.consistency_review.call_llm_sync",
        return_value=review,
    ):
        engine.run_chapter_generation(1)
        engine.apply_chapter_decision(
            1,
            False,
            "只调整文字节奏",
            revision_scope="polish",
        )
        engine.run_chapter_generation(1)
        assert (plan_call.call_count, write_call.call_count) == (1, 1)
        assert polish_call.call_count == 2

        engine.apply_chapter_decision(
            1,
            False,
            "重写本章动作",
            revision_scope="writing",
        )
        engine.run_chapter_generation(1)
        assert (plan_call.call_count, write_call.call_count) == (1, 2)
        assert polish_call.call_count == 3

        engine.apply_chapter_decision(
            1,
            False,
            "调整本章因果计划",
            revision_scope="plan",
        )
        engine.run_chapter_generation(1)
        assert (plan_call.call_count, write_call.call_count) == (2, 3)
        assert polish_call.call_count == 4

    assert state.chapters[0].human_revision_scope == "plan"
    print("✓ PASSED")


def test_approval_requires_a_clean_final_review():
    """A stale or failed final review cannot commit chapter side effects."""
    print("  Testing final review approval guard...", end=" ")
    from graph_novel.engine import GraphExecutionError

    state = make_sample_state()
    state.foundation_approval = ApprovalStatus.APPROVED
    engine = GraphNovelEngine(state)
    plan, write, review, polish = _chapter_pipeline_mocks()

    with mock.patch(
        "graph_novel.nodes.chapter_planning.call_llm_sync",
        return_value=plan,
    ), mock.patch(
        "graph_novel.nodes.writing.call_llm_sync",
        return_value=write,
    ), mock.patch(
        "graph_novel.nodes.style_polish.call_llm_sync",
        return_value=polish,
    ), mock.patch(
        "graph_novel.nodes.consistency_review.call_llm_sync",
        return_value=review,
    ):
        engine.run_chapter_generation(1)

    chapter = state.chapters[0]
    chapter.consistency_report["requires_rewrite"] = True
    chapter.consistency_report["rewrite_scope"] = "writing"
    try:
        engine.apply_chapter_decision(1, True, "")
        raise AssertionError("Expected failed final review to block approval")
    except GraphExecutionError as exc:
        assert exc.code == "invalid_transition"

    assert chapter.approval == ApprovalStatus.PENDING
    assert not chapter.side_effects_committed
    assert state.pending_gate == "chapter:1"
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
            json={
                "approved": False,
                "feedback": "增强章末反转",
                "revision_scope": "invalid",
            },
        )
        assert response.status_code == 400

        response = client.post(
            f"/api/{project_id}/approve-chapter/1",
            json={
                "approved": False,
                "feedback": "增强章末反转",
                "revision_scope": "polish",
            },
        )
        payload = response.get_json()
        assert response.status_code == 200
        assert payload["next_action"] == "polish_chapter"
        assert state.chapters[0].human_revision_scope == "polish"

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


def test_chapter_generation_requires_approved_predecessor():
    """The chapter graph and Web UI must prevent out-of-order generation."""
    print("  Testing sequential chapter gate...", end=" ")
    from graph_novel.engine import GraphExecutionError
    from graph_novel.web.app import app as flask_app, _engines, _states

    project_id = "sequential_chapter_gate"
    state = make_sample_state()
    state.project_id = project_id
    state.save_dir = TEST_PROJECTS_DIR / project_id
    state.foundation_approval = ApprovalStatus.APPROVED
    state.workflow_phase = "chapter_loop"
    state.save()
    engine = GraphNovelEngine(state)
    _states[project_id] = state
    _engines[project_id] = engine

    try:
        engine.validate_chapter_generation(2)
        raise AssertionError("Expected chapter 2 to require chapter 1 approval")
    except GraphExecutionError as exc:
        assert exc.code == "invalid_transition"
        assert exc.node_key == "human_approval_1"

    with flask_app.test_client() as client:
        response = client.post(f"/api/{project_id}/run-chapter/2")
        assert response.status_code == 409
        assert response.get_json()["status"] == "invalid_transition"

        page = client.get(f"/project/{project_id}/chapters")
        html = page.get_data(as_text=True)
        assert 'onclick="runChapter(1)' in html
        assert 'onclick="runChapter(2)' not in html
        assert "需先完成第1章" in html

    state.chapters[0].approval = ApprovalStatus.APPROVED
    engine.validate_chapter_generation(2)
    print("✓ PASSED")


def test_chapter_generation_resumes_from_persisted_node_outputs():
    """Restart recovery reuses completed chapter nodes and rewrite budgets."""
    print("  Testing persisted chapter checkpoint resume...", end=" ")

    scenarios = {
        "writing": (0, 1, 1, 1),
        "polish": (0, 0, 1, 1),
        "review": (0, 0, 0, 1),
    }
    expected_counters = {
        "writing_contract": 1,
        "plan": 1,
        "writing": 1,
        "polish": 0,
        "total": 3,
    }

    for interrupted_node, expected_calls in scenarios.items():
        state = make_sample_state()
        state.foundation_approval = ApprovalStatus.APPROVED
        state.workflow_phase = "failed"
        chapter = state.chapters[0]
        chapter.plan = json.loads(mock_chapter_plan())
        chapter.rewrite_counters = dict(expected_counters)
        state.node_status["chapter_planning_1"] = NodeStatus.COMPLETED

        if interrupted_node in {"polish", "review"}:
            chapter.draft = MOCK_CHAPTER_DRAFT
            chapter.word_count = len(MOCK_CHAPTER_DRAFT.replace(" ", ""))
            state.node_status["writing_1"] = NodeStatus.COMPLETED
        if interrupted_node == "review":
            chapter.polished_draft = "PERSISTED POLISHED CANDIDATE"
            state.node_status["style_polish_1"] = NodeStatus.COMPLETED

        node_keys = {
            "writing": "writing_1",
            "polish": "style_polish_1",
            "review": "consistency_review_1",
        }
        state.node_status[node_keys[interrupted_node]] = NodeStatus.IN_PROGRESS
        state.last_error = {
            "node": node_keys[interrupted_node],
            "message": "service interrupted",
        }
        engine = GraphNovelEngine(state)

        with mock.patch(
            "graph_novel.nodes.chapter_planning.call_llm_sync",
            return_value=mock_chapter_plan(),
        ) as plan_call, mock.patch(
            "graph_novel.nodes.writing.call_llm_sync",
            return_value=mock_chapter_response(),
        ) as write_call, mock.patch(
            "graph_novel.nodes.style_polish.call_llm_sync",
            return_value="RESUMED POLISHED CANDIDATE",
        ) as polish_call, mock.patch(
            "graph_novel.nodes.consistency_review.call_llm_sync",
            return_value=json.dumps(MOCK_CONSISTENCY_REPORT),
        ) as review_call:
            engine.run_chapter_generation(1)

        actual_calls = (
            plan_call.call_count,
            write_call.call_count,
            polish_call.call_count,
            review_call.call_count,
        )
        assert actual_calls == expected_calls, (
            interrupted_node,
            actual_calls,
        )
        assert chapter.rewrite_counters == expected_counters
        assert state.pending_gate == "chapter:1"

    print("✓ PASSED")


def test_logic_gate_rejects_polish_only_rewrite():
    """A hard narrative gate cannot route to a wording-only revision."""
    print("  Testing hard-gate rewrite scope contract...", end=" ")
    from graph_novel.output_contracts import (
        CONSISTENCY_REVIEW_CONTRACT,
        OutputContractError,
    )

    invalid = json.loads(json.dumps(MOCK_CONSISTENCY_REPORT))
    invalid.update({
        "requires_rewrite": True,
        "rewrite_scope": "polish",
        "logic_gate_passed": False,
        "bridge_gate_passed": True,
        "summary": "Narrative logic failed but the model requested polish.",
    })
    try:
        CONSISTENCY_REVIEW_CONTRACT.validate(invalid)
        raise AssertionError("Expected hard logic gate to reject polish scope")
    except OutputContractError as exc:
        assert "rewrite_scope" in str(exc)

    print("✓ PASSED")


def test_polish_revision_uses_current_polished_candidate():
    """A wording-only revision starts from the latest polished candidate."""
    print("  Testing polish revision source...", end=" ")

    state = make_sample_state()
    state.foundation_approval = ApprovalStatus.APPROVED
    chapter = state.chapters[0]
    chapter.plan = json.loads(mock_chapter_plan())
    chapter.draft = "ORIGINAL DRAFT SHOULD NOT BE THE POLISH SOURCE"
    chapter.polished_draft = "CURRENT POLISHED CANDIDATE"
    chapter.consistency_report = dict(MOCK_CONSISTENCY_REPORT)
    chapter.approval = ApprovalStatus.REJECTED
    chapter.human_feedback = "只调整句子节奏"
    chapter.human_revision_scope = "polish"
    state.node_status.update({
        "chapter_planning_1": NodeStatus.COMPLETED,
        "writing_1": NodeStatus.COMPLETED,
        "style_polish_1": NodeStatus.COMPLETED,
        "consistency_review_1": NodeStatus.COMPLETED,
    })
    engine = GraphNovelEngine(state)

    with mock.patch(
        "graph_novel.nodes.chapter_planning.call_llm_sync",
        return_value=mock_chapter_plan(),
    ) as plan_call, mock.patch(
        "graph_novel.nodes.writing.call_llm_sync",
        return_value=mock_chapter_response(),
    ) as write_call, mock.patch(
        "graph_novel.nodes.style_polish.call_llm_sync",
        return_value="REVISED POLISHED CANDIDATE",
    ) as polish_call, mock.patch(
        "graph_novel.nodes.consistency_review.call_llm_sync",
        return_value=json.dumps(MOCK_CONSISTENCY_REPORT),
    ):
        engine.run_chapter_generation(1)

    plan_call.assert_not_called()
    write_call.assert_not_called()
    assert polish_call.call_count == 1
    polish_prompt = polish_call.call_args.args[1]
    assert "CURRENT POLISHED CANDIDATE" in polish_prompt
    assert "ORIGINAL DRAFT SHOULD NOT BE THE POLISH SOURCE" not in polish_prompt
    assert chapter.polished_draft == "REVISED POLISHED CANDIDATE"
    print("✓ PASSED")


def test_project_creation_rejects_empty_and_duplicate_slug():
    """Invalid or colliding project IDs never overwrite project state."""
    print("  Testing project ID collision guard...", end=" ")
    from graph_novel.web.app import app as flask_app, _states

    project_id = "project_collision_guard"
    payload = {
        "title": "Project Collision Guard",
        "genre": "悬疑",
        "premise": "Original premise",
        "theme": "Truth",
        "target_chapters": "5",
        "target_words": "50000",
        "notes": "Original notes",
    }

    with flask_app.test_client() as client:
        first = client.post("/create", data=payload)
        assert first.status_code == 302
        state_path = (
            TEST_PROJECTS_DIR / project_id / f"{project_id}_state.json"
        )
        original_state = state_path.read_bytes()

        duplicate = client.post("/create", data={
            **payload,
            "premise": "This must not overwrite the original",
        })
        assert duplicate.status_code == 200
        assert "已存在" in duplicate.get_data(as_text=True)
        assert state_path.read_bytes() == original_state
        assert _states[project_id].creative_premise == "Original premise"

        empty_slug = client.post("/create", data={
            **payload,
            "title": "!!!",
        })
        assert empty_slug.status_code == 200
        assert "有效的项目名称" in empty_slug.get_data(as_text=True)
        assert not (TEST_PROJECTS_DIR / "graph_novel_state.json").exists()

    print("✓ PASSED")


def test_chapter_page_paginates_and_uses_server_next_chapter():
    """Long projects render one page and never infer graph order from the DOM."""
    print("  Testing chapter pagination + server next edge...", end=" ")
    from graph_novel.web.app import app as flask_app, _states

    project_id = "chapter_pagination"
    state = make_sample_state()
    state.project_id = project_id
    state.save_dir = TEST_PROJECTS_DIR / project_id
    state.foundation_approval = ApprovalStatus.APPROVED
    state.total_chapters = 200
    state.target_total_chapters = 200
    state.chapters = [
        Chapter(chapter_number=number, title=f"Chapter {number}")
        for number in range(1, 201)
    ]
    for chapter in state.chapters[:23]:
        chapter.approval = ApprovalStatus.APPROVED
    _states[project_id] = state

    with flask_app.test_client() as client:
        first_page = client.get(
            f"/project/{project_id}/chapters"
        ).get_data(as_text=True)
        assert 'id="chapter-card-1"' in first_page
        assert 'id="chapter-card-24"' in first_page
        assert 'id="chapter-card-25"' not in first_page
        assert "const nextWritableChapter = 24;" in first_page
        assert "querySelector('.badge')" not in first_page

        second_page = client.get(
            f"/project/{project_id}/chapters?page=2"
        ).get_data(as_text=True)
        assert 'id="chapter-card-25"' in second_page
        assert 'id="chapter-card-48"' in second_page
        assert 'id="chapter-card-49"' not in second_page
        assert 'onclick="runChapter(25)' not in second_page
        assert "需先完成第24章" in second_page

        final_page = client.get(
            f"/project/{project_id}/chapters?page=9"
        ).get_data(as_text=True)
        assert 'id="chapter-card-193"' in final_page
        assert 'id="chapter-card-200"' in final_page

    print("✓ PASSED")


def test_web_output_is_safe_and_server_defaults_are_local():
    """Untrusted chapter/error text is escaped and local serving is opt-in."""
    print("  Testing Web output safety + server defaults...", end=" ")
    from graph_novel.web.app import app as flask_app, _states
    from web_server import get_server_options

    with mock.patch.dict(
        os.environ,
        {"FLASK_HOST": "", "FLASK_DEBUG": "", "PORT": ""},
        clear=False,
    ):
        host, port, debug = get_server_options()
    assert host == "127.0.0.1"
    assert port == 5500
    assert debug is False

    project_id = "safe_chapter_rendering"
    state = make_sample_state()
    state.project_id = project_id
    state.foundation_approval = ApprovalStatus.APPROVED
    state.chapters[0].draft = '<img src=x onerror="window.injected=1">'
    _states[project_id] = state

    with flask_app.test_client() as client:
        html = client.get(
            f"/project/{project_id}/chapters"
        ).get_data(as_text=True)

    assert "renderProse" in html
    assert "paragraph.textContent" in html
    assert "modal-content').innerHTML" not in html
    assert "escapeHtml(data.error" in html
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
        test_consistency_reviews_final_polished_candidate,
        test_review_scope_selects_the_smallest_rewrite_edge,
        test_rewrite_budgets_are_independent_and_persisted,
        test_chapter_plan_is_persisted_and_consumed,
        test_context_keeps_immediate_predecessor_ending,
        test_chapter_plan_requires_an_opening_bridge,
        test_optional_source_character_null_is_normalized,
        test_continuity_context_reaches_all_chapter_nodes,
        test_narrative_context_is_bounded_for_long_projects,
        test_information_transfer_requires_a_valid_source,
        test_unplanned_writing_fact_retries_without_replanning,
        test_high_score_knowledge_leak_forces_rewrite,
        test_unresolved_bridge_violation_stops_graph,
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
        test_human_rejection_scope_routes_to_selected_node,
        test_approval_requires_a_clean_final_review,
        test_chapter_failure_stops_before_gate,
        test_chapter_web_api_contract,
        test_complete_mock_web_workflow,
        test_web_task_lock_and_restart_recovery,
        test_chapter_generation_requires_approved_predecessor,
        test_chapter_generation_resumes_from_persisted_node_outputs,
        test_logic_gate_rejects_polish_only_rewrite,
        test_polish_revision_uses_current_polished_candidate,
        test_project_creation_rejects_empty_and_duplicate_slug,
        test_chapter_page_paginates_and_uses_server_next_chapter,
        test_web_output_is_safe_and_server_defaults_are_local,
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
