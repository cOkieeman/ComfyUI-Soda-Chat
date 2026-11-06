# ComfyUI Soda Chat

在 ComfyUI 侧边栏和大语言模型聊天：模型按预设写出图像提示词，点一下就把提示词和尺寸填进工作流里的「Soda Chat 提示词」节点，再替你排队出图。不用切出去复制粘贴，也不用写 API 格式的工作流。

预设兼容 SillyTavern 插件 st-chatu8 的 LLM 预设文件，可以直接导入现成的生图预设。

## 功能

- **侧边栏聊天**：选预设和模型服务，流式显示回复，可以中途停止。对话记录保存在本机，可以回看和继续。
- **图片卡片**：回复里的每张图显示成一张卡片，有标题、尺寸和可修改的提示词。按钮「填入」「填入并出图」，多张图时还有「全部依次出图」。
- **看图修改**：选择当前工作流或最近生成的图片，附上修改要求，交给支持看图的模型继续写提示词；历史对话中的图片可以再次选用。
- **「Soda Chat 提示词」节点**：输出 `prompt`、`width`、`height`，接进任意工作流。
- **预设管理**：导入 st-chatu8 预设 JSON，逐条开关条目，修改 `{@setvar@}` 变量；可以预览实际发给模型的全部消息。
- **角色库**：支持预设里的 `${...}$` 角色调用，按正面 / 背面和穿着状态拼出外貌描述。
- **模型服务**：OpenAI 兼容的 `chat/completions` 接口，可存多套配置；可以从 Soda Prompt Workflow 导入已有配置。
- 自带三个预设，不导入预设也能直接用：「Soda 默认 · MOSS 单图」「Soda 默认 · Anima 单图」（danbooru 标签 + 英文短句）、「Soda 默认 · Krea2 结构化」（一行带方括号区块，开头的画风句可在变量「画风开头」里改）。

## 安装

把整个 `ComfyUI-Soda-Chat` 文件夹放到 `ComfyUI/custom_nodes/`，或在该目录执行：

```sh
git clone https://github.com/cOkieeman/ComfyUI-Soda-Chat.git
```

重启 ComfyUI 并刷新网页，左侧栏会出现「Soda Chat」（对话气泡图标）。不需要额外 `pip install`：使用 Python 标准库及 ComfyUI 自带的 aiohttp、Pillow。

## 第一次使用

1. **添加模型服务**：打开「设置」页，填名称、服务地址、模型和 API Key，点「保存」，再点「测试连接」。本机的 LM Studio、Ollama（OpenAI 兼容地址）可以不填 Key。装过 Soda Prompt Workflow 的话，可以直接点「从 Soda Prompt Workflow 导入」。
2. **选预设**：「聊天」页顶部选预设。要用自己的预设，到「预设」页点「导入预设 JSON」。
3. **放节点**：在工作流里添加「Soda Chat 提示词」节点（搜索 Soda Chat），把 `prompt` 接到文本编码或字符串拼接节点的文本输入，`width`、`height` 接到空 Latent 的尺寸。画布上没有这个节点时，聊天页会提示，并提供「添加节点」按钮。
4. **聊天出图**：说想画什么，回复里出现图片卡片后，点「填入并出图」。

`example_workflows/soda-chat-demo.json` 是不需要任何模型的演示工作流：节点的三个输出接到文字预览，用来确认填入和排队都正常。

### 根据生成图继续修改

1. 先用工作流出图，在聊天输入区点「选择生成图」，选择要讨论的图片，再点「完成选择」。列表包含当前工作流和最近 20 次任务中的 PNG、JPEG、WebP。
2. 使用支持图片输入的 OpenAI 兼容模型，写清希望保留和修改的部分，例如「保留配色和背景，把人物放大并移到左侧」，再发送。
3. 查看新的提示词卡片，必要时手动修改，再点「填入并出图」。手动改过的卡片内容会进入后续聊天上下文。

每轮最多附 4 张图。选中的图片会随每轮消息发送，直到你点「移除」；可以在「预览发送内容」中核对。历史记录不会自动重发图片，需要时点「继续用这张图」。

图片会在本机保存去除工作流、EXIF 等元数据的 JPEG 副本，长边最多 2048 像素；原图不变。支持不超过 20 MB、4000 万像素的原图。附件只用于模型观察和修改提示词，不会自动接入工作流的图生图输入。移除选图或删除对话目前不会自动清理附件副本。

### 多个节点

