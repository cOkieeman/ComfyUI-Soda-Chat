import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = (await readFile(new URL("../web/soda_chat.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "")
  .replaceAll("import.meta.url", '"http://localhost/extensions/soda-chat/soda_chat.js"');

function harness(fetchApi = async () => ({ ok: true, json: async () => ({}) })) {
  const storage = new Map();
  const notices = [];
  const app = {
    registerExtension() {},
    extensionManager: { toast: { add: (notice) => notices.push(notice) } },
    rootGraph: { nodes: [] },
    graph: { setDirtyCanvas() {} },
    queuePrompt: async () => true,
  };
  const sandbox = {
    app, api: { fetchApi }, console, TextDecoder, AbortController, URL, URLSearchParams,
    setTimeout, clearTimeout, confirm: () => true,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nglobalThis.subject = { S, graphNodes, fill, fillCards, rememberPrompt, flushPromptEdits, readEvents, sendMessage, reuseAttachment, removeAttachment, turnRequest, deleteSession, presetVariableValue, editPresetVariable, savePresetVariables, chatSettingsValues, saveChatSettings, openPreset, togglePresetEntry, ensureCharacters, saveCharacters, importCharactersData };`, sandbox);
  return { ...sandbox.subject, app, notices, storage };
}

function promptNode(mode = 0) {
  return {
    type: "SodaChatPrompt", mode,
    widgets: [{ name: "prompt", value: "before" }, { name: "label", value: "" }],
    setDirtyCanvas() {},
  };
}

function sse(events) {
  return new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("failed queue stops a batch and never shows queue success", async () => {
  const h = harness();
  const node = promptNode();
  h.app.rootGraph.nodes = [node];
  let attempts = 0;
  h.app.queuePrompt = async () => { attempts++; return false; };
  await h.fillCards([{ prompt: "first" }, { prompt: "second" }], true);
  assert.equal(attempts, 1);
  assert.equal(node.widgets[0].value, "first");
  assert.equal(h.notices.some((item) => item.severity === "success"), false);
  assert.match(h.notices[0].detail, /未成功提交/);
});

test("inactive ancestor blocks mutation and queueing of nested targets", async () => {
  const h = harness();
  const node = promptNode();
  h.app.rootGraph.nodes = [{ mode: 2, subgraph: { nodes: [{ mode: 0, subgraph: { nodes: [node] } }] } }];
  let queued = false;
  h.app.queuePrompt = async () => { queued = true; return true; };
  assert.equal(await h.fill({ prompt: "new" }, true), false);
  assert.equal(node.widgets[0].value, "before");
  assert.equal(queued, false);
});

test("uninstantiated subgraph definitions are not selected as targets", () => {
  const h = harness();
  h.app.rootGraph.subgraphs = new Map([["unused", { nodes: [promptNode()] }]]);
  assert.equal(h.graphNodes().length, 0);
});

test("edits to two cards survive a single debounce window", async () => {
  const writes = [];
  const h = harness(async (path, options) => {
    writes.push({ path, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({}) };
  });
  h.S.session = { id: "session", turns: [] };
  h.rememberPrompt({ id: "turn" }, { index: 0 }, "first edit");
  h.rememberPrompt({ id: "turn" }, { index: 1 }, "second edit");
  await h.flushPromptEdits();
  assert.deepEqual(writes.map((item) => [item.body.index, item.body.prompt]), [[0, "first edit"], [1, "second edit"]]);
});

test("failed card save can be retried without losing its pending edit", async () => {
  let attempts = 0;
  const h = harness(async () => {
    attempts++;
    return { ok: attempts > 1, json: async () => ({ error: "temporary error" }) };
  });
  h.S.session = { id: "session", turns: [] };
  h.rememberPrompt({ id: "turn" }, { index: 0 }, "keep me");
  await assert.rejects(h.flushPromptEdits(), /未保存/);
  await h.flushPromptEdits();
  assert.equal(attempts, 2);
});

test("SSE reader accepts CRLF and a final event without a trailing blank line", async () => {
  const h = harness();
  const events = [];
  await h.readEvents(new Response('event: delta\r\ndata: {"text":"你好"}\r\n\r\nevent: done\r\ndata: {"ok":true}'), (name, data) => events.push([name, data]));
  assert.equal(events.length, 2);
  assert.equal(events[0][1].text, "你好");
  assert.equal(events[1][0], "done");
});

test("premature EOF preserves partial reply and draft on disk", async () => {
  const h = harness(async (path) => {
    if (path === "/soda_chat/chat") return sse([
      ["start", { session_id: "session", turn_id: "remote-turn", title: "example", report: {} }],
      ["delta", { text: "partial reply", kind: "content" }],
    ]);
    if (path === "/soda_chat/sessions/session") return { ok: true, json: async () => ({ id: "session", turns: [] }) };
    return { ok: true, json: async () => ({ sessions: [] }) };
  });
  h.S.session = { id: "session", turns: [] };
  h.S.presetId = "preset";
  h.S.services.active = "service";
  h.S.draft = "keep my request";
  await h.sendMessage();
  assert.equal(h.S.draft, "keep my request");
  assert.equal(JSON.parse(h.storage.get("soda-chat:draft")), "keep my request");
  assert.equal(h.S.session.turns[0].reply, "partial reply");
  assert.equal(h.S.session.turns[0].status, "interrupted");
  assert.equal(h.S.streaming, null);
});

test("interrupted stream uses its exact saved turn, without appending a duplicate", async () => {
  const savedTurn = { id: "remote-turn", user: "hello", reply: "saved partial", status: "interrupted" };
  const h = harness(async (path) => {
    if (path === "/soda_chat/chat") return sse([
      ["start", { session_id: "session", turn_id: "remote-turn", title: "example", report: {} }],
      ["delta", { text: "partial", kind: "content" }],
    ]);
    if (path === "/soda_chat/sessions/session") return { ok: true, json: async () => ({ id: "session", turns: [savedTurn] }) };
    return { ok: true, json: async () => ({ sessions: [] }) };
  });
  h.S.session = { id: "session", turns: [] };
  h.S.presetId = "preset";
  h.S.services.active = "service";
  h.S.draft = "hello";
  await h.sendMessage();
  assert.equal(h.S.session.turns.length, 1);
  assert.equal(h.S.session.turns[0].id, "remote-turn");
  assert.equal(h.S.session.turns[0].reply, "saved partial");
});

test("image selection is explicit, persists across requests, and is capped at four", () => {
  const h = harness();
  assert.equal(h.turnRequest().image_ids.length, 0);
  for (let i = 0; i < 4; i++) h.reuseAttachment({ id: `image-${i}`, name: `${i}.png` });
  h.reuseAttachment({ id: "image-0" });
  assert.equal(h.turnRequest().image_ids.length, 4);
  assert.throws(() => h.reuseAttachment({ id: "image-4" }), /最多发送 4/);
  h.turnRequest();
  assert.equal(h.S.attachments.length, 4);
  h.removeAttachment("image-1");
  assert.equal(h.turnRequest().image_ids.length, 3);
  assert.equal(JSON.parse(h.storage.get("soda-chat:attachments")).length, 3);
});

test("deleting any conversation while streaming is blocked", async () => {
  let called = false;
  const h = harness(async () => { called = true; return { ok: true }; });
  h.S.streaming = {};
  await assert.rejects(h.deleteSession("session"), /停止回复后/);
  assert.equal(called, false);
});

test("preset variable drafts survive refreshed data and stay separate between presets", () => {
  const h = harness();
  const first = { id: "first", variables: [{ name: "style", override: "saved" }] };
  const second = { id: "second", variables: [{ name: "style", override: "other" }] };
  h.editPresetVariable(first.id, "style", "unsaved edit");
  const refreshed = { id: first.id, variables: [{ name: "style", override: "server refresh" }] };
  assert.equal(h.presetVariableValue(refreshed, refreshed.variables[0]), "unsaved edit");
  assert.equal(h.presetVariableValue(second, second.variables[0]), "other");
  h.editPresetVariable(first.id, "style", "");
  assert.equal(h.presetVariableValue(refreshed, refreshed.variables[0]), "");
});

test("saving variables preserves newer edits and does not switch back to an old preset", async () => {
  let finish;
  let request;
  const h = harness((path, options) => {
    request = { path, body: JSON.parse(options.body) };
    return new Promise((resolve) => { finish = resolve; });
  });
  const first = { id: "first", variables: [{ name: "style", override: "before" }, { name: "size", override: "square" }] };
  h.S.presetDetail = first;
  h.editPresetVariable(first.id, "style", "submitted");
  h.editPresetVariable(first.id, "size", "");
  const pending = h.savePresetVariables(first.id);
  h.editPresetVariable(first.id, "style", "typed while saving");
  h.S.presetDetail = { id: "second", variables: [] };
  finish({ ok: true, json: async () => ({ id: "first", variables: [{ name: "style", override: "submitted" }, { name: "size", override: null }] }) });
  await pending;
  assert.deepEqual(request.body.overrides, { style: "submitted" });
  assert.equal(h.S.presetDetail.id, "second");
  assert.equal(h.presetVariableValue(first, first.variables[0]), "typed while saving");
  assert.equal(h.S.presetVariableDrafts.get(first.id).has("size"), false);
});

test("a failed variable save retains the draft for retry", async () => {
  const h = harness(async () => ({ ok: false, json: async () => ({ error: "temporary error" }) }));
  h.S.presetDetail = { id: "first", variables: [{ name: "style", override: "saved" }] };
  h.editPresetVariable("first", "style", "keep this");
  await assert.rejects(h.savePresetVariables("first"), /temporary error/);
  assert.equal(h.presetVariableValue(h.S.presetDetail, h.S.presetDetail.variables[0]), "keep this");
});

test("chat settings drafts survive refreshes and save only visible chat settings", async () => {
  let body;
  const h = harness(async (_path, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ ...body, history_turns: 50, last_preset: "latest", seeded_builtin: ["internal"] }) };
  });
  h.S.settings = { history_turns: 6, user_name: "before", char_name: "assistant", target_label: "", use_ai_size: true, last_preset: "old" };
  h.S.settingsDraft.history_turns = 75;
  h.S.settingsDraft.target_label = "my target";
  h.S.settings = { ...h.S.settings, user_name: "refreshed", last_preset: "latest" };
  assert.equal(h.chatSettingsValues().history_turns, 75);
  assert.equal(h.chatSettingsValues().user_name, "refreshed");
  await h.saveChatSettings();
  assert.equal(body.last_preset, undefined);
  assert.equal(body.seeded_builtin, undefined);
  assert.equal(body.target_label, "my target");
  assert.equal(h.chatSettingsValues().history_turns, 50);
  assert.equal(Object.keys(h.S.settingsDraft).length, 0);
});

test("settings edited during a pending save are kept as the next draft", async () => {
  let finish;
  const h = harness((_path, options) => {
    const body = JSON.parse(options.body);
    return new Promise((resolve) => { finish = () => resolve({ ok: true, json: async () => body }); });
  });
  h.S.settings = { history_turns: 6, user_name: "before", char_name: "assistant", target_label: "", use_ai_size: true };
  h.S.settingsDraft.user_name = "submitted";
  const pending = h.saveChatSettings();
  h.S.settingsDraft.user_name = "next edit";
  finish();
  await pending;
  assert.equal(h.S.settings.user_name, "submitted");
  assert.equal(h.chatSettingsValues().user_name, "next edit");
});

test("a slow preset load cannot replace the last clicked preset", async () => {
  const requests = new Map();
  const h = harness((path) => new Promise((resolve) => requests.set(path, resolve)));
  const first = h.openPreset("first");
  const second = h.openPreset("second");
  await new Promise(setImmediate);
  requests.get("/soda_chat/presets/second")({ ok: true, json: async () => ({ id: "second", entries: [] }) });
  await second;
  requests.get("/soda_chat/presets/first")({ ok: true, json: async () => ({ id: "first", entries: [] }) });
  await first;
  assert.equal(h.S.presetDetail.id, "second");
});

test("an entry toggle response cannot switch away from the currently viewed preset", async () => {
  let finish;
  const h = harness(() => new Promise((resolve) => { finish = resolve; }));
  const entry = { id: "entry", enabled: true };
  h.S.presetDetail = { id: "first", entries: [entry] };
  const pending = h.togglePresetEntry(entry, false);
  await new Promise(setImmediate);
  h.S.presetDetail = { id: "second", entries: [] };
  finish({ ok: true, json: async () => ({ id: "first", entries: [{ id: "entry", enabled: false }] }) });
  await pending;
  assert.equal(h.S.presetDetail.id, "second");
});

test("rapid entry toggles submit in order and keep the newest checkbox state visible", async () => {
  const requests = [];
  const h = harness((_path, options) => new Promise((resolve) => requests.push({ body: JSON.parse(options.body), resolve })));
  const entry = { id: "entry", enabled: true };
  h.S.presetDetail = { id: "first", entries: [entry] };
  const first = h.togglePresetEntry(entry, false);
  const second = h.togglePresetEntry(entry, true);
  await new Promise(setImmediate);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.entries.entry, false);
  requests[0].resolve({ ok: true, json: async () => ({ id: "first", entries: [{ id: "entry", enabled: false }] }) });
  await first;
  await new Promise(setImmediate);
  assert.equal(h.S.presetDetail.entries[0].enabled, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.entries.entry, true);
  requests[1].resolve({ ok: true, json: async () => ({ id: "first", entries: [{ id: "entry", enabled: true }] }) });
  await second;
  assert.equal(h.S.presetDetail.entries[0].enabled, true);
});

test("a rejected entry toggle restores the server state", async () => {
  const h = harness(async (_path, options) => options.method === "PATCH"
    ? { ok: false, json: async () => ({ error: "save failed" }) }
    : { ok: true, json: async () => ({ id: "first", entries: [{ id: "entry", enabled: true }] }) });
  const entry = { id: "entry", enabled: true };
  h.S.presetDetail = { id: "first", entries: [entry] };
  await assert.rejects(h.togglePresetEntry(entry, false), /save failed/);
  assert.equal(h.S.presetDetail.entries[0].enabled, true);
});

test("saving characters cannot undo edits or resurrect deletions made during the request", async () => {
  let finish;
  const h = harness(() => new Promise((resolve) => { finish = resolve; }));
  const first = { name: "first", summary: "before", front: {}, back: {} };
  const removed = { name: "removed", summary: "", front: {}, back: {} };
  h.S.characters = [first, removed];
  const pending = h.saveCharacters();
  await new Promise(setImmediate);
  first.summary = "new edit";
  h.S.characters.splice(1, 1);
  finish({ ok: true, json: async () => ({ characters: [{ name: "first", summary: "before", front: {}, back: {} }, removed] }) });
  await pending;
  assert.equal(h.S.characters.length, 1);
  assert.equal(h.S.characters[0], first);
  assert.equal(first.summary, "new edit");
  assert.match(h.notices[0].detail, /之后的编辑仍保留/);
});

test("successful character normalization preserves card and nested field identities", async () => {
  const h = harness(async () => ({ ok: true, json: async () => ({ characters: [{ name: "Alice", summary: "clean", aliases: [], front: { base: "front" }, back: { base: "back" } }] }) }));
  const character = { name: " Alice ", summary: " clean ", aliases: [], front: { base: " front " }, back: { base: " back " } };
  const front = character.front;
  const back = character.back;
  h.S.characters = [character];
  await h.saveCharacters();
  assert.equal(h.S.characters[0], character);
  assert.equal(character.front, front);
  assert.equal(character.back, back);
  assert.equal(character.name, "Alice");
  assert.equal(front.base, "front");
});

test("repeated character saves submit snapshots serially with the latest edit last", async () => {
  const requests = [];
  const h = harness((_path, options) => new Promise((resolve) => requests.push({ body: JSON.parse(options.body), resolve })));
  const character = { name: "Alice", summary: "first", front: {}, back: {} };
  h.S.characters = [character];
  const first = h.saveCharacters();
  character.summary = "second";
  const second = h.saveCharacters();
  await new Promise(setImmediate);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.characters[0].summary, "first");
  requests[0].resolve({ ok: true, json: async () => requests[0].body });
  await first;
  await new Promise(setImmediate);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.characters[0].summary, "second");
  requests[1].resolve({ ok: true, json: async () => requests[1].body });
  await second;
  assert.equal(character.summary, "second");
  assert.equal(h.S.characters[0], character);
});

test("initial character loads share one request and cannot overwrite newer library data", async () => {
  let requests = 0;
  let finish;
  const h = harness(() => {
    requests++;
    return new Promise((resolve) => { finish = resolve; });
  });
  const first = h.ensureCharacters();
  const second = h.ensureCharacters();
  assert.equal(requests, 1);
  const newLibrary = [{ name: "newly imported", front: {}, back: {} }];
  h.S.characters = newLibrary;
  finish({ ok: true, json: async () => ({ characters: [{ name: "stale response" }] }) });
  await Promise.all([first, second]);
  assert.equal(h.S.characters, newLibrary);
});

test("character import runs after a pending save and replaces prior unsaved data", async () => {
  const requests = [];
  const h = harness((_path, options) => new Promise((resolve) => requests.push({ body: JSON.parse(options.body), resolve })));
  h.S.characters = [{ name: "old", summary: "before", front: {}, back: {} }];
  const save = h.saveCharacters();
  h.S.characters[0].summary = "existing unsaved change";
  const imported = { characters: [{ name: "imported", summary: "new library", front: {}, back: {} }] };
  const importing = h.importCharactersData(imported);
  await new Promise(setImmediate);
  assert.equal(requests.length, 1);
  requests[0].resolve({ ok: true, json: async () => requests[0].body });
  await save;
  await new Promise(setImmediate);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.characters[0].name, "imported");
  requests[1].resolve({ ok: true, json: async () => requests[1].body });
  await importing;
  assert.equal(h.S.characters[0].name, "imported");
});

test("character edits made while import is pending remain as an unsaved draft", async () => {
  let finish;
  const h = harness(() => new Promise((resolve) => { finish = resolve; }));
  const character = { name: "old", summary: "before", front: {}, back: {} };
  h.S.characters = [character];
  const imported = { characters: [{ name: "imported", front: {}, back: {} }] };
  const pending = h.importCharactersData(imported);
  await new Promise(setImmediate);
  character.summary = "typed during import";
  finish({ ok: true, json: async () => imported });
  await pending;
  assert.equal(h.S.characters[0], character);
  assert.equal(character.summary, "typed during import");
  assert.match(h.notices[0].detail, /未保存草稿/);
});

test("variable save response does not replace a preset while another preset is loading", async () => {
  const requests = new Map();
  const h = harness((path) => new Promise((resolve) => requests.set(path, resolve)));
  const first = { id: "first", variables: [{ name: "style", override: "before" }], entries: [] };
  h.S.presetDetail = first;
  h.editPresetVariable("first", "style", "after");
  const saving = h.savePresetVariables("first");
  const switching = h.openPreset("second");
  await new Promise(setImmediate);
  requests.get("/soda_chat/presets/first")({ ok: true, json: async () => ({ id: "first", variables: [{ name: "style", override: "after" }], entries: [] }) });
  await saving;
  assert.equal(h.S.presetDetail, first);
  requests.get("/soda_chat/presets/second")({ ok: true, json: async () => ({ id: "second", variables: [], entries: [] }) });
  await switching;
  assert.equal(h.S.presetDetail.id, "second");
});

test("variable save response preserves entry switches that are still pending", async () => {
  const requests = new Map();
  const h = harness((_path, options) => {
    const body = JSON.parse(options.body);
    return new Promise((resolve) => requests.set(body.entries ? "entry" : "variables", resolve));
  });
  const entry = { id: "entry", enabled: true };
  h.S.presetDetail = { id: "first", variables: [{ name: "style", override: "before" }], entries: [entry] };
  const toggle = h.togglePresetEntry(entry, false);
  const saving = h.savePresetVariables("first");
  await new Promise(setImmediate);
  requests.get("variables")({ ok: true, json: async () => ({ id: "first", variables: [], entries: [{ id: "entry", enabled: true }] }) });
  await saving;
  assert.equal(h.S.presetDetail.entries[0].enabled, false);
  requests.get("entry")({ ok: true, json: async () => ({ id: "first", variables: [], entries: [{ id: "entry", enabled: false }] }) });
  await toggle;
  assert.equal(h.S.presetDetail.entries[0].enabled, false);
});
