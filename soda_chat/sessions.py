"""Chat sessions stored as one JSON file each."""

from __future__ import annotations

from datetime import UTC, datetime
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

    def append(self, session: dict[str, Any], turn: dict[str, Any]) -> None:
        session["turns"].append(turn)
        session["updated"] = turn["time"]
        write_json(self._path(session["id"]), session)

    def update_prompt(self, session_id: str, turn_id: str, index: int, prompt: str) -> None:
        session = self.get(session_id)
        for turn in session["turns"]:
            if turn["id"] == turn_id:
                turn["parsed"]["images"][index]["prompt"] = prompt
                write_json(self._path(session_id), session)
                return
        raise KeyError("找不到这一轮对话")

    def delete(self, session_id: str) -> None:
        self._path(session_id).unlink(missing_ok=True)


def context_text(session: dict[str, Any], turns: int) -> str:
    """Earlier turns for {{上下文}}: the user's words and the assistant reply without thinking."""
    lines = []
    for turn in session["turns"][-turns:] if turns > 0 else []:
        lines.append(f"用户：{turn['user']}")
        if turn.get("reply"):
            lines.append(f"助手：{history_text(turn['reply'])}")
    return "\n\n".join(lines)
