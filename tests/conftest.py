from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from types import ModuleType

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(ROOT))


@pytest.fixture(scope="session")
def plugin() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "soda_chat_plugin", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def sample_text() -> str:
    return (FIXTURES / "sample_preset.json").read_text(encoding="utf-8")
