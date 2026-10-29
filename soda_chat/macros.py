"""st-chatu8 style variables ({@setvar@}/{@getvar@}) and {{placeholders}}."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections import Counter
    from collections.abc import Iterable, Mapping

SETVAR = re.compile(r"\{@setvar::(?P<name>.+?)::(?P<value>.*?)@\}", re.DOTALL)
GETVAR = re.compile(r"\{@getvar::(?P<name>.+?)@\}")
PLACEHOLDER = re.compile(r"\{\{(?P<body>[^{}]*)\}\}")
_BLANK_RUNS = re.compile(r"\n[ \t]*(?:\n[ \t]*){2,}")


def collect_setvars(texts: Iterable[str]) -> dict[str, str]:
    """Default value of every variable: the last {@setvar@} wins."""
    values: dict[str, str] = {}
    for text in texts:
        for match in SETVAR.finditer(text):
            name = match["name"].strip()
            values.pop(name, None)
            values[name] = match["value"]
    return values


def macro_name(body: str) -> str:
    words = body.strip().split()
    return words[0] if words else "（空）"


def render(
    text: str,
    variables: Mapping[str, str],
    placeholders: Mapping[str, str],
    removed: Counter[str],
    missing: set[str],
) -> str:
    """Strip setvar, resolve getvar, then replace known placeholders and drop the rest."""
    text = SETVAR.sub("", text)

    def getvar(match: re.Match[str]) -> str:
        name = match["name"].strip()
        if name in variables:
            return variables[name]
        missing.add(name)
        return ""

    def placeholder(match: re.Match[str]) -> str:
        body = match["body"].strip()
        if body in placeholders:
            return placeholders[body]
        removed[macro_name(body)] += 1
        return ""

    text = GETVAR.sub(getvar, text)
    text = PLACEHOLDER.sub(placeholder, text)
    return _BLANK_RUNS.sub("\n\n", text).strip()
