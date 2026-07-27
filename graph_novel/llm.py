"""Central DeepSeek provider adapter for all GraphNovel LLM calls."""

from __future__ import annotations

import asyncio
import concurrent.futures
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from openai import OpenAI


@dataclass(frozen=True)
class LLMSettings:
    base_url: str
    model: str
    timeout_seconds: float
    api_retries: int
    format_retries: int
    thinking: str
    reasoning_effort: str


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
    return LLMSettings(
        base_url=base_url,
        model=model,
        timeout_seconds=timeout_seconds,
        api_retries=api_retries,
        format_retries=format_retries,
        thinking=thinking,
        reasoning_effort=reasoning_effort,
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

    resp = await asyncio.to_thread(
        lambda: client.chat.completions.create(**request)
    )

    content = resp.choices[0].message.content
    return content.strip() if content else ""


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
