"""
GraphNovel Web Application — Flask-based UI for the novel writing graph.

Provides:
- Project creation and configuration
- Foundation phase with human approval
- Per-chapter pipeline execution and review
- Global review dashboard
- Novel export
"""

import os
import json
import threading
import uuid
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from flask import (
    Flask, render_template, request, jsonify, redirect, url_for,
    session, flash,
)
from dotenv import load_dotenv

from graph_novel.state import (
    GraphNovelState, ApprovalStatus, NodeStatus
)
from graph_novel.engine import GraphNovelEngine, GraphExecutionError

load_dotenv()

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "graph-novel-dev-secret-key")

# Process-local engine cache, task threads, and project locks.
_engines: Dict[str, GraphNovelEngine] = {}
_states: Dict[str, GraphNovelState] = {}
_project_locks: Dict[str, threading.Lock] = {}
_task_threads: Dict[str, threading.Thread] = {}
_registry_lock = threading.Lock()
_save_dir = Path(os.environ.get("GRAPH_NOVEL_DIR", str(Path.home() / "GraphNovel_Projects")))

_save_dir.mkdir(parents=True, exist_ok=True)

# ======================================================================
# Routes
# ======================================================================


@app.route("/")
def index():
    """Home page — list existing projects or create new."""
    projects = _list_projects()
    return render_template("index.html", projects=projects)


@app.route("/create", methods=["GET", "POST"])
def create_project():
    """Create a new novel project for 番茄小说."""
    if request.method == "POST":
        title = request.form.get("title", "").strip()
        genre = request.form.get("genre", "都市脑洞").strip()
        premise = request.form.get("premise", "").strip()
        theme = request.form.get("theme", "").strip()
        try:
            target_chapters = int(request.form.get("target_chapters", "30"))
            target_words = int(request.form.get("target_words", "500000"))
        except (TypeError, ValueError):
            flash("目标章数和目标总字数必须是整数。", "error")
            return render_template("create.html")
        notes = request.form.get("notes", "").strip()
        # genre_tags as comma-separated list
        tags_raw = request.form.get("genre_tags", "")
        genre_tags = [t.strip() for t in tags_raw.split(",") if t.strip()]

        if not title:
            flash("请输入小说名称。", "error")
            return render_template("create.html")
        if not 5 <= target_chapters <= 200:
            flash("目标章数必须在 5 到 200 之间。", "error")
            return render_template("create.html")
        if not 50000 <= target_words <= 5000000:
            flash("目标总字数必须在 5 万到 500 万之间。", "error")
            return render_template("create.html")

        # Create state
        project_id = _slugify(title)
        state = GraphNovelState(
            project_id=project_id,
            novel_title=title,
            save_dir=_save_dir / project_id,
            creative_genre=genre,
            creative_premise=premise,
            creative_theme=theme,
            genre_tags=genre_tags,
            target_total_words=target_words,
            target_total_chapters=target_chapters,
            creative_notes=notes,
            world_setting=None,
            total_chapters=target_chapters,
        )
        state.save()

        engine = GraphNovelEngine(state)
        engine.set_output_dir(state.save_dir / "output")

        with _registry_lock:
            _engines[project_id] = engine
            _states[project_id] = state

        return redirect(url_for("foundation", project_id=project_id))

    return render_template("create.html")


@app.route("/project/<project_id>")
def project_dashboard(project_id: str):
    """Project dashboard."""
    state = _load_or_get_state(project_id)
    if not state:
        flash("Project not found.", "error")
        return redirect(url_for("index"))

    return render_template(
        "dashboard.html",
        project_id=project_id,
        state=state,
        approved_count=sum(
            1
            for chapter in state.chapters
            if chapter.approval == ApprovalStatus.APPROVED
        ),
    )


@app.route("/project/<project_id>/foundation")
def foundation(project_id: str):
    """Foundation phase — world building, character design, outline planning."""
    state = _load_or_get_state(project_id)
    if not state:
        flash("Project not found.", "error")
        return redirect(url_for("index"))

    return render_template(
        "foundation.html",
        project_id=project_id,
        state=state,
    )


