"""JSON files under the Soda Chat data directory, written atomically."""

from __future__ import annotations

import json
import os
import re
import tempfile
import uuid
from pathlib import Path
from typing import Any

_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def read_json(path: Path, default: Any) -> Any:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return default
    try:
        return json.loads(text)
    except ValueError:
        raise ValueError(f"{path.name} 不是有效的 JSON，请修复或删除后重试") from None


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        Path(temporary).replace(path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def check_id(value: Any) -> str:
    if not isinstance(value, str) or not _ID.match(value):
        raise ValueError("编号格式不正确")
    return value
