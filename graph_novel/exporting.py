"""Approved-only Markdown export shared by the Engine and Web UI."""

import re
from typing import List

from graph_novel.state import ApprovalStatus, Chapter, GraphNovelState


def approved_chapters(state: GraphNovelState) -> List[Chapter]:
    """Return exportable chapters within the configured graph boundary."""
    return [
        chapter
        for chapter in state.chapters[:state.total_chapters]
        if (
            chapter.approval == ApprovalStatus.APPROVED
            and (chapter.polished_draft or chapter.draft)
        )
    ]


def build_novel_markdown(state: GraphNovelState) -> str:
    """Build one canonical Chinese Markdown export."""
    chapters = approved_chapters(state)
    total_words = sum(chapter.word_count for chapter in chapters)
    lines = [
        f"# {state.novel_title}",
        "",
        f"已批准章节：{len(chapters)}/{state.total_chapters}",
        f"总字数：{total_words}",
        "",
    ]

    if state.novel_outline:
        outline = state.novel_outline
        lines.extend([
            f"*{outline.genre}*",
            "",
            f"> {outline.premise}",
            "",
            f"**主题：** {outline.theme}",
            "",
        ])
        if outline.shuangdian_map:
            lines.extend(["## 爽点排期表", ""])
            for item in outline.shuangdian_map:
                lines.append(
                    "- "
                    f"{item.get('chapter_range', '')} | "
                    f"{item.get('type', '')} | "
                    f"{item.get('description', '')}"
                )
            lines.append("")

    lines.extend(["---", ""])
    for chapter in chapters:
        lines.extend([
            f"## 第{chapter.chapter_number}章：{chapter.title}",
            "",
            chapter.polished_draft or chapter.draft,
            "",
        ])
    return "\n".join(lines).rstrip() + "\n"


def export_filename(state: GraphNovelState) -> str:
    """Return a stable filesystem-safe Markdown filename."""
    base = state.project_id or state.novel_title or "graph_novel"
    safe = re.sub(r'[\\/:*?"<>|\s]+', "_", base).strip("._")
    return f"{safe[:80] or 'graph_novel'}_完整版.md"
