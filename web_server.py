#!/usr/bin/env python3
"""
GraphNovel Web Server — launch the Flask web UI.

Usage:
    python -m graph_novel.web.app
    # or:
    python web_server.py

Environment:
    DEEPSEEK_API_KEY  — required
    FLASK_SECRET_KEY   — optional (dev default)
    GRAPH_NOVEL_DIR    — project storage directory
"""

import os
import sys
from typing import Tuple

from dotenv import load_dotenv

load_dotenv()

if not os.environ.get("DEEPSEEK_API_KEY"):
    print("Warning: DEEPSEEK_API_KEY not set. LLM calls will fail.")
    print("Export your key or create a .env file with DEEPSEEK_API_KEY=your-key")

from graph_novel.web.app import app


def get_server_options() -> Tuple[str, int, bool]:
    """Resolve explicit development overrides with local-only defaults."""
    host = os.environ.get("FLASK_HOST", "").strip() or "127.0.0.1"
    port = int(os.environ.get("PORT", "").strip() or "5500")
    debug = os.environ.get("FLASK_DEBUG", "").strip() == "1"
    return host, port, debug


if __name__ == "__main__":
    host, port, debug = get_server_options()
    print(f"\n📖 GraphNovel Web UI starting at http://{host}:{port}")
    print(f"Projects stored in: {os.environ.get('GRAPH_NOVEL_DIR', '~/GraphNovel_Projects')}\n")
    app.run(host=host, port=port, debug=debug)
