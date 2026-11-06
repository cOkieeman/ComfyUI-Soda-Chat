from __future__ import annotations

import asyncio
import base64
import io
import json
from typing import TYPE_CHECKING, Any

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from conftest import ROOT
from PIL import Image, PngImagePlugin
from test_routes import SEEN, events, upstream_app

from soda_chat import attachments
from soda_chat.attachments import AttachmentStore, attach_images

if TYPE_CHECKING:
    from pathlib import Path
    from types import ModuleType


def make_image(path: Path, size: tuple[int, int] = (80, 60)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    info = PngImagePlugin.PngInfo()
    info.add_text("workflow", "PRIVATE_WORKFLOW_METADATA")
    Image.new("RGBA", size, (80, 110, 180, 160)).save(path, format="PNG", pnginfo=info)


def test_generated_image_is_copied_resized_and_stripped(tmp_path: Path) -> None:
    output = tmp_path / "output"
    original = output / "soda" / "frame.png"
    make_image(original, (3000, 1500))
    store = AttachmentStore(tmp_path / "user", {"output": output})
    image = store.from_output({"filename": "frame.png", "subfolder": "soda", "type": "output"})
    assert image["name"] == "frame.png"
    assert image["mime"] == "image/jpeg"
    assert (image["width"], image["height"]) == (2048, 1024)
    with Image.open(store.path(image["id"])) as preview:
        assert preview.format == "JPEG"
        assert preview.mode == "RGB"
        assert "workflow" not in preview.info
    assert b"PRIVATE_WORKFLOW_METADATA" not in store.path(image["id"]).read_bytes()
    original.unlink()
    assert store.get(image["id"]) == image
    assert store.data_url(image["id"]).startswith("data:image/jpeg;base64,")


@pytest.mark.parametrize(
    "reference",
    [
        {"filename": "../private.png"},
        {"filename": "..\\private.png"},
        {"filename": "C:\\private.png"},
        {"filename": "frame.png:stream"},
        {"filename": "frame.png", "subfolder": "../private"},
        {"filename": "frame.png", "subfolder": "nested/../../private"},
        {"filename": "frame.png", "subfolder": "/private"},
        {"filename": "frame.png", "subfolder": "\\\\server\\share"},
        {"filename": "frame.png", "type": "input"},
        {"filename": "frame.png", "type": {}},
    ],
)
def test_only_output_files_are_accepted(tmp_path: Path, reference: dict[str, Any]) -> None:
    store = AttachmentStore(tmp_path / "user", {"output": tmp_path / "output"})
    with pytest.raises(ValueError, match=r"图片|目录"):
        store.from_output(reference)


def test_symlink_cannot_escape_output_directory(tmp_path: Path) -> None:
    original = tmp_path / "private" / "frame.png"
    make_image(original)
    output = tmp_path / "output"
    output.mkdir()
    try:
        (output / "frame.png").symlink_to(original)
    except OSError:
        pytest.skip("This Windows account cannot create symbolic links")
    store = AttachmentStore(tmp_path / "user", {"output": output})
    with pytest.raises(ValueError, match="出图目录"):
        store.from_output({"filename": "frame.png"})


def test_bad_and_oversized_images_are_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    output = tmp_path / "output"
    output.mkdir()
    source = output / "frame.png"
    source.write_bytes(b"not an image")
    store = AttachmentStore(tmp_path / "user", {"output": output})
    with pytest.raises(ValueError, match="无法读取"):
        store.from_output({"filename": "frame.png"})
    make_image(source)
    monkeypatch.setattr(attachments, "MAX_SOURCE_BYTES", 8)
    with pytest.raises(ValueError, match="20 MB"):
        store.from_output({"filename": "frame.png"})
    monkeypatch.setattr(attachments, "MAX_SOURCE_BYTES", 20 * 1024 * 1024)
    monkeypatch.setattr(attachments, "MAX_PIXELS", 10)
    with pytest.raises(ValueError, match="像素"):
        store.from_output({"filename": "frame.png"})


@pytest.mark.parametrize("image_ids", ["id", None, {}, ["id"] * 5, ["../path"], [False]])
def test_selected_images_are_bounded(tmp_path: Path, image_ids: Any) -> None:
    store = AttachmentStore(tmp_path / "user")
    with pytest.raises(ValueError, match=r"image_ids|编号"):
        store.selected(image_ids)


def test_images_preserve_assistant_prefill_and_do_not_mutate_text() -> None:
    original = [
        {"role": "system", "content": "rules"},
        {"role": "user", "content": "make the cat smaller"},
        {"role": "assistant", "content": "<images>"},
    ]
    result = attach_images(original, [{"name": "cat.png"}], ["/soda_chat/attachments/abc"])
    assert result[1]["content"][0] == {"type": "text", "text": "make the cat smaller"}
    assert result[1]["content"][-1]["image_url"]["url"] == "/soda_chat/attachments/abc"
    assert result[-1] == original[-1]
    assert original[1]["content"] == "make the cat smaller"
    no_user = attach_images([original[0], original[-1]], [{"name": "cat.png"}], ["image"])
    assert [message["role"] for message in no_user] == ["system", "user", "assistant"]
    assert attach_images(original, [], []) == original


async def attachment_scenario(plugin: ModuleType, root: Path) -> dict[str, Any]:
    source = root / "output" / "soda" / "frame.png"
    make_image(source)
    upstream = TestServer(upstream_app())
    await upstream.start_server()
    ctx = plugin.routes.Context.create(
        root / "user", ROOT / "presets_builtin", image_roots={"output": root / "output"}
    )
    ctx.services.save("", {"base_url": f"http://127.0.0.1:{upstream.port}/v1", "model": "vision"})
    app = web.Application()
    for method, path, handler in plugin.routes.route_table(lambda: ctx):
        app.router.add_route(method.upper(), path, handler)
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        imported = await client.post(
            "/soda_chat/attachments/from-output",
            json={"filename": "frame.png", "subfolder": "soda", "type": "output"},
        )
        assert imported.status == 200
        image = (await imported.json())["attachment"]
        request = {
            "preset_id": ctx.presets.list()[0]["id"],
            "input": "让人物小一点，其他部分保留",
            "image_ids": [image["id"]],
        }
        preview = await (await client.post("/soda_chat/preview", json=request)).json()
        served = await client.get(image["url"])
        copied_bytes = await served.read()
        forbidden = await client.get(image["url"], headers={"Origin": "https://outside.example"})
        source.unlink()
        response = await client.post("/soda_chat/chat", json=request)
        first = events(await response.text())
        session_id = first[0][1]["session_id"]
        response = await client.post(
            "/soda_chat/chat",
            json={**request, "session_id": session_id, "image_ids": [], "input": "现在只讨论文字"},
        )
        second = events(await response.text())
        session = ctx.sessions.get(session_id)
        bad = await client.post("/soda_chat/preview", json={**request, "image_ids": ["missing"]})
        return {
            "image": image,
            "preview": preview,
            "copied_bytes": copied_bytes,
            "content_type": served.content_type,
            "forbidden": forbidden.status,
            "first": first,
            "second": second,
            "session": session,
            "seen": upstream.app[SEEN],
            "missing": bad.status,
        }
    finally:
        await client.close()
        await upstream.close()


def test_image_roundtrip_preview_chat_history_and_explicit_removal(
    plugin: ModuleType, tmp_path: Path
) -> None:
    result = asyncio.run(attachment_scenario(plugin, tmp_path))
    image = result["image"]
    assert result["preview"]["images"] == [image]
    preview_text = json.dumps(result["preview"])
    assert "data:image" not in preview_text
    assert image["url"] in preview_text
    assert result["content_type"] == "image/jpeg"
    with Image.open(io.BytesIO(result["copied_bytes"])) as copied:
        assert copied.size == (80, 60)
    assert result["forbidden"] == 403
    first_body = result["seen"][0]["body"]
    content = next(
        message["content"] for message in first_body["messages"] if isinstance(message["content"], list)
    )
    url = next(part["image_url"]["url"] for part in content if part["type"] == "image_url")
    assert base64.b64decode(url.split(",", 1)[1]) == result["copied_bytes"]
    assert result["first"][0][1]["turn_id"] == result["first"][-1][1]["turn"]["id"]
    assert result["session"]["turns"][0]["images"] == [image]
    assert result["session"]["turns"][1]["images"] == []
    assert "data:image" not in json.dumps(result["session"])
    assert all(isinstance(message["content"], str) for message in result["seen"][1]["body"]["messages"])
    assert result["missing"] == 404