@app.route("/api/<project_id>/run-foundation", methods=["POST"])
def api_run_foundation(project_id: str):
    """Start Foundation nodes 1-3 in the background."""
    engine = _get_or_create_engine(project_id)
    if not engine:
        return jsonify({"error": "Project not found"}), 404

    task, error = _start_project_task(
        project_id=project_id,
        engine=engine,
        kind="foundation",
        runner=engine.run_foundation_generation,
        preflight=engine.validate_foundation_generation,
    )
    if error:
        payload, status_code = error
        return jsonify(payload), status_code

    return jsonify({
        "success": True,
        "status": "running",
        "task": task,
    }), 202


@app.route("/api/<project_id>/approve-foundation", methods=["POST"])
def api_approve_foundation(project_id: str):
    """Approve or reject the foundation."""
    engine = _get_or_create_engine(project_id)
    if not engine:
        return jsonify({"error": "Project not found"}), 404

    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not isinstance(data.get("approved"), bool):
        return jsonify({"error": "approved must be a boolean"}), 400

    approved = data["approved"]
    feedback = str(data.get("feedback", "")).strip()
    if not approved and not feedback:
        return jsonify({"error": "驳回 Foundation 时请填写修改意见。"}), 400

    project_lock = _get_project_lock(project_id)
    if not project_lock.acquire(blocking=False):
        return jsonify(_busy_payload(engine.state)), 409

    try:
        state = engine.apply_foundation_decision(approved, feedback)
        _complete_decision_task(
            state,
            outcome="approved" if approved else "rejected",
        )
    except GraphExecutionError as exc:
        return jsonify({
            "success": False,
            "status": "invalid_transition",
            "node": exc.node_key,
            "error": str(exc),
        }), 409
    finally:
        project_lock.release()

    _states[project_id] = state
    return jsonify({
        "success": True,
        "status": "approved" if approved else "rejected",
        "next_action": (
            "chapters" if approved else "regenerate_foundation"
        ),
    })


@app.route("/project/<project_id>/chapters")
def chapters_list(project_id: str):
    """Chapter list and management."""
    state = _load_or_get_state(project_id)
    if not state:
        flash("Project not found.", "error")
        return redirect(url_for("index"))

    return render_template(
        "chapters.html",
        project_id=project_id,
        state=state,
        approved_count=sum(
            1
            for chapter in state.chapters
            if chapter.approval == ApprovalStatus.APPROVED
        ),
    )


@app.route("/api/<project_id>/run-chapter/<int:ch_num>", methods=["POST"])
def api_run_chapter(project_id: str, ch_num: int):
    """Start chapter nodes 4-7 in the background."""
    engine = _get_or_create_engine(project_id)
    if not engine:
        return jsonify({"error": "Project not found"}), 404

    task, error = _start_project_task(
        project_id=project_id,
        engine=engine,
        kind="chapter",
        runner=lambda: engine.run_chapter_generation(ch_num),
        preflight=lambda: engine.validate_chapter_generation(ch_num),
        chapter=ch_num,
    )
    if error:
        payload, status_code = error
        return jsonify(payload), status_code

    return jsonify({
        "success": True,
        "status": "running",
        "task": task,
    }), 202


@app.route("/api/<project_id>/approve-chapter/<int:ch_num>", methods=["POST"])
def api_approve_chapter(project_id: str, ch_num: int):
    """Approve or reject a chapter."""
    engine = _get_or_create_engine(project_id)
    if not engine:
        return jsonify({"error": "Project not found"}), 404

    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not isinstance(data.get("approved"), bool):
        return jsonify({"error": "approved must be a boolean"}), 400

    approved = data["approved"]
    feedback = str(data.get("feedback", "")).strip()
    if not approved and not feedback:
        return jsonify({"error": "驳回章节时请填写修改意见。"}), 400

    project_lock = _get_project_lock(project_id)
    if not project_lock.acquire(blocking=False):
        return jsonify(_busy_payload(engine.state)), 409

    try:
        state = engine.apply_chapter_decision(ch_num, approved, feedback)
        _complete_decision_task(
            state,
            outcome="approved" if approved else "rejected",
        )
    except GraphExecutionError as exc:
        return jsonify({
            "success": False,
            "status": "invalid_transition",
            "node": exc.node_key,
            "error": str(exc),
        }), 409
    finally:
        project_lock.release()

    _states[project_id] = state
    if not approved:
        next_action = "rewrite_chapter"
    elif state.workflow_phase == "global_review":
        next_action = "global_review"
    else:
        next_action = "next_chapter"

    return jsonify({
        "success": True,
        "status": "approved" if approved else "rejected",
        "next_action": next_action,
    })


