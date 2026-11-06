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


def test_card_edits_are_used_by_next_turn_and_survive_an_older_stream(tmp_path: Path) -> None:
    store = SessionStore(tmp_path)
    session = store.get_or_create("", "画猫")
    store.append(
        session, turn("画猫", "<thinking>secret thought</thinking><image><prompts>old cat</prompts></image>")
    )
    older_stream = store.get(session["id"])
    store.update_prompt(session["id"], "t1", 0, "new smaller cat")
    store.append(older_stream, turn("继续", "完成", "t2"))
    current = store.get(session["id"])
    assert len(current["turns"]) == 2
    assert current["turns"][0]["parsed"]["images"][0]["prompt"] == "new smaller cat"
    context = context_text(current, 5)
    assert "new smaller cat" in context
    assert "old cat" not in context
    assert "secret thought" not in context


@pytest.mark.parametrize("index", [-1, 1, 99, True, "0"])
def test_prompt_update_rejects_invalid_card_index(tmp_path: Path, index: int) -> None:
    store = SessionStore(tmp_path)
    session = store.get_or_create("", "画猫")
    store.append(session, turn("画猫", "<image><prompts>cat</prompts></image>"))
    with pytest.raises(ValueError, match="提示词卡片"):
        store.update_prompt(session["id"], "t1", index, "edited")


def test_parallel_session_snapshots_do_not_overwrite_other_turns(tmp_path: Path) -> None:
    store = SessionStore(tmp_path)
    session = store.get_or_create("", "第一轮")
    store.append(session, turn("第一轮", "一", "t1"))
    first_snapshot = store.get(session["id"])
    second_snapshot = store.get(session["id"])
    store.append(first_snapshot, turn("第二轮", "二", "t2"))
    store.append(second_snapshot, turn("第三轮", "三", "t3"))
    assert [item["id"] for item in store.get(session["id"])["turns"]] == ["t1", "t2", "t3"]


def test_deleted_conversation_is_not_revived_by_a_pending_stream(tmp_path: Path) -> None:
    store = SessionStore(tmp_path)
    session = store.get_or_create("", "第一轮")
    store.append(session, turn("第一轮", "一", "t1"))
    pending = store.get(session["id"])
    store.delete(session["id"])
    saved = store.append(pending, turn("第二轮", "迟到的回复", "t2"))
    assert store.list() == []
    assert saved is False
    fresh = store.get_or_create("", "新的对话")
    assert store.append(fresh, turn("新的对话", "可以保存", "new")) is True
    assert store.get(fresh["id"])["turns"][0]["reply"] == "可以保存"


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
