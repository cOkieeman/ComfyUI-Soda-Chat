"""Import, store and render st-chatu8 LLM presets."""

from __future__ import annotations

import json
import re
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .macros import GETVAR, collect_setvars, render
from .storage import check_id, new_id, read_json, write_json

ROLES = ("system", "user", "assistant")
MAX_IMPORT_BYTES = 5 * 1024 * 1024
_WORD_SPLIT = re.compile(r"[,，、|｜\n]")


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def normalize_entry(raw: Any, index: int, warnings: list[str]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise TypeError(f"第 {index + 1} 个条目不是对象")
    entry = dict(raw)
    role = _text(raw.get("role")).strip().lower()
    if role not in ROLES:
        warnings.append(
            f"条目「{_text(raw.get('name')) or index + 1}」的角色 {role or '（空）'} 不认识，按 user 处理"
        )
        role = "user"
    entry.update(
        {
            "id": _text(raw.get("id")) or f"entry_{index + 1}",
            "name": _text(raw.get("name")) or f"条目 {index + 1}",
            "role": role,
            "content": _text(raw.get("content")),
            "enabled": raw.get("enabled", True) is not False,
            "triggerMode": _text(raw.get("triggerMode")) or "always",
            "triggerWords": _text(raw.get("triggerWords")),
            "andTriggerWords": _text(raw.get("andTriggerWords")),
        }
    )
    return entry


def parse_file(text: str, filename: str = "") -> tuple[list[dict[str, Any]], list[str]]:
    """Return the presets in an st-chatu8 preset file and any warnings."""
    if len(text.encode("utf-8")) > MAX_IMPORT_BYTES:
        raise ValueError("预设文件超过 5 MB")
    try:
        data = json.loads(text)
    except ValueError:
        raise ValueError("预设文件不是有效的 JSON") from None
    if not isinstance(data, dict):
        raise TypeError("预设文件的顶层必须是对象")
    if isinstance(data.get("entries"), list):
        name = _text(data.get("name")) or Path(filename).stem or "未命名预设"
        data = {name: data}
    warnings: list[str] = []
    presets = []
    for name, body in data.items():
        if not isinstance(body, dict) or not isinstance(body.get("entries"), list):
            continue
        entries = [normalize_entry(raw, i, warnings) for i, raw in enumerate(body["entries"])]
        presets.append({"name": str(name).strip() or "未命名预设", "entries": entries})
    if not presets:
        raise ValueError('没有找到预设：需要 {"预设名": {"entries": [...]}} 格式')
    return presets, warnings


def _words(value: str) -> list[str]:
    return [word.strip() for word in _WORD_SPLIT.split(value) if word.strip()]


def triggered(entry: dict[str, Any], haystack: str) -> bool:
    if entry["triggerMode"] == "always":
        return True
    any_words, all_words = _words(entry["triggerWords"]), _words(entry["andTriggerWords"])
    if any_words and not any(word in haystack for word in any_words):
        return False
    return all(word in haystack for word in all_words)


def _defaults(preset: dict[str, Any], sent: list[dict[str, Any]]) -> tuple[dict[str, str], set[str]]:
    """Setvars in sent entries win; those in entries that are not sent still serve as fallbacks.

    Returns the values and the names that only come from entries that are not sent.
    """
    sent_ids = {id(e) for e in sent}
    fallback = collect_setvars(e["content"] for e in preset["entries"] if id(e) not in sent_ids)
    own = collect_setvars(e["content"] for e in sent)
    return {**fallback, **own}, set(fallback) - set(own)


def variables(preset: dict[str, Any]) -> list[dict[str, Any]]:
    defaults, _ = _defaults(preset, [e for e in preset["entries"] if e["enabled"]])
    overrides = preset.get("overrides", {})
    names = list(defaults) + [name for name in overrides if name not in defaults]
    return [{"name": n, "default": defaults.get(n), "override": overrides.get(n)} for n in names]


def _select(preset: dict[str, Any], haystack: str) -> tuple[list[dict], list[str], list[str]]:
    selected, skipped, warnings = [], [], []
    for entry in preset["entries"]:
        if not entry["enabled"] or not entry["content"].strip():
            continue
        if entry["triggerMode"] != "always":
            warnings.append(f"条目「{entry['name']}」的触发方式 {entry['triggerMode']} 按触发词规则处理")
        if triggered(entry, haystack):
            selected.append(entry)
        else:
            skipped.append(entry["name"])
    return selected, skipped, warnings


def _merge(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    merged: list[dict[str, str]] = []
    for message in messages:
        if merged and merged[-1]["role"] == message["role"]:
            merged[-1]["content"] += "\n\n" + message["content"]
        else:
            merged.append(dict(message))
    return merged


def render_messages(
    preset: dict[str, Any],
    placeholders: dict[str, str],
    haystack: str,
    *,
    merge_same_role: bool = False,
    system_to_user: bool = False,
) -> tuple[list[dict[str, str]], dict[str, Any]]:
    """Turn the enabled, triggered entries into chat messages."""
    selected, skipped, warnings = _select(preset, haystack)
    values, borrowed = _defaults(preset, selected)
    overrides = {k: v for k, v in preset.get("overrides", {}).items() if isinstance(v, str)}
    values.update(overrides)
    used = {m["name"].strip() for e in selected for m in GETVAR.finditer(e["content"])}
    borrowed = sorted((borrowed & used) - set(overrides))
    if borrowed:
        warnings.append(f"这些变量取自停用或未触发的条目：{'、'.join(borrowed)}")
    removed: Counter[str] = Counter()
    missing: set[str] = set()
    messages = []
    for entry in selected:
        content = render(entry["content"], values, placeholders, removed, missing)
        if content:
            role = "user" if system_to_user and entry["role"] == "system" else entry["role"]
            messages.append({"role": role, "content": content})
    if merge_same_role:
        messages = _merge(messages)
    if removed:
        listed = "、".join(f"{name} ×{count}" for name, count in removed.items())
        warnings.append(f"已删除不支持的宏：{listed}")
    if missing:
        warnings.append(f"未定义的变量（按空值处理）：{'、'.join(sorted(missing))}")
    report = {
        "entries_sent": len(selected),
        "entries_skipped": skipped,
        "variables": values,
        "removed_macros": dict(removed),
        "missing_variables": sorted(missing),
        "warnings": warnings,
    }
    return messages, report


class PresetStore:
    def __init__(self, root: Path) -> None:
        self.dir = root / "presets"

    def _path(self, preset_id: str) -> Path:
        return self.dir / f"{check_id(preset_id)}.json"

    def _all(self) -> list[dict[str, Any]]:
        if not self.dir.is_dir():
            return []
        return [read_json(path, None) for path in sorted(self.dir.glob("*.json"))]

    def list(self) -> list[dict[str, Any]]:
        items = [
            {
                "id": p["id"],
                "name": p["name"],
                "entry_count": len(p["entries"]),
                "enabled_count": sum(1 for e in p["entries"] if e["enabled"]),
                "builtin": p.get("builtin", False),
            }
            for p in self._all()
            if p
        ]
        return sorted(items, key=lambda item: (not item["builtin"], item["name"]))

    def get(self, preset_id: str) -> dict[str, Any]:
        preset = read_json(self._path(preset_id), None)
        if not preset:
            raise KeyError("预设不存在")
        return preset

    def detail(self, preset_id: str) -> dict[str, Any]:
        preset = self.get(preset_id)
        return {**preset, "variables": variables(preset)}

    def save(self, preset: dict[str, Any]) -> None:
        write_json(self._path(preset["id"]), preset)

    def import_text(self, text: str, filename: str = "", mode: str = "ask", *, builtin: bool = False) -> dict:
        presets, warnings = parse_file(text, filename)
        existing = {p["name"]: p for p in self._all() if p}
        conflicts = [p["name"] for p in presets if p["name"] in existing]
        if conflicts and mode == "ask":
            return {"imported": [], "conflicts": conflicts, "warnings": warnings}
        imported = []
        for item in presets:
            preset = {
                "id": new_id(),
                "name": item["name"],
                "format": "st-chatu8",
                "source_file": Path(filename).name,
                "imported_at": datetime.now(UTC).isoformat(timespec="seconds"),
                "builtin": builtin,
                "overrides": {},
                "entries": item["entries"],
            }
            old = existing.get(item["name"])
            if old and mode == "replace":
                preset["id"] = old["id"]
                preset["builtin"] = old.get("builtin", False) or builtin
                names = {v["name"] for v in variables(preset)}
                preset["overrides"] = {k: v for k, v in old.get("overrides", {}).items() if k in names}
            elif old:
                number = 2
                while f"{item['name']} ({number})" in existing:
                    number += 1
                preset["name"] = f"{item['name']} ({number})"
            existing[preset["name"]] = preset
            self.save(preset)
            imported.append({"id": preset["id"], "name": preset["name"]})
        return {"imported": imported, "conflicts": [], "warnings": warnings}

    def update(self, preset_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        preset = self.get(preset_id)
        toggles = patch.get("entries", {})
        if not isinstance(toggles, dict):
            raise TypeError("entries 必须是 {条目编号: 是否启用}")
        for entry in preset["entries"]:
            if entry["id"] in toggles:
                entry["enabled"] = toggles[entry["id"]] is True
        if "overrides" in patch:
            overrides = patch["overrides"]
            if not isinstance(overrides, dict) or not all(
                isinstance(k, str) and isinstance(v, str) for k, v in overrides.items()
            ):
                raise TypeError("变量覆盖值必须是 {名字: 文字}")
            preset["overrides"] = overrides
        if isinstance(patch.get("name"), str) and patch["name"].strip():
            preset["name"] = patch["name"].strip()
        self.save(preset)
        return self.detail(preset_id)

    def delete(self, preset_id: str) -> None:
        self._path(preset_id).unlink(missing_ok=True)

    def export(self, preset_id: str) -> dict[str, Any]:
        preset = self.get(preset_id)
        return {preset["name"]: {"entries": preset["entries"]}}

    def seed_builtin(self, builtin_dir: Path, seeded: list[str]) -> list[str]:
        """Copy bundled presets once; a preset the user deleted is not restored."""
        for path in sorted(builtin_dir.glob("*.json")):
            if path.name in seeded:
                continue
            self.import_text(path.read_text(encoding="utf-8"), path.name, "copy", builtin=True)
            seeded.append(path.name)
        return seeded
