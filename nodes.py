"""The node the sidebar writes into. It does no network or file access of its own."""

from __future__ import annotations

from typing import Any

SIDE = {"min": 256, "max": 4096, "step": 8}


class SodaChatPrompt:
    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "prompt": (
                    "STRING",
                    {"multiline": True, "default": "", "tooltip": "由 Soda Chat 侧边栏填入，也可手改"},
                ),
                "width": ("INT", {"default": 832, **SIDE}),
                "height": ("INT", {"default": 1216, **SIDE}),
                "label": ("STRING", {"default": "", "tooltip": "画布上有多个本节点时，用它区分要填哪一个"}),
            }
        }

    RETURN_TYPES = ("STRING", "INT", "INT")
    RETURN_NAMES = ("prompt", "width", "height")
    FUNCTION = "run"
    CATEGORY = "Soda/Chat"
    DESCRIPTION = "Soda Chat 侧边栏把聊天得到的提示词和尺寸写进这里。"

    def run(self, prompt: str, width: int, height: int, label: str) -> tuple[str, int, int]:
        return prompt, width, height


NODE_CLASS_MAPPINGS = {"SodaChatPrompt": SodaChatPrompt}
NODE_DISPLAY_NAME_MAPPINGS = {"SodaChatPrompt": "Soda Chat 提示词"}
