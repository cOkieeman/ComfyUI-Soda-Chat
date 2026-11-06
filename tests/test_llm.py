from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from soda_chat import llm
from soda_chat.llm import LLMError, stream_chat

SECRET = "sk-test-boundary-secret"


async def request_reply(body: str, *, stream: bool, status: int = 200) -> tuple[list, str]:
    async def upstream(_request: web.Request) -> web.Response:
        return web.Response(text=body, status=status)

    app = web.Application()
    app.router.add_post("/chat/completions", upstream)
    server = TestServer(app)
    await server.start_server()
    profile = {
        "base_url": str(server.make_url("/")), "model": "test", "api_key": SECRET, "stream": stream,
    }
    pieces = []
    try:
        async for piece in stream_chat(profile, [{"role": "user", "content": "test"}]):
            pieces.append(piece)  # noqa: PERF401 -- keep partial output when the iterator raises
    except LLMError as exc:
        return pieces, str(exc)
    finally:
        await server.close()
    return pieces, ""


@pytest.mark.parametrize("body", ["<html>gateway error</html>", "[]", '{"choices":12}', '{"choices":[12]}'])
def test_malformed_response_is_a_user_facing_error(body: str) -> None:
    pieces, error = asyncio.run(request_reply(body, stream=False))
    assert pieces == []
    assert "模型服务" in error


@pytest.mark.parametrize("body", ["data: []\n\n", "data: not-json\n\n", "<html>gateway</html>"])
def test_invalid_stream_does_not_succeed_silently(body: str) -> None:
    pieces, error = asyncio.run(request_reply(body, stream=True))
    assert pieces == []
    assert error


def test_premature_stream_preserves_partial_reply_and_reports_error() -> None:
    body = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
    pieces, error = asyncio.run(request_reply(body, stream=True))
    assert pieces == [("content", "partial")]
    assert "提前结束" in error


@pytest.mark.parametrize(
    "terminator", ["data: [DONE]\n\n", 'data: {"choices":[{"finish_reason":"stop"}]}\n\n']
)
def test_stream_accepts_done_or_finish_reason(terminator: str) -> None:
    body = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' + terminator
    pieces, error = asyncio.run(request_reply(body, stream=True))
    assert pieces == [("content", "hello")]
    assert not error


def test_multimodal_text_blocks_are_supported() -> None:
    body = json.dumps({"choices": [{"message": {"content": [{"type": "text", "text": "hello"}]}}]})
    pieces, error = asyncio.run(request_reply(body, stream=False))
    assert pieces == [("content", "hello")]
    assert not error


@pytest.mark.parametrize("content", [None, "", "  ", {"text": "bad"}, [{"text": 12}]])
def test_missing_or_malformed_content_is_reported(content: Any) -> None:
    body = json.dumps({"choices": [{"message": {"content": content}}]})
    _, error = asyncio.run(request_reply(body, stream=False))
    assert error


def test_http_error_redacts_before_truncation() -> None:
    body = "x" * 495 + SECRET + " denied"
    _, error = asyncio.run(request_reply(body, stream=False, status=401))
    assert "sk-te" not in error
    assert "***" in error


def test_stream_error_redacts_before_truncation() -> None:
    body = "data: " + json.dumps({"error": "x" * 493 + SECRET}) + "\n\n"
    _, error = asyncio.run(request_reply(body, stream=True))
    assert "sk-te" not in error
    assert "***" in error


async def connection_reply(body: str, status: int = 200) -> tuple[dict[str, Any], dict[str, Any], str]:
    seen = {}

    async def upstream(request: web.Request) -> web.Response:
        seen.update(await request.json())
        assert request.headers["Authorization"] == f"Bearer {SECRET}"
        return web.Response(text=body, status=status)

    app = web.Application()
    app.router.add_post("/chat/completions", upstream)
    server = TestServer(app)
    await server.start_server()
    try:
        result = await llm.test_connection(
            {"base_url": str(server.make_url("/")), "model": "thinking-test", "api_key": SECRET}
        )
    except LLMError as exc:
        return {}, seen, str(exc)
    else:
        return result, seen, ""
    finally:
        await server.close()


def test_connection_accepts_real_reasoning_when_small_budget_has_no_answer() -> None:
    body = json.dumps(
        {"choices": [{"message": {"reasoning_content": "Let me consider this.", "content": None},
                      "finish_reason": "length"}]}
    )
    result, sent, error = asyncio.run(connection_reply(body))
    assert not error
    assert result["ok"] is True
    assert result["reply"] == "已收到模型响应（仅返回思考）"
    assert sent["stream"] is False
    assert sent["max_tokens"] == 128
    assert "Let me consider" not in json.dumps(result)
    assert SECRET not in json.dumps(result)


def test_connection_prefers_answer_when_model_returns_both_kinds() -> None:
    body = json.dumps({"choices": [{"message": {"reasoning_content": "thinking", "content": " OK "}}]})
    result, _, error = asyncio.run(connection_reply(body))
    assert not error
    assert result["reply"] == "OK"


@pytest.mark.parametrize(
    "body",
    [
        '{"choices": [{"message": {"content": null}}]}',
        '{"choices": [{"message": {"reasoning_content": " ", "content": " "}}]}',
        '{"error": {"message": "rejected"}}',
        '{"error": "rejected", "choices": [{"message": {"reasoning_content": "thinking"}}]}',
        "<html>gateway error</html>",
    ],
)
def test_connection_does_not_accept_empty_malformed_or_error_responses(body: str) -> None:
    result, _, error = asyncio.run(connection_reply(body))
    assert not result
    assert error


def test_connection_does_not_accept_unauthorized_reasoning_shaped_body() -> None:
    body = json.dumps({"choices": [{"message": {"reasoning_content": "unauthorized"}}]})
    result, _, error = asyncio.run(connection_reply(body, status=401))
    assert not result
    assert "401" in error


@pytest.mark.parametrize("stream", [False, True])
def test_regular_chat_still_rejects_reasoning_without_answer(*, stream: bool) -> None:
    if stream:
        body = 'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\ndata: [DONE]\n\n'
    else:
        body = '{"choices": [{"message": {"reasoning_content": "thinking", "content": null}}]}'
    pieces, error = asyncio.run(request_reply(body, stream=stream))
    assert pieces == [("reasoning", "thinking")]
    assert "可显示的文字" in error


def test_connection_propagates_errors_after_reasoning(monkeypatch: pytest.MonkeyPatch) -> None:
    async def failing_stream(_profile: dict, _messages: list, *, max_tokens: int) -> Any:
        assert max_tokens == 128
        yield "reasoning", "some genuine reasoning"
        message = "upstream failed after reasoning"
        raise LLMError(message)

    monkeypatch.setattr(llm, "stream_chat", failing_stream)
    with pytest.raises(LLMError, match="upstream failed after reasoning"):
        asyncio.run(llm.test_connection({"model": "test"}))
