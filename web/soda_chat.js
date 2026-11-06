import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "SodaChatPrompt";
const TAB_ID = "soda-chat";
const LS = "soda-chat:";
const MAX_IMAGES = 4;
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
  if (tag === "button") {
    el.type = "button";
    el.dataset.uiKey = props["aria-label"] || props.title || props.text || "button";
  } else if (tag === "summary") el.dataset.uiKey = "summary";
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

function savedAttachments() {
  const images = load("attachments", []);
  return Array.isArray(images) ? images.filter((image) => image && typeof image.id === "string" && typeof image.url === "string").slice(0, MAX_IMAGES) : [];
}

// ---- state -----------------------------------------------------------------------------------------------

const S = {
  host: null,
  ready: false,
  tab: load("tab", "chat"),
  presets: [],
  services: { active: "", profiles: [] },
  serviceSwitchSerial: 0,
  serviceSwitchPending: null,
  serviceSwitchError: "",
  settings: {},
  settingsDraft: {},
  sessions: [],
  session: null,
  presetId: load("preset", ""),
  draft: load("draft", ""),
  material: load("material", ""),
  setting: load("setting", ""),
  streaming: null,
  sending: false,
  filling: false,
  attachments: savedAttachments(),
  imagePicker: null,
  presetDetail: null,
  presetVariableDrafts: new Map(),
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
  // A newly started stream acquires its server ID without becoming a different view.
  const root = S.host?.querySelector('.soda-chat[data-ui-view="chat:new"]');
  if (S.streaming && !S.session && session && root) root.dataset.uiView = `chat:${session.id}`;
  S.session = session;
  save("session", session?.id ?? "");
}

// ---- graph -----------------------------------------------------------------------------------------------

function graphNodes() {
  const root = app.rootGraph ?? app.graph;
  const found = [];
  const visit = (graph, inactive = false, ancestors = new Set()) => {
    if (!graph || ancestors.has(graph)) return;
    const path = new Set(ancestors).add(graph);
    for (const node of graph.nodes ?? graph._nodes ?? []) {
      const disabled = inactive || node.mode === 2 || node.mode === 4;
      if ((node.comfyClass ?? node.type) === NODE_TYPE) found.push({ node, inactive: disabled });
      if (node.subgraph) visit(node.subgraph, disabled, path);
    }
  };
  visit(root);
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
  if (label) return nodes.find(({ node }) => widget(node, "label")?.value === label) ?? null;
  return nodes[0] ?? null;
}

async function fill(image, queue) {
  const target = targetNode();
  if (!target) {
    S.noNode = true;
    render();
    toast("画布上没有可填入的「Soda Chat 提示词」节点", "warn");
    return false;
  }
  const { node, inactive } = target;
  if (inactive) {
    toast("目标节点或所在子图已静音 / 绕过，请先启用对应的 Soda Chat 模式", "warn");
    return false;
  }
  if (queue && app.processingQueue) {
    toast("ComfyUI 正在提交其他任务，请稍后再点「填入并出图」", "warn");
    return false;
  }
  if (!setWidget(node, "prompt", image.prompt)) throw new Error("目标节点缺少 prompt 输入，请重新添加 Soda Chat 提示词节点");
  if (S.settings.use_ai_size && image.size) {
    setWidget(node, "width", image.size.width);
    setWidget(node, "height", image.size.height);
  }
  node.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
  if (queue) {
    const queued = await app.queuePrompt(0, 1);
    if (queued === false) {
      toast("提示词已填入，但出图未成功提交。请查看 ComfyUI 的报错或队列状态", "warn");
      return false;
    }
    toast("已填入并排队出图", "success");
  } else {
    toast("已填入节点", "success");
  }
  return true;
}

