"""
LLM client — thin wrapper around DeepSeek API (OpenAI-compatible) for all nodes.

DeepSeek uses the OpenAI chat completions format.
Base URL: https://api.deepseek.com/v1
Supported models: deepseek-v4-pro, deepseek-v4-flash
"""

from __future__ import annotations

import os

from openai import OpenAI


def _get_client() -> OpenAI:
    api_key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not api_key:
        raise RuntimeError(
            "DEEPSEEK_API_KEY not set. Export it or create a .env file."
        )
    return OpenAI(
        api_key=api_key,
        base_url="https://api.deepseek.com/v1",
    )


# ---------------------------------------------------------------------------
# Public API — exact same signature as before, all nodes use these
# ---------------------------------------------------------------------------


async def call_llm(
    system_prompt: str,
    user_message: str,
    *,
    model: str = "deepseek-v4-pro",
    max_tokens: int = 4096,
    temperature: float = 0.7,
) -> str:
    """Call DeepSeek Chat API with system + user prompts.

    Returns the response text. Raises on API errors.
    """
    import asyncio

    client = _get_client()

    # Build messages — DeepSeek supports system role natively
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_message},
    ]

    resp = await asyncio.to_thread(
        lambda: client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
        )
    )

    content = resp.choices[0].message.content
    return content.strip() if content else ""


def call_llm_sync(
    system_prompt: str,
    user_message: str,
    *,
    model: str = "deepseek-v4-pro",
    max_tokens: int = 4096,
    temperature: float = 0.7,
) -> str:
    """Synchronous wrapper for call_llm.

    Safe to call from any context (sync thread, async loop, or nested).
    """
    import asyncio
    import concurrent.futures

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # No running loop — simplest case
        return asyncio.run(
            call_llm(
                system_prompt, user_message,
                model=model, max_tokens=max_tokens, temperature=temperature,
            )
        )

    # A loop is running (e.g. inside Flask with asyncio, or pytest-asyncio).
    # Run in a separate thread to avoid nesting issues.
    with concurrent.futures.ThreadPoolExecutor() as executor:
        future = executor.submit(
            asyncio.run,
            call_llm(
                system_prompt, user_message,
                model=model, max_tokens=max_tokens, temperature=temperature,
            ),
        )
        return future.result()
