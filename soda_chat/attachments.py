"""Small, metadata-free copies of generated images selected for a chat turn."""

from __future__ import annotations

import base64
import io
from typing import TYPE_CHECKING, Any

from PIL import Image, ImageOps, UnidentifiedImageError

from .storage import check_id, new_id, read_json, write_json

if TYPE_CHECKING:
    from pathlib import Path

MAX_IMAGES = 4
MAX_SOURCE_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 40_000_000
MAX_SIDE = 2048
MAX_FILENAME = 255
MAX_SUBFOLDER = 1000
SUPPORTED_FORMATS = {"PNG", "JPEG", "WEBP"}


def _source_path(roots: dict[str, Path], reference: dict[str, Any]) -> Path:
    image_type = reference.get("type", "output")
    if not isinstance(image_type, str) or image_type not in {"output", "temp"}:
        raise ValueError("只能选择 ComfyUI 的 output 或 temp 图片")
    if image_type not in roots:
        raise ValueError("当前实例没有可用的出图目录")
    filename = reference.get("filename", "")
    subfolder = reference.get("subfolder", "")
    if (
        not isinstance(filename, str)
        or not filename
        or len(filename) > MAX_FILENAME
        or filename in {".", ".."}
        or any(char in filename for char in "/\\:\0")
    ):
        raise ValueError("图片文件名格式不正确")
    if (
        not isinstance(subfolder, str)
        or len(subfolder) > MAX_SUBFOLDER
        or any(c in subfolder for c in ":\0")
    ):
        raise ValueError("图片子目录格式不正确")
    parts = subfolder.replace("\\", "/").split("/") if subfolder else []
    if any(part in {"", ".", ".."} for part in parts):
        raise ValueError("图片子目录不能包含绝对路径或目录跳转")
    root = roots[image_type].resolve()
    try:
        source = root.joinpath(*parts, filename).resolve(strict=True)
    except (FileNotFoundError, NotADirectoryError):
        raise FileNotFoundError("图片已被移动或删除，请重新选择") from None
    if not source.is_relative_to(root):
        raise ValueError("图片必须位于 ComfyUI 的出图目录内")
    if not source.is_file():
        raise ValueError("选择的内容不是图片文件")
    return source


def _jpeg_copy(data: bytes) -> tuple[bytes, int, int]:
    try:
        with Image.open(io.BytesIO(data)) as source:
            if source.format not in SUPPORTED_FORMATS:
                raise ValueError("图片格式只支持 PNG、JPEG 和 WebP")
            if source.width * source.height > MAX_PIXELS:
                raise ValueError("图片超过 4000 万像素，请选择较小的图片")
            source.load()
            image = ImageOps.exif_transpose(source)
            image.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
            rgba = image.convert("RGBA")
            rgb = Image.new("RGB", rgba.size, "white")
            rgb.paste(rgba, mask=rgba.getchannel("A"))
            result = io.BytesIO()
            rgb.save(result, format="JPEG", quality=90)
            return result.getvalue(), rgb.width, rgb.height
    except (Image.DecompressionBombError, UnidentifiedImageError, OSError):
        raise ValueError("图片无法读取或尺寸过大，请选择有效的 PNG、JPEG 或 WebP") from None


class AttachmentStore:
    def __init__(self, root: Path, image_roots: dict[str, Path] | None = None) -> None:
        self.dir = root / "attachments"
        self.image_roots = image_roots or {}

    def from_output(self, reference: dict[str, Any]) -> dict[str, Any]:
        source = _source_path(self.image_roots, reference)
        if source.stat().st_size > MAX_SOURCE_BYTES:
            raise ValueError("图片超过 20 MB，请选择较小的图片")
        with source.open("rb") as handle:
            data = handle.read(MAX_SOURCE_BYTES + 1)
        if len(data) > MAX_SOURCE_BYTES:
            raise ValueError("图片超过 20 MB，请选择较小的图片")
        encoded, width, height = _jpeg_copy(data)
        attachment_id = new_id()
        metadata = {"id": attachment_id, "name": source.name, "width": width, "height": height}
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path(attachment_id).write_bytes(encoded)
        write_json(self.dir / f"{attachment_id}.json", metadata)
        return self.get(attachment_id)

    def path(self, attachment_id: str) -> Path:
        return self.dir / f"{check_id(attachment_id)}.jpg"

    def get(self, attachment_id: str) -> dict[str, Any]:
        attachment_id = check_id(attachment_id)
        metadata = read_json(self.dir / f"{attachment_id}.json", None)
        if not isinstance(metadata, dict) or not self.path(attachment_id).is_file():
            raise KeyError("所选图片不存在，请重新选择")
        return {
            "id": attachment_id,
            "name": str(metadata.get("name", "图片")),
            "mime": "image/jpeg",
            "width": metadata["width"],
            "height": metadata["height"],
            "url": f"/soda_chat/attachments/{attachment_id}",
        }

    def selected(self, image_ids: Any) -> list[dict[str, Any]]:
        if not isinstance(image_ids, list) or len(image_ids) > MAX_IMAGES:
            raise ValueError(f"image_ids 必须是列表，每轮最多选择 {MAX_IMAGES} 张图片")
        images = []
        seen = set()
        for raw_id in image_ids:
            attachment_id = check_id(raw_id)
            if attachment_id not in seen:
                images.append(self.get(attachment_id))
                seen.add(attachment_id)
        return images

    def data_url(self, attachment_id: str) -> str:
        self.get(attachment_id)
        data = base64.b64encode(self.path(attachment_id).read_bytes()).decode("ascii")
        return f"data:image/jpeg;base64,{data}"


def attach_images(
    messages: list[dict[str, Any]], images: list[dict[str, Any]], urls: list[str]
) -> list[dict[str, Any]]:
    """Add selected images to the last user entry without displacing an assistant prefill."""
    if not images:
        return messages
    result = [dict(message) for message in messages]
    user_index = next((i for i in range(len(result) - 1, -1, -1) if result[i]["role"] == "user"), None)
    if user_index is None:
        user_index = len(result)
        while user_index and result[user_index - 1]["role"] == "assistant":
            user_index -= 1
        result.insert(user_index, {"role": "user", "content": "请结合本轮所附图片和用户要求作答。"})
    content: list[dict[str, Any]] = [{"type": "text", "text": result[user_index]["content"]}]
    for number, (attachment, url) in enumerate(zip(images, urls, strict=True), start=1):
        content.extend(
            [
                {"type": "text", "text": f"本轮参考图 {number}：{attachment['name']}"},
                {"type": "image_url", "image_url": {"url": url}},
            ]
        )
    result[user_index]["content"] = content
    return result