@app.route("/api/<project_id>/run-global-review", methods=["POST"])
def api_run_global_review(project_id: str):
    """Start Node 9 in the background."""
    engine = _get_or_create_engine(project_id)
    if not engine:
        return jsonify({"error": "Project not found"}), 404

    task, error = _start_project_task(
        project_id=project_id,
        engine=engine,
        kind="global_review",
        runner=engine.run_global_review_only,
        preflight=engine.validate_global_review,
    )
    if error:
        payload, status_code = error
        return jsonify(payload), status_code

    return jsonify({
        "success": True,
        "status": "running",
        "task": task,
    }), 202


@app.route("/project/<project_id>/review")
def global_review_page(project_id: str):
    """Global review dashboard."""
    state = _load_or_get_state(project_id)
    if not state:
        flash("Project not found.", "error")
        return redirect(url_for("index"))

    return render_template(
        "review.html",
        project_id=project_id,
        state=state,
    )


@app.route("/api/<project_id>/task-status", methods=["GET"])
def api_task_status(project_id: str):
    """Return the persisted execution status for one project."""
    state = _load_or_get_state(project_id)
    if not state:
        return jsonify({"error": "Project not found"}), 404
    return jsonify(_task_status_payload(state))


@app.route("/api/<project_id>/state", methods=["GET"])
def api_get_state(project_id: str):
    """Get the current state as JSON."""
    state = _load_or_get_state(project_id)
    if not state:
        return jsonify({"error": "Project not found"}), 404

    return jsonify({
        "title": state.novel_title,
        "workflow_phase": state.workflow_phase,
        "pending_gate": state.pending_gate,
        "task_status": _task_status_payload(state)["status"],
        "active_task": state.active_task,
        "foundation_approval": state.foundation_approval.value,
        "current_chapter": state.current_chapter,
        "total_chapters": state.total_chapters,
        "node_status": {k: v.value for k, v in state.node_status.items()},
        "chapters": [
            {
                "number": ch.chapter_number,
                "title": ch.title,
                "word_count": ch.word_count,
                "approval": ch.approval.value,
                "score": ch.consistency_report.get("overall_score", 0) if ch.consistency_report else 0,
            }
            for ch in state.chapters
        ],
        "characters": [{"name": c.name, "role": c.role} for c in state.characters],
        "foreshadowing_count": len(state.foreshadowing_tracker),
    })


@app.route("/api/<project_id>/chapter/<int:ch_num>", methods=["GET"])
def api_get_chapter(project_id: str, ch_num: int):
    """Get a specific chapter's content."""
    state = _load_or_get_state(project_id)
    if not state or ch_num > len(state.chapters):
        return jsonify({"error": "Chapter not found"}), 404

    ch = state.chapters[ch_num - 1]
    return jsonify({
        "number": ch.chapter_number,
        "title": ch.title,
        "draft": ch.draft,
        "polished": ch.polished_draft,
        "word_count": ch.word_count,
        "approval": ch.approval.value,
        "feedback": ch.human_feedback,
        "revision_count": ch.revision_count,
        "consistency": ch.consistency_report,
        "outline": _serialize_dataclass(ch.outline) if ch.outline else None,
    })


@app.route("/download/<project_id>/state")
def download_state(project_id: str):
    """Download the full state JSON."""
    state = _load_or_get_state(project_id)
    if not state:
        return "Not found", 404
    return app.response_class(
        state.to_json(),
        mimetype="application/json",
        headers={"Content-Disposition": f"attachment; filename={project_id}_state.json"},
    )


