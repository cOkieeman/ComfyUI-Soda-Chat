import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "SodaChatPrompt";
const TAB_ID = "soda-chat";
const LS = "soda-chat:";
const ROLE_LABEL = { system: "系统", user: "用户", assistant: "助手" };
const SIDES = { front: "正面", back: "背面" };
const FIELDS = {
  base: "基础外貌",
  upper_sfw: "上半身（穿着）",
  upper_nsfw: "上半身（未穿）",
  lower_sfw: "下半身（穿着）",
  lower_nsfw: "下半身（未穿）",
};

// ---- small helpers ---------------------------------------------------------------------------------------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "on") for (const [event, fn] of Object.entries(value)) el.addEventListener(event, fn);
    else if (key === "style") Object.assign(el.style, value);
    else if (key in el && key !== "list") el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(LS + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(LS + key, JSON.stringify(value));
  } catch {
    /* storage is only a convenience */
  }
}

async function call(path, { method = "GET", body } = {}) {
  const options = { method };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  const res = await api.fetchApi(`/soda_chat/${path}`, options);
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

function toast(detail, severity = "info") {
  const service = app.extensionManager?.toast;
  if (service?.add) service.add({ severity, summary: "Soda Chat", detail, life: severity === "error" ? 6000 : 2500 });
  else console[severity === "error" ? "error" : "log"]("[Soda Chat]", detail);
}

function guard(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      toast(error.message || String(error), "error");
    }
  };
}

function download(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const link = h("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function pickFile() {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept: ".json,application/json" });
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.click();
  });
}

function shortTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ---- state -----------------------------------------------------------------------------------------------

const S = {
  host: null,
  ready: false,
  tab: load("tab", "chat"),
  presets: [],
  services: { active: "", profiles: [] },
  settings: {},
  sessions: [],
  session: null,
  presetId: load("preset", ""),
  draft: load("draft", ""),
  material: load("material", ""),
  setting: load("setting", ""),
  streaming: null,
  presetDetail: null,
  characters: null,
  serviceForm: null,
  modelOptions: [],
  showHistory: false,
  noNode: false,
  preview: null,
  stickBottom: true,
};

async function init() {
  const data = await call("state");
  Object.assign(S, { presets: data.presets, services: data.services, settings: data.settings, sessions: data.sessions });
  if (!S.presets.some((p) => p.id === S.presetId)) S.presetId = data.settings.last_preset || S.presets[0]?.id || "";
  const sessionId = load("session", "");
  if (sessionId && S.sessions.some((s) => s.id === sessionId)) {
    try {
      S.session = await call(`sessions/${sessionId}`);
    } catch {
      S.session = null;
    }
  }
  S.ready = true;
  render();
}

function setSession(session) {
  S.session = session;
  save("session", session?.id ?? "");
}

// ---- graph -----------------------------------------------------------------------------------------------

function graphNodes() {
  const root = app.rootGraph ?? app.graph;
  const found = [];
  const visit = (graph) => {
    for (const node of graph?.nodes ?? []) {
      if ((node.comfyClass ?? node.type) === NODE_TYPE && !found.includes(node)) found.push(node);
    }
  };
  visit(root);
  const subgraphs = root?.subgraphs;
  if (subgraphs?.values) for (const graph of subgraphs.values()) visit(graph);
  return found;
}

function widget(node, name) {
  return node.widgets?.find((w) => w.name === name);
}

function setWidget(node, name, value) {
  const w = widget(node, name);
  if (!w) return false;
  w.value = value;
  try {
    w.callback?.(value, app.canvas, node);
  } catch {
    /* some widgets have no meaningful callback */
  }
  return true;
}

function targetNode() {
  const nodes = graphNodes();
  const label = (S.settings.target_label || "").trim();
  if (label) return nodes.find((n) => widget(n, "label")?.value === label) ?? null;
  return nodes[0] ?? null;
}

async function fill(image, queue) {
  const node = targetNode();
  if (!node) {
    S.noNode = true;
    render();
    toast("画布上没有可填入的「Soda Chat 提示词」节点", "warn");
    return false;
  }
  setWidget(node, "prompt", image.prompt);
  if (S.settings.use_ai_size && image.size) {
    setWidget(node, "width", image.size.width);
    setWidget(node, "height", image.size.height);
  }
  node.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
  if (queue) {
    await app.queuePrompt(0, 1);
    toast("已填入并排队出图", "success");
  } else {
    toast("已填入节点", "success");
  }
  return true;
}

async function fillAll(images) {
  for (const image of images) {
    if (!(await fill(image, true))) return;
  }
}

