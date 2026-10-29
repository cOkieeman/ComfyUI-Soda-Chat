"""Character library and ${...}$ character calls."""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING, Any

from .storage import read_json, write_json

if TYPE_CHECKING:
    from pathlib import Path

SIDES = ("front", "back")
FIELDS = ("base", "upper_sfw", "upper_nsfw", "lower_sfw", "lower_nsfw")
KINDS = ("specific", "template")
_CALL = re.compile(r"\$\{(?P<body>.*?)\}\$", re.DOTALL)
_SEPARATORS = re.compile(r"(?:\s*,\s*){2,}")


def _clean(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def normalize_character(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or not _clean(raw.get("name")):
        raise ValueError("每个角色都需要名字")
    aliases = raw.get("aliases", [])
    if isinstance(aliases, str):
        aliases = re.split(r"[,，、|｜]", aliases)
    character = {
        "name": _clean(raw["name"]),
        "aliases": [a.strip() for a in aliases if isinstance(a, str) and a.strip()],
        "kind": raw.get("kind") if raw.get("kind") in KINDS else "specific",
        "enabled": raw.get("enabled", True) is not False,
        "summary": _clean(raw.get("summary")),
    }
    for side in SIDES:
        values = raw.get(side) if isinstance(raw.get(side), dict) else {}
        character[side] = {field: _clean(values.get(field)) for field in FIELDS}
    return character


def normalize_library(data: Any) -> dict[str, Any]:
    items = data.get("characters") if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise TypeError('角色库格式应为 {"characters": [...]}')
    characters = [normalize_character(item) for item in items]
    names = [c["name"].lower() for c in characters]
    duplicated = sorted({n for n in names if names.count(n) > 1})
    if duplicated:
        raise ValueError(f"角色名重复：{'、'.join(duplicated)}")
    return {"characters": characters}


class CharacterStore:
    def __init__(self, root: Path) -> None:
        self.path = root / "characters.json"

    def load(self) -> dict[str, Any]:
        return normalize_library(read_json(self.path, {"characters": []}))

    def save(self, data: Any) -> dict[str, Any]:
        library = normalize_library(data)
        write_json(self.path, library)
        return library


def roster_text(library: dict[str, Any], kind: str) -> str:
    lines = []
    for character in library["characters"]:
        if not character["enabled"] or character["kind"] != kind:
            continue
        line = f"- {character['name']}"
        if character["aliases"]:
            line += f"（别名：{'、'.join(character['aliases'])}）"
        if character["summary"]:
            line += f"：{character['summary']}"
        lines.append(line)
    return "\n".join(lines) if lines else "（无）"


def find_character(library: dict[str, Any], name: str) -> dict[str, Any] | None:
    wanted = name.strip().lower()
    for character in library["characters"]:
        if not character["enabled"]:
            continue
        if wanted in [character["name"].lower(), *(a.lower() for a in character["aliases"])]:
            return character
    return None


def _part(character: dict[str, Any], side: str, field: str) -> str:
    return character[side][field] or character["front"][field]


def describe(character: dict[str, Any], call: dict[str, Any], warnings: list[str]) -> str:
    side = "back" if "behind" in str(call.get("angle", "")).lower() else "front"
    parts = [_part(character, side, "base")]
    for body, label in (("upper", "upperBody"), ("lower", "lowerBody")):
        state = str(call.get(label, "sfw")).strip().lower()
        if state == "hidden":
            continue
        if state not in {"sfw", "nsfw"}:
            warnings.append(f"角色 {character['name']} 的 {label} 值「{state}」不认识，按 sfw 处理")
            state = "sfw"
        parts.append(_part(character, side, f"{body}_{state}"))
    return ", ".join(p for p in parts if p)


def resolve_calls(prompt: str, library: dict[str, Any]) -> tuple[str, list[dict[str, Any]], list[str]]:
    """Replace each ${json}$ with the character's fields; unknown names become the bare name."""
    calls: list[dict[str, Any]] = []
    warnings: list[str] = []

    def replace(match: re.Match[str]) -> str:
        raw = match.group(0)
        body = match["body"].replace("“", '"').replace("”", '"')
        try:
            call = json.loads("{" + body + "}")
        except ValueError:
            call = None
        if not isinstance(call, dict):
            warnings.append(f"角色调用格式不对，已删除：{raw[:80]}")
            calls.append({"raw": raw, "name": "", "found": False, "result": ""})
            return ""
        name = str(call.get("name", "")).strip()
        character = find_character(library, name) if name else None
        if character is None:
            warnings.append(f"角色库里没有「{name}」，只保留了名字")
            calls.append({"raw": raw, "name": name, "found": False, "result": name})
            return name
        result = describe(character, call, warnings)
        calls.append({"raw": raw, "name": character["name"], "found": True, "result": result})
        return result

    text = _CALL.sub(replace, prompt)
    text = _SEPARATORS.sub(", ", text)
    return text, calls, warnings