# ======================================================================
# Creative Chat API
# ======================================================================

@app.route("/chat-test")
def chat_test_page():
    """Quick standalone chat test page."""
    from flask import render_template as _rt
    return _rt("chat-test.html")


@app.route("/api/<project_id>/chat", methods=["POST"])
def api_chat(project_id: str):
    """Creative chat assistant — discuss novel ideas with the AI.

    Works in two modes:
    - project_id == "creative": standalone creative brainstorm, no project context
    - project_id matches a real project: uses novel state as context
    """
    data = request.get_json()
    user_message = data.get("message", "").strip()
    chat_history = data.get("history", [])  # [{role, content}]

    if not user_message:
        return jsonify({"error": "Empty message"}), 400

    # Load project state if available, otherwise creative-only mode
    state = None
    if project_id != "creative":
        state = _load_or_get_state(project_id)

    # Build context from current novel state (if any)
    context_blocks = []

    if state and state.novel_title:
        context_blocks.append(f"小说书名：《{state.novel_title}》")
        context_blocks.append(f"目标平台：番茄小说")

    if state and state.genre_tags:
        context_blocks.append(f"题材标签：{'、'.join(state.genre_tags)}")

    if state and state.novel_outline:
        no = state.novel_outline
        context_blocks.append(f"题材：{no.genre}")
        context_blocks.append(f"一句话卖点：{no.premise}")
        context_blocks.append(f"主题：{no.theme}")
        if no.target_length:
            context_blocks.append(f"目标篇幅：{no.target_length}")
        if no.shuangdian_map:
            sd_text = "；".join([
                f"{s.get('chapter_range','')}: {s.get('type','')}({s.get('description','')[:50]})"
                for s in no.shuangdian_map[:5]
            ])
            context_blocks.append(f"爽点排期：{sd_text}")

    if state and state.world_setting:
        ws = state.world_setting
        context_blocks.append(f"世界背景：{ws.era} / {ws.location}")
        if ws.magic_system:
            context_blocks.append(f"核心设定：{ws.magic_system}")
        if ws.notes:
            context_blocks.append(f"金手指/备注：{ws.notes[:150]}")

    if state and state.characters:
        char_lines = []
        for c in state.characters[:5]:
            char_lines.append(f"  {c.name}（{c.role}）：{c.motivation[:60]}")
        context_blocks.append(f"主要角色：\n" + "\n".join(char_lines))

    # Chapter progress
    if state and state.chapters:
        written = [ch for ch in state.chapters if ch.polished_draft]
        context_blocks.append(f"章节进度：{len(written)}/{state.total_chapters}章已完成")
        # Latest chapter summary
        if written:
            latest = written[-1]
            context_blocks.append(f"最新章节：第{latest.chapter_number}章《{latest.title}》（{latest.word_count}字）")

    novel_context = "\n".join(context_blocks) if context_blocks else "尚无小说项目信息，作者正在构思阶段。请自由地和他讨论创意——聊什么都行，帮他理清思路。这个阶段不要催促他填信息，而是用对话帮他找到方向。"

    is_creative_mode = not context_blocks

    SYSTEM_PROMPT = f"""你是「番茄小说工坊」的创意助手，名叫「小番」。你是一位网文创意顾问，
专门帮作者讨论小说创意、情节构思、人物设计、爽点安排、平台策略等问题。

你了解番茄小说平台的规则：黄金三章、爽点节奏（3章一小爽/10章一大爽）、
章末钩子、AI写作禁忌、算法适配等。

当前小说的信息：
{novel_context}

{"**重要：作者现在还没有创建任何小说项目。你的首要任务是和他自由地聊创意——不要催促他去填表，不要让他先去创建项目。用轻松自然的对话帮他理清想法。如果他提到某个感兴趣的方向，你就顺着那个方向深挖，给具体的建议。当聊得差不多了，自然地提议「要不要我把刚才聊的这些整理成一个项目初稿？」这只是个温和的建议，不是必须立刻做的事。**" if is_creative_mode else ""}

你的风格：
- 热情专业，像一位懂行的写作搭档
- 给具体建议，不说空话
- 用中文回复，语气亲切自然
- 如果作者问某个情节是否合理，从番茄读者视角给判断
- 如果作者卡文了，提供3-5个具体的破局思路
- 回复简洁有力，每段不超过3行（手机阅读习惯）

在讨论中你可以提到：
- 这个设定在番茄平台上能不能留住读者
- 爽点密度够不够
- 黄金三章有没有踩准节奏
- 角色的人设辨识度够不够
- AI写作病要避开什么"""

    # Build messages for DeepSeek
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for h in chat_history[-20:]:  # Keep last 20 turns
        messages.append({"role": h.get("role", "user"), "content": h.get("content", "")})
    messages.append({"role": "user", "content": user_message})

    try:
        from graph_novel.llm import call_llm_messages_sync
        reply = call_llm_messages_sync(
            messages,
            max_tokens=2000,
            temperature=0.8,
        )
        return jsonify({"success": True, "reply": reply})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/download/<project_id>/novel")