async function fillCards(images, queue) {
  if (S.filling) return;
  S.filling = true;
  render();
  try {
    await flushPromptEdits();
    for (const image of images) {
      if (!(await fill(image, queue))) return;
    }
  } finally {
    S.filling = false;
    render();
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

// ---- image attachments -----------------------------------------------------------------------------------

function localURL(path) {
  return api.apiURL ? api.apiURL(path) : path;
}

function imageRefKey(ref) {
  return JSON.stringify([ref.type || "output", ref.subfolder || "", ref.filename]);
}

function outputImageURL(ref) {
  return localURL(`/view?${new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder || "", type: ref.type || "output" })}`);
}

function rememberAttachments() {
  save("attachments", S.attachments);
}

function reuseAttachment(attachment) {
  if (S.streaming || S.sending) return;
  if (S.attachments.some((item) => item.id === attachment.id)) return;
  if (S.attachments.length >= MAX_IMAGES) throw new Error(`每轮最多发送 ${MAX_IMAGES} 张图，请先移除一张`);
  S.attachments.push(attachment);
  rememberAttachments();
  render();
}

function removeAttachment(id) {
  if (S.streaming || S.sending) return;
  S.attachments = S.attachments.filter((item) => item.id !== id);
  rememberAttachments();
  render();
}

async function chooseOutput(ref) {
  const picker = S.imagePicker;
  if (!picker || picker.busy || S.streaming || S.sending) return;
  if (S.attachments.length >= MAX_IMAGES) throw new Error(`每轮最多发送 ${MAX_IMAGES} 张图，请先移除一张`);
  picker.busy = true;
  picker.error = "";
  render();
  try {
    const { attachment } = await call("attachments/from-output", { method: "POST", body: ref });
    reuseAttachment(attachment);
    picker.selected.add(imageRefKey(ref));
  } catch (error) {
    picker.error = error.message || String(error);
  } finally {
    picker.busy = false;
    render();
  }
}

async function openImagePicker() {
  if (S.streaming || S.sending) return;
  const images = [];
  const previous = S.imagePicker;
  const picker = { images: previous?.images ?? images, loading: true, busy: false, error: "", selected: new Set(previous?.selected) };
  S.imagePicker = picker;
  const seen = new Set();
  const collect = (outputs, source) => {
    for (const output of Object.values(outputs ?? {})) {
      for (const image of output?.images ?? []) {
        if (!image || typeof image.filename !== "string" || !/\.(png|jpe?g|webp)$/i.test(image.filename)) continue;
        if (image.type && !["output", "temp"].includes(image.type)) continue;
        const ref = { filename: image.filename, subfolder: image.subfolder || "", type: image.type || "output" };
        const key = imageRefKey(ref);
        if (seen.has(key) || images.length >= 120) continue;
        seen.add(key);
        images.push({ ref, source });
      }
    }
  };
  collect(app.nodeOutputs, "当前工作流");
  render();
  try {
    const res = await api.fetchApi("/history?max_items=20");
    if (!res.ok) throw new Error(`历史图片读取失败（${res.status}）`);
    const history = await res.json();
    for (const run of Object.values(history).reverse()) collect(run?.outputs, "最近生成");
  } catch (error) {
    picker.error = error.message || String(error);
  } finally {
    picker.images = images;
    picker.loading = false;
    if (S.imagePicker === picker) render();
  }
}

function attachmentThumb(attachment) {
  return h("img", { class: "sc-attachment-img", src: localURL(attachment.url), alt: attachment.name || "附带图片", loading: "lazy" });
}

function attachmentList(images, mode = "history") {
  if (!images?.length) return null;
  return h("div", { class: "sc-attachments", "data-ui-key": `attachments:${mode}` }, images.map((attachment) => h(
    "div", { class: "sc-attachment", "data-ui-key": attachment.id },
    h("a", { href: localURL(attachment.url), target: "_blank", rel: "noopener", title: "查看图片" }, attachmentThumb(attachment)),
    h("div", { class: "sc-attachment-info" },
      h("span", { class: "sc-attachment-name", text: attachment.name || "图片", title: attachment.name || "图片" }),
      h("span", { class: "sc-meta", text: `${attachment.width}×${attachment.height}` }),
      mode === "selected"
        ? h("button", { class: "sc-link", text: "移除", title: `移除 ${attachment.name || "图片"}`, disabled: Boolean(S.streaming || S.sending), on: { click: () => removeAttachment(attachment.id) } })
        : h("button", { class: "sc-link", text: S.attachments.some((item) => item.id === attachment.id) ? "已选中" : "继续用这张图", disabled: Boolean(S.streaming || S.sending) || S.attachments.some((item) => item.id === attachment.id), on: { click: guard(() => reuseAttachment(attachment)) } }),
    ),
  )));
}

function imagePickerOverlay() {
  const picker = S.imagePicker;
  const close = () => { if (!picker.busy) { S.imagePicker = null; render(); } };
  return h("div", { class: "sc-overlay", on: { keydown: (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } } } },
    h("div", { class: "sc-dialog", "data-ui-key": "image-picker", role: "dialog", "aria-label": "选择生成图", "aria-modal": "true" },
      h("div", { class: "sc-row sc-between" }, h("strong", { text: "选择生成图" }), h("button", { class: "sc-icon", text: "×", title: "关闭图片选择", disabled: picker.busy, on: { click: close } })),
      h("div", { class: "sc-muted", text: `从当前工作流和最近 20 次生成中选择，最多 ${MAX_IMAGES} 张。已选 ${S.attachments.length} 张。` }),
      h("div", { class: "sc-row" }, h("button", { class: "sc-btn", text: picker.loading ? "读取中…" : "刷新图片", disabled: picker.loading || picker.busy, on: { click: guard(openImagePicker) } })),
      picker.error ? h("div", { class: "sc-error", text: picker.error }) : null,
      h("div", { class: "sc-dialog-body", "data-ui-key": "body" },
        !picker.images.length && !picker.loading ? h("div", { class: "sc-empty", text: "还没有可选择的生成图。先用工作流出图，再点「刷新图片」。支持 PNG、JPEG 和 WebP。" }) : null,
        h("div", { class: "sc-image-grid" }, picker.images.map(({ ref, source }) => {
          const selected = picker.selected.has(imageRefKey(ref));
          return h("button", { class: `sc-output-image${selected ? " sc-selected" : ""}`, title: `${source} · ${ref.subfolder ? `${ref.subfolder}/` : ""}${ref.filename}`, "aria-label": `选择图片 ${ref.filename}`, disabled: picker.busy || selected || S.attachments.length >= MAX_IMAGES, on: { click: guard(() => chooseOutput(ref)) } },
            h("img", { src: outputImageURL(ref), alt: ref.filename, loading: "lazy" }),
            h("span", { class: "sc-attachment-name", text: ref.filename }),
            h("span", { class: "sc-meta", text: selected ? "已选中" : source }),
          );
        })),
      ),
      h("button", { class: "sc-btn sc-primary", text: "完成选择", disabled: picker.busy, on: { click: close } }),
    ),
  );
}

// ---- chat ------------------------------------------------------------------------------------------------

async function readEvents(res, onEvent) {
  if (!res.body) throw new Error("模型服务没有返回可读取的回复流");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const emit = (chunk) => {
    let event = "message";
    const data = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length) onEvent(event, JSON.parse(data.join("\n")));
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let cut;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        emit(buffer.slice(0, cut));
        buffer = buffer.slice(cut + 2);
      }
      if (done) {
        if (buffer.trim()) emit(buffer);
        break;
      }
    }
  } finally {
    reader.releaseLock();
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
    image_ids: S.attachments.map((image) => image.id),
  };
}

function checkReady() {
  if (!S.presetId) throw new Error("请先在「预设」页导入或选择预设");
  if (S.serviceSwitchError) throw new Error(S.serviceSwitchError);
  if (!S.services.active) {
    S.tab = "settings";
    render();
    throw new Error("请先在「设置」里添加模型服务");
  }
}

async function ensureServiceReady() {
  while (S.serviceSwitchPending) {
    try {
      await S.serviceSwitchPending;
    } catch {
      // A newer selection may already be queued; only the latest failure blocks sending.
    }
  }
  checkReady();
}

