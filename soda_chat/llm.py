"""OpenAI-compatible chat/completions client (aiohttp ships with ComfyUI)."""

from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING, Any

import aiohttp

from .services import chat_url, models_url

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

ERROR_SNIPPET = 500


class LLMError(RuntimeError):
    pass


def redact(text: str, profile: dict[str, Any]) -> str:
    key = profile.get("api_key") or ""
    return text.replace(key, "***") if key else text


def _headers(profile: dict[str, Any]) -> dict[str, str]:
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if profile.get("api_key"):
        headers["Authorization"] = f"Bearer {profile['api_key']}"
    return headers


def _timeout(profile: dict[str, Any]) -> aiohttp.ClientTimeout:
    return aiohttp.ClientTimeout(total=None, sock_connect=30, sock_read=profile.get("timeout", 180))


async def _fail(response: aiohttp.ClientResponse, profile: dict[str, Any]) -> None:
    body = await response.text(errors="replace")
    raise LLMError(f"模型服务返回 {response.status}：{redact(body[:ERROR_SNIPPET], profile)}")


def _stream_error(data: dict[str, Any], profile: dict[str, Any]) -> None:
    if isinstance(data.get("error"), dict | str):
        raise LLMError(
            f"模型服务报错：{redact(json.dumps(data['error'], ensure_ascii=False)[:500], profile)}"
        )


async def _sse_pieces(
    response: aiohttp.ClientResponse, profile: dict[str, Any]
) -> AsyncIterator[tuple[str, str]]:
    async for raw in response.content:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        chunk = line[5:].strip()
        if chunk == "[DONE]":
            return
        try:
            data = json.loads(chunk)
        except ValueError:
            continue
        _stream_error(data, profile)
        delta = ((data.get("choices") or [{}])[0]).get("delta") or {}
        if delta.get("reasoning_content"):
            yield "reasoning", delta["reasoning_content"]
        if delta.get("content"):
            yield "content", delta["content"]


async def stream_chat(
    profile: dict[str, Any], messages: list[dict[str, str]], *, max_tokens: int | None = None
) -> AsyncIterator[tuple[str, str]]:
    """Yield ("content" | "reasoning", text) pieces."""
    if not profile.get("model"):
        raise LLMError("这套服务还没填模型名称")
    payload = {
        "model": profile["model"],
        "messages": messages,
        "temperature": profile.get("temperature", 0.8),
        "max_tokens": max_tokens or profile.get("max_tokens", 8192),
        "stream": bool(profile.get("stream", True)),
    }
    try:
        async with (
            aiohttp.ClientSession(timeout=_timeout(profile)) as session,
            session.post(chat_url(profile["base_url"]), json=payload, headers=_headers(profile)) as response,
        ):
            if response.status != 200:  # noqa: PLR2004
                await _fail(response, profile)
            if not payload["stream"]:
                data = await response.json(content_type=None)
                _stream_error(data, profile)
                message = (data.get("choices") or [{}])[0].get("message") or {}
                if message.get("reasoning_content"):
                    yield "reasoning", message["reasoning_content"]
                yield "content", message.get("content") or ""
                return
            async for piece in _sse_pieces(response, profile):
                yield piece
    except TimeoutError:
        raise LLMError("模型服务超时，可以在设置里调大超时") from None
    except aiohttp.ClientError as exc:
        raise LLMError(f"连不上模型服务：{redact(str(exc), profile) or type(exc).__name__}") from None


async def complete(profile: dict[str, Any], messages: list[dict[str, str]], max_tokens: int) -> str:
    parts = [
        text
        async for kind, text in stream_chat(profile, messages, max_tokens=max_tokens)
        if kind == "content"
    ]
    return "".join(parts)


async def test_connection(profile: dict[str, Any]) -> dict[str, Any]:
    started = time.monotonic()
    reply = await complete({**profile, "stream": False}, [{"role": "user", "content": "回复 OK"}], 16)
    return {"ok": True, "reply": reply.strip()[:100], "seconds": round(time.monotonic() - started, 2)}


async def list_models(profile: dict[str, Any]) -> list[str]:
    try:
        async with (
            aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as session,
            session.get(models_url(profile["base_url"]), headers=_headers(profile)) as response,
        ):
            if response.status != 200:  # noqa: PLR2004
                await _fail(response, profile)
            data = await response.json(content_type=None)
    except TimeoutError:
        raise LLMError("拉取模型列表超时") from None
    except aiohttp.ClientError as exc:
        raise LLMError(f"连不上模型服务：{redact(str(exc), profile) or type(exc).__name__}") from None
    items = data.get("data") if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise LLMError("服务没有返回模型列表，可以手动填写模型名称")
    return sorted({str(item.get("id")) for item in items if isinstance(item, dict) and item.get("id")})
