"""Loopback-only PromptServer routes under /soda_chat. Import-safe outside ComfyUI."""

from __future__ import annotations

import asyncio
import importlib
import ipaddress
import json
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from aiohttp import web

from .soda_chat.characters import CharacterStore
from .soda_chat.chat import SettingsStore, build_messages, parse_turn
from .soda_chat.llm import LLMError, list_models, stream_chat, test_connection
from .soda_chat.presets import PresetStore
from .soda_chat.services import ServiceStore
from .soda_chat.sessions import SessionStore, now
from .soda_chat.storage import new_id

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    Handler = Callable[["Context", web.Request, dict[str, Any]], Awaitable[Any]]

BUILTIN_DIR = Path(__file__).resolve().parent / "presets_builtin"
MAX_BODY = 1024 * 1024
MAX_IMPORT_BODY = 7 * 1024 * 1024
MAX_INPUT = 200_000
_REGISTERED = False
_CONTEXT: Context | None = None


@dataclass
class Context:
    root: Path
    presets: PresetStore
    services: ServiceStore
    characters: CharacterStore
    sessions: SessionStore
    settings: SettingsStore

    @classmethod
    def create(cls, root: Path, builtin_dir: Path = BUILTIN_DIR) -> Context:
        context = cls(
            root,
            PresetStore(root),
            ServiceStore(root),
            CharacterStore(root),
            SessionStore(root),
            SettingsStore(root),
        )
        seeded = list(context.settings.load()["seeded_builtin"])
        before = len(seeded)
        context.presets.seed_builtin(builtin_dir, seeded)
        if len(seeded) != before:
            context.settings.remember_seeded(seeded)
        return context

    @property
    def spw_services(self) -> Path:
        return self.root.parent / "soda_prompt_workflow" / "ai_services.json"


def default_context() -> Context:
    global _CONTEXT  # noqa: PLW0603 -- created once, after ComfyUI knows its user directory
    if _CONTEXT is None:
        folder_paths = importlib.import_module("folder_paths")
        _CONTEXT = Context.create(Path(folder_paths.get_user_directory()) / "soda_chat")
    return _CONTEXT


def is_loopback(host: str) -> bool:
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return address.is_loopback


def allowed_request(remote: str, host: str, origin: str | None) -> bool:
    if not is_loopback(remote):
        return False
    try:
        hostname = urlsplit(f"//{host}").hostname or ""
        if hostname.lower() != "localhost" and not is_loopback(hostname):
            return False
        if origin:
            url = urlsplit(origin)
            if url.scheme not in {"http", "https"} or url.netloc.lower() != host.lower():
                return False
    except ValueError:
        return False
    return True


def _text(body: dict[str, Any], key: str, limit: int = MAX_INPUT) -> str:
    value = body.get(key, "")
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError(f"{key} 必须是文字，且不超过 {limit} 字")
    return value


async def _body(request: web.Request, limit: int) -> dict[str, Any]:
    if request.method == "GET":
        return dict(request.query)
    if request.content_length and request.content_length > limit:
        raise ValueError("请求内容太大")
    chunks, total = [], 0
    async for chunk in request.content.iter_chunked(65536):
        total += len(chunk)
        if total > limit:
            raise ValueError("请求内容太大")
        chunks.append(chunk)
    if not chunks:
        return {}
    try:
        data = json.loads(b"".join(chunks).decode("utf-8"))
    except UnicodeDecodeError:
        raise ValueError("请求内容不是 UTF-8 编码") from None
    except ValueError:
        raise ValueError("请求内容不是有效的 JSON") from None
    if not isinstance(data, dict):
        raise TypeError("请求体必须是 JSON 对象")
    return data


def _message(exc: BaseException) -> str:
    return str(exc.args[0]) if exc.args else type(exc).__name__


# ---- handlers -------------------------------------------------------------------------------------------


async def state(ctx: Context, _request: web.Request, _body: dict[str, Any]) -> Any:
    return {
        "presets": ctx.presets.list(),
        "services": ctx.services.public(),
        "settings": ctx.settings.load(),
        "sessions": ctx.sessions.list(),
    }


async def preset_detail(ctx: Context, request: web.Request, _body: dict[str, Any]) -> Any:
    return ctx.presets.detail(request.match_info["preset_id"])


async def preset_import(ctx: Context, _request: web.Request, body: dict[str, Any]) -> Any:
    mode = body.get("mode", "ask")
    if mode not in {"ask", "replace", "copy"}:
        raise ValueError("mode 只能是 ask / replace / copy")
    result = ctx.presets.import_text(
        _text(body, "content", MAX_IMPORT_BODY), _text(body, "filename", 300), mode
    )
    return {**result, "presets": ctx.presets.list()}


async def preset_update(ctx: Context, request: web.Request, body: dict[str, Any]) -> Any:
    return ctx.presets.update(request.match_info["preset_id"], body)


