#!/usr/bin/env python3
"""
GraphNovel CLI — run the novel-writing graph from the command line.

Usage:
    python -m graph_novel.cli --title "My Novel" --genre fantasy --chapters 20

Environment:
    Set DEEPSEEK_API_KEY in your environment or .env file.
"""

import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from graph_novel.state import GraphNovelState
from graph_novel.engine import GraphNovelEngine
from graph_novel.exporting import approved_chapters


def main():
    parser = argparse.ArgumentParser(
        description="GraphNovel — AI-powered novel writing with graph engineering",
    )
    parser.add_argument("--title", required=True, help="Novel title")
    parser.add_argument("--genre", default="fantasy",
                        choices=["fantasy", "science_fiction", "mystery", "romance",
                                 "literary", "historical", "horror", "adventure"])
    parser.add_argument("--chapters", type=int, default=20, help="Target chapter count")
    parser.add_argument("--notes", default="", help="Creative direction / notes")
    parser.add_argument("--premise", default="", help="One-sentence premise")
    parser.add_argument("--theme", default="", help="Central thematic question")
    parser.add_argument("--output", default=".", help="Output directory")
    parser.add_argument("--auto-approve", action="store_true",
                        help="Auto-approve all human approval gates (for headless runs)")

    args = parser.parse_args()

    if not os.environ.get("DEEPSEEK_API_KEY"):
        print("错误：未设置 DEEPSEEK_API_KEY，请通过环境变量或 .env 提供。")
        sys.exit(1)

    # Create state
    output_dir = Path(args.output).resolve()
    project_id = args.title.lower().replace(" ", "_")[:50]
    save_dir = output_dir / project_id

    state = GraphNovelState(
        project_id=project_id,
        novel_title=args.title,
        save_dir=save_dir,
        creative_genre=args.genre,
        creative_premise=args.premise,
        creative_theme=args.theme,
        genre_tags=[args.genre],
        target_total_chapters=args.chapters,
        creative_notes=args.notes,
        total_chapters=args.chapters,
    )

    engine = GraphNovelEngine(state)
    engine.set_output_dir(save_dir / "output")

    # Auto-approve if requested
    if args.auto_approve:
        engine.set_foundation_approval_callback(lambda s, **kw: (True, ""))
        engine.set_approval_callback(lambda s, c: (True, ""))
        print("⚠ Auto-approve mode enabled — skipping all human review.")

    # Run
    print(f"\n{'='*60}")
    print(f"GraphNovel: '{args.title}'")
    print(f"Genre: {args.genre} | Target: {args.chapters} chapters")
    print(f"Output: {save_dir}")
    print(f"{'='*60}\n")

    result = engine.run()

    print(f"\n{'='*60}")
    print("GraphNovel run complete!")
    print(f"State saved to: {save_dir}")
    print(
        f"Chapters approved: "
        f"{len(approved_chapters(result))}/{args.chapters}"
    )
    if result.global_review_report:
        score = result.global_review_report.get("overall_score", "?")
        print(f"Global review score: {score}/10")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