function addNode() {
  const node = globalThis.LiteGraph?.createNode?.(NODE_TYPE);
  if (!node) {
    toast("没能自动创建节点，请在画布里搜索「Soda Chat 提示词」手动添加", "error");
    return;
  }
  const canvas = app.canvas;
  const ds = canvas?.ds;
  const rect = canvas?.canvas?.getBoundingClientRect?.();
  // The sidebar covers the left part of the canvas, so aim right of centre.
  if (ds && rect) node.pos = [(rect.width * 0.6) / ds.scale - ds.offset[0] - 160, rect.height / 2 / ds.scale - ds.offset[1] - 120];
  (canvas?.graph ?? app.graph).add(node);
  app.graph?.setDirtyCanvas?.(true, true);
  S.noNode = false;
  render();
  toast("已添加节点，把它的输出接到工作流里", "success");
}

// ---- chat ------------------------------------------------------------------------------------------------

async function readEvents(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

function turnRequest() {
  return {
    session_id: S.session?.id ?? "",
    preset_id: S.presetId,
    service_id: S.services.active,
    input: S.draft,
    material: S.material,
    setting: S.setting,
  };
}

function checkReady() {
  if (!S.presetId) throw new Error("请先在「预设」页导入或选择预设");
  if (!S.services.active) {
    S.tab = "settings";
    render();
    throw new Error("请先在「设置」里添加模型服务");
  }
}

async function sendMessage() {
  if (S.streaming) return;
  if (!S.draft.trim() && !S.material.trim()) return;
  checkReady();
  const body = turnRequest();
  const controller = new AbortController();
  S.streaming = { controller, user: body.input, text: "", reasoning: "", report: null };
  S.stickBottom = true;
  S.draft = "";
  save("draft", "");
  render();
  let finished = null;
  try {
    const res = await api.fetchApi("/soda_chat/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `请求失败（${res.status}）`);
    }
    await readEvents(res, (event, data) => {
      if (event === "start") {
        S.streaming.report = data.report;
        if (!S.session || S.session.id !== data.session_id) setSession({ id: data.session_id, title: data.title, turns: [] });
      } else if (event === "delta") {
        S.streaming[data.kind === "reasoning" ? "reasoning" : "text"] += data.text;
        updateStreaming();
      } else if (event === "done" || event === "error") {
        finished = data.turn;
        if (event === "error") toast(data.error, "error");
      }
    });
  } catch (error) {
    if (error.name === "AbortError") {
      finished = { id: `local-${Date.now()}`, user: body.input, reply: S.streaming.text, status: "interrupted", parsed: null, report: S.streaming.report };
    } else {
      S.draft = body.input;
      toast(error.message, "error");
    }
  } finally {
    if (finished && S.session) S.session.turns.push(finished);
    S.streaming = null;
    S.stickBottom = true;
    try {
      S.sessions = (await call("sessions")).sessions;
    } catch {
      /* the list refreshes next time */
    }
    render();
  }
}

function stopMessage() {
  S.streaming?.controller.abort();
}

async function openPreview() {
  checkReady();
  S.preview = await call("preview", { method: "POST", body: turnRequest() });
  render();
}

async function newSession() {
  if (S.streaming) return;
  setSession(null);
  S.showHistory = false;
  render();
}

async function openSession(id) {
  if (S.streaming) return;
  setSession(await call(`sessions/${id}`));
  S.showHistory = false;
  render();
}

async function deleteSession(id) {
  if (!confirm("删除这段对话记录？")) return;
  S.sessions = (await call(`sessions/${id}`, { method: "DELETE" })).sessions;
  if (S.session?.id === id) setSession(null);
  render();
}

let promptTimer = null;
function rememberPrompt(turn, image, value) {
  image.prompt = value;
  if (!S.session || String(turn.id).startsWith("local-")) return;
  clearTimeout(promptTimer);
  const sessionId = S.session.id;
  promptTimer = setTimeout(() => {
    call(`sessions/${sessionId}/prompt`, { method: "PATCH", body: { turn_id: turn.id, index: image.index, prompt: value } }).catch(() => {});
  }, 600);
}

// ---- rendering: chat -------------------------------------------------------------------------------------

function presetSelect() {
  return h(
    "select",
    {
      class: "sc-select",
      title: "预设",
      on: {
        change: guard(async (e) => {
          S.presetId = e.target.value;
          save("preset", S.presetId);
          S.settings = await call("settings", { method: "PUT", body: { last_preset: S.presetId } });
        }),
      },
    },
    S.presets.length ? null : h("option", { value: "", text: "（没有预设）" }),
    S.presets.map((p) => h("option", { value: p.id, text: p.name, selected: p.id === S.presetId })),
  );
}

function serviceSelect() {
  return h(
    "select",
    {
      class: "sc-select",
      title: "模型服务",
      on: {
        change: guard(async (e) => {
          S.services = await call(`services/${e.target.value}/activate`, { method: "POST", body: {} });
        }),
      },
    },
    S.services.profiles.length ? null : h("option", { value: "", text: "（没有模型服务）" }),
    S.services.profiles.map((p) => h("option", { value: p.id, text: p.model ? `${p.name} · ${p.model}` : p.name, selected: p.id === S.services.active })),
  );
}

function warningList(items) {
  if (!items?.length) return null;
  return h("ul", { class: "sc-warnings" }, items.map((w) => h("li", { text: w })));
}

function imageCard(turn, image) {
  const size = image.size ? `${image.size.width}×${image.size.height}` : image.size_raw ? `尺寸无效：${image.size_raw}` : "未给尺寸";
  const textarea = h("textarea", {
    class: "sc-prompt",
    value: image.prompt,
    rows: 8,
    spellcheck: false,
    on: { input: (e) => rememberPrompt(turn, image, e.target.value) },
  });
  return h(
    "div",
    { class: `sc-card${image.incomplete ? " sc-incomplete" : ""}` },
    h("div", { class: "sc-card-head" }, h("span", { class: "sc-card-title", text: image.title || `图 ${image.index + 1}` }), h("span", { class: "sc-badge", text: size })),
    image.think ? h("details", { class: "sc-fold" }, h("summary", { text: "画面思考" }), h("div", { class: "sc-pre", text: image.think })) : null,
    textarea,
    image.calls?.length
      ? h(
          "details",
          { class: "sc-fold" },
          h("summary", { text: `角色调用（${image.calls.length}）` }),
          image.calls.map((c) => h("div", { class: "sc-call" }, h("code", { text: c.raw }), h("div", { text: c.found ? `→ ${c.result || "（字段为空）"}` : `→ 未找到，保留「${c.result}」` }))),
        )
      : null,
    warningList(image.warnings),
    h(
      "div",
      { class: "sc-row sc-actions" },
      h("button", { class: "sc-btn", text: "填入", on: { click: guard(() => fill(image, false)) } }),
      h("button", { class: "sc-btn sc-primary", text: "填入并出图", on: { click: guard(() => fill(image, true)) } }),
    ),
  );
}

function assistantBlock(turn) {
  const parsed = turn.parsed;
  const thoughts = [turn.reasoning, ...(parsed?.thinking ?? [])].filter(Boolean);
  const status = { interrupted: "已中断", error: "出错" }[turn.status];
  const images = parsed?.images ?? [];
  return h(
    "div",
    { class: "sc-msg sc-assistant" },
    h("div", { class: "sc-meta", text: [turn.preset_name, turn.model, status].filter(Boolean).join(" · ") }),
    turn.error ? h("div", { class: "sc-error", text: turn.error }) : null,
    turn.report?.warnings?.length ? h("details", { class: "sc-fold sc-muted" }, h("summary", { text: `提示（${turn.report.warnings.length}）` }), warningList(turn.report.warnings)) : null,
    thoughts.length ? h("details", { class: "sc-fold" }, h("summary", { text: "思考过程" }), h("div", { class: "sc-pre", text: thoughts.join("\n\n") })) : null,
    parsed ? (parsed.text ? h("div", { class: "sc-text", text: parsed.text }) : null) : h("div", { class: "sc-text", text: turn.reply || "" }),
    images.map((image) => imageCard(turn, image)),
    images.length > 1 ? h("button", { class: "sc-btn sc-wide", text: `全部依次出图（${images.length} 张）`, on: { click: guard(() => fillAll(images)) } }) : null,
  );
}

function userBlock(text, material) {
  return h(
    "div",
    { class: "sc-msg sc-user" },
    text ? h("div", { class: "sc-text", text }) : null,
    material ? h("div", { class: "sc-meta", text: `附带素材 ${material.length} 字` }) : null,
  );
}

function streamingBlock() {
  const s = S.streaming;
  const body = h("div", { class: "sc-text sc-live" });
  const block = h("div", { class: "sc-msg sc-assistant" }, h("div", { class: "sc-meta", text: "生成中…" }), body);
  s.el = body;
  updateStreaming();
  return block;
}

function updateStreaming() {
  const s = S.streaming;
  if (!s?.el) return;
  s.el.textContent = s.text || (s.reasoning ? `（思考中，已收到 ${s.reasoning.length} 字）` : "（等待模型回复）");
  const list = s.el.closest(".sc-messages");
  if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 160) list.scrollTop = list.scrollHeight;
}

