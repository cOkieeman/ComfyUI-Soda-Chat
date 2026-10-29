"""Parse an LLM reply written with an st-chatu8 style image preset."""

from __future__ import annotations

import re
from typing import Any

THINK_TAG = r"(?:thinking|think|[A-Za-z]*_think)"
_THINK_BLOCK = re.compile(rf"<(?P<tag>{THINK_TAG})\s*>(?P<body>.*?)</(?P=tag)\s*>", re.DOTALL | re.IGNORECASE)
_THINK_OPEN = re.compile(rf"<(?P<tag>{THINK_TAG})\s*>", re.IGNORECASE)
_THINK_CLOSE = re.compile(rf"</(?P<tag>{THINK_TAG})\s*>", re.IGNORECASE)
_IMAGE = re.compile(r"<image\s*>(?P<body>.*?)(?:</image\s*>|\Z)", re.DOTALL | re.IGNORECASE)
_IMAGES_WRAPPER = re.compile(r"</?images\s*>", re.IGNORECASE)
_SIZE = re.compile(r"(\d{2,5})\s*[xX×*＊]\s*(\d{2,5})")
_BLANK_RUNS = re.compile(r"\n[ \t]*(?:\n[ \t]*){2,}")
MIN_SIDE, MAX_SIDE, SIDE_STEP = 256, 4096, 8


def _field(body: str, tags: str) -> str | None:
    pattern = rf"<(?P<tag>{tags})\s*>(?P<value>.*?)(?:</(?P=tag)\s*>|\Z)"
    match = re.search(pattern, body, re.DOTALL | re.IGNORECASE)
    return match["value"].strip() if match else None


def parse_size(raw: str | None) -> tuple[dict[str, int] | None, str | None]:
    if not raw:
        return None, None
    match = _SIZE.search(raw)
    if not match:
        return None, f"尺寸「{raw}」看不懂，未采用"
    width, height = int(match[1]), int(match[2])
    for side in (width, height):
        if not MIN_SIDE <= side <= MAX_SIDE or side % SIDE_STEP:
            return None, f"尺寸 {width}x{height} 需在 {MIN_SIDE}–{MAX_SIDE} 之间且是 8 的倍数，未采用"
    return {"width": width, "height": height}, None


def strip_thinking(text: str) -> tuple[str, list[str]]:
    """Remove think blocks; a leading close tag without an opener marks everything before it."""
    thoughts: list[str] = []
    close = _THINK_CLOSE.search(text)
    opener = _THINK_OPEN.search(text)
    if close and (not opener or opener.start() > close.start()):
        thoughts.append(text[: close.start()].strip())
        text = text[close.end() :]

    def keep(match: re.Match[str]) -> str:
        thoughts.append(match["body"].strip())
        return ""

    text = _THINK_BLOCK.sub(keep, text)
    opener = _THINK_OPEN.search(text)
    if opener:  # unfinished stream: the rest is still thinking
        thoughts.append(text[opener.end() :].strip())
        text = text[: opener.start()]
    return text, [t for t in thoughts if t]


def parse_reply(text: str, *, finished: bool = True) -> dict[str, Any]:
    warnings: list[str] = []
    images: list[dict[str, Any]] = []
    image_spans: list[tuple[int, int]] = []
    for match in _IMAGE.finditer(text):
        body = match["body"]
        closed = bool(re.search(r"</image\s*>\s*$", match.group(0), re.IGNORECASE))
        image_spans.append(match.span())
        size, size_warning = parse_size(_field(body, "size"))
        item_warnings = [size_warning] if size_warning else []
        prompt = _field(body, "prompts|prompt")
        if prompt is None:
            item_warnings.append("这张图没有 <prompts> 内容")
        prompt_closed = re.search(r"</prompts?\s*>", body, re.IGNORECASE)
        incomplete = not closed or (prompt is not None and not prompt_closed)
        if incomplete and finished:
            item_warnings.append("回复被截断，这张图可能不完整")
        images.append(
            {
                "index": len(images),
                "title": _field(body, "title_styled|title") or "",
                "mount": _field(body, "regex") or "",
                "think": _field(body, THINK_TAG) or "",
                "size": size,
                "size_raw": _field(body, "size") or "",
                "prompt": prompt or "",
                "incomplete": incomplete,
                "warnings": item_warnings,
            }
        )
    rest = text
    for start, end in reversed(image_spans):
        rest = rest[:start] + rest[end:]
    rest, thoughts = strip_thinking(_IMAGES_WRAPPER.sub("", rest))
    return {
        "text": _BLANK_RUNS.sub("\n\n", rest).strip(),
        "thinking": thoughts,
        "images": images,
        "warnings": warnings,
    }


def history_text(reply: str) -> str:
    """Assistant reply as context for later turns: thinking removed, image blocks kept."""
    text, _ = strip_thinking(reply)
    return _BLANK_RUNS.sub("\n\n", text).strip()
