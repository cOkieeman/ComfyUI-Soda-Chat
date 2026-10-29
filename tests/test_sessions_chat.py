from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from soda_chat.characters import normalize_library
from soda_chat.chat import SettingsStore, build_messages, parse_turn, placeholders
from soda_chat.presets import parse_file
from soda_chat.sessions import SessionStore, context_text

if TYPE_CHECKING:
    from pathlib import Path

LIBRARY = normalize_library(
    {"characters": [{"name": "Ann", "front": {"base": "red hair", "upper_sfw": "coat"}}]}
)


def turn(user: str, reply: str, turn_id: str = "t1") -> dict:
    return {
        "id": turn_id,
        "time": "2026-10-30T00:00:00+00:00",
        "user": user,
        "reply": reply,
        "parsed": parse_turn(reply, LIBRARY),
    }


def test_sessions_roundtrip(tmp_path: Path) -> None:
    store = SessionStore(tmp_path)
    session = store.get_or_create("", "第一句话\n第二行")
    assert session["title"] == "第一句话"
    store.append(session, turn("你好", '<image><prompts>${"name":"Ann"}$</prompts></image>'))
    loaded = store.get(session["id"])
    assert loaded["turns"][0]["parsed"]["images"][0]["prompt"] == "red hair, coat"
    store.update_prompt(session["id"], "t1", 0, "edited")
    assert store.get(session["id"])["turns"][0]["parsed"]["images"][0]["prompt"] == "edited"
    assert store.list()[0]["turns"] == 1
    store.delete(session["id"])
    assert store.list() == []
    with pytest.raises(KeyError):
        store.get(session["id"])


def test_context_text_limits_turns_and_strips_thinking() -> None:
    session = {"turns": [turn("一", "<thinking>想</thinking>答一"), turn("二", "答二"), turn("三", "答三")]}
    assert context_text(session, 2) == "用户：二\n\n助手：答二\n\n用户：三\n\n助手：答三"
    assert "想" not in context_text(session, 5)
    assert context_text(session, 0) == ""


def test_settings_validation(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path)
    assert store.load()["history_turns"] == 6
    saved = store.save({"history_turns": 999, "use_ai_size": False, "unknown": 1, "seeded_builtin": ["x"]})
    assert saved["history_turns"] == 50
    assert saved["use_ai_size"] is False
    assert saved["seeded_builtin"] == []
    with pytest.raises(TypeError):
        store.save({"history_turns": True})
    with pytest.raises(TypeError):
        store.save({"use_ai_size": 1})


def test_placeholders_fall_back_to_input(tmp_path: Path) -> None:
    settings = SettingsStore(tmp_path).load()
    session = {"turns": []}
    values = placeholders({"input": "画猫", "material": "", "setting": ""}, session, LIBRARY, settings)
    assert values["正文"] == "画猫"
    assert values["素材"] == ""
    values = placeholders(
        {"input": "画猫", "material": "一段剧情", "setting": "设定"}, session, LIBRARY, settings
    )
    assert values["正文"] == "一段剧情"
    assert values["世界书触发"] == "设定"
    assert values["角色启用列表"] == "- Ann"


def test_build_messages_uses_profile_options(tmp_path: Path) -> None:
    presets, _ = parse_file(
        '{"p": {"entries": [{"role": "system", "content": "a"}, {"role": "system", "content": "b"}]}}'
    )
    preset = {**presets[0], "id": "p", "overrides": {}}
    settings = SettingsStore(tmp_path).load()
    messages, _ = build_messages(
        preset,
        {"turns": []},
        {"input": "x"},
        library=LIBRARY,
        settings=settings,
        profile={"merge_same_role": True},
    )
    assert messages == [{"role": "system", "content": "a\n\nb"}]
