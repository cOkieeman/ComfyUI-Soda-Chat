"""OpenAI-compatible service profiles. Keys stay in services.json and never leave the server."""

from __future__ import annotations

import ipaddress
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from .storage import check_id, new_id, read_json, write_json

if TYPE_CHECKING:
    from pathlib import Path

DEFAULTS: dict[str, Any] = {
    "name": "",
    "base_url": "",
    "model": "",
    "temperature": 0.8,
    "max_tokens": 8192,
    "timeout": 180,
    "stream": True,
    "merge_same_role": False,
    "system_to_user": False,
}
LAN_NETWORKS = tuple(
    ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7")
)
MAX_TEXT = 1000
MAX_KEY = 8192


def check_base_url(base_url: str) -> str:
    url = base_url.strip().rstrip("/")
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        raise ValueError("服务地址需要完整的 http(s) 地址")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("服务地址里不能带账号、密钥、查询参数或 # 片段")
    if parts.scheme == "http":
        host = parts.hostname.lower()
        allowed = host == "localhost" or host.endswith(".localhost")
        try:
            address = ipaddress.ip_address(host)
            allowed = address.is_loopback or any(address in network for network in LAN_NETWORKS)
        except ValueError:
            pass
        if not allowed:
            raise ValueError("公网服务地址请用 https；http 只允许本机和局域网地址")
    return url


def chat_url(base_url: str) -> str:
    url = check_base_url(base_url)
    return url if url.endswith("/chat/completions") else url + "/chat/completions"


def models_url(base_url: str) -> str:
    url = check_base_url(base_url)
    return url.removesuffix("/chat/completions") + "/models"


def _line(value: Any, label: str) -> str:
    if not isinstance(value, str) or len(value) > MAX_TEXT or "\n" in value or "\r" in value:
        raise ValueError(f"{label}必须是单行文字")
    return value.strip()


def _number(value: Any, label: str, low: float, high: float, *, integer: bool = False) -> float | int:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise TypeError(f"{label}必须是数字")
    if not low <= value <= high:
        raise ValueError(f"{label}需在 {low}–{high} 之间")
    return int(value) if integer else float(value)


def merge_profile(old: dict[str, Any] | None, update: dict[str, Any]) -> dict[str, Any]:
    """Validate an edited profile. An empty key keeps the old one unless the address changed."""
    if not isinstance(update, dict):
        raise TypeError("服务配置格式错误")
    profile = {**DEFAULTS, **(old or {})}
    profile["name"] = _line(update.get("name", profile["name"]), "名称") or "未命名服务"
    profile["base_url"] = check_base_url(_line(update.get("base_url", profile["base_url"]), "服务地址"))
    profile["model"] = _line(update.get("model", profile["model"]), "模型")
    profile["temperature"] = _number(update.get("temperature", profile["temperature"]), "temperature", 0, 2)
    profile["max_tokens"] = _number(
        update.get("max_tokens", profile["max_tokens"]), "max_tokens", 16, 200000, integer=True
    )
    profile["timeout"] = _number(update.get("timeout", profile["timeout"]), "超时", 10, 1800, integer=True)
    for flag in ("stream", "merge_same_role", "system_to_user"):
        value = update.get(flag, profile[flag])
        if not isinstance(value, bool):
            raise TypeError(f"{flag} 必须是开关值")
        profile[flag] = value
    key = update.get("api_key", "")
    if not isinstance(key, str) or len(key) > MAX_KEY or "\n" in key or "\r" in key:
        raise ValueError("API Key 必须是单行文字")
    if key.strip():
        profile["api_key"] = key.strip()
    elif old and old.get("api_key") and old.get("base_url", "").rstrip("/") != profile["base_url"]:
        raise ValueError("服务地址改了，请重新填写 API Key，避免把旧密钥发到新地址")
    return profile


def public(profile_id: str, profile: dict[str, Any]) -> dict[str, Any]:
    data = {k: v for k, v in profile.items() if k != "api_key"}
    return {**data, "id": profile_id, "has_key": bool(profile.get("api_key"))}