function historyPanel() {
  return h(
    "div",
    { class: "sc-history" },
    S.sessions.length ? null : h("div", { class: "sc-muted", text: "还没有对话记录" }),
    S.sessions.map((s) =>
      h(
        "div",
        { class: `sc-history-item${S.session?.id === s.id ? " sc-active" : ""}` },
        h("button", { class: "sc-link", text: s.title, title: s.title, on: { click: guard(() => openSession(s.id)) } }),
        h("span", { class: "sc-muted", text: `${s.turns} 轮 · ${shortTime(s.updated)}` }),
        h("button", { class: "sc-icon", text: "×", title: "删除", on: { click: guard(() => deleteSession(s.id)) } }),
      ),
    ),
  );
}

function previewOverlay() {
  const p = S.preview;
  const close = () => {
    S.preview = null;
    render();
  };
  return h(
    "div",
    { class: "sc-overlay" },
    h(
      "div",
      { class: "sc-dialog" },
      h("div", { class: "sc-row sc-between" }, h("strong", { text: `将发送 ${p.messages.length} 条消息（来自 ${p.report.entries_sent} 个条目）` }), h("button", { class: "sc-icon", text: "×", on: { click: close } })),
      warningList(p.report.warnings),
      Object.keys(p.report.variables).length
        ? h("div", { class: "sc-muted", text: `变量：${Object.entries(p.report.variables).map(([k, v]) => `${k}=${v}`).join("；")}` })
        : null,
      h(
        "div",
        { class: "sc-dialog-body" },
        p.messages.map((m, i) => h("details", { class: "sc-fold", open: i === p.messages.length - 1 }, h("summary", { text: `${i + 1}. ${ROLE_LABEL[m.role] ?? m.role} · ${m.content.length} 字` }), h("div", { class: "sc-pre", text: m.content }))),
      ),
    ),
  );
}

