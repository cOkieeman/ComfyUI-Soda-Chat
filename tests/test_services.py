from __future__ import annotations

import json
from typing import TYPE_CHECKING

import pytest

from soda_chat.services import ServiceStore, chat_url, check_base_url, models_url

if TYPE_CHECKING:
    from pathlib import Path

SECRET = "sk-test-secret-123"


@pytest.mark.parametrize(
    "url",
    [
        "https://api.example.com/v1",
        "http://127.0.0.1:1234/v1",
        "http://localhost:8000",
        "http://192.168.1.5:8045/v1",
    ],
)
def test_allowed_urls(url: str) -> None:
    assert check_base_url(url + "/") == url


@pytest.mark.parametrize(
    "url",
    ["http://api.example.com/v1", "ftp://x", "https://user:pw@x.com", "https://x.com/v1?key=1", "not a url"],
)
def test_rejected_urls(url: str) -> None:
    with pytest.raises(ValueError, match=r"服务地址|https"):
        check_base_url(url)


def test_endpoint_paths() -> None:
    assert chat_url("https://a.com/v1") == "https://a.com/v1/chat/completions"
    assert chat_url("https://a.com/v1/chat/completions") == "https://a.com/v1/chat/completions"
    assert models_url("https://a.com/v1/chat/completions") == "https://a.com/v1/models"


def test_keys_are_hidden_kept_and_reset_on_address_change(tmp_path: Path) -> None:
    store = ServiceStore(tmp_path)
    result = store.save("", {"name": "A", "base_url": "https://a.com/v1", "model": "m", "api_key": SECRET})
    profile_id = result["saved"]
    assert result["active"] == profile_id
    assert SECRET not in json.dumps(store.public())
    assert store.public()["profiles"][0]["has_key"] is True

    store.save(profile_id, {"name": "A2", "model": "m2", "api_key": ""})
    assert store.get(profile_id)["api_key"] == SECRET
    assert store.get()["model"] == "m2"

    with pytest.raises(ValueError, match="重新填写"):
        store.save(profile_id, {"base_url": "https://b.com/v1", "api_key": ""})
    store.save(profile_id, {"base_url": "https://b.com/v1", "api_key": "sk-new"})
    assert store.get(profile_id)["api_key"] == "sk-new"


def test_draft_uses_stored_key_without_saving(tmp_path: Path) -> None:
    store = ServiceStore(tmp_path)
    profile_id = store.save("", {"base_url": "https://a.com/v1", "model": "m", "api_key": SECRET})["saved"]
    draft = store.draft(profile_id, {"model": "other"})
    assert draft["api_key"] == SECRET
    assert store.get(profile_id)["model"] == "m"


@pytest.mark.parametrize(
    "update",
    [
        {"base_url": "https://a.com", "temperature": 5},
        {"base_url": "https://a.com", "max_tokens": True},
        {"base_url": "https://a.com", "stream": "yes"},
        {"base_url": "https://a.com", "model": "two\nlines"},
    ],
)
def test_invalid_profiles(tmp_path: Path, update: dict) -> None:
    with pytest.raises((ValueError, TypeError)):
        ServiceStore(tmp_path).save("", update)


def test_activate_delete_and_missing(tmp_path: Path) -> None:
    store = ServiceStore(tmp_path)
    with pytest.raises(KeyError):
        store.get()
    a = store.save("", {"base_url": "https://a.com", "model": "a"})["saved"]
    b = store.save("", {"base_url": "https://b.com", "model": "b"})["saved"]
    assert store.activate(b)["active"] == b
    assert store.delete(b)["active"] == a


def test_import_from_soda_prompt_workflow(tmp_path: Path) -> None:
    source = tmp_path / "spw" / "ai_services.json"
    source.parent.mkdir()
    source.write_text(
        json.dumps(
            {
                "active": "glm",
                "profiles": {
                    "deepseek": {
                        "name": "DeepSeek",
                        "base_url": "https://api.deepseek.com",
                        "text_model": "deepseek-flash",
                    },
                    "glm": {
                        "name": "GLM",
                        "base_url": "https://open.bigmodel.cn/api/paas/v4",
                        "text_model": "glm-x",
                        "api_key": SECRET,
                    },
                    "custom": {"name": "空", "base_url": "", "text_model": ""},
                },
            }
        ),
        encoding="utf-8",
    )
    store = ServiceStore(tmp_path / "data")
    result = store.import_soda_prompt_workflow(source)
    assert result["imported"] == ["SPW · DeepSeek", "SPW · GLM"]
    assert any("DeepSeek" in s for s in result["skipped"])
    assert SECRET not in json.dumps(result)
    glm = next(p for p in result["profiles"] if p["name"] == "SPW · GLM")
    assert glm["has_key"] is True
    assert store.get(glm["id"])["api_key"] == SECRET
    again = store.import_soda_prompt_workflow(source)
    assert len(again["profiles"]) == 2
    with pytest.raises(FileNotFoundError):
        store.import_soda_prompt_workflow(tmp_path / "missing.json")
