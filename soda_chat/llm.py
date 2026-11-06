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


class EmptyReplyError(LLMError):
    """A valid model response contained no visible answer text."""


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
    raise LLMError(f"模型服务返回 {response.status}：{redact(body, profile)[:ERROR_SNIPPET]}")


def _stream_error(data: dict[str, Any], profile: dict[str, Any]) -> None:
    if isinstance(data.get("error"), dict | str):
        raise LLMError(
            f"模型服务报错：{redact(json.dumps(data['error'], ensure_ascii=False), profile)[:ERROR_SNIPPET]}"
        )


def _choice(data: Any, profile: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise LLMError("模型服务返回的内容不是有效的聊天响应")
    _stream_error(data, profile)
    choices = data.get("choices", [])
    if not isinstance(choices, list) or (choices and not isinstance(choices[0], dict)):
        raise LLMError("模型服务返回的 choices 格式不正确")
    return choices[0] if choices else {}


def _pieces(message: Any) -> list[tuple[str, str]]:
    if not isinstance(message, dict):
        raise LLMError("模型服务返回的消息格式不正确")
    result = []
    for kind, field in (("reasoning", "reasoning_content"), ("content", "content")):
        value = message.get(field)
        if value is None:
            continue
        if isinstance(value, list):
            if any(not isinstance(part, dict) or not isinstance(part.get("text", ""), str) for part in value):
                raise LLMError("模型服务返回的文字块格式不正确")
            value = "".join(part.get("text", "") for part in value)
        if not isinstance(value, str):
            raise LLMError("模型服务返回的消息内容不是文字")
        if value:
            result.append((kind, value))
    return result


async def _sse_pieces(
    response: aiohttp.ClientResponse, profile: dict[str, Any]
) -> AsyncIterator[tuple[str, str]]:
    finished = False
    has_content = False
    async for raw in response.content:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        chunk = line[5:].strip()
        if chunk == "[DONE]":
            finished = True
            break
        try:
            data = json.loads(chunk)
        except ValueError:
            raise LLMError("模型服务返回了无效的流式 JSON，已保留收到的回复") from None
        choice = _choice(data, profile)
        for kind, piece in _pieces(choice.get("delta") or {}):
            has_content = has_content or (kind == "content" and bool(piece.strip()))
            yield kind, piece
        if choice.get("finish_reason"):
            finished = True
    if not finished:
        raise LLMError("模型回复连接提前结束，已保留收到的内容，请重试")
    if not has_content:
        raise EmptyReplyError("模型没有返回可显示的文字，请检查模型名称或提高输出长度")


async def stream_chat(
    profile: dict[str, Any], messages: list[dict[str, Any]], *, max_tokens: int | None = None
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
                try:
                    data = await response.json(content_type=None)
                except (ValueError, UnicodeDecodeError):
                    raise LLMError("模型服务没有返回有效的 JSON，请检查服务地址和接口类型") from None
                pieces = _pieces(_choice(data, profile).get("message") or {})
                for piece in pieces:
                    yield piece
                if not any(kind == "content" and text.strip() for kind, text in pieces):
                    raise EmptyReplyError("模型没有返回可显示的文字，请检查模型名称或提高输出长度")
                return
            async for piece in _sse_pieces(response, profile):
                yield piece
    except TimeoutError:
        raise LLMError("模型服务超时，可以在设置里调大超时") from None
    except aiohttp.ClientError as exc:
        raise LLMError(f"连不上模型服务：{redact(str(exc), profile) or type(exc).__name__}") from None


async def complete(profile: dict[str, Any], messages: list[dict[str, Any]], max_tokens: int) -> str:
    parts = [
        text
        async for kind, text in stream_chat(profile, messages, max_tokens=max_tokens)
        if kind == "content"
    ]
    return "".join(parts)


async def test_connection(profile: dict[str, Any]) -> dict[str, Any]:
    started = time.monotonic()
    content: list[str] = []
    has_reasoning = False
    try:
        async for kind, text in stream_chat(
            {**profile, "stream": False}, [{"role": "user", "content": "只回复 OK"}], max_tokens=128
        ):
            if kind == "reasoning":
                has_reasoning = has_reasoning or bool(text.strip())
            else:
                content.append(text)
    except EmptyReplyError:
        # Reasoning models may spend this small connection-test budget before producing an answer.
        # Actual upstream errors must still propagate, even after some valid output arrived.
        if not has_reasoning:
            raise
    reply = "".join(content).strip()[:100] or "已收到模型响应（仅返回思考）"
    return {"ok": True, "reply": reply, "seconds": round(time.monotonic() - started, 2)}


async def list_models(profile: dict[str, Any]) -> list[str]:
    try:
        async with (
            aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as session,
            session.get(models_url(profile["base_url"]), headers=_headers(profile)) as response,
        ):
            if response.status != 200:  # noqa: PLR2004
                await _fail(response, profile)
            try:
                data = await response.json(content_type=None)
            except (ValueError, UnicodeDecodeError):
                raise LLMError("服务没有返回有效的模型列表 JSON，可以手动填写模型名称") from None
    except TimeoutError:
        raise LLMError("拉取模型列表超时") from None
    except aiohttp.ClientError as exc:
        raise LLMError(f"连不上模型服务：{redact(str(exc), profile) or type(exc).__name__}") from None
    items = data.get("data") if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise LLMError("服务没有返回模型列表，可以手动填写模型名称")
    return sorted({str(item.get("id")) for item in items if isinstance(item, dict) and item.get("id")})