async def preset_delete(ctx: Context, request: web.Request, _body: dict[str, Any]) -> Any:
    ctx.presets.delete(request.match_info["preset_id"])
    return {"presets": ctx.presets.list()}


async def preset_export(ctx: Context, request: web.Request, _body: dict[str, Any]) -> Any:
    return ctx.presets.export(request.match_info["preset_id"])


async def characters_get(ctx: Context, _request: web.Request, _body: dict[str, Any]) -> Any:
    return ctx.characters.load()


async def characters_put(ctx: Context, _request: web.Request, body: dict[str, Any]) -> Any:
    return ctx.characters.save(body)


async def service_save(ctx: Context, _request: web.Request, body: dict[str, Any]) -> Any:
    return ctx.services.save(_text(body, "id", 64), body.get("profile", {}))


async def service_activate(ctx: Context, request: web.Request, _body: dict[str, Any]) -> Any:
    return ctx.services.activate(request.match_info["service_id"])


async def service_delete(ctx: Context, request: web.Request, _body: dict[str, Any]) -> Any:
    return ctx.services.delete(request.match_info["service_id"])


async def service_test(ctx: Context, _request: web.Request, body: dict[str, Any]) -> Any:
    return await test_connection(ctx.services.draft(_text(body, "id", 64), body.get("profile", {})))


async def service_models(ctx: Context, _request: web.Request, body: dict[str, Any]) -> Any:
    return {"models": await list_models(ctx.services.draft(_text(body, "id", 64), body.get("profile", {})))}


async def service_import_spw(ctx: Context, _request: web.Request, _body: dict[str, Any]) -> Any:
    return ctx.services.import_soda_prompt_workflow(ctx.spw_services)


async def settings_put(ctx: Context, _request: web.Request, body: dict[str, Any]) -> Any:
    return ctx.settings.save(body)


async def sessions_list(ctx: Context, _request: web.Request, _body: dict[str, Any]) -> Any:
    return {"sessions": ctx.sessions.list()}


async def session_get(ctx: Context, request: web.Request, _body: dict[str, Any]) -> Any:
    return ctx.sessions.get(request.match_info["session_id"])


async def session_delete(ctx: Context, request: web.Request, _body: dict[str, Any]) -> Any:
    ctx.sessions.delete(request.match_info["session_id"])
    return {"sessions": ctx.sessions.list()}


async def session_prompt(ctx: Context, request: web.Request, body: dict[str, Any]) -> Any:
    index = body.get("index")
    if not isinstance(index, int) or isinstance(index, bool):
        raise TypeError("index 必须是整数")
    ctx.sessions.update_prompt(
        request.match_info["session_id"], _text(body, "turn_id", 64), index, _text(body, "prompt")
    )
    return {"ok": True}


def _turn_inputs(ctx: Context, body: dict[str, Any]) -> tuple[dict, dict, dict, dict, dict, dict]:
    request = {key: _text(body, key) for key in ("input", "material", "setting")}
    if not request["input"].strip() and not request["material"].strip():
        raise ValueError("请先输入内容")
    preset = ctx.presets.get(_text(body, "preset_id", 64))
    profile = ctx.services.get(_text(body, "service_id", 64))
    session = ctx.sessions.get_or_create(
        _text(body, "session_id", 64), request["input"] or request["material"]
    )
    return request, preset, profile, session, ctx.characters.load(), ctx.settings.load()


async def preview(ctx: Context, _request: web.Request, body: dict[str, Any]) -> Any:
    request, preset, profile, session, library, settings = _turn_inputs(ctx, body)
    messages, report = build_messages(
        preset, session, request, library=library, settings=settings, profile=profile
    )
    return {"messages": messages, "report": report}


ROUTES: list[tuple[str, str, Handler, int]] = [
    ("get", "state", state, MAX_BODY),
    ("get", "presets/{preset_id}", preset_detail, MAX_BODY),
    ("post", "presets/import", preset_import, MAX_IMPORT_BODY),
    ("patch", "presets/{preset_id}", preset_update, MAX_BODY),
    ("delete", "presets/{preset_id}", preset_delete, MAX_BODY),
    ("get", "presets/{preset_id}/export", preset_export, MAX_BODY),
    ("get", "characters", characters_get, MAX_BODY),
    ("put", "characters", characters_put, MAX_IMPORT_BODY),
    ("post", "services", service_save, MAX_BODY),
    ("post", "services/test", service_test, MAX_BODY),
    ("post", "services/models", service_models, MAX_BODY),
    ("post", "services/import-spw", service_import_spw, MAX_BODY),
    ("post", "services/{service_id}/activate", service_activate, MAX_BODY),
    ("delete", "services/{service_id}", service_delete, MAX_BODY),
    ("put", "settings", settings_put, MAX_BODY),
    ("get", "sessions", sessions_list, MAX_BODY),
    ("get", "sessions/{session_id}", session_get, MAX_BODY),
    ("delete", "sessions/{session_id}", session_delete, MAX_BODY),
    ("patch", "sessions/{session_id}/prompt", session_prompt, MAX_BODY),
    ("post", "preview", preview, MAX_BODY),
]