async function sendMessage() {
  if (S.streaming || S.sending) return;
  if (!S.draft.trim() && !S.material.trim()) {
    if (S.attachments.length) throw new Error("已选好图片，请写下希望模型观察或修改的内容");
    return;
  }
  checkReady();
  S.sending = true;
  try {
    await flushPromptEdits();
    await ensureServiceReady();
  } catch (error) {
    S.sending = false;
    render();
    throw error;
  }
  const body = turnRequest();
  const controller = new AbortController();
  const previousIds = new Set((S.session?.turns ?? []).map((turn) => turn.id));
  S.streaming = { controller, user: body.input, material: body.material, images: [...S.attachments], text: "", reasoning: "", report: null, turnId: "" };
  S.stickBottom = true;
  S.draft = "";
  save("draft", "");
  render();
  let finished = null;
  let receivedTerminal = false;
  let recovery = false;
  const restoreDraft = () => {
    if (!body.input || S.draft === body.input || S.draft.startsWith(`${body.input}\n\n`)) return;
    S.draft = S.draft ? `${body.input}\n\n${S.draft}` : body.input;
    save("draft", S.draft);
  };
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
        S.streaming.turnId = data.turn_id || "";
        if (!S.session || S.session.id !== data.session_id) setSession({ id: data.session_id, title: data.title, turns: [] });
      } else if (event === "delta") {
        S.streaming[data.kind === "reasoning" ? "reasoning" : "text"] += data.text;
        updateStreaming();
      } else if (event === "done" || event === "error") {
        receivedTerminal = true;
        if (data.session_deleted) {
          setSession(null);
          finished = null;
        } else {
          finished = data.turn;
        }
        if (event === "error") {
          restoreDraft();
          toast(data.error || "模型回复失败，已保留本轮输入", "error");
        }
      }
    });
    if (!receivedTerminal) throw new Error("回复连接提前结束，已保留收到的内容和本轮输入，可以重试");
  } catch (error) {
    if (!finished) {
      recovery = true;
      S.streaming.recovering = true;
      restoreDraft();
      finished = {
        id: `local-${Date.now()}`, user: body.input, material: body.material, images: S.streaming.images,
        reply: S.streaming.text, reasoning: S.streaming.reasoning, status: "interrupted", parsed: null,
        report: S.streaming.report, error: error.name === "AbortError" ? "已停止，本轮输入已保留" : error.message,
      };
      if (error.name !== "AbortError") toast(error.message, "error");
      render();
    }
  } finally {
    if (S.session && recovery) {
      // The server persists a stopped turn after the upstream stream closes. Wait briefly for its exact ID.
      for (const delay of [0, 200, 500, 1000, 1500, 2000]) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        try {
          const saved = await call(`sessions/${S.session.id}`);
          const canonical = saved.turns.find((turn) => S.streaming.turnId
            ? turn.id === S.streaming.turnId
            : !previousIds.has(turn.id) && turn.user === body.input);
          if (canonical) {
            setSession(saved);
            finished = null;
            break;
          }
        } catch {
          /* A brand-new session may not be on disk until the interrupted turn is saved. */
        }
      }
    }
    if (finished && S.session && !S.session.turns.some((turn) => turn.id === finished.id)) S.session.turns.push(finished);
    S.streaming = null;
    S.sending = false;
    try {
      S.sessions = (await call("sessions")).sessions;
    } catch {
      /* the list refreshes next time */
    }
    render();
  }
}

function stopMessage() {
  if (S.streaming) S.streaming.stopping = true;
  S.streaming?.controller.abort();
  render();
}

async function openPreview() {
  checkReady();
  await flushPromptEdits();
  await ensureServiceReady();
  S.preview = await call("preview", { method: "POST", body: turnRequest() });
  render();
}

async function newSession() {
  if (S.streaming || S.sending) return;
  await flushPromptEdits();
  setSession(null);
  S.stickBottom = true;
  S.showHistory = false;
  render();
}

async function openSession(id) {
  if (S.streaming || S.sending) return;
  await flushPromptEdits();
  setSession(await call(`sessions/${id}`));
  S.showHistory = false;
  render();
}

async function deleteSession(id) {
  if (S.streaming || S.sending) throw new Error("请先等待当前回复完成，或停止回复后再删除对话");
  await flushPromptEdits();
  if (!confirm("删除这段对话记录？")) return;
  S.sessions = (await call(`sessions/${id}`, { method: "DELETE" })).sessions;
  if (S.session?.id === id) setSession(null);
  render();
}

const promptEdits = new Map();
const promptWrites = new Map();

function persistPromptEdit(key, edit) {
  clearTimeout(edit.timer);
  if (edit.promise) return edit.promise;
  const previous = promptWrites.get(key) ?? Promise.resolve();
  const job = previous.catch(() => {}).then(() => call(`sessions/${edit.sessionId}/prompt`, { method: "PATCH", body: edit.body })).then(() => {
    if (promptEdits.get(key) === edit) promptEdits.delete(key);
  }).catch((error) => {
    edit.promise = null;
    throw new Error(`提示词修改未保存：${error.message}。请保持当前页面后重试。`);
  }).finally(() => {
    if (promptWrites.get(key) === job) promptWrites.delete(key);
  });
  edit.promise = job;
  promptWrites.set(key, job);
  return job;
}

async function flushPromptEdits() {
  await Promise.all([...promptEdits].map(([key, edit]) => persistPromptEdit(key, edit)));
  await Promise.all(promptWrites.values());
}

function rememberPrompt(turn, image, value) {
  image.prompt = value;
  if (!S.session || String(turn.id).startsWith("local-")) return;
  const sessionId = S.session.id;
  const key = `${sessionId}/${turn.id}/${image.index}`;
  clearTimeout(promptEdits.get(key)?.timer);
  const edit = { sessionId, body: { turn_id: turn.id, index: image.index, prompt: value }, timer: null, promise: null };
  edit.timer = setTimeout(() => persistPromptEdit(key, edit).catch((error) => toast(error.message, "error")), 600);
  promptEdits.set(key, edit);
}