function composer() {
  const input = h("textarea", {
    class: "sc-input",
    rows: 3,
    placeholder: "说说想画什么…（Ctrl+Enter 发送）",
    value: S.draft,
    on: {
      input: (e) => {
        S.draft = e.target.value;
        save("draft", S.draft);
      },
      keydown: (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          guard(sendMessage)();
        }
      },
    },
  });
  const area = (key, label, hint) =>
    h(
      "details",
      { class: "sc-fold", open: Boolean(S[key]) },
      h("summary", { text: S[key] ? `${label}（${S[key].length} 字）` : label }),
      h("textarea", {
        class: "sc-input",
        rows: 4,
        placeholder: hint,
        value: S[key],
        on: {
          input: (e) => {
            S[key] = e.target.value;
            save(key, S[key]);
          },
        },
      }),
    );
  return h(
    "div",
    { class: "sc-composer" },
    area("material", "素材", "可选：贴一段剧情或画面描述，对应预设里的 {{正文}}"),
    area("setting", "设定", "可选：世界观、固定设定，对应预设里的 {{世界书触发}}"),
    input,
    h(
      "div",
      { class: "sc-row sc-between" },
      h("button", { class: "sc-btn", text: "预览发送内容", disabled: Boolean(S.streaming), on: { click: guard(openPreview) } }),
      S.streaming
        ? h("button", { class: "sc-btn sc-danger", text: "停止", on: { click: stopMessage } })
        : h("button", { class: "sc-btn sc-primary", text: "发送", on: { click: guard(sendMessage) } }),
    ),
  );
}

function chatTab() {
  const turns = S.session?.turns ?? [];
  const previous = S.host?.querySelector(".sc-messages");
  const keepScroll = previous && !S.stickBottom ? previous.scrollTop : null;
  const messages = h(
    "div",
    { class: "sc-messages" },
    !turns.length && !S.streaming ? h("div", { class: "sc-empty", text: "选好预设和模型服务，直接说想画什么。回复里的每张图都可以一键填入「Soda Chat 提示词」节点并出图。" }) : null,
    turns.map((turn) => [userBlock(turn.user, turn.material), assistantBlock(turn)]),
    S.streaming ? [userBlock(S.streaming.user, ""), streamingBlock()] : null,
  );
  requestAnimationFrame(() => {
    messages.scrollTop = keepScroll ?? messages.scrollHeight;
    S.stickBottom = false;
  });
  const notice = S.noNode
    ? h(
        "div",
        { class: "sc-notice" },
        h("span", { text: S.settings.target_label ? `没找到 label 为「${S.settings.target_label}」的「Soda Chat 提示词」节点。` : "画布上还没有「Soda Chat 提示词」节点。" }),
        h("button", { class: "sc-btn", text: "添加节点", on: { click: addNode } }),
        h("button", { class: "sc-icon", text: "×", on: { click: () => { S.noNode = false; render(); } } }),
      )
    : null;
  return h(
    "div",
    { class: "sc-chat" },
    h("div", { class: "sc-row" }, presetSelect(), serviceSelect()),
    h(
      "div",
      { class: "sc-row sc-between" },
      h("span", { class: "sc-title", text: S.session?.title ?? "新对话", title: S.session?.title ?? "" }),
      h(
        "span",
        { class: "sc-row" },
        h("button", { class: "sc-btn", text: S.showHistory ? "收起历史" : "历史", on: { click: () => { S.showHistory = !S.showHistory; render(); } } }),
        h("button", { class: "sc-btn", text: "新对话", on: { click: guard(newSession) } }),
      ),
    ),
    S.showHistory ? historyPanel() : null,
    notice,
    messages,
    composer(),
    S.preview ? previewOverlay() : null,
  );
}