def json_handler(handler: Handler, limit: int, get_context: Callable[[], Context]) -> Any:
    async def wrapped(request: web.Request) -> web.Response:
        if not allowed_request(request.remote or "", request.host, request.headers.get("Origin")):
            return web.json_response({"error": "Soda Chat 只接受本机同源请求"}, status=403)
        try:
            body = await _body(request, limit)
            ctx = await asyncio.to_thread(get_context)
            return web.json_response(await handler(ctx, request, body))
        except LLMError as exc:
            return web.json_response({"error": _message(exc)}, status=502)
        except (KeyError, FileNotFoundError) as exc:
            return web.json_response({"error": _message(exc)}, status=404)
        except (ValueError, TypeError) as exc:
            return web.json_response({"error": _message(exc)}, status=400)
        except OSError as exc:
            return web.json_response({"error": f"读写数据失败：{_message(exc)}"}, status=500)

    return wrapped


def chat_handler(get_context: Callable[[], Context]) -> Any:
    async def wrapped(request: web.Request) -> web.StreamResponse:
        if not allowed_request(request.remote or "", request.host, request.headers.get("Origin")):
            return web.json_response({"error": "Soda Chat 只接受本机同源请求"}, status=403)
        try:
            body = await _body(request, MAX_BODY)
            ctx = await asyncio.to_thread(get_context)
            user, preset, profile, session, library, settings = _turn_inputs(ctx, body)
            messages, report = build_messages(
                preset, session, user, library=library, settings=settings, profile=profile
            )
        except (KeyError, FileNotFoundError) as exc:
            return web.json_response({"error": _message(exc)}, status=404)
        except (ValueError, TypeError) as exc:
            return web.json_response({"error": _message(exc)}, status=400)
        return await run_chat(request, ctx, user, preset, profile, session, library, messages, report)

    return wrapped


async def run_chat(  # noqa: PLR0913, PLR0917 -- one turn needs all of these
    request: web.Request,
    ctx: Context,
    user: dict[str, str],
    preset: dict[str, Any],
    profile: dict[str, Any],
    session: dict[str, Any],
    library: dict[str, Any],
    messages: list[dict[str, str]],
    report: dict[str, Any],
) -> web.StreamResponse:
    response = web.StreamResponse(
        headers={"Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache"}
    )
    await response.prepare(request)

    async def send(event: str, data: Any) -> None:
        payload = json.dumps(data, ensure_ascii=False)
        await response.write(f"event: {event}\ndata: {payload}\n\n".encode())

    content: list[str] = []
    reasoning: list[str] = []
    status, error = "ok", ""
    stream = stream_chat(profile, messages)
    cancelled = False
    try:
        await send("start", {"session_id": session["id"], "title": session["title"], "report": report})
        async for kind, piece in stream:
            (content if kind == "content" else reasoning).append(piece)
            await send("delta", {"kind": kind, "text": piece})
    except LLMError as exc:
        status, error = "error", _message(exc)
    except ConnectionResetError:
        status = "interrupted"
    except asyncio.CancelledError:
        status, cancelled = "interrupted", True
    finally:
        await stream.aclose()
    reply = "".join(content)
    turn = {
        "id": new_id(),
        "time": now(),
        "user": user["input"],
        "material": user["material"],
        "setting": user["setting"],
        "preset_id": preset["id"],
        "preset_name": preset["name"],
        "service_name": profile.get("name", ""),
        "model": profile.get("model", ""),
        "reply": reply,
        "reasoning": "".join(reasoning),
        "parsed": parse_turn(reply, library, finished=status == "ok"),
        "status": status,
        "error": error,
        "report": report,
    }
    await asyncio.to_thread(ctx.sessions.append, session, turn)
    if cancelled:
        raise asyncio.CancelledError
    if status != "interrupted":
        try:
            await send("done" if status == "ok" else "error", {"turn": turn, "error": error})
            await response.write_eof()
        except ConnectionResetError:
            pass
    return response


def route_table(get_context: Callable[[], Context]) -> list[tuple[str, str, Any]]:
    table = [(m, f"/soda_chat/{p}", json_handler(h, limit, get_context)) for m, p, h, limit in ROUTES]
    table.append(("post", "/soda_chat/chat", chat_handler(get_context)))
    return table


def register_routes() -> None:
    global _REGISTERED  # noqa: PLW0603 -- one registration per extension import
    if _REGISTERED:
        return
    try:
        prompt_server = importlib.import_module("server").PromptServer
    except (ImportError, AttributeError):
        return
    if not hasattr(prompt_server, "instance"):
        return
    routes = prompt_server.instance.routes
    for method, path, handler in route_table(default_context):
        getattr(routes, method)(path)(handler)
    _REGISTERED = True
