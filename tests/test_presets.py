from __future__ import annotations

import itertools
import json
from typing import TYPE_CHECKING

import pytest

from soda_chat.presets import PresetStore, parse_file, render_messages, variables

if TYPE_CHECKING:
    from pathlib import Path

PLACEHOLDERS = {
    "用户需求": "画一个撑伞的人",
    "正文": "雨中的车站",
    "上下文": "用户：上一轮",
    "世界书触发": "现代都市",
    "角色启用列表": "- 小青",
    "通用角色启用列表": "（无）",
    "user": "阿明",
    "char": "小青",
}


def first_preset(sample_text: str) -> dict:
    presets, _ = parse_file(sample_text, "sample.json")
    return {**presets[0], "id": "p1", "overrides": {}}


def test_parse_file_reads_every_preset_and_normalizes_roles(sample_text: str) -> None:
    presets, warnings = parse_file(sample_text, "sample.json")
    assert [p["name"] for p in presets] == ["样例预设", "第二个预设"]
    assert len(presets[0]["entries"]) == 9
    assert presets[1]["entries"][0]["role"] == "user"
    assert any("narrator" in w for w in warnings)


@pytest.mark.parametrize(
    ("text", "message"),
    [("not json", "有效的 JSON"), ("[]", "顶层必须是对象"), ('{"a": {"no": []}}', "没有找到预设")],
)
def test_parse_file_rejects_bad_files(text: str, message: str) -> None:
    with pytest.raises((ValueError, TypeError), match=message):
        parse_file(text)


def test_parse_file_accepts_single_preset_object() -> None:
    presets, _ = parse_file(json.dumps({"entries": [{"role": "user", "content": "hi"}]}), "单个.json")
    assert presets[0]["name"] == "单个"
    assert presets[0]["entries"][0]["enabled"] is True


def test_render_applies_variables_placeholders_and_drops_unknown_macros(sample_text: str) -> None:
    preset = first_preset(sample_text)
    messages, report = render_messages(preset, PLACEHOLDERS, "画一个撑伞的人")
    contents = "\n".join(m["content"] for m in messages)
    assert "每次给 3 张图" in contents  # the later setvar wins
    assert "语气温和" in contents
    assert "这条不应发送" not in contents
    assert "{{" not in contents
    assert "{@" not in contents
    assert report["removed_macros"] == {"roll": 2, "未知宏": 1}
    assert report["missing_variables"] == ["不存在"]
    assert report["variables"] == {"张数": "3", "语气": "温和"}
    assert "正文：雨中的车站" in contents
    assert "需求：画一个撑伞的人" in contents
    assert messages[-2] == {"role": "assistant", "content": "好的，阿明。"}
    assert all(m["content"].strip() for m in messages)


def test_render_triggers(sample_text: str) -> None:
    preset = first_preset(sample_text)
    plain, report = render_messages(preset, PLACEHOLDERS, "晴天")
    assert "雨丝" not in str(plain)
    assert set(report["entries_skipped"]) == {"雨天补充", "夜景加街道"}
    rainy, _ = render_messages(preset, PLACEHOLDERS, "今天下雨")
    assert "雨丝" in str(rainy)
    half, _ = render_messages(preset, PLACEHOLDERS, "夜晚")
    assert "路灯" not in str(half)
    both, _ = render_messages(preset, PLACEHOLDERS, "夜晚的街道")
    assert "路灯" in str(both)


def test_override_beats_every_setvar(sample_text: str) -> None:
    preset = first_preset(sample_text)
    preset["overrides"] = {"张数": "1"}
    messages, report = render_messages(preset, PLACEHOLDERS, "")
    assert "每次给 1 张图" in str(messages)
    assert report["variables"]["张数"] == "1"


def test_message_options(sample_text: str) -> None:
    preset = first_preset(sample_text)
    messages, _ = render_messages(preset, PLACEHOLDERS, "", system_to_user=True, merge_same_role=True)
    roles = [m["role"] for m in messages]
    assert "system" not in roles
    assert all(a != b for a, b in itertools.pairwise(roles))


def test_variables_lists_defaults_from_enabled_entries(sample_text: str) -> None:
    preset = first_preset(sample_text)
    preset["overrides"] = {"额外": "x"}
    listed = {v["name"]: v for v in variables(preset)}
    assert listed["张数"]["default"] == "3"
    assert listed["额外"]["default"] is None
    assert listed["额外"]["override"] == "x"