class ServiceStore:
    def __init__(self, root: Path) -> None:
        self.path = root / "services.json"

    def _load(self) -> dict[str, Any]:
        data = read_json(self.path, {"active": "", "profiles": {}})
        if not isinstance(data, dict) or not isinstance(data.get("profiles"), dict):
            raise TypeError("services.json 格式不对，请删除后重新配置")
        return data

    def public(self) -> dict[str, Any]:
        data = self._load()
        profiles = [public(pid, p) for pid, p in data["profiles"].items()]
        return {"active": data.get("active", ""), "profiles": profiles}

    def get(self, profile_id: str = "") -> dict[str, Any]:
        """Full profile including the key, for server-side requests only."""
        data = self._load()
        profile_id = profile_id or data.get("active", "")
        if profile_id not in data["profiles"]:
            raise KeyError("还没有可用的模型服务，请先到「设置」里添加")
        return {**DEFAULTS, **data["profiles"][profile_id]}

    def draft(self, profile_id: str, update: dict[str, Any]) -> dict[str, Any]:
        """Unsaved edits merged with the stored key, for test / list-models buttons."""
        old = self._load()["profiles"].get(profile_id) if profile_id else None
        return merge_profile(old, update)

    def save(self, profile_id: str, update: dict[str, Any]) -> dict[str, Any]:
        data = self._load()
        if profile_id:
            check_id(profile_id)
        else:
            profile_id = new_id()
        data["profiles"][profile_id] = merge_profile(data["profiles"].get(profile_id), update)
        if not data.get("active") or data["active"] not in data["profiles"]:
            data["active"] = profile_id
        write_json(self.path, data)
        return {**self.public(), "saved": profile_id}

    def activate(self, profile_id: str) -> dict[str, Any]:
        data = self._load()
        if profile_id not in data["profiles"]:
            raise KeyError("服务不存在")
        data["active"] = profile_id
        write_json(self.path, data)
        return self.public()

    def delete(self, profile_id: str) -> dict[str, Any]:
        data = self._load()
        data["profiles"].pop(profile_id, None)
        if data.get("active") == profile_id:
            data["active"] = next(iter(data["profiles"]), "")
        write_json(self.path, data)
        return self.public()

    def import_soda_prompt_workflow(self, path: Path) -> dict[str, Any]:
        """Copy the profiles of the Soda Prompt Workflow node pack (keys included, never returned)."""
        if not path.is_file():
            raise FileNotFoundError("没有找到 Soda Prompt Workflow 的服务配置（ai_services.json）")
        source = read_json(path, {})
        profiles = source.get("profiles") if isinstance(source, dict) else None
        if not isinstance(profiles, dict):
            raise TypeError("Soda Prompt Workflow 的服务配置格式看不懂")
        data = self._load()
        imported, skipped = [], []
        for key, item in profiles.items():
            if not isinstance(item, dict):
                continue
            label = str(item.get("name") or key)
            if not item.get("base_url") or not item.get("text_model"):
                continue
            if not item.get("api_key"):
                skipped.append(f"{label}（密钥不在这个文件里，请手动填写）")
            update = {"name": f"SPW · {label}", "base_url": item["base_url"], "model": item["text_model"]}
            if item.get("api_key"):
                update["api_key"] = item["api_key"]
            try:
                profile = merge_profile(None, update)
            except (ValueError, TypeError) as exc:
                skipped.append(f"{label}（{exc}）")
                continue
            existing = next(
                (pid for pid, p in data["profiles"].items() if p["name"] == profile["name"]), None
            )
            data["profiles"][existing or new_id()] = profile
            imported.append(profile["name"])
        if not data.get("active") and data["profiles"]:
            data["active"] = next(iter(data["profiles"]))
        write_json(self.path, data)
        return {**self.public(), "imported": imported, "skipped": skipped}
