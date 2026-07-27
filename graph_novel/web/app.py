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
from enum import Enum
from pathlib import Path
from typing import Optional, Dict, List

from flask import (
    Flask, render_template, request, jsonify, redirect, url_for,
    session, flash,
)
from dotenv import load_dotenv

from graph_novel.state import (
    GraphNovelState, ApprovalStatus, NodeStatus
)
from graph_novel.engine import GraphNovelEngine

load_dotenv()

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "graph-novel-dev-secret-key")

# In-memory store for running engines (one per session)
_engines: Dict[str, GraphNovelEngine] = {}
_states: Dict[str, GraphNovelState] = {}
_approval_events: Dict[str, threading.Event] = {}
_approval_results: Dict[str, dict] = {}
_save_dir = Path(os.environ.get("GRAPH_NOVEL_DIR", str(Path.home() / "GraphNovel_Projects")))

_save_dir.mkdir(parents=True, exist_ok=True)

# Store for running engines — indexed by project_id
_running_engines: Dict[str, GraphNovelEngine] = {}

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
        target_chapters = int(request.form.get("target_chapters", "30"))
        target_words = int(request.form.get("target_words", "500000"))
        notes = request.form.get("notes", "").strip()
        # genre_tags as comma-separated list
        tags_raw = request.form.get("genre_tags", "")
        genre_tags = [t.strip() for t in tags_raw.split(",") if t.strip()]

        if not title:
            flash("请输入小说名称。", "error")
            return render_template("create.html")

        # Create state
        project_id = _slugify(title)
        state = GraphNovelState(
            novel_title=title,
            save_dir=_save_dir / project_id,
            genre_tags=genre_tags,
            target_total_words=target_words,
            creative_notes=notes,
            world_setting=None,
            total_chapters=target_chapters,
        )
        state.save()

        engine = GraphNovelEngine(state)
        engine.set_output_dir(state.save_dir / "output")

        _engines[project_id] = engine
        _states[project_id] = state
        _approval_events[project_id] = threading.Event()
        _approval_results[project_id] = {}

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
    """Run the foundation phase (nodes 1-3 + approval)."""
    engine = _get_or_create_engine(project_id)
    if not engine:
        return jsonify({"error": "Project not found"}), 404

    # Set up foundation approval to auto-approve via callback,
    # because the user will approve manually through the UI
    approval_event = threading.Event()
    approval_result = {}

    def foundation_callback(state, stage="foundation"):
        approval_event.wait()  # Wait for UI to respond
        return approval_result.get("approved", False), approval_result.get("feedback", "")

    engine.set_foundation_approval_callback(foundation_callback)

    # Store
    _approval_events[project_id] = approval_event
    _approval_results[project_id] = approval_result
    _running_engines[project_id] = engine

    # Run in background thread
    def run_phase():
        try:
            engine._run_foundation()
            engine.state.save()
        except Exception as e:
            engine.state.log(f"Foundation error: {e}")

    thread = threading.Thread(target=run_phase, daemon=True)
    thread.start()
    # Wait briefly for foundation to complete (it's fast)
    thread.join(timeout=120)

    state = engine.state
    _states[project_id] = state

    return jsonify({
        "success": True,
        "world_setting": _serialize_dataclass(state.world_setting) if state.world_setting else None,
        "characters": [_serialize_dataclass(c) for c in state.characters],
        "outline": _serialize_dataclass(state.novel_outline) if state.novel_outline else None,
        "needs_approval": True,
    })


@app.route("/api/<project_id>/approve-foundation", methods=["POST"])
def api_approve_foundation(project_id: str):
    """Approve or reject the foundation."""
    data = request.get_json()
    approved = data.get("approved", False)
    feedback = data.get("feedback", "")

    if project_id in _approval_results:
        _approval_results[project_id]["approved"] = approved
        _approval_results[project_id]["feedback"] = feedback
    if project_id in _approval_events:
        _approval_events[project_id].set()

    if project_id in _running_engines and approved:
        engine = _running_engines[project_id]
        # Complete the chapter initiation
        for ch_num in range(1, engine.state.total_chapters + 1):
            from graph_novel.state import Chapter
            if len(engine.state.chapters) < ch_num:
                engine.state.chapters.append(
                    Chapter(chapter_number=ch_num, title=f"Chapter {ch_num}")
                )
        engine.state.save()
        _states[project_id] = engine.state

    return jsonify({"success": True})


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
    )


