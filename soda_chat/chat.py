"""Glue between presets, sessions and the character library for one chat turn."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .characters import resolve_calls, roster_text
from .parse import parse_reply
from .presets import render_messages
from .sessions import context_text
from .storage import read_json, write_json

if TYPE_CHECKING:
    from pathlib import Path

SETTINGS_DEFAULTS: dict[str, Any] = {
    "history_turns": 6,
    "user_name": "用户",
    "char_name": "角色",
    "use_ai_size": True,
    "target_label": "",
    "last_preset": "",
    "seeded_builtin": [],
}
MAX_HISTORY_TURNS = 50


class SettingsStore:
    def __init__(self, root: Path) -> None:
        self.path = root / "settings.json"

    def load(self) -> dict[str, Any]:
        saved = read_json(self.path, {})
        return {**SETTINGS_DEFAULTS, **(saved if isinstance(saved, dict) else {})}

    def save(self, update: dict[str, Any]) -> dict[str, Any]:
        settings = self.load()
        for key, value in update.items():
            if key not in SETTINGS_DEFAULTS or key == "seeded_builtin":
                continue
            expected = type(SETTINGS_DEFAULTS[key])
            if not isinstance(value, expected) or isinstance(value, bool) != (expected is bool):
                raise TypeError(f"设置项 {key} 的类型不对")
            settings[key] = value
        settings["history_turns"] = max(0, min(MAX_HISTORY_TURNS, settings["history_turns"]))
        write_json(self.path, settings)
        return settings

    def remember_seeded(self, seeded: list[str]) -> None:
        settings = self.load()
        settings["seeded_builtin"] = seeded
        write_json(self.path, settings)


def placeholders(
    request: dict[str, Any], session: dict[str, Any], library: dict[str, Any], settings: dict[str, Any]
) -> dict[str, str]:
    user_input, material = request.get("input", ""), request.get("material", "")
    return {
        "用户需求": user_input,
        "正文": material or user_input,
        "素材": material,
        "上下文": context_text(session, settings["history_turns"]),
        "世界书触发": request.get("setting", ""),
        "角色启用列表": roster_text(library, "specific"),
        "通用角色启用列表": roster_text(library, "template"),
        "user": settings["user_name"],
        "char": settings["char_name"],
    }


def build_messages(  # noqa: PLR0913 -- one turn needs all of these
    preset: dict[str, Any],
    session: dict[str, Any],
    request: dict[str, Any],
    *,
    library: dict[str, Any],
    settings: dict[str, Any],
    profile: dict[str, Any],
) -> tuple[list[dict[str, str]], dict[str, Any]]:
    values = placeholders(request, session, library, settings)
    haystack = f"{request.get('input', '')}\n{request.get('material', '')}"
    return render_messages(
        preset,
        values,
        haystack,
        merge_same_role=bool(profile.get("merge_same_role")),
        system_to_user=bool(profile.get("system_to_user")),
    )


def parse_turn(reply: str, library: dict[str, Any], *, finished: bool = True) -> dict[str, Any]:
    parsed = parse_reply(reply, finished=finished)
    for image in parsed["images"]:
        image["prompt_raw"] = image["prompt"]
        image["prompt"], image["calls"], call_warnings = resolve_calls(image["prompt"], library)
        image["warnings"].extend(call_warnings)
    return parsed