// ---- rendering: presets ----------------------------------------------------------------------------------

async function importPreset() {
  const file = await pickFile();
  if (!file) return;
  const content = await file.text();
  let result = await call("presets/import", { method: "POST", body: { filename: file.name, content, mode: "ask" } });
  if (result.conflicts.length) {
    const names = result.conflicts.join("、");
    let mode = null;
    if (confirm(`已有同名预设：${names}\n\n确定 = 覆盖（保留仍然有效的变量覆盖值）\n取消 = 选择是否另存一份`)) mode = "replace";
    else if (confirm("另存为新的一份？")) mode = "copy";
    if (!mode) return;
    result = await call("presets/import", { method: "POST", body: { filename: file.name, content, mode } });
  }
  S.presets = result.presets;
  const first = result.imported[0];
  if (first) await openPreset(first.id);
  toast(`已导入 ${result.imported.length} 个预设${result.warnings.length ? `，${result.warnings.length} 条提示` : ""}`, "success");
  for (const warning of result.warnings) toast(warning, "warn");
  render();
}

async function openPreset(id) {
  S.presetDetail = await call(`presets/${id}`);
  render();
}

async function togglePresetEntry(entry, enabled) {
  S.presetDetail = await call(`presets/${S.presetDetail.id}`, { method: "PATCH", body: { entries: { [entry.id]: enabled } } });
  S.presets = (await call("state")).presets;
  render();
}

async function savePresetVariables(form) {
  const overrides = {};
  for (const input of form.querySelectorAll("input[data-var]")) {
    if (input.value !== "") overrides[input.dataset.var] = input.value;
  }
  S.presetDetail = await call(`presets/${S.presetDetail.id}`, { method: "PATCH", body: { overrides } });
  toast("变量已保存", "success");
  render();
}

async function deletePreset() {
  const detail = S.presetDetail;
  if (!confirm(`删除预设「${detail.name}」？`)) return;
  S.presets = (await call(`presets/${detail.id}`, { method: "DELETE" })).presets;
  S.presetDetail = null;
  if (S.presetId === detail.id) S.presetId = S.presets[0]?.id ?? "";
  render();
}

function entryRow(entry) {
  const content = h("div", { class: "sc-pre" });
  return h(
    "details",
    { class: `sc-entry${entry.enabled ? "" : " sc-off"}`, on: { toggle: (e) => { if (e.target.open && !content.textContent) content.textContent = entry.content || "（空）"; } } },
    h(
      "summary",
      {},
      h("input", {
        type: "checkbox",
        checked: entry.enabled,
        title: "启用",
        on: { click: (e) => e.stopPropagation(), change: guard((e) => togglePresetEntry(entry, e.target.checked)) },
      }),
      h("span", { class: `sc-role sc-role-${entry.role}`, text: ROLE_LABEL[entry.role] ?? entry.role }),
      h("span", { class: "sc-entry-name", text: entry.name }),
      h("span", { class: "sc-muted", text: `${entry.content.length} 字` }),
    ),
    content,
  );
}

function presetDetail() {
  const d = S.presetDetail;
  const form = h(
    "div",
    { class: "sc-vars" },
    d.variables.length ? null : h("div", { class: "sc-muted", text: "这个预设没有 {@setvar@} 变量" }),
    d.variables.map((v) =>
      h(
        "label",
        { class: "sc-var" },
        h("span", { text: v.name }),
        h("input", { class: "sc-field", "data-var": v.name, value: v.override ?? "", placeholder: v.default ?? "（未设置）" }),
      ),
    ),
  );
  return h(
    "div",
    { class: "sc-section" },
    h("div", { class: "sc-row sc-between" }, h("strong", { text: d.name }), h("span", { class: "sc-muted", text: d.source_file || "" })),
    h(
      "div",
      { class: "sc-row" },
      h("button", { class: "sc-btn", text: S.presetId === d.id ? "已是聊天预设" : "设为聊天预设", disabled: S.presetId === d.id, on: { click: guard(async () => { S.presetId = d.id; save("preset", d.id); S.settings = await call("settings", { method: "PUT", body: { last_preset: d.id } }); render(); }) } }),
      h("button", { class: "sc-btn", text: "导出", on: { click: guard(async () => download(`${d.name}.json`, await call(`presets/${d.id}/export`))) } }),
      h("button", { class: "sc-btn sc-danger", text: "删除", on: { click: guard(deletePreset) } }),
    ),
    h("h4", { text: "变量" }),
    h("div", { class: "sc-muted", text: "留空 = 用预设里的默认值。改完点保存。" }),
    form,
    d.variables.length ? h("button", { class: "sc-btn", text: "保存变量", on: { click: guard(() => savePresetVariables(form)) } }) : null,
    h("h4", { text: `条目（启用 ${d.entries.filter((e) => e.enabled).length} / ${d.entries.length}）` }),
    h("div", { class: "sc-muted", text: "勾选决定是否发送；点条目名查看内容。" }),
    d.entries.map(entryRow),
  );
}