@app.route("/api/<project_id>/run-chapter/<int:ch_num>", methods=["POST"])
def api_run_chapter(project_id: str, ch_num: int):
    """Run the pipeline for a single chapter (planning → writing → review → polish)."""
    engine = _get_or_create_engine(project_id)
    if not engine:
        return jsonify({"error": "Project not found"}), 404

    # Set up approval callback
    approval_event = threading.Event()
    approval_result = {}

    def chapter_callback(state, chapter_num):
        approval_event.wait()
        return approval_result.get("approved", False), approval_result.get("feedback", "")

    engine.set_approval_callback(chapter_callback)
    _approval_events[f"{project_id}_{ch_num}"] = approval_event
    _approval_results[f"{project_id}_{ch_num}"] = approval_result

    # Run in background thread
    def run_chapter():
        try:
            engine.run_single_chapter(ch_num)
            engine.state.save()
        except Exception as e:
            engine.state.log(f"Chapter {ch_num} error: {e}")

    thread = threading.Thread(target=run_chapter, daemon=True)
    thread.start()
    thread.join(timeout=180)

    state = engine.state
    _states[project_id] = state

    if ch_num <= len(state.chapters):
        ch = state.chapters[ch_num - 1]
        return jsonify({
            "success": True,
            "chapter": {
                "number": ch.chapter_number,
                "title": ch.title,
                "word_count": ch.word_count,
                "draft": ch.polished_draft or ch.draft,
                "consistency_score": ch.consistency_report.get("overall_score", 0) if ch.consistency_report else 0,
                "issues": ch.consistency_report.get("issues", []) if ch.consistency_report else [],
                "needs_approval": True,
            },
        })

    return jsonify({"success": False, "error": "Chapter not written"})


@app.route("/api/<project_id>/approve-chapter/<int:ch_num>", methods=["POST"])
def api_approve_chapter(project_id: str, ch_num: int):
    """Approve or reject a chapter."""
    data = request.get_json()
    approved = data.get("approved", False)
    feedback = data.get("feedback", "")

    key = f"{project_id}_{ch_num}"
    if key in _approval_results:
        _approval_results[key]["approved"] = approved
        _approval_results[key]["feedback"] = feedback
    if key in _approval_events:
        _approval_events[key].set()

    # Update state
    state = _load_or_get_state(project_id)
    if state and ch_num <= len(state.chapters):
        state.chapters[ch_num - 1].approval = (
            ApprovalStatus.APPROVED if approved else ApprovalStatus.REJECTED
        )
        state.chapters[ch_num - 1].human_feedback = feedback
        state.save()
        _states[project_id] = state

    return jsonify({"success": True})


@app.route("/api/<project_id>/run-global-review", methods=["POST"])
def api_run_global_review(project_id: str):
    """Run the global review node."""
    engine = _get_or_create_engine(project_id)
    if not engine:
        return jsonify({"error": "Project not found"}), 404

    def run_review():
        try:
            engine.run_global_review_only()
            engine.state.save()
        except Exception as e:
            engine.state.log(f"Global review error: {e}")

    thread = threading.Thread(target=run_review, daemon=True)
    thread.start()
    thread.join(timeout=300)

    state = engine.state
    _states[project_id] = state

    return jsonify({
        "success": True,
        "report": state.global_review_report,
    })


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


@app.route("/api/<project_id>/state", methods=["GET"])
def api_get_state(project_id: str):
    """Get the current state as JSON."""
    state = _load_or_get_state(project_id)
    if not state:
        return jsonify({"error": "Project not found"}), 404

    return jsonify({
        "title": state.novel_title,
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
        from graph_novel.llm import _get_client
        client = _get_client()
        resp = client.chat.completions.create(
            model="deepseek-v4-pro",
            messages=messages,
            max_tokens=2000,
            temperature=0.8,
        )
        reply = resp.choices[0].message.content.strip()
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
        if ch.polished_draft or ch.draft:
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


def _load_or_get_state(project_id: str) -> Optional[GraphNovelState]:
    """Load state from memory or disk."""
    if project_id in _states:
        return _states[project_id]

    state_path = _save_dir / project_id / f"{project_id}_state.json"
    if state_path.exists():
        state = GraphNovelState.from_json(state_path)
        _states[project_id] = state
        return state

    return None


def _get_or_create_engine(project_id: str) -> Optional[GraphNovelEngine]:
    """Get engine from memory or create from saved state."""
    if project_id in _engines:
        return _engines[project_id]

    state = _load_or_get_state(project_id)
    if not state:
        return None

    engine = GraphNovelEngine(state)
    engine.set_output_dir(state.save_dir / "output")
    _engines[project_id] = engine
    return engine


def _list_projects() -> List[dict]:
    """List all saved novel projects."""
    projects = []
    if not _save_dir.exists():
        return projects

    for project_dir in sorted(_save_dir.iterdir(), reverse=True):
        if project_dir.is_dir():
            state_file = project_dir / f"{project_dir.name}_state.json"
            if state_file.exists():
                try:
                    data = json.loads(state_file.read_text())
                    projects.append({
                        "id": project_dir.name,
                        "title": data.get("novel_title", project_dir.name),
                        "chapters": len(data.get("chapters", [])),
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