def download_novel(project_id: str):
    """Download the complete novel as markdown."""
    state = _load_or_get_state(project_id)
    if not state:
        return "Not found", 404

    novel_text = f"# {state.novel_title}\n\n"
    if state.novel_outline:
        novel_text += f"*{state.novel_outline.genre}*\n\n"
        novel_text += f"> {state.novel_outline.premise}\n\n"
        novel_text += f"**Theme:** {state.novel_outline.theme}\n\n---\n\n"

    for ch in state.chapters:
        if (
            ch.approval == ApprovalStatus.APPROVED
            and (ch.polished_draft or ch.draft)
        ):
            novel_text += f"## Chapter {ch.chapter_number}: {ch.title}\n\n"
            novel_text += (ch.polished_draft or ch.draft)
            novel_text += "\n\n"

    return app.response_class(
        novel_text,
        mimetype="text/markdown",
        headers={"Content-Disposition": f"attachment; filename={project_id}_novel.md"},
    )


# ======================================================================
# Helpers
# ======================================================================


def _get_project_lock(project_id: str) -> threading.Lock:
    with _registry_lock:
        lock = _project_locks.get(project_id)
        if lock is None:
            lock = threading.Lock()
            _project_locks[project_id] = lock
        return lock


def _start_project_task(
    project_id: str,
    engine: GraphNovelEngine,
    kind: str,
    runner: Callable[[], GraphNovelState],
    preflight: Callable[[], None],
    chapter: Optional[int] = None,
):
    """Validate, persist, and start one project-scoped background task."""
    project_lock = _get_project_lock(project_id)
    if not project_lock.acquire(blocking=False):
        return None, (_busy_payload(engine.state), 409)

    try:
        preflight()
    except GraphExecutionError as exc:
        project_lock.release()
        return None, (_graph_error_payload(exc), 409)
    except Exception as exc:
        project_lock.release()
        return None, ({
            "success": False,
            "status": "failed",
            "error": str(exc),
        }, 500)

    task: Dict[str, Any] = {
        "id": uuid.uuid4().hex,
        "kind": kind,
        "status": "running",
        "started_at": datetime.now().isoformat(),
        "finished_at": "",
        "error": {},
    }
    if chapter is not None:
        task["chapter"] = chapter

    state = engine.state
    state.active_task = task
    try:
        state.save()
    except Exception as exc:
        task["status"] = "failed"
        task["error"] = {"code": "checkpoint_failed", "message": str(exc)}
        project_lock.release()
        return None, ({
            "success": False,
            "status": "failed",
            "error": f"Unable to save task checkpoint: {exc}",
        }, 500)

    thread = threading.Thread(
        target=_run_project_task,
        args=(project_id, engine, task.copy(), runner, project_lock),
        daemon=True,
        name=f"graph-novel-{project_id}-{kind}",
    )
    with _registry_lock:
        _task_threads[project_id] = thread
        _states[project_id] = state

    try:
        thread.start()
    except Exception as exc:
        with _registry_lock:
            _task_threads.pop(project_id, None)
        task["status"] = "failed"
        task["finished_at"] = datetime.now().isoformat()
        task["error"] = {"code": "thread_start_failed", "message": str(exc)}
        state.active_task = task
        state.workflow_phase = "failed"
        state.last_error = {
            "node": kind,
            "message": str(exc),
            "code": "thread_start_failed",
        }
        state.save()
        project_lock.release()
        return None, ({
            "success": False,
            "status": "failed",
            "error": str(exc),
        }, 500)

    return task, None