function presetsTab() {
  return h(
    "div",
    { class: "sc-scroll" },
    h("div", { class: "sc-row" }, h("button", { class: "sc-btn sc-primary", text: "导入预设 JSON", on: { click: guard(importPreset) } })),
    h("div", { class: "sc-muted", text: "支持 st-chatu8 的 LLM 预设格式。" }),
    h(
      "div",
      { class: "sc-list" },
      S.presets.map((p) =>
        h(
          "button",
          { class: `sc-list-item${S.presetDetail?.id === p.id ? " sc-active" : ""}`, on: { click: guard(() => openPreset(p.id)) } },
          h("span", { text: p.name }),
          h("span", { class: "sc-muted", text: `${p.builtin ? "内置 · " : ""}${p.enabled_count}/${p.entry_count} 条${S.presetId === p.id ? " · 聊天中" : ""}` }),
        ),
      ),
    ),
    S.presetDetail ? presetDetail() : null,
  );
}

// ---- rendering: characters -------------------------------------------------------------------------------

function blankCharacter() {
  const side = () => Object.fromEntries(Object.keys(FIELDS).map((k) => [k, ""]));
  return { name: "", aliases: [], kind: "specific", enabled: true, summary: "", front: side(), back: side() };
}

async function ensureCharacters() {
  if (!S.characters) {
    S.characters = (await call("characters")).characters;
    render();
  }
}

async function saveCharacters() {
  S.characters = (await call("characters", { method: "PUT", body: { characters: S.characters } })).characters;
  toast("角色库已保存", "success");
  render();
}

function characterCard(character, index) {
  const bind = (obj, key, props = {}) =>
    h(props.multiline ? "textarea" : "input", {
      class: "sc-field",
      value: Array.isArray(obj[key]) ? obj[key].join("、") : obj[key],
      rows: props.multiline ? 2 : undefined,
      placeholder: props.placeholder,
      on: { input: (e) => { obj[key] = key === "aliases" ? e.target.value.split(/[,，、|｜]/).map((s) => s.trim()).filter(Boolean) : e.target.value; } },
    });
  return h(
    "details",
    { class: "sc-card", open: !character.name },
    h("summary", {}, h("strong", { text: character.name || "（新角色）" }), h("span", { class: "sc-muted", text: ` ${character.kind === "template" ? "通用模板" : "特定角色"}${character.enabled ? "" : " · 停用"}` })),
    h("label", { class: "sc-var" }, h("span", { text: "名字" }), bind(character, "name", { placeholder: "预设调用时用的名字，如 xiao hong" })),
    h("label", { class: "sc-var" }, h("span", { text: "别名" }), bind(character, "aliases", { placeholder: "用顿号或逗号分隔" })),
    h("label", { class: "sc-var" }, h("span", { text: "简介" }), bind(character, "summary", { placeholder: "给 LLM 看的一句话" })),
    h(
      "div",
      { class: "sc-row" },
      h("select", { class: "sc-select", on: { change: (e) => { character.kind = e.target.value; } } }, h("option", { value: "specific", text: "特定角色", selected: character.kind === "specific" }), h("option", { value: "template", text: "通用模板", selected: character.kind === "template" })),
      h("label", { class: "sc-check" }, h("input", { type: "checkbox", checked: character.enabled, on: { change: (e) => { character.enabled = e.target.checked; } } }), "启用"),
      h("button", { class: "sc-btn sc-danger", text: "删除", on: { click: () => { S.characters.splice(index, 1); render(); } } }),
    ),
    Object.entries(SIDES).map(([side, label]) =>
      h("details", { class: "sc-fold" }, h("summary", { text: `${label}字段` }), Object.entries(FIELDS).map(([key, name]) => h("label", { class: "sc-var" }, h("span", { text: name }), bind(character[side], key, { multiline: true, placeholder: side === "back" ? "留空则用正面" : "danbooru 标签＋一句英文" })))),
    ),
  );
}