// ---- rendering: chat -------------------------------------------------------------------------------------

function presetSelect() {
  return h(
    "select",
    {
      class: "sc-select",
      title: "预设",
      "data-ui-key": "preset-select",
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

function selectService(serviceId) {
  const serial = ++S.serviceSwitchSerial;
  const previous = S.serviceSwitchPending ?? Promise.resolve();
  S.services = { ...S.services, active: serviceId };
  S.serviceSwitchError = "";
  const pending = previous.catch(() => {}).then(async () => {
    const services = await call(`services/${serviceId}/activate`, { method: "POST", body: {} });
    if (serial === S.serviceSwitchSerial) S.services = services;
  }).catch((error) => {
    if (serial !== S.serviceSwitchSerial) return;
    S.serviceSwitchError = `模型服务切换失败：${error.message}。请重新选择服务后重试。`;
    throw new Error(S.serviceSwitchError);
  }).finally(() => {
    if (serial === S.serviceSwitchSerial) {
      S.serviceSwitchPending = null;
      render();
    }
  });
  S.serviceSwitchPending = pending;
  render();
  return pending;
}

function serviceSelect() {
  return h(
    "select",
    {
      class: "sc-select",
      title: "模型服务",
      "data-ui-key": "service-select",
      on: {
        change: guard((e) => selectService(e.target.value)),
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
    "data-ui-key": "prompt",
    value: image.prompt,
    rows: 8,
    spellcheck: false,
    disabled: Boolean(S.streaming || S.sending),
    on: { input: (e) => rememberPrompt(turn, image, e.target.value) },
  });
  return h(
    "div",
    { class: `sc-card${image.incomplete ? " sc-incomplete" : ""}`, "data-ui-key": `image:${image.index}` },
    h("div", { class: "sc-card-head" }, h("span", { class: "sc-card-title", text: image.title || `图 ${image.index + 1}` }), h("span", { class: "sc-badge", text: size })),
    image.think ? h("details", { class: "sc-fold", "data-ui-key": "image-thought" }, h("summary", { text: "画面思考" }), h("div", { class: "sc-pre", "data-ui-key": "content", text: image.think })) : null,
    textarea,
    image.calls?.length
      ? h(
          "details",
          { class: "sc-fold", "data-ui-key": "character-calls" },
          h("summary", { text: `角色调用（${image.calls.length}）` }),
          image.calls.map((c) => h("div", { class: "sc-call" }, h("code", { text: c.raw }), h("div", { text: c.found ? `→ ${c.result || "（字段为空）"}` : `→ 未找到，保留「${c.result}」` }))),
        )
      : null,
    warningList(image.warnings),
    h(
      "div",
      { class: "sc-row sc-actions" },
      h("button", { class: "sc-btn", text: "填入", disabled: S.filling, on: { click: guard(() => fillCards([image], false)) } }),
      h("button", { class: "sc-btn sc-primary", text: "填入并出图", disabled: S.filling, on: { click: guard(() => fillCards([image], true)) } }),
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
    { class: "sc-msg sc-assistant", "data-ui-key": `assistant:${turn.id}` },
    h("div", { class: "sc-meta", text: [turn.preset_name, turn.model, status].filter(Boolean).join(" · ") }),
    turn.error ? h("div", { class: "sc-error", text: turn.error }) : null,
    turn.report?.warnings?.length ? h("details", { class: "sc-fold sc-muted", "data-ui-key": "warnings" }, h("summary", { text: `提示（${turn.report.warnings.length}）` }), warningList(turn.report.warnings)) : null,
    thoughts.length ? h("details", { class: "sc-fold", "data-ui-key": "thoughts" }, h("summary", { text: "思考过程" }), h("div", { class: "sc-pre", "data-ui-key": "content", text: thoughts.join("\n\n") })) : null,
    parsed ? (parsed.text ? h("div", { class: "sc-text", text: parsed.text }) : null) : h("div", { class: "sc-text", text: turn.reply || "" }),
    images.map((image) => imageCard(turn, image)),
    images.length > 1 ? h("button", { class: "sc-btn sc-wide", text: `全部依次出图（${images.length} 张）`, disabled: S.filling, on: { click: guard(() => fillCards(images, true)) } }) : null,
  );
}

function userBlock(text, material, images, id) {
  return h(
    "div",
    { class: "sc-msg sc-user", "data-ui-key": `user:${id}` },
    text ? h("div", { class: "sc-text", text }) : null,
    material ? h("div", { class: "sc-meta", text: `附带素材 ${material.length} 字` }) : null,
    attachmentList(images),
  );
}

function streamingBlock() {
  const s = S.streaming;
  const body = h("div", { class: "sc-text sc-live", "data-ui-key": "response" });
  const block = h("div", { class: "sc-msg sc-assistant", "data-ui-key": "streaming" }, h("div", { class: "sc-meta", text: s.stopping || s.recovering ? "正在保存已收到的回复…" : "生成中…" }), body);
  s.el = body;
  updateStreaming();
  return block;
}

function updateStreaming() {
  const s = S.streaming;
  if (!s?.el) return;
  const list = s.el.closest(".sc-messages");
  const follow = list && list.scrollHeight - list.scrollTop - list.clientHeight < 160;
  const followText = s.el.scrollHeight - s.el.scrollTop - s.el.clientHeight < 80;
  s.el.textContent = s.text || (s.reasoning ? `（思考中，已收到 ${s.reasoning.length} 字）` : "（等待模型回复）");
  if (follow && followText) s.el.scrollTop = s.el.scrollHeight;
  if (follow) list.scrollTop = list.scrollHeight;
}

function historyPanel() {
  return h(
    "div",
    { class: "sc-history", "data-ui-key": "history" },
    S.sessions.length ? null : h("div", { class: "sc-muted", text: "还没有对话记录" }),
    S.sessions.map((s) =>
      h(
        "div",
        { class: `sc-history-item${S.session?.id === s.id ? " sc-active" : ""}`, "data-ui-key": s.id },
        h("button", { class: "sc-link", text: s.title, title: s.title, on: { click: guard(() => openSession(s.id)) } }),
        h("span", { class: "sc-muted", text: `${s.turns} 轮 · ${shortTime(s.updated)}` }),
        h("button", { class: "sc-icon", text: "×", title: "删除", disabled: Boolean(S.streaming || S.sending), on: { click: guard(() => deleteSession(s.id)) } }),
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
        { class: "sc-dialog-body", "data-ui-key": "preview-body" },
        p.messages.map((m, i) => {
          const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
          const length = parts.reduce((sum, part) => sum + (part.type === "text" ? (part.text || "").length : 0), 0);
          const count = parts.filter((part) => part.type === "image_url").length;
          return h("details", { class: "sc-fold", "data-ui-key": `message:${i}`, open: i === p.messages.length - 1 },
            h("summary", { text: `${i + 1}. ${ROLE_LABEL[m.role] ?? m.role} · ${length} 字${count ? ` · ${count} 张图` : ""}` }),
            parts.map((part, partIndex) => part.type === "image_url"
              ? h("img", { class: "sc-preview-image", src: localURL(part.image_url.url), alt: "将发送给模型的图片", loading: "lazy" })
              : h("div", { class: "sc-pre", "data-ui-key": `content:${partIndex}`, text: part.text || "" })),
          );
        }),
      ),
    ),
  );
}

function composer() {
  const input = h("textarea", {
    class: "sc-input",
    "data-ui-key": "draft",
    rows: 3,
    placeholder: S.attachments.length ? "告诉模型这张图哪里要保留、哪里要修改…（Ctrl+Enter 发送）" : "说说想画什么…（Ctrl+Enter 发送）",
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
      { class: "sc-fold", "data-ui-key": key, open: Boolean(S[key]) },
      h("summary", { text: S[key] ? `${label}（${S[key].length} 字）` : label }),
      h("textarea", {
        class: "sc-input",
        "data-ui-key": "text",
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
    { class: "sc-composer", "data-ui-key": "composer" },
    area("material", "素材", "可选：贴一段剧情或画面描述，对应预设里的 {{正文}}"),
    area("setting", "设定", "可选：世界观、固定设定，对应预设里的 {{世界书触发}}"),
    h("div", { class: "sc-row" },
      h("button", { class: "sc-btn", text: "选择生成图", disabled: Boolean(S.streaming || S.sending) || S.attachments.length >= MAX_IMAGES, on: { click: guard(openImagePicker) } }),
      h("span", { class: "sc-muted", text: S.attachments.length ? `${S.attachments.length}/${MAX_IMAGES} 张 · 需使用支持看图的模型` : "可选 · 把生成图发给看图模型继续修改" }),
    ),
    attachmentList(S.attachments, "selected"),
    S.attachments.length ? h("div", { class: "sc-muted sc-image-notice", text: "选中的图片会随每轮消息发送，直到你移除它们。" }) : null,
    input,
    h(
      "div",
      { class: "sc-row sc-between" },
      h("button", { class: "sc-btn", text: "预览发送内容", disabled: Boolean(S.streaming || S.sending), on: { click: guard(openPreview) } }),
      S.streaming
        ? h("button", { class: "sc-btn sc-danger", text: S.streaming.stopping || S.streaming.recovering ? "保存中…" : "停止", disabled: Boolean(S.streaming.stopping || S.streaming.recovering), on: { click: stopMessage } })
        : h("button", { class: "sc-btn sc-primary", text: S.sending ? "准备发送…" : "发送", disabled: S.sending, on: { click: guard(sendMessage) } }),
    ),
  );
}

function chatTab() {
  const turns = S.session?.turns ?? [];
  const messages = h(
    "div",
    { class: "sc-messages", "data-ui-key": "messages" },
    !turns.length && !S.streaming ? h("div", { class: "sc-empty", text: "选好预设和模型服务，直接说想画什么。回复里的每张图都可以一键填入「Soda Chat 提示词」节点并出图。" }) : null,
    turns.map((turn) => [userBlock(turn.user, turn.material, turn.images, turn.id), assistantBlock(turn)]),
    S.streaming ? [userBlock(S.streaming.user, S.streaming.material, S.streaming.images, "streaming"), streamingBlock()] : null,
  );
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
        h("button", { class: "sc-btn", text: "新对话", disabled: Boolean(S.streaming || S.sending), on: { click: guard(newSession) } }),
      ),
    ),
    S.showHistory ? historyPanel() : null,
    notice,
    messages,
    composer(),
    S.preview ? previewOverlay() : null,
    S.imagePicker ? imagePickerOverlay() : null,
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

let presetOpenSerial = 0;
let desiredPresetId = "";
const presetToggleQueues = new Map();
const presetEntryDrafts = new Map();
const presetEntryVersions = new Map();

function applyPresetEntryDrafts(detail) {
  const drafts = presetEntryDrafts.get(detail.id);
  for (const entry of detail.entries ?? []) {
    if (drafts?.has(entry.id)) entry.enabled = drafts.get(entry.id).enabled;
  }
  return detail;
}

function showPresetUpdate(detail) {
  applyPresetEntryDrafts(detail);
  if (S.presetDetail?.id === detail.id && (!desiredPresetId || desiredPresetId === detail.id)) S.presetDetail = detail;
  S.presets = S.presets.map((preset) => preset.id === detail.id ? {
    ...preset, enabled_count: detail.entries.filter((entry) => entry.enabled).length,
    entry_count: detail.entries.length,
  } : preset);
  render();
}

async function openPreset(id) {
  const serial = ++presetOpenSerial;
  desiredPresetId = id;
  try {
    // Wait for already-clicked switches before loading the same preset again.
    await (presetToggleQueues.get(id) ?? Promise.resolve()).catch(() => {});
    const version = presetEntryVersions.get(id) ?? 0;
    const detail = await call(`presets/${id}`);
    if (serial !== presetOpenSerial) return;
    if (version !== (presetEntryVersions.get(id) ?? 0)) return openPreset(id);
    S.presetDetail = applyPresetEntryDrafts(detail);
    render();
  } catch (error) {
    if (serial !== presetOpenSerial) return;
    desiredPresetId = S.presetDetail?.id ?? "";
    throw error;
  }
}

async function togglePresetEntry(entry, enabled) {
  const id = S.presetDetail?.id;
  if (!id) return;
  if (!presetEntryDrafts.has(id)) presetEntryDrafts.set(id, new Map());
  const drafts = presetEntryDrafts.get(id);
  const edit = { enabled };
  drafts.set(entry.id, edit);
  presetEntryVersions.set(id, (presetEntryVersions.get(id) ?? 0) + 1);
  entry.enabled = enabled;
  const previous = presetToggleQueues.get(id) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    try {
      const detail = await call(`presets/${id}`, { method: "PATCH", body: { entries: { [entry.id]: enabled } } });
      if (drafts.get(entry.id) === edit) drafts.delete(entry.id);
      showPresetUpdate(detail);
    } catch (error) {
      if (drafts.get(entry.id) === edit) drafts.delete(entry.id);
      try { showPresetUpdate(await call(`presets/${id}`)); } catch { /* Keep the draft visible if the server is offline. */ }
      throw error;
    }
  }).finally(() => {
    if (presetToggleQueues.get(id) === pending) presetToggleQueues.delete(id);
    if (!drafts.size) presetEntryDrafts.delete(id);
  });
  presetToggleQueues.set(id, pending);
  return pending;
}

function presetVariableValue(detail, variable) {
  const draft = S.presetVariableDrafts.get(detail.id);
  return draft?.has(variable.name) ? draft.get(variable.name) : variable.override ?? "";
}

function editPresetVariable(presetId, name, value) {
  if (!S.presetVariableDrafts.has(presetId)) S.presetVariableDrafts.set(presetId, new Map());
  S.presetVariableDrafts.get(presetId).set(name, value);
}

async function savePresetVariables(presetId) {
  const detail = S.presetDetail;
  if (!detail || detail.id !== presetId) return;
  const snapshot = new Map(detail.variables.map((variable) => [variable.name, presetVariableValue(detail, variable)]));
  const overrides = Object.fromEntries([...snapshot].filter(([, value]) => value !== ""));
  const saved = await call(`presets/${presetId}`, { method: "PATCH", body: { overrides } });
  if (S.presetDetail?.id === presetId && (!desiredPresetId || desiredPresetId === presetId)) S.presetDetail = applyPresetEntryDrafts(saved);
  const draft = S.presetVariableDrafts.get(presetId);
  if (draft) {
    for (const [name, value] of snapshot) {
      if (draft.get(name) === value) draft.delete(name);
    }
    if (!draft.size) S.presetVariableDrafts.delete(presetId);
  }
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
  const content = h("div", { class: "sc-pre", "data-ui-key": "content" });
  return h(
    "details",
    { class: `sc-entry${entry.enabled ? "" : " sc-off"}`, "data-ui-key": `entry:${entry.id}`, on: { toggle: (e) => { if (e.target.open && !content.textContent) content.textContent = entry.content || "（空）"; } } },
    h(
      "summary",
      {},
      h("input", {
        type: "checkbox",
        "data-ui-key": "enabled",
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
        h("input", {
          class: "sc-field", "data-var": v.name, "data-ui-key": `preset-variable:${d.id}:${v.name}`,
          value: presetVariableValue(d, v), placeholder: v.default ?? "（未设置）",
          on: { input: (e) => editPresetVariable(d.id, v.name, e.target.value) },
        }),
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
    d.variables.length ? h("button", { class: "sc-btn", text: "保存变量", on: { click: guard(() => savePresetVariables(d.id)) } }) : null,
    h("h4", { text: `条目（启用 ${d.entries.filter((e) => e.enabled).length} / ${d.entries.length}）` }),
    h("div", { class: "sc-muted", text: "勾选决定是否发送；点条目名查看内容。" }),
    d.entries.map(entryRow),
  );
}

function presetsTab() {
  return h(
    "div",
    { class: "sc-scroll", "data-ui-key": "scroll" },
    h("div", { class: "sc-row" }, h("button", { class: "sc-btn sc-primary", text: "导入预设 JSON", on: { click: guard(importPreset) } })),
    h("div", { class: "sc-muted", text: "支持 st-chatu8 的 LLM 预设格式。" }),
    h(
      "div",
      { class: "sc-list" },
      S.presets.map((p) =>
        h(
          "button",
          { class: `sc-list-item${S.presetDetail?.id === p.id ? " sc-active" : ""}`, "data-ui-key": `preset:${p.id}`, on: { click: guard(() => openPreset(p.id)) } },
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

let characterLoadPromise = null;

async function ensureCharacters() {
  if (S.characters) return;
  if (!characterLoadPromise) {
    characterLoadPromise = call("characters").then(({ characters }) => {
      if (!S.characters) {
        S.characters = characters;
        render();
      }
    }).finally(() => { characterLoadPromise = null; });
  }
  return characterLoadPromise;
}

let characterSaveQueue = Promise.resolve();
let characterSaveSerial = 0;

async function saveCharacters() {
  const source = S.characters;
  const serialized = JSON.stringify(source);
  const snapshot = JSON.parse(serialized);
  const serial = ++characterSaveSerial;
  const pending = characterSaveQueue.catch(() => {}).then(async () => {
    const saved = (await call("characters", { method: "PUT", body: { characters: snapshot } })).characters;
    if (serial !== characterSaveSerial) return;
    if (S.characters === source && JSON.stringify(S.characters) === serialized && saved.length === source.length) {
      // Keep object identities (including nested fields) stable for open cards and focus restoration.
      saved.forEach((character, index) => {
        const { front, back, ...fields } = character;
        Object.assign(source[index], fields);
        Object.assign(source[index].front, front);
        Object.assign(source[index].back, back);
      });
      toast("角色库已保存", "success");
    } else {
      toast("已保存点击时的角色库；之后的编辑仍保留，请再点保存", "info");
    }
    render();
  });
  characterSaveQueue = pending;
  return pending;
}

async function importCharactersData(data) {
  const source = S.characters;
  const baseline = JSON.stringify(source);
  const snapshot = JSON.parse(JSON.stringify(data));
  const serial = ++characterSaveSerial;
  const pending = characterSaveQueue.catch(() => {}).then(async () => {
    const saved = (await call("characters", { method: "PUT", body: snapshot })).characters;
    if (serial !== characterSaveSerial) return;
    if (S.characters === source && JSON.stringify(S.characters) === baseline) {
      // Import intentionally replaces the library, so imported cards get new identities.
      S.characters = saved;
      toast("角色库已导入", "success");
    } else {
      toast("角色库已导入；页面上后续的编辑仍保留为未保存草稿", "info");
    }
    render();
  });
  characterSaveQueue = pending;
  return pending;
}

async function importCharacters() {
  const file = await pickFile();
  if (!file) return;
  await importCharactersData(JSON.parse(await file.text()));
}

const characterUIKeys = new WeakMap();
let characterUISequence = 0;

function characterCard(character, index) {
  if (!characterUIKeys.has(character)) characterUIKeys.set(character, ++characterUISequence);
  const bind = (obj, key, props = {}) =>
    h(props.multiline ? "textarea" : "input", {
      class: "sc-field",
      "data-ui-key": key,
      value: Array.isArray(obj[key]) ? obj[key].join("、") : obj[key],
      rows: props.multiline ? 2 : undefined,
      placeholder: props.placeholder,
      on: { input: (e) => { obj[key] = key === "aliases" ? e.target.value.split(/[,，、|｜]/).map((s) => s.trim()).filter(Boolean) : e.target.value; } },
    });
  return h(
    "details",
    { class: "sc-card", "data-ui-key": `character:${characterUIKeys.get(character)}`, open: !character.name },
    h("summary", {}, h("strong", { text: character.name || "（新角色）" }), h("span", { class: "sc-muted", text: ` ${character.kind === "template" ? "通用模板" : "特定角色"}${character.enabled ? "" : " · 停用"}` })),
    h("label", { class: "sc-var" }, h("span", { text: "名字" }), bind(character, "name", { placeholder: "预设调用时用的名字，如 xiao hong" })),
    h("label", { class: "sc-var" }, h("span", { text: "别名" }), bind(character, "aliases", { placeholder: "用顿号或逗号分隔" })),
    h("label", { class: "sc-var" }, h("span", { text: "简介" }), bind(character, "summary", { placeholder: "给 LLM 看的一句话" })),
    h(
      "div",
      { class: "sc-row" },
      h("select", { class: "sc-select", "data-ui-key": "kind", on: { change: (e) => { character.kind = e.target.value; } } }, h("option", { value: "specific", text: "特定角色", selected: character.kind === "specific" }), h("option", { value: "template", text: "通用模板", selected: character.kind === "template" })),
      h("label", { class: "sc-check" }, h("input", { type: "checkbox", "data-ui-key": "enabled", checked: character.enabled, on: { change: (e) => { character.enabled = e.target.checked; } } }), "启用"),
      h("button", { class: "sc-btn sc-danger", text: "删除", on: { click: () => { S.characters.splice(index, 1); render(); } } }),
    ),
    Object.entries(SIDES).map(([side, label]) =>
      h("details", { class: "sc-fold", "data-ui-key": side }, h("summary", { text: `${label}字段` }), Object.entries(FIELDS).map(([key, name]) => h("label", { class: "sc-var" }, h("span", { text: name }), bind(character[side], key, { multiline: true, placeholder: side === "back" ? "留空则用正面" : "danbooru 标签＋一句英文" })))),
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
    { class: "sc-scroll", "data-ui-key": "scroll" },
    h("div", { class: "sc-muted", text: "预设里的 ${\"name\":…}$ 调用会换成这里的字段：基础外貌＋按状态选的上半身、下半身；from behind 用背面字段。" }),
    h(
      "div",
      { class: "sc-row" },
      h("button", { class: "sc-btn", text: "新增角色", on: { click: () => { S.characters.unshift(blankCharacter()); render(); } } }),
      h("button", { class: "sc-btn", text: "导入", on: { click: guard(importCharacters) } }),
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

function chatSettingsValues() {
  return { ...S.settings, ...S.settingsDraft };
}

async function saveChatSettings() {
  const values = chatSettingsValues();
  const keys = ["history_turns", "user_name", "char_name", "target_label", "use_ai_size"];
  const body = Object.fromEntries(keys.map((key) => [key, values[key]]));
  S.settings = await call("settings", { method: "PUT", body });
  // Do not clear edits made while the save request was in flight.
  for (const [key, value] of Object.entries(body)) {
    if (S.settingsDraft[key] === value) delete S.settingsDraft[key];
  }
  toast("设置已保存", "success");
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
        "data-ui-key": `service-field:${form.id || "new"}:${key}`,
        type: props.type ?? "text",
        value: form[key] ?? "",
        placeholder: props.placeholder,
        step: props.step,
        list: props.list,
        autocomplete: props.type === "password" ? "new-password" : "off",
        on: { input: (e) => { form[key] = props.type === "number" ? Number(e.target.value) : e.target.value; } },
      }),
    );
  const flag = (key, label) => h("label", { class: "sc-check" }, h("input", { type: "checkbox", "data-ui-key": `service-field:${form.id || "new"}:${key}`, checked: Boolean(form[key]), on: { change: (e) => { form[key] = e.target.checked; } } }), label);
  const settings = chatSettingsValues();
  const setting = (key, label, type = "text") =>
    h(
      "label",
      { class: type === "checkbox" ? "sc-check" : "sc-var" },
      type === "checkbox" ? null : h("span", { text: label }),
      h("input", {
        class: type === "checkbox" ? undefined : "sc-field",
        "data-ui-key": `settings:${key}`,
        type,
        value: type === "checkbox" ? undefined : settings[key],
        checked: type === "checkbox" ? settings[key] : undefined,
        on: { input: (e) => { S.settingsDraft[key] = type === "checkbox" ? e.target.checked : type === "number" ? Number(e.target.value) : e.target.value; } },
      }),
      type === "checkbox" ? label : null,
    );
  return h(
    "div",
    { class: "sc-scroll", "data-ui-key": "scroll" },
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
      form.id && form.id !== S.services.active ? h("button", { class: "sc-btn", text: "设为当前", on: { click: guard(() => selectService(form.id)) } }) : null,
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
    h("button", { class: "sc-btn", text: "保存设置", on: { click: guard(saveChatSettings) } }),
  );
}

// ---- shell -----------------------------------------------------------------------------------------------

const TABS = { chat: "聊天", presets: "预设", characters: "角色", settings: "设置" };
const viewStates = new Map();
const SCROLLERS = ".sc-scroll, .sc-messages, .sc-composer, .sc-history, .sc-dialog-body, .sc-attachments, .sc-pre, .sc-live, textarea";

function viewKey() {
  if (S.tab === "chat") return `chat:${S.session?.id || "new"}`;
  if (S.tab === "presets") return `presets:${S.presetDetail?.id || "list"}`;
  return S.tab;
}

function elementKey(element, root) {
  const parts = [];
  for (let item = element; item && item !== root; item = item.parentElement) {
    if (item.dataset.uiKey) parts.unshift(item.dataset.uiKey);
  }
  return JSON.stringify(parts);
}

function captureView(root) {
  const state = { details: new Map(), scroll: new Map(), focus: null };
  for (const element of root.querySelectorAll("[data-ui-key]")) {
    const key = elementKey(element, root);
    if (element.tagName === "DETAILS") state.details.set(key, element.open);
    if (element.matches(SCROLLERS)) {
      const live = element.matches(".sc-messages") ? element.querySelector(".sc-live") : null;
      state.scroll.set(key, {
        top: element.scrollTop, left: element.scrollLeft,
        follow: element.matches(".sc-messages, .sc-live")
          && element.scrollHeight - element.scrollTop - element.clientHeight < (element.matches(".sc-live") ? 80 : 160)
          && (!live || live.scrollHeight - live.scrollTop - live.clientHeight < 80),
        height: element.tagName === "TEXTAREA" ? element.style.height : "",
      });
    }
    if (element === document.activeElement) {
      state.focus = { key, start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection };
    }
  }
  return state;
}

function restoreView(root, state, restoreFocus, bottom) {
  const elements = new Map([...root.querySelectorAll("[data-ui-key]")].map((element) => [elementKey(element, root), element]));
  // Expand first: restoring offsets against collapsed content would clamp them to zero.
  for (const [key, open] of state?.details ?? []) {
    const element = elements.get(key);
    if (!element) continue;
    element.open = open;
    // Preset contents are lazy. Native toggle is asynchronous, so populate before layout.
    if (open) element.dispatchEvent(new Event("toggle"));
  }
  for (const [key, position] of state?.scroll ?? []) {
    const element = elements.get(key);
    if (element && position.height) element.style.height = position.height;
  }
  if (restoreFocus && state?.focus) {
    const { key, start, end, direction } = state.focus;
    const element = elements.get(key);
    if (element && !element.disabled) {
      element.focus({ preventScroll: true });
      if (start != null && typeof element.setSelectionRange === "function") {
        try { element.setSelectionRange(start, end, direction); } catch { /* number inputs have no text selection */ }
      }
    }
  }
  for (const [key, position] of state?.scroll ?? []) {
    const element = elements.get(key);
    if (!element) continue;
    element.scrollLeft = position.left;
    element.scrollTop = position.follow ? element.scrollHeight : position.top;
  }
  const messages = root.querySelector(".sc-messages");
  if (messages && (bottom || !state)) messages.scrollTop = messages.scrollHeight;
}

function switchTab(key) {
  S.tab = key;
  save("tab", key);
  render();
  if (key === "presets" || key === "chat") {
    // Presets may have been imported elsewhere (another browser tab or the API).
    const serviceSerial = S.serviceSwitchSerial;
    const switching = Boolean(S.serviceSwitchPending);
    return guard(async () => {
      const data = await call("state");
      S.presets = data.presets;
      if (!switching && !S.serviceSwitchPending && serviceSerial === S.serviceSwitchSerial) S.services = data.services;
      render();
    })();
  }
}

function render() {
  const host = S.host;
  if (!host) return;
  const previous = host.querySelector(".soda-chat[data-ui-view]");
  if (previous) {
    viewStates.delete(previous.dataset.uiView);
    viewStates.set(previous.dataset.uiView, captureView(previous));
    // Keep navigation state bounded even across many old conversations.
    if (viewStates.size > 30) viewStates.delete(viewStates.keys().next().value);
  }
  if (!S.ready) {
    host.replaceChildren(h("div", { class: "soda-chat" }, h("div", { class: "sc-muted", text: "Soda Chat 读取中…" })));
    return;
  }
  const key = viewKey();
  const body = { chat: chatTab, presets: presetsTab, characters: charactersTab, settings: settingsTab }[S.tab] ?? chatTab;
  const root = h(
    "div",
    {
      class: "soda-chat",
      "data-ui-view": key,
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
  );
  host.replaceChildren(root);
  restoreView(root, viewStates.get(key), previous?.dataset.uiView === key, S.stickBottom);
  if (S.tab === "chat") S.stickBottom = false;
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
