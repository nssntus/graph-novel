"""Central DeepSeek provider adapter for all GraphNovel LLM calls."""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import os
import re
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from openai import OpenAI

_DEBUG_WRITE_LOCK = threading.Lock()
_SECRET_PATTERNS = (
    re.compile(r"\bsk-[A-Za-z0-9_-]+\b", re.IGNORECASE),
    re.compile(
        r"(?i)((?:api[_ -]?key|authorization|bearer)\s*[:=]?\s*)"
        r"[^\s,;\"']+"
    ),
)


@dataclass(frozen=True)
class LLMSettings:
    base_url: str
    model: str
    timeout_seconds: float
    api_retries: int
    format_retries: int
    thinking: str
    reasoning_effort: str
    debug_file: Optional[Path]
    debug_max_chars: int


def get_llm_settings() -> LLMSettings:
    """Load and validate provider settings without reading project files."""
    timeout_seconds = _read_float_env(
        "DEEPSEEK_TIMEOUT_SECONDS",
        default=120.0,
        minimum=1.0,
        maximum=600.0,
    )
    api_retries = _read_int_env(
        "DEEPSEEK_API_RETRIES",
        default=2,
        minimum=0,
        maximum=5,
    )
    format_retries = _read_int_env(
        "DEEPSEEK_FORMAT_RETRIES",
        default=1,
        minimum=0,
        maximum=3,
    )
    thinking = os.environ.get("DEEPSEEK_THINKING", "disabled").strip().lower()
    if thinking not in {"enabled", "disabled"}:
        raise RuntimeError(
            "DEEPSEEK_THINKING must be 'enabled' or 'disabled'"
        )
    reasoning_effort = (
        os.environ.get("DEEPSEEK_REASONING_EFFORT", "high")
        .strip()
        .lower()
    )
    if reasoning_effort not in {"high", "max"}:
        raise RuntimeError(
            "DEEPSEEK_REASONING_EFFORT must be 'high' or 'max'"
        )
    base_url = (
        os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
        .strip()
        .rstrip("/")
    )
    if not base_url:
        raise RuntimeError("DEEPSEEK_BASE_URL cannot be empty")
    model = os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-pro").strip()
    if not model:
        raise RuntimeError("DEEPSEEK_MODEL cannot be empty")
    debug_file_value = os.environ.get(
        "GRAPH_NOVEL_LLM_DEBUG_FILE",
        "",
    ).strip()
    debug_max_chars = _read_int_env(
        "GRAPH_NOVEL_LLM_DEBUG_MAX_CHARS",
        default=2000,
        minimum=100,
        maximum=20000,
    )
    return LLMSettings(
        base_url=base_url,
        model=model,
        timeout_seconds=timeout_seconds,
        api_retries=api_retries,
        format_retries=format_retries,
        thinking=thinking,
        reasoning_effort=reasoning_effort,
        debug_file=Path(debug_file_value) if debug_file_value else None,
        debug_max_chars=debug_max_chars,
    )


def _get_client(settings: Optional[LLMSettings] = None) -> OpenAI:
    api_key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not api_key:
        raise RuntimeError(
            "DEEPSEEK_API_KEY not set. Export it or create a .env file."
        )
    resolved = settings or get_llm_settings()
    return OpenAI(
        api_key=api_key,
        base_url=resolved.base_url,
        timeout=resolved.timeout_seconds,
        max_retries=resolved.api_retries,
    )


async def call_llm(
    system_prompt: str,
    user_message: str,
    *,
    model: Optional[str] = None,
    max_tokens: int = 4096,
    temperature: float = 0.7,
    response_format: Optional[Dict[str, str]] = None,
    thinking: Optional[str] = None,
    reasoning_effort: Optional[str] = None,
) -> str:
    """Call DeepSeek with a system and user message."""
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_message},
    ]
    return await call_llm_messages(
        messages,
        model=model,
        max_tokens=max_tokens,
        temperature=temperature,
        response_format=response_format,
        thinking=thinking,
        reasoning_effort=reasoning_effort,
    )