def test_store_import_conflicts_update_export(tmp_path: Path, sample_text: str) -> None:
    store = PresetStore(tmp_path)
    first = store.import_text(sample_text, "sample.json")
    assert len(first["imported"]) == 2
    asked = store.import_text(sample_text, "sample.json")
    assert asked["imported"] == []
    assert set(asked["conflicts"]) == {"样例预设", "第二个预设"}

    preset_id = next(p["id"] for p in store.list() if p["name"] == "样例预设")
    store.update(preset_id, {"overrides": {"张数": "5", "已删变量": "1"}, "entries": {"e1": False}})
    replaced = store.import_text(sample_text, "sample.json", "replace")
    assert {p["id"] for p in replaced["imported"]} >= {preset_id}
    kept = store.get(preset_id)
    assert kept["overrides"] == {"张数": "5"}
    assert kept["entries"][0]["enabled"] is True

    copied = store.import_text(sample_text, "sample.json", "copy")
    assert {p["name"] for p in copied["imported"]} == {"样例预设 (2)", "第二个预设 (2)"}
    exported = store.export(preset_id)
    assert list(exported) == ["样例预设"]
    assert exported["样例预设"]["entries"][0]["id"] == "e1"
    store.delete(preset_id)
    with pytest.raises(KeyError):
        store.get(preset_id)


def test_store_rejects_bad_ids(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="编号"):
        PresetStore(tmp_path).get("../x")


def test_builtin_presets_are_seeded_once(tmp_path: Path) -> None:
    builtin = tmp_path / "builtin"
    builtin.mkdir()
    (builtin / "a.json").write_text(json.dumps({"内置": {"entries": [{"role": "user", "content": "x"}]}}))
    store = PresetStore(tmp_path / "data")
    seeded = store.seed_builtin(builtin, [])
    assert seeded == ["a.json"]
    assert store.list()[0]["builtin"] is True
    store.delete(store.list()[0]["id"])
    assert store.seed_builtin(builtin, seeded) == ["a.json"]
    assert store.list() == []


@pytest.mark.parametrize(
    ("filename", "model", "expected_variables"),
    [
        ("soda-moss-basic.json", "MOSS-Image", {"生图数量": "1"}),
        ("soda-anima-basic.json", "Anima", {"生图数量": "1"}),
        ("soda-krea2-basic.json", "Krea2", {"生图数量": "1", "画风开头": "Anime-style illustration"}),
    ],
)
def test_bundled_presets_render_cleanly(filename: str, model: str, expected_variables: dict) -> None:
    from conftest import ROOT  # noqa: PLC0415

    text = (ROOT / "presets_builtin" / filename).read_text(encoding="utf-8")
    presets, warnings = parse_file(text)
    assert warnings == []
    preset = {**presets[0], "id": "b", "overrides": {}}
    messages, report = render_messages(preset, {**PLACEHOLDERS, "素材": ""}, "")
    assert report["removed_macros"] == {}
    assert report["missing_variables"] == []
    assert report["variables"] == expected_variables
    assert f"{model} 文生图提示词" in messages[0]["content"]
    assert "{@" not in json.dumps(messages, ensure_ascii=False)
    assert messages[-1]["role"] == "user"
    assert "画一个撑伞的人" in messages[-1]["content"]


def test_bundled_krea2_style_opening_can_be_overridden() -> None:
    from conftest import ROOT  # noqa: PLC0415

    presets, _ = parse_file((ROOT / "presets_builtin" / "soda-krea2-basic.json").read_text(encoding="utf-8"))
    preset = {**presets[0], "id": "k", "overrides": {"画风开头": "Photorealistic photo"}}
    messages, report = render_messages(preset, {**PLACEHOLDERS, "素材": ""}, "")
    rules = json.dumps(messages, ensure_ascii=False)
    assert report["variables"]["画风开头"] == "Photorealistic photo"
    assert "Photorealistic photo, [Tags]" in rules
    assert "Anime-style illustration" not in rules


def test_variables_from_disabled_entries_are_fallbacks() -> None:
    entries = [
        {"role": "system", "content": "{@setvar::tag::think@}{@setvar::n::2@}配置", "enabled": False},
        {"role": "user", "content": "<{@getvar::tag@}> 共 {@getvar::n@} 张"},
        {"role": "user", "content": "{@setvar::n::5@}"},
    ]
    presets, _ = parse_file(json.dumps({"p": {"entries": entries}}))
    preset = {**presets[0], "id": "p", "overrides": {}}
    messages, report = render_messages(preset, {}, "")
    assert messages == [{"role": "user", "content": "<think> 共 5 张"}]
    assert report["missing_variables"] == []
    assert any("tag" in w and "停用" in w for w in report["warnings"])
    assert not any("n" in w.split("：")[-1].split("、") for w in report["warnings"])
    assert {v["name"]: v["default"] for v in variables(preset)} == {"tag": "think", "n": "5"}
