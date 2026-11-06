"""Chat sessions stored as one JSON file each."""

from __future__ import annotations

from datetime import UTC, datetime
from threading import RLock
from typing import TYPE_CHECKING, Any

from .parse import history_text
from .storage import check_id, new_id, read_json, write_json

if TYPE_CHECKING:
    from pathlib import Path

TITLE_LENGTH = 24


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class SessionStore:
    def __init__(self, root: Path) -> None:
        self.dir = root / "sessions"
        self._lock = RLock()
        self._deleted: set[str] = set()

    def _path(self, session_id: str) -> Path:
        return self.dir / f"{check_id(session_id)}.json"

    def list(self) -> list[dict[str, Any]]:
        if not self.dir.is_dir():
            return []
        items = []
        for path in self.dir.glob("*.json"):
            session = read_json(path, None)
            if session:
                items.append(
                    {
                        "id": session["id"],
                        "title": session["title"],
                        "updated": session["updated"],
                        "turns": len(session["turns"]),
                    }
                )
        return sorted(items, key=lambda item: item["updated"], reverse=True)

    def get(self, session_id: str) -> dict[str, Any]:
        session = read_json(self._path(session_id), None)
        if not session:
            raise KeyError("对话不存在")
        return session

    def get_or_create(self, session_id: str, first_input: str) -> dict[str, Any]:
        if session_id:
            return self.get(session_id)
        title = first_input.strip().splitlines()[0][:TITLE_LENGTH] if first_input.strip() else "新对话"
        stamp = now()
        return {"id": new_id(), "title": title, "created": stamp, "updated": stamp, "turns": []}

    def append(self, session: dict[str, Any], turn: dict[str, Any]) -> bool:
        """Save a turn, or return False if another request deleted its conversation."""
        # A stream may take minutes. Preserve edits / other turns saved since it started.
        with self._lock:
            if session["id"] in self._deleted:
                return False
            current = read_json(self._path(session["id"]), None) or session
            current["turns"].append(turn)
            current["updated"] = turn["time"]
            write_json(self._path(session["id"]), current)
            return True

    def update_prompt(self, session_id: str, turn_id: str, index: int, prompt: str) -> None:
        with self._lock:
            session = self.get(session_id)
            for turn in session["turns"]:
                if turn["id"] == turn_id:
                    images = turn["parsed"]["images"]
                    if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < len(images):
                        raise ValueError("找不到这张提示词卡片")
                    images[index]["prompt"] = prompt
                    images[index]["edited"] = True
                    write_json(self._path(session_id), session)
                    return
            raise KeyError("找不到这一轮对话")

    def delete(self, session_id: str) -> None:
        with self._lock:
            self._path(session_id).unlink(missing_ok=True)
            self._deleted.add(session_id)


def _reply_context(turn: dict[str, Any]) -> str:
    parsed = turn.get("parsed") or {}
    images = parsed.get("images") or []
    if not any(
        image.get("edited") or ("prompt_raw" in image and image["prompt"] != image["prompt_raw"])
        for image in images
    ):
        return history_text(turn["reply"])
    # Use the latest cards as the authoritative prompts after a manual edit.
    parts = [parsed.get("text", "")]
    for image in images:
        size = image.get("size")
        size_text = f"<size>{size['width']}x{size['height']}</size>" if size else ""
        parts.append(
            f"<image><title_styled>{image.get('title', '')}</title_styled>{size_text}"
            f"<prompts>{image.get('prompt', '')}</prompts></image>"
        )
    return "\n".join(part for part in parts if part)


def context_text(session: dict[str, Any], turns: int) -> str:
    """Earlier turns for {{上下文}}: the user's words and the assistant reply without thinking."""
    lines = []
    for turn in session["turns"][-turns:] if turns > 0 else []:
        lines.append(f"用户：{turn['user']}")
        if turn.get("images"):
            names = "、".join(image.get("name", "图片") for image in turn["images"])
            lines.append(f"本轮曾附图片：{names}（图片仅在当前选择时发送，历史文字不包含图片内容）")
        if turn.get("reply"):
            lines.append(f"助手：{_reply_context(turn)}")
    return "\n\n".join(lines)
