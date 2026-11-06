from __future__ import annotations

import asyncio
import json
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from conftest import FIXTURES, ROOT

if TYPE_CHECKING:
    from pathlib import Path
    from types import ModuleType

SECRET = "sk-route-secret"
SEEN = web.AppKey("seen", list)
REPLY = [
    "<thinking>想",
    "一下</thinking>好的。\n<images><image><title_styled>猫</title_styled>",
    "<size>832x1216</size><prompts>[Tags]\n1girl, cat</prompts></image></images>",
]


def test_concurrent_first_requests_share_one_context(
    plugin: ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workers = 6
    barrier = Barrier(workers)
    created = []
    folder_paths = SimpleNamespace(
        get_user_directory=lambda: str(tmp_path / "user"),
        get_output_directory=lambda: str(tmp_path / "output"),
        get_temp_directory=lambda: str(tmp_path / "temp"),
    )
    original_import = plugin.routes.importlib.import_module

    def fake_import(name: str) -> Any:
        return folder_paths if name == "folder_paths" else original_import(name)

    def create_context(_cls: type, _root: Path, **_options: Any) -> Any:
        time.sleep(0.03)  # Simulate slow disk setup after all request workers have entered.
        context = SimpleNamespace()
        created.append(context)
        return context

    def first_request(_index: int) -> Any:
        barrier.wait(timeout=2)
        return plugin.routes.default_context()

    monkeypatch.setattr(plugin.routes, "_CONTEXT", None)
    monkeypatch.setattr(plugin.routes.importlib, "import_module", fake_import)
    monkeypatch.setattr(plugin.routes.Context, "create", classmethod(create_context))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        contexts = list(executor.map(first_request, range(workers)))
    assert len(created) == 1
    assert all(context is contexts[0] for context in contexts)


def upstream_app(fail: int = 0) -> web.Application:
    seen: list[dict[str, Any]] = []

    async def chat(request: web.Request) -> web.StreamResponse:
        body = await request.json()
        seen.append({"body": body, "auth": request.headers.get("Authorization")})
        if fail:
            return web.json_response({"error": {"message": f"invalid key {SECRET}"}}, status=fail)
        if not body["stream"]:
            return web.json_response({"choices": [{"message": {"content": "OK"}}]})
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        await response.write(b'data: {"choices":[{"delta":{"reasoning_content":"r"}}]}\n\n')
        for piece in REPLY:
            await response.write(
                f"data: {json.dumps({'choices': [{'delta': {'content': piece}}]})}\n\n".encode()
            )
        await response.write(b"data: [DONE]\n\n")
        return response

    async def models(_request: web.Request) -> web.Response:
        return web.json_response({"data": [{"id": "b"}, {"id": "a"}]})

    app = web.Application()
    app[SEEN] = seen
    app.router.add_post("/v1/chat/completions", chat)
    app.router.add_get("/v1/models", models)
    return app


def events(text: str) -> list[tuple[str, Any]]:
    result = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        result.append((lines["event"], json.loads(lines["data"])))
    return result


async def scenario(plugin: ModuleType, root: Path, fail: int = 0) -> dict[str, Any]:
    upstream = TestServer(upstream_app(fail))
    await upstream.start_server()
    ctx = plugin.routes.Context.create(root, ROOT / "presets_builtin")
    app = web.Application()
    for method, path, handler in plugin.routes.route_table(lambda: ctx):
        app.router.add_route(method.upper(), path, handler)
    client = TestClient(TestServer(app))
    await client.start_server()
    out: dict[str, Any] = {"seen": upstream.app[SEEN]}
    try:
        state = await (await client.get("/soda_chat/state")).json()
        out["state"] = state
        base = f"http://127.0.0.1:{upstream.port}/v1"
        saved = await client.post(
            "/soda_chat/services",
            json={"profile": {"name": "fake", "base_url": base, "model": "m", "api_key": SECRET}},
        )
        out["saved"] = await saved.json()
        imported = await client.post(
            "/soda_chat/presets/import",
            json={
                "filename": "sample.json",
                "content": (FIXTURES / "sample_preset.json").read_text(encoding="utf-8"),
            },
        )
        out["imported"] = await imported.json()
        preset_id = out["imported"]["imported"][0]["id"]
        request = {"preset_id": preset_id, "input": "画一只猫", "material": "", "setting": ""}
        out["preview"] = await (await client.post("/soda_chat/preview", json=request)).json()
        first = await client.post("/soda_chat/chat", json=request)
        out["first_status"] = first.status
        out["first"] = events(await first.text())
        session_id = out["first"][0][1]["session_id"]
        second = await client.post(
            "/soda_chat/chat", json={**request, "session_id": session_id, "input": "再来一张"}
        )
        out["second"] = events(await second.text())
        out["session"] = await (await client.get(f"/soda_chat/sessions/{session_id}")).json()
        out["models"] = await (
            await client.post("/soda_chat/services/models", json={"id": out["saved"]["saved"]})
        ).json()
        out["test"] = await client.post("/soda_chat/services/test", json={"id": out["saved"]["saved"]})
        out["test_body"] = await out["test"].json()
        out["missing"] = await client.get("/soda_chat/presets/abcdef")
        out["empty"] = await client.post("/soda_chat/chat", json={**request, "input": ""})
    finally:
        await client.close()
        await upstream.close()
    return out


def test_full_chat_flow(plugin: ModuleType, tmp_path: Path) -> None:
    out = asyncio.run(scenario(plugin, tmp_path))
    assert [p["name"] for p in out["state"]["presets"]] == [
        "Soda 默认 · Anima 单图",
        "Soda 默认 · Krea2 结构化",
        "Soda 默认 · MOSS 单图",
    ]
    assert SECRET not in json.dumps(out["saved"])
    assert out["preview"]["report"]["removed_macros"] == {"roll": 2, "未知宏": 1}
    assert out["first_status"] == 200
    kinds = [name for name, _ in out["first"]]
    assert kinds[0] == "start"
    assert kinds[-1] == "done"
    assert kinds.count("delta") == 4
    turn = out["first"][-1][1]["turn"]
    assert turn["status"] == "ok"
    assert turn["reasoning"] == "r"
    assert turn["parsed"]["text"] == "好的。"
    assert turn["parsed"]["images"][0]["size"] == {"width": 832, "height": 1216}
    assert out["seen"][0]["auth"] == f"Bearer {SECRET}"
    assert out["seen"][0]["body"]["stream"] is True
    second_prompt = json.dumps(out["seen"][1]["body"]["messages"], ensure_ascii=False)
    assert "用户：画一只猫" in second_prompt
    assert "想一下" not in second_prompt
    assert len(out["session"]["turns"]) == 2
    assert SECRET not in json.dumps(out["session"])
    assert out["models"] == {"models": ["a", "b"]}
    assert out["test"].status == 200
    assert out["test_body"]["reply"] == "OK"
    assert out["missing"].status == 404
    assert out["empty"].status == 400


def test_upstream_error_is_reported_without_key(plugin: ModuleType, tmp_path: Path) -> None:
    out = asyncio.run(scenario(plugin, tmp_path, fail=401))
    name, data = out["first"][-1]
    assert name == "error"
    assert "401" in data["error"]
    assert SECRET not in json.dumps(out["first"])
    assert data["turn"]["status"] == "error"
    assert out["test"].status == 502
    assert SECRET not in json.dumps(out["test_body"])


@pytest.mark.parametrize(
    ("remote", "host", "origin", "allowed"),
    [
        ("127.0.0.1", "127.0.0.1:8190", None, True),
        ("::1", "localhost:8190", "http://localhost:8190", True),
        ("192.168.1.9", "127.0.0.1:8190", None, False),
        ("127.0.0.1", "evil.com", None, False),
        ("127.0.0.1", "127.0.0.1:8190", "http://evil.com", False),
    ],
)
def test_allowed_request(
    plugin: ModuleType, remote: str, host: str, origin: str | None, *, allowed: bool
) -> None:
    assert plugin.routes.allowed_request(remote, host, origin) is allowed


def test_node_passthrough(plugin: ModuleType) -> None:
    node = plugin.NODE_CLASS_MAPPINGS["SodaChatPrompt"]()
    assert node.run("p", 832, 1216, "") == ("p", 832, 1216)
    required = plugin.NODE_CLASS_MAPPINGS["SodaChatPrompt"].INPUT_TYPES()["required"]
    assert list(required) == ["prompt", "width", "height", "label"]


def test_example_workflow_uses_known_nodes() -> None:
    workflow = json.loads((ROOT / "example_workflows" / "soda-chat-demo.json").read_text(encoding="utf-8"))
    assert {n["type"] for n in workflow["nodes"]} == {"SodaChatPrompt", "PreviewAny"}


async def body_cases(plugin: ModuleType, root: Path) -> dict[str, Any]:
    ctx = plugin.routes.Context.create(root, ROOT / "presets_builtin")
    app = web.Application()
    for method, path, handler in plugin.routes.route_table(lambda: ctx):
        app.router.add_route(method.upper(), path, handler)
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        big = {"大预设": {"entries": [{"role": "user", "content": "长" * 4000} for _ in range(100)]}}
        content = json.dumps(big, ensure_ascii=False)
        imported = await client.post(
            "/soda_chat/presets/import", json={"filename": "big.json", "content": content, "mode": "copy"}
        )
        gbk = await client.put(
            "/soda_chat/characters",
            data='{"characters": [{"name": "小青"}]}'.encode("gbk"),
            headers={"Content-Type": "application/json"},
        )
        broken = await client.post(
            "/soda_chat/preview", data=b"{not json", headers={"Content-Type": "application/json"}
        )
        return {
            "size": len(content.encode()),
            "imported": imported.status,
            "imported_body": await imported.json(),
            "gbk": (gbk.status, await gbk.json()),
            "broken": (broken.status, await broken.json()),
        }
    finally:
        await client.close()


def test_request_bodies(plugin: ModuleType, tmp_path: Path) -> None:
    out = asyncio.run(body_cases(plugin, tmp_path))
    assert out["size"] > 1_000_000
    assert out["imported"] == 200
    assert out["imported_body"]["imported"][0]["name"] == "大预设"
    assert out["gbk"] == (400, {"error": "请求内容不是 UTF-8 编码"})
    assert out["broken"] == (400, {"error": "请求内容不是有效的 JSON"})


async def interrupted_case(plugin: ModuleType, root: Path) -> dict[str, Any]:
    async def slow_chat(request: web.Request) -> web.StreamResponse:
        await request.json()
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        for _ in range(40):
            await response.write(b'data: {"choices":[{"delta":{"content":"piece "}}]}\n\n')
            await asyncio.sleep(0.05)
        await response.write(b"data: [DONE]\n\n")
        return response

    slow = web.Application()
    slow.router.add_post("/v1/chat/completions", slow_chat)
    upstream = TestServer(slow)
    await upstream.start_server()
    ctx = plugin.routes.Context.create(root, ROOT / "presets_builtin")
    profile = {"name": "slow", "base_url": f"http://127.0.0.1:{upstream.port}/v1", "model": "m"}
    ctx.services.save("", profile)
    app = web.Application()
    for method, path, handler in plugin.routes.route_table(lambda: ctx):
        app.router.add_route(method.upper(), path, handler)
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        preset_id = ctx.presets.list()[0]["id"]
        response = await client.post("/soda_chat/chat", json={"preset_id": preset_id, "input": "画猫"})
        first = (await response.content.readany()).decode()
        session_id = json.loads(first.split("data: ", 1)[1].split("\n", 1)[0])["session_id"]
        response.close()
        for _ in range(40):
            await asyncio.sleep(0.1)
            try:
                session = ctx.sessions.get(session_id)
            except KeyError:
                continue
            if session["turns"]:
                return session["turns"][-1]
        return {}
    finally:
        await client.close()
        await upstream.close()


def test_client_disconnect_saves_interrupted_turn(plugin: ModuleType, tmp_path: Path) -> None:
    turn = asyncio.run(interrupted_case(plugin, tmp_path))
    assert turn["status"] == "interrupted"
    assert set(turn["reply"].split()) <= {"piece"}  # whatever arrived before the disconnect
    assert len(turn["reply"]) < len("piece ") * 40


async def stopped_before_first_token(
    plugin: ModuleType, root: Path, monkeypatch: pytest.MonkeyPatch
) -> dict[str, Any]:
    closed = asyncio.Event()
    never = asyncio.Event()

    async def waiting_stream(_profile: dict, _messages: list[dict]) -> Any:
        try:
            await never.wait()
            yield "content", "should not arrive"
        finally:
            closed.set()

    monkeypatch.setattr(plugin.routes, "stream_chat", waiting_stream)
    monkeypatch.setattr(plugin.routes, "HEARTBEAT_SECONDS", 0.02)
    ctx = plugin.routes.Context.create(root, ROOT / "presets_builtin")
    ctx.services.save("", {"base_url": "http://127.0.0.1:1/v1", "model": "waiting"})
    app = web.Application()
    for method, path, handler in plugin.routes.route_table(lambda: ctx):
        app.router.add_route(method.upper(), path, handler)
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        response = await client.post(
            "/soda_chat/chat", json={"preset_id": ctx.presets.list()[0]["id"], "input": "停止等待"}
        )
        first = (await response.content.readany()).decode()
        start = json.loads(first.split("data: ", 1)[1].split("\n", 1)[0])
        response.close()
        await asyncio.wait_for(closed.wait(), timeout=1)
        for _ in range(100):
            await asyncio.sleep(0.01)
            try:
                session = ctx.sessions.get(start["session_id"])
            except KeyError:
                continue
            if session["turns"]:
                return {"start": start, "turn": session["turns"][-1]}
        return {}
    finally:
        await client.close()


def test_stop_before_first_token_cancels_upstream_and_saves_exact_turn(
    plugin: ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    result = asyncio.run(stopped_before_first_token(plugin, tmp_path, monkeypatch))
    assert result["turn"]["id"] == result["start"]["turn_id"]
    assert result["turn"]["status"] == "interrupted"
    assert result["turn"]["reply"] == ""


async def deleted_while_streaming(
    plugin: ModuleType, root: Path, monkeypatch: pytest.MonkeyPatch
) -> dict[str, Any]:
    waiting = asyncio.Event()
    release = asyncio.Event()

    async def delayed_stream(_profile: dict, _messages: list[dict]) -> Any:
        yield "content", "first part "
        waiting.set()
        await release.wait()
        yield "content", "last part"

    monkeypatch.setattr(plugin.routes, "stream_chat", delayed_stream)
    ctx = plugin.routes.Context.create(root, ROOT / "presets_builtin")
    ctx.services.save("", {"base_url": "http://127.0.0.1:1/v1", "model": "waiting"})
    session = ctx.sessions.get_or_create("", "existing")
    ctx.sessions.append(session, {"id": "before", "time": "2026-01-01", "user": "old", "reply": "old"})
    app = web.Application()
    for method, path, handler in plugin.routes.route_table(lambda: ctx):
        app.router.add_route(method.upper(), path, handler)
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        response = await client.post(
            "/soda_chat/chat",
            json={"session_id": session["id"], "preset_id": ctx.presets.list()[0]["id"], "input": "continue"},
        )
        await asyncio.wait_for(waiting.wait(), timeout=1)
        deleted = await client.delete(f"/soda_chat/sessions/{session['id']}")
        assert deleted.status == 200
        release.set()
        result = events(await response.text())
        missing = await client.get(f"/soda_chat/sessions/{session['id']}")
        return {"events": result, "sessions": ctx.sessions.list(), "missing": missing.status}
    finally:
        release.set()
        await client.close()


def test_deleted_inflight_conversation_returns_clear_error_without_revival(
    plugin: ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    result = asyncio.run(deleted_while_streaming(plugin, tmp_path, monkeypatch))
    event, terminal = result["events"][-1]
    assert event == "error"
    assert terminal["session_deleted"] is True
    assert terminal["turn"]["status"] == "error"
    assert "已在其他窗口删除" in terminal["error"]
    assert "请新建对话" in terminal["error"]
    assert result["sessions"] == []
    assert result["missing"] == 404