画布上有多个「Soda Chat 提示词」节点时，在节点的 `label` 里填上名字，再到「设置 → 目标节点 label」填同一个名字。留空就填第一个找到的节点。子图里的节点也能找到。

目标节点或父子图处于静音 / 绕过状态时会提示先启用对应模式。排队失败会显示错误，批量出图也会在失败处停止。

## 预设格式

文件是 JSON 对象，每个顶层键是一个预设：

```json
{
  "预设名": {
    "entries": [
      { "name": "条目名", "role": "system", "content": "……", "enabled": true,
        "triggerMode": "always", "triggerWords": "", "andTriggerWords": "" }
    ]
  }
}
```

每个启用的条目按顺序变成一条消息，`assistant` 条目就是预填的助手回复。

**触发**：`triggerMode` 为 `always` 时总是发送；否则 `triggerWords`（逗号、顿号或竖线分隔）任意一个出现在本轮输入或素材里才发送，`andTriggerWords` 要全部出现。

**变量**：`{@setvar::名字::值@}` 设置变量，`{@getvar::名字@}` 读取。同名变量以最后一个为准；停用或未触发的条目里定义的变量也会作为默认值，但优先级最低。在「预设」页填的覆盖值优先于预设里的所有定义。

**占位符**：

| 占位符 | 内容 |
|---|---|
| `{{用户需求}}` | 本轮输入 |
| `{{正文}}` | 「素材」框；为空时用本轮输入 |
| `{{素材}}` | 「素材」框（为空就是空） |
| `{{上下文}}` | 之前若干轮对话（轮数在设置里改），已去掉思考过程 |
| `{{世界书触发}}` | 「设定」框 |
| `{{角色启用列表}}` / `{{通用角色启用列表}}` | 角色库里启用的特定角色 / 通用模板 |
| `{{user}}` / `{{char}}` | 设置里的名字 |

其他 `{{...}}` 宏不支持，发送前会删除，并在回复上方的「提示」里列出删了哪些、各几次。

**回复解析**：识别 `<image>` 块里的 `<title_styled>`、`<size>`、`<prompts>` 和画面思考；`<thinking>`、`<think>`、`*_think` 思考块会折叠起来，不进入下一轮的上下文。尺寸必须在 256–4096 之间且是 8 的倍数，否则不采用。

## 角色库

预设里的角色调用写成：

```text
${"name":"xiao hong", "angle":"from front", "upperBody":"sfw", "lowerBody":"hidden"}$
```

Soda Chat 按名字或别名在角色库里查找，拼接「基础外貌 + 上半身 + 下半身」：`angle` 含 `behind` 时用背面字段（背面为空时退回正面），`hidden` 的部分跳过。找不到角色时只保留名字，并在卡片上提示。

## 密钥与安全

- 配置和数据都在 `ComfyUI/user/soda_chat/`：`services.json`（含 API Key）、`presets/`、`characters.json`、`sessions/`、`attachments/`、`settings.json`。附件副本保留在本机，原始输出被移动后仍可用于续聊。
- API Key 只在服务端读取，接口不会返回，也不会写进节点、工作流、出图 PNG 或对话记录。修改服务地址时必须重新填写 Key，避免把旧 Key 发到新地址。
- 公网服务地址必须是 https；本机和局域网地址允许 http。
- Soda Chat 的接口只接受本机同源请求。用 `--listen` 从其他设备访问 ComfyUI 时，侧边栏会被拒绝。

## 已知限制

- 只支持 OpenAI 兼容的 `chat/completions`，不支持原生 Anthropic Messages 或 Gemini generateContent 地址。
- 看图需要服务和模型支持 OpenAI `image_url` 内容块；普通文本模型仍可用于不附图的聊天。
- 负面提示词不经过 Soda Chat，请在工作流里自己设置。

## 开发

```sh
uv run pytest
uv run ruff check .
node --test tests/frontend.test.mjs tests/frontend-service.test.mjs
```

浏览器布局回归使用已安装的 Playwright 和 Chromium / Edge，所有接口均由测试模拟，不调用模型或修改实际数据：

```sh
node --test tests/frontend-dom.test.mjs
```

如果 Playwright 不在项目的模块搜索路径中，将环境变量 `PLAYWRIGHT_PACKAGE_JSON` 设为现有 Playwright 的 `package.json` 绝对路径。需要指定浏览器时设置 `PLAYWRIGHT_EXECUTABLE_PATH`。

## 许可证

Apache-2.0