def _run_project_task(
    project_id: str,
    engine: GraphNovelEngine,
    task: Dict[str, Any],
    runner: Callable[[], GraphNovelState],
    project_lock: threading.Lock,
) -> None:
    """Execute one task and always persist its terminal status."""
    state = engine.state
    terminal_status = "failed"
    task_error: Dict[str, Any] = {}
    try:
        state = runner()
        terminal_status = (
            "awaiting_approval" if state.pending_gate else "completed"
        )
    except GraphExecutionError as exc:
        state = engine.state
        task_error = {
            "code": exc.code,
            "node": exc.node_key,
            "message": str(exc),
        }
        if not state.last_error:
            state.last_error = {
                "node": exc.node_key,
                "message": str(exc),
                "code": exc.code,
            }
    except Exception as exc:
        state = engine.state
        state.workflow_phase = "failed"
        state.pending_gate = None
        state.last_error = {
            "node": task["kind"],
            "message": str(exc),
            "code": "task_failed",
        }
        task_error = {
            "code": "task_failed",
            "node": task["kind"],
            "message": str(exc),
        }
    finally:
        task["status"] = terminal_status
        task["finished_at"] = datetime.now().isoformat()
        task["error"] = task_error
        if terminal_status == "awaiting_approval":
            task["pending_gate"] = state.pending_gate
        state.active_task = task
        try:
            state.save()
        except Exception as exc:
            state.log(f"Task checkpoint save failed: {exc}")
        with _registry_lock:
            _states[project_id] = state
            current = _task_threads.get(project_id)
            if current is threading.current_thread():
                _task_threads.pop(project_id, None)
        project_lock.release()


def _complete_decision_task(
    state: GraphNovelState,
    outcome: str,
) -> None:
    task = dict(state.active_task)
    if not task:
        task = {
            "id": uuid.uuid4().hex,
            "kind": "decision",
            "started_at": datetime.now().isoformat(),
        }
    task["status"] = "completed"
    task["outcome"] = outcome
    task["decision_at"] = datetime.now().isoformat()
    task["error"] = {}
    task.pop("pending_gate", None)
    state.active_task = task
    state.save()


def _busy_payload(state: GraphNovelState) -> Dict[str, Any]:
    return {
        "success": False,
        "status": "busy",
        "error": "该项目已有任务正在运行，请等待当前任务完成。",
        "task": state.active_task,
    }


def _graph_error_payload(exc: GraphExecutionError) -> Dict[str, Any]:
    return {
        "success": False,
        "status": "invalid_transition",
        "node": exc.node_key,
        "error": str(exc),
    }


def _task_status_payload(state: GraphNovelState) -> Dict[str, Any]:
    task = dict(state.active_task)
    task_status = task.get("status")
    if task_status == "running":
        status = "running"
    elif state.pending_gate:
        status = "awaiting_approval"
    elif task_status == "failed" or state.workflow_phase == "failed":
        status = "failed"
    elif task_status == "completed" or state.workflow_phase == "done":
        status = "completed"
    else:
        status = "idle"

    current_node = ""
    if status == "failed":
        current_node = state.last_error.get("node", "")
    elif status == "awaiting_approval":
        current_node = state.pending_gate or ""
    elif status == "running":
        in_progress = [
            key
            for key, node_status in state.node_status.items()
            if node_status == NodeStatus.IN_PROGRESS
        ]
        current_node = in_progress[-1] if in_progress else task.get("kind", "")

    return {
        "success": True,
        "status": status,
        "task": task,
        "workflow_phase": state.workflow_phase,
        "pending_gate": state.pending_gate,
        "current_node": current_node,
        "last_error": state.last_error,
    }