function charactersTab() {
  if (!S.characters) {
    guard(ensureCharacters)();
    return h("div", { class: "sc-muted", text: "读取中…" });
  }
  return h(
    "div",
    { class: "sc-scroll" },
    h("div", { class: "sc-muted", text: "预设里的 ${\"name\":…}$ 调用会换成这里的字段：基础外貌＋按状态选的上半身、下半身；from behind 用背面字段。" }),
    h(
      "div",
      { class: "sc-row" },
      h("button", { class: "sc-btn", text: "新增角色", on: { click: () => { S.characters.unshift(blankCharacter()); render(); } } }),
      h("button", { class: "sc-btn", text: "导入", on: { click: guard(async () => { const file = await pickFile(); if (!file) return; const data = JSON.parse(await file.text()); S.characters = (await call("characters", { method: "PUT", body: data })).characters; toast("角色库已导入", "success"); render(); }) } }),
      h("button", { class: "sc-btn", text: "导出", on: { click: () => download("soda-chat-characters.json", { characters: S.characters }) } }),
      h("button", { class: "sc-btn sc-primary", text: "保存", on: { click: guard(saveCharacters) } }),
    ),
    S.characters.length ? null : h("div", { class: "sc-empty", text: "还没有角色。没有角色时，预设会让模型自己写外貌。" }),
    S.characters.map(characterCard),
  );
}

// ---- rendering: settings ---------------------------------------------------------------------------------

function blankService() {
  return { id: "", name: "", base_url: "", model: "", temperature: 0.8, max_tokens: 8192, timeout: 180, stream: true, merge_same_role: false, system_to_user: false, has_key: false, api_key: "" };
}

function serviceForm() {
  if (!S.serviceForm) {
    const active = S.services.profiles.find((p) => p.id === S.services.active);
    S.serviceForm = active ? { ...active, api_key: "" } : blankService();
  }
  return S.serviceForm;
}

function formPayload(form) {
  const { id, has_key: _hasKey, ...profile } = form;
  return { id, profile };
}

async function saveService() {
  const form = serviceForm();
  const result = await call("services", { method: "POST", body: formPayload(form) });
  S.services = { active: result.active, profiles: result.profiles };
  const saved = result.profiles.find((p) => p.id === result.saved);
  S.serviceForm = { ...saved, api_key: "" };
  toast("服务已保存", "success");
  render();
}

function settingsTab() {
  const form = serviceForm();
  const field = (key, label, props = {}) =>
    h(
      "label",
      { class: "sc-var" },
      h("span", { text: label }),
      h("input", {
        class: "sc-field",
        type: props.type ?? "text",
        value: form[key] ?? "",
        placeholder: props.placeholder,
        step: props.step,
        list: props.list,
        autocomplete: props.type === "password" ? "new-password" : "off",
        on: { input: (e) => { form[key] = props.type === "number" ? Number(e.target.value) : e.target.value; } },
      }),
    );
  const flag = (key, label) => h("label", { class: "sc-check" }, h("input", { type: "checkbox", checked: Boolean(form[key]), on: { change: (e) => { form[key] = e.target.checked; } } }), label);
  const settings = { ...S.settings };
  const setting = (key, label, type = "text") =>
    h(
      "label",
      { class: type === "checkbox" ? "sc-check" : "sc-var" },
      type === "checkbox" ? null : h("span", { text: label }),
      h("input", {
        class: type === "checkbox" ? undefined : "sc-field",
        type,
        value: type === "checkbox" ? undefined : settings[key],
        checked: type === "checkbox" ? settings[key] : undefined,
        on: { input: (e) => { settings[key] = type === "checkbox" ? e.target.checked : type === "number" ? Number(e.target.value) : e.target.value; } },
      }),
      type === "checkbox" ? label : null,
    );
  return h(
    "div",
    { class: "sc-scroll" },
    h("h4", { text: "模型服务" }),
    h(
      "div",
      { class: "sc-row" },
      h(
        "select",
        { class: "sc-select", on: { change: (e) => { const p = S.services.profiles.find((x) => x.id === e.target.value); S.serviceForm = p ? { ...p, api_key: "" } : blankService(); S.modelOptions = []; render(); } } },
        S.services.profiles.map((p) => h("option", { value: p.id, text: `${p.name}${p.id === S.services.active ? "（当前）" : ""}`, selected: p.id === form.id })),
        h("option", { value: "", text: "＋ 新建服务", selected: !form.id }),
      ),
      h("button", { class: "sc-btn", text: "从 Soda Prompt Workflow 导入", on: { click: guard(async () => { const r = await call("services/import-spw", { method: "POST", body: {} }); S.services = { active: r.active, profiles: r.profiles }; S.serviceForm = null; toast(r.imported.length ? `已导入：${r.imported.join("、")}` : "没有可导入的服务", r.imported.length ? "success" : "warn"); for (const s of r.skipped) toast(s, "warn"); render(); }) } }),
    ),
    field("name", "名称", { placeholder: "如 DeepSeek / 本机 LM Studio" }),
    field("base_url", "服务地址", { placeholder: "https://api.deepseek.com 或 http://127.0.0.1:1234/v1" }),
    field("api_key", "API Key", { type: "password", placeholder: form.has_key ? "已保存，留空不变" : "本机模型可以不填" }),
    field("model", "模型", { list: "sc-model-options", placeholder: "可点「拉取模型」后选择" }),
    h("datalist", { id: "sc-model-options" }, S.modelOptions.map((m) => h("option", { value: m }))),
    h("div", { class: "sc-grid" }, field("temperature", "temperature", { type: "number", step: "0.1" }), field("max_tokens", "max_tokens", { type: "number", step: "256" }), field("timeout", "超时（秒）", { type: "number", step: "10" })),
    flag("stream", "流式输出（逐字显示）"),
    flag("merge_same_role", "合并连续同角色消息"),
    flag("system_to_user", "把 system 消息改成 user"),
    h(
      "div",
      { class: "sc-row" },
      h("button", { class: "sc-btn sc-primary", text: "保存", on: { click: guard(saveService) } }),
      form.id && form.id !== S.services.active ? h("button", { class: "sc-btn", text: "设为当前", on: { click: guard(async () => { S.services = await call(`services/${form.id}/activate`, { method: "POST", body: {} }); render(); }) } }) : null,
      h("button", { class: "sc-btn", text: "测试连接", on: { click: guard(async () => { const r = await call("services/test", { method: "POST", body: formPayload(form) }); toast(`连接成功（${r.seconds} 秒）：${r.reply || "（空回复）"}`, "success"); }) } }),
      h("button", { class: "sc-btn", text: "拉取模型", on: { click: guard(async () => { S.modelOptions = (await call("services/models", { method: "POST", body: formPayload(form) })).models; toast(`拉到 ${S.modelOptions.length} 个模型，在「模型」框里选择`, "success"); render(); }) } }),
      form.id ? h("button", { class: "sc-btn sc-danger", text: "删除", on: { click: guard(async () => { if (!confirm(`删除服务「${form.name}」？`)) return; S.services = await call(`services/${form.id}`, { method: "DELETE" }); S.serviceForm = null; render(); }) } }) : null,
    ),
    h("div", { class: "sc-muted", text: "密钥只保存在本机 ComfyUI/user/soda_chat/services.json，不会写进工作流或图片。" }),
    h("h4", { text: "聊天" }),
    setting("history_turns", "上下文轮数", "number"),
    setting("user_name", "{{user}} 名字"),
    setting("char_name", "{{char}} 名字"),
    setting("target_label", "目标节点 label（空 = 第一个）"),
    setting("use_ai_size", "使用 AI 给的尺寸", "checkbox"),
    h("button", { class: "sc-btn", text: "保存设置", on: { click: guard(async () => { const { seeded_builtin: _s, ...body } = settings; S.settings = await call("settings", { method: "PUT", body }); toast("设置已保存", "success"); render(); }) } }),
  );
}