async def call_llm_messages(
    messages: List[Dict[str, str]],
    *,
    model: Optional[str] = None,
    max_tokens: int = 4096,
    temperature: float = 0.7,
    response_format: Optional[Dict[str, str]] = None,
    thinking: Optional[str] = None,
    reasoning_effort: Optional[str] = None,
) -> str:
    """Call DeepSeek Chat Completions with centrally adapted parameters."""
    settings = get_llm_settings()
    client = _get_client(settings)
    thinking_mode = thinking or settings.thinking
    if thinking_mode not in {"enabled", "disabled"}:
        raise ValueError("thinking must be 'enabled' or 'disabled'")

    request: Dict[str, Any] = {
        "model": model or settings.model,
        "messages": messages,
        "max_tokens": max_tokens,
        "extra_body": {"thinking": {"type": thinking_mode}},
    }
    if thinking_mode == "enabled":
        effort = reasoning_effort or settings.reasoning_effort
        if effort not in {"high", "max"}:
            raise ValueError("reasoning_effort must be 'high' or 'max'")
        request["reasoning_effort"] = effort
    else:
        request["temperature"] = temperature
    if response_format is not None:
        request["response_format"] = response_format

    request_id = uuid.uuid4().hex
    _write_debug_event(
        settings,
        {
            "event": "request",
            "request_id": request_id,
            "model": request["model"],
            "thinking": thinking_mode,
            "messages": messages,
            "max_tokens": max_tokens,
        },
    )
    try:
        resp = await asyncio.to_thread(
            lambda: client.chat.completions.create(**request)
        )
    except Exception as exc:
        _write_debug_event(
            settings,
            {
                "event": "error",
                "request_id": request_id,
                "error": str(exc),
            },
        )
        raise

    content = resp.choices[0].message.content
    result = content.strip() if content else ""
    _write_debug_event(
        settings,
        {
            "event": "response",
            "request_id": request_id,
            "content": result,
        },
    )
    return result


def call_llm_sync(
    system_prompt: str,
    user_message: str,
    *,
    model: Optional[str] = None,
    max_tokens: int = 4096,
    temperature: float = 0.7,
    response_format: Optional[Dict[str, str]] = None,
    thinking: Optional[str] = None,
    reasoning_effort: Optional[str] = None,
) -> str:
    """Synchronous system/user wrapper safe inside an existing event loop."""
    return _run_coroutine_sync(call_llm(
        system_prompt,
        user_message,
        model=model,
        max_tokens=max_tokens,
        temperature=temperature,
        response_format=response_format,
        thinking=thinking,
        reasoning_effort=reasoning_effort,
    ))


def call_llm_messages_sync(
    messages: List[Dict[str, str]],
    *,
    model: Optional[str] = None,
    max_tokens: int = 4096,
    temperature: float = 0.7,
    response_format: Optional[Dict[str, str]] = None,
    thinking: Optional[str] = None,
    reasoning_effort: Optional[str] = None,
) -> str:
    """Synchronous multi-message wrapper for the Web creative chat."""
    return _run_coroutine_sync(call_llm_messages(
        messages,
        model=model,
        max_tokens=max_tokens,
        temperature=temperature,
        response_format=response_format,
        thinking=thinking,
        reasoning_effort=reasoning_effort,
    ))


def _run_coroutine_sync(coroutine: Any) -> str:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coroutine)

    with concurrent.futures.ThreadPoolExecutor() as executor:
        future = executor.submit(asyncio.run, coroutine)
        return future.result()


def _read_int_env(
    name: str,
    *,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    raw = os.environ.get(name)
    try:
        value = default if raw is None else int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def _read_float_env(
    name: str,
    *,
    default: float,
    minimum: float,
    maximum: float,
) -> float:
    raw = os.environ.get(name)
    try:
        value = default if raw is None else float(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be a number") from exc
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def _write_debug_event(
    settings: LLMSettings,
    payload: Dict[str, Any],
) -> None:
    """Append one best-effort JSONL event when debug logging is enabled."""
    if settings.debug_file is None:
        return

    event = {
        "timestamp": datetime.now().isoformat(),
        **_sanitize_debug_value(payload, settings.debug_max_chars),
    }
    try:
        settings.debug_file.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(event, ensure_ascii=False, default=str)
        with _DEBUG_WRITE_LOCK:
            with settings.debug_file.open("a", encoding="utf-8") as stream:
                stream.write(line + "\n")
    except OSError:
        # Diagnostics must never change the provider call's behavior.
        return


def _sanitize_debug_value(value: Any, max_chars: int) -> Any:
    if isinstance(value, str):
        redacted = value
        for pattern in _SECRET_PATTERNS:
            if pattern.groups:
                redacted = pattern.sub(r"\1[REDACTED]", redacted)
            else:
                redacted = pattern.sub("[REDACTED]", redacted)
        if len(redacted) > max_chars:
            return redacted[:max_chars] + "…[TRUNCATED]"
        return redacted
    if isinstance(value, dict):
        return {
            str(key): _sanitize_debug_value(item, max_chars)
            for key, item in value.items()
            if str(key).lower() not in {"api_key", "authorization"}
        }
    if isinstance(value, list):
        return [
            _sanitize_debug_value(item, max_chars)
            for item in value
        ]
    return value
