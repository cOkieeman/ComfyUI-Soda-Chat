from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from soda_chat.characters import CharacterStore, normalize_library, resolve_calls, roster_text

if TYPE_CHECKING:
    from pathlib import Path

LIBRARY = normalize_library(
    {
        "characters": [
            {
                "name": "Xiao Qing",
                "aliases": "小青、青青",
                "summary": "短发的咖啡店店员",
                "front": {
                    "base": "short black hair, green eyes",
                    "upper_sfw": "white shirt",
                    "upper_nsfw": "UPPER-N",
                    "lower_sfw": "black skirt",
                    "lower_nsfw": "LOWER-N",
                },
                "back": {"base": "short black hair seen from behind", "upper_sfw": "shirt back"},
            },
            {"name": "Young woman template", "kind": "template", "front": {"base": "a young woman"}},
            {"name": "Hidden one", "enabled": False, "front": {"base": "nope"}},
        ]
    }
)


def call(**fields: str) -> str:
    body = ", ".join(f'"{k}":"{v}"' for k, v in fields.items())
    return "${" + body + "}$"


def test_front_call_uses_states() -> None:
    text, calls, warnings = resolve_calls(
        "[Subject]\n" + call(name="xiao qing", angle="from front", upperBody="sfw", lowerBody="hidden"),
        LIBRARY,
    )
    assert text == "[Subject]\nshort black hair, green eyes, white shirt"
    assert calls[0]["found"] is True
    assert warnings == []


def test_back_call_falls_back_to_front_fields() -> None:
    text, _, _ = resolve_calls(
        call(name="小青", angle="from behind", upperBody="sfw", lowerBody="sfw"), LIBRARY
    )
    assert text == "short black hair seen from behind, shirt back, black skirt"


def test_nsfw_state_and_unknown_state() -> None:
    text, _, warnings = resolve_calls(call(name="青青", upperBody="nsfw", lowerBody="weird"), LIBRARY)
    assert text == "short black hair, green eyes, UPPER-N, black skirt"
    assert any("weird" in w for w in warnings)


def test_missing_disabled_and_broken_calls() -> None:
    text, calls, warnings = resolve_calls(
        f"A {call(name='Nobody')} and {call(name='Hidden one')} and ${{broken}}$ end", LIBRARY
    )
    assert text == "A Nobody and Hidden one and  end"
    assert [c["found"] for c in calls] == [False, False, False]
    assert len(warnings) == 3


def test_full_width_quotes_are_accepted() -> None:
    text, _, _ = resolve_calls("${“name”:“小青”, “upperBody”:“hidden”, “lowerBody”:“hidden”}$", LIBRARY)
    assert text == "short black hair, green eyes"


def test_roster_text() -> None:
    assert roster_text(LIBRARY, "specific") == "- Xiao Qing（别名：小青、青青）：短发的咖啡店店员"
    assert roster_text(LIBRARY, "template") == "- Young woman template"
    assert roster_text({"characters": []}, "specific") == "（无）"


def test_library_validation_and_store(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="名字"):
        normalize_library({"characters": [{"name": " "}]})
    with pytest.raises(ValueError, match="重复"):
        normalize_library({"characters": [{"name": "A"}, {"name": "a"}]})
    store = CharacterStore(tmp_path)
    assert store.load() == {"characters": []}
    saved = store.save({"characters": [{"name": "A", "front": {"base": "x", "junk": "y"}}]})
    assert saved["characters"][0]["front"] == {
        "base": "x",
        "upper_sfw": "",
        "upper_nsfw": "",
        "lower_sfw": "",
        "lower_nsfw": "",
    }
    assert store.load() == saved