// ---- shell -----------------------------------------------------------------------------------------------

const TABS = { chat: "聊天", presets: "预设", characters: "角色", settings: "设置" };

function switchTab(key) {
  S.tab = key;
  save("tab", key);
  render();
  if (key === "presets" || key === "chat") {
    // Presets may have been imported elsewhere (another browser tab or the API).
    guard(async () => {
      const data = await call("state");
      S.presets = data.presets;
      S.services = data.services;
      render();
    })();
  }
}

function render() {
  const host = S.host;
  if (!host) return;
  if (!S.ready) {
    host.replaceChildren(h("div", { class: "soda-chat" }, h("div", { class: "sc-muted", text: "Soda Chat 读取中…" })));
    return;
  }
  const body = { chat: chatTab, presets: presetsTab, characters: charactersTab, settings: settingsTab }[S.tab] ?? chatTab;
  host.replaceChildren(
    h(
      "div",
      {
        class: "soda-chat",
        // Keep typing inside the panel from reaching ComfyUI shortcuts (Ctrl+Enter queues the workflow).
        on: { keydown: (e) => { if (e.target.matches?.("input, textarea, select")) e.stopPropagation(); } },
      },
      h(
        "div",
        { class: "sc-tabs" },
        Object.entries(TABS).map(([key, label]) =>
          h("button", { class: `sc-tab${S.tab === key ? " sc-active" : ""}`, text: label, on: { click: () => switchTab(key) } }),
        ),
      ),
      body(),
    ),
  );
}

function mount(element) {
  if (S.host === element && element.querySelector(".soda-chat")) return;
  S.host = element;
  element.classList.add("soda-chat-host");
  render();
  if (!S.ready) guard(init)();
}

function injectStyles() {
  if (document.getElementById("soda-chat-css")) return;
  document.head.append(h("link", { id: "soda-chat-css", rel: "stylesheet", href: new URL("./soda_chat.css", import.meta.url).href }));
}

app.registerExtension({
  name: "Soda.Chat",
  async setup() {
    injectStyles();
    app.extensionManager.registerSidebarTab({
      id: TAB_ID,
      icon: "pi pi-comments",
      title: "Soda Chat",
      tooltip: "Soda Chat：聊天写提示词，一键填入并出图",
      type: "custom",
      render: mount,
    });
  },
});