def _recover_interrupted_task(state: GraphNovelState) -> None:
    """Normalize a persisted task that has no surviving worker thread."""
    task = dict(state.active_task)
    status = task.get("status")
    if status == "running":
        task["finished_at"] = datetime.now().isoformat()
        if state.pending_gate:
            task["status"] = "awaiting_approval"
            task["pending_gate"] = state.pending_gate
            task["error"] = {}
        elif state.workflow_phase == "done":
            task["status"] = "completed"
            task["error"] = {}
        else:
            error = {
                "code": "interrupted",
                "node": task.get("kind", "task"),
                "message": "服务重启导致后台任务中断，请重新运行。",
            }
            task["status"] = "failed"
            task["error"] = error
            state.workflow_phase = "failed"
            state.last_error = error
    elif status == "awaiting_approval" and not state.pending_gate:
        task["status"] = "completed"
        task["decision_at"] = datetime.now().isoformat()

    if task != state.active_task:
        state.active_task = task
        state.save()


def _load_or_get_state(project_id: str) -> Optional[GraphNovelState]:
    """Load state from memory or disk."""
    with _registry_lock:
        cached = _states.get(project_id)
    if cached is not None:
        return cached

    project_dir = _save_dir / project_id
    state_paths = (
        project_dir / f"{project_id}_state.json",
        project_dir / "graph_novel_state.json",
    )
    for state_path in state_paths:
        if state_path.exists():
            state = GraphNovelState.from_json(state_path)
            if not state.project_id:
                state.project_id = project_id
            _recover_interrupted_task(state)
            with _registry_lock:
                existing = _states.setdefault(project_id, state)
            return existing

    return None


def _get_or_create_engine(project_id: str) -> Optional[GraphNovelEngine]:
    """Get engine from memory or create from saved state."""
    with _registry_lock:
        cached = _engines.get(project_id)
    if cached is not None:
        return cached

    state = _load_or_get_state(project_id)
    if not state:
        return None

    engine = GraphNovelEngine(state)
    engine.set_output_dir(state.save_dir / "output")
    with _registry_lock:
        existing = _engines.setdefault(project_id, engine)
    return existing


def _list_projects() -> List[dict]:
    """List all saved novel projects."""
    projects = []
    if not _save_dir.exists():
        return projects

    for project_dir in sorted(_save_dir.iterdir(), reverse=True):
        if project_dir.is_dir():
            state_file = project_dir / f"{project_dir.name}_state.json"
            if not state_file.exists():
                state_file = project_dir / "graph_novel_state.json"
            if state_file.exists():
                try:
                    data = json.loads(state_file.read_text())
                    completed_chapters = sum(
                        1
                        for chapter in data.get("chapters", [])
                        if chapter.get("approval") == ApprovalStatus.APPROVED.value
                    )
                    projects.append({
                        "id": project_dir.name,
                        "title": data.get("novel_title", project_dir.name),
                        "chapters": completed_chapters,
                        "total_chapters": data.get("total_chapters", 0),
                        "created_at": data.get("created_at", ""),
                    })
                except (json.JSONDecodeError, KeyError):
                    pass
    return projects


def _slugify(text: str) -> str:
    """Create a URL-safe slug from text."""
    import re
    slug = text.lower().strip()
    slug = re.sub(r'[^\w\s-]', '', slug)
    slug = re.sub(r'[-\s]+', '_', slug)
    return slug[:50]


# ======================================================================
# Main
# ======================================================================

def _serialize_dataclass(obj):
    """Serialize a dataclass to dict, handling nested dataclasses + enums."""
    if obj is None:
        return None
    if isinstance(obj, Enum):
        return obj.value
    if isinstance(obj, Path):
        return str(obj)
    if isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, list):
        return [_serialize_dataclass(v) for v in obj]
    if isinstance(obj, dict):
        return {k: _serialize_dataclass(v) for k, v in obj.items()}
    if hasattr(obj, '__dataclass_fields__'):
        result = {}
        for k, v in obj.__dataclass_fields__.items():
            result[k] = _serialize_dataclass(getattr(obj, k))
        return result
    return str(obj)


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5500)
