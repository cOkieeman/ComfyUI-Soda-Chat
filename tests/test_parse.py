from __future__ import annotations

import pytest

from soda_chat.parse import history_text, parse_reply, parse_size, strip_thinking

REPLY = """<thinking>
先想一想构图。
</thinking>
这一版走雨夜氛围。
<images>
<image>
<regex>她撑着伞</regex>
<title_styled>雨夜车站</title_styled>
<scene_think>车站、雨、路灯</scene_think>
<size>832x1216</size>
<prompts>
[Tags]
1girl, solo, umbrella, rain

[Concept]
A woman waits at a station in the rain.
</prompts>
</image>
<image>
<title_styled>第二张</title_styled>
<size>1216 × 832</size>
<prompts>
[Tags]
city, night
</prompts>
</image>
</images>"""


def test_parse_reply_splits_thinking_text_and_images() -> None:
    parsed = parse_reply(REPLY)
    assert parsed["thinking"] == ["先想一想构图。"]
    assert parsed["text"] == "这一版走雨夜氛围。"
    first, second = parsed["images"]
    assert first["title"] == "雨夜车站"
    assert first["mount"] == "她撑着伞"
    assert first["think"] == "车站、雨、路灯"
    assert first["size"] == {"width": 832, "height": 1216}
    assert first["prompt"].startswith("[Tags]\n1girl, solo")
    assert first["prompt"].endswith("in the rain.")
    assert first["incomplete"] is False
    assert second["size"] == {"width": 1216, "height": 832}
    assert second["warnings"] == []


def test_truncated_image_is_flagged() -> None:
    parsed = parse_reply("<images><image><size>832x1216</size><prompts>[Tags]\n1girl, solo")
    image = parsed["images"][0]
    assert image["incomplete"] is True
    assert image["prompt"] == "[Tags]\n1girl, solo"
    assert any("截断" in w for w in image["warnings"])
    streaming = parse_reply("<image><prompts>[Tags]", finished=False)
    assert streaming["images"][0]["warnings"] == []


def test_image_without_prompts_and_plain_chat() -> None:
    parsed = parse_reply("你想要什么风格？\n<image><size>800x600</size></image>")
    assert parsed["text"] == "你想要什么风格？"
    assert any("prompts" in w for w in parsed["images"][0]["warnings"])
    assert parse_reply("只是聊天")["images"] == []


@pytest.mark.parametrize(
    ("raw", "size", "warned"),
    [
        ("832x1216", {"width": 832, "height": 1216}, False),
        ("1024*1024", {"width": 1024, "height": 1024}, False),
        ("尺寸 768X1344 推荐", {"width": 768, "height": 1344}, False),
        ("830x1216", None, True),
        ("100x100", None, True),
        ("竖幅", None, True),
        ("", None, False),
    ],
)
def test_parse_size(raw: str, size: dict | None, *, warned: bool) -> None:
    result, warning = parse_size(raw)
    assert result == size
    assert bool(warning) is warned


def test_strip_thinking_variants() -> None:
    assert strip_thinking("前面的思考</thinking>正文") == ("正文", ["前面的思考"])
    assert strip_thinking("<Tag_think>a</Tag_think>b") == ("b", ["a"])
    assert strip_thinking("x<thinking>还没想完") == ("x", ["还没想完"])


def test_history_text_keeps_images_without_thinking() -> None:
    text = history_text(REPLY)
    assert "先想一想" not in text
    assert "车站、雨、路灯" not in text
    assert "<prompts>" in text
