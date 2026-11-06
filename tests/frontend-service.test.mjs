import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = (await readFile(new URL("../web/soda_chat.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "")
  .replaceAll("import.meta.url", '"http://localhost/extensions/soda-chat/soda_chat.js"');

function harness(fetchApi) {
  const storage = new Map();
  const notices = [];
  const sandbox = {
    app: { registerExtension() {}, extensionManager: { toast: { add: (notice) => notices.push(notice) } } },
    api: { fetchApi }, console, TextDecoder, AbortController, URL, URLSearchParams,
    setTimeout, clearTimeout,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nh = (tag, props = {}, ...children) => ({ tag, props, children: children.flat(Infinity) });\nglobalThis.subject = { S, selectService, ensureServiceReady, sendMessage, openPreview, switchTab, settingsTab };`, sandbox);
  const subject = sandbox.subject;
  subject.S.presetId = "preset";
  subject.S.services = profiles("A");
  subject.S.draft = "paint a tree";
  subject.S.session = { id: "session", turns: [] };
  return { ...subject, storage, notices };
}

function profiles(active) {
  return { active, profiles: ["A", "B", "C"].map((id) => ({ id, name: id })) };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function json(data, ok = true) {
  return { ok, json: async () => data };
}

function sse(events) {
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""));
}

function completedChat() {
  return sse([
    ["start", { session_id: "session", turn_id: "turn", title: "test", report: {} }],
    ["done", { turn: { id: "turn", user: "paint a tree", reply: "OK", status: "ok", parsed: null } }],
  ]);
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test("send waits for the visible service selection before constructing its request", async () => {
  const activation = deferred();
  const requests = [];
  const h = harness(async (path, options) => {
    if (path === "/soda_chat/services/B/activate") return activation.promise;
    if (path === "/soda_chat/chat") {
      requests.push(JSON.parse(options.body));
      return completedChat();
    }
    return json({ sessions: [] });
  });
  const switching = h.selectService("B");
  assert.equal(h.S.services.active, "B");
  const sending = h.sendMessage();
  await nextTick();
  assert.equal(requests.length, 0);
  activation.resolve(json(profiles("B")));
  await Promise.all([switching, sending]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].service_id, "B");
});

test("rapid B then C switches serialize on the server and preview waits for C", async () => {
  const b = deferred();
  const c = deferred();
  const activations = [];
  const previews = [];
  const h = harness(async (path, options) => {
    if (path.endsWith("/activate")) {
      activations.push(path);
      return path.includes("/B/") ? b.promise : c.promise;
    }
    if (path === "/soda_chat/preview") {
      previews.push(JSON.parse(options.body));
      return json({ messages: [], report: {} });
    }
    return json({});
  });
  const first = h.selectService("B");
  const second = h.selectService("C");
  const preview = h.openPreview();
  assert.equal(h.S.services.active, "C");
  await nextTick();
  assert.deepEqual(activations, ["/soda_chat/services/B/activate"]);
  b.resolve(json(profiles("B")));
  await first;
  await nextTick();
  assert.equal(h.S.services.active, "C");
  assert.deepEqual(activations, ["/soda_chat/services/B/activate", "/soda_chat/services/C/activate"]);
  assert.equal(previews.length, 0);
  c.resolve(json(profiles("C")));
  await Promise.all([second, preview]);
  assert.equal(previews[0].service_id, "C");
});

test("a failed latest switch blocks chat and preview without losing the draft", async () => {
  const activation = deferred();
  let upstreamCalls = 0;
  const h = harness(async (path) => {
    if (path.endsWith("/activate")) return activation.promise;
    upstreamCalls++;
    return json({});
  });
  const switching = h.selectService("B");
  const rejectedSwitch = assert.rejects(switching, /切换失败/);
  const sending = h.sendMessage();
  const rejectedSend = assert.rejects(sending, /切换失败/);
  activation.resolve(json({ error: "service was removed" }, false));
  await Promise.all([rejectedSwitch, rejectedSend]);
  await assert.rejects(h.openPreview(), /切换失败/);
  assert.equal(upstreamCalls, 0);
  assert.equal(h.S.draft, "paint a tree");
  assert.equal(h.S.sending, false);
});

test("a superseded switch failure does not prevent the newer selection", async () => {
  const h = harness(async (path) => path.includes("/B/")
    ? json({ error: "old selection missing" }, false)
    : json(profiles("C")));
  const b = h.selectService("B");
  const c = h.selectService("C");
  await Promise.all([b, c, h.ensureServiceReady()]);
  assert.equal(h.S.services.active, "C");
  assert.equal(h.S.serviceSwitchError, "");
});

test("deleted-session terminal error clears its ID and keeps the request for a new chat", async () => {
  const requests = [];
  const h = harness(async (path, options) => {
    if (path === "/soda_chat/chat") {
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) return sse([
        ["start", { session_id: "session", turn_id: "discarded", title: "test", report: {} }],
        ["error", { session_deleted: true, error: "conversation deleted", turn: { id: "discarded", reply: "partial" } }],
      ]);
      return completedChat();
    }
    return json({ sessions: [] });
  });
  await h.sendMessage();
  assert.equal(h.S.session, null);
  assert.equal(h.S.draft, "paint a tree");
  assert.equal(JSON.parse(h.storage.get("soda-chat:session")), "");
  await h.sendMessage();
  assert.equal(requests[1].session_id, "");
});

test("a state request started before a service switch cannot restore the old service", async () => {
  const state = deferred();
  const h = harness(async (path) => path === "/soda_chat/state" ? state.promise : json(profiles("B")));
  const refreshing = h.switchTab("chat");
  await h.selectService("B");
  state.resolve(json({ presets: [{ id: "fresh-preset" }], services: profiles("A") }));
  await refreshing;
  assert.equal(h.S.services.active, "B");
  assert.equal(h.S.presets[0].id, "fresh-preset");
});

test("state fetched during activation remains stale even if it arrives after activation", async () => {
  const state = deferred();
  const activation = deferred();
  const h = harness(async (path) => path === "/soda_chat/state" ? state.promise : activation.promise);
  const switching = h.selectService("B");
  const refreshing = h.switchTab("presets");
  activation.resolve(json(profiles("B")));
  await switching;
  state.resolve(json({ presets: [], services: profiles("A") }));
  await refreshing;
  assert.equal(h.S.services.active, "B");
});

test("state refresh still accepts another window's service change when no local switch intervened", async () => {
  const h = harness(async () => json({ presets: [], services: profiles("C") }));
  await h.switchTab("chat");
  assert.equal(h.S.services.active, "C");
});

test("settings activate button participates in the same serialized selection queue", async () => {
  const b = deferred();
  const calls = [];
  const h = harness(async (path) => {
    calls.push(path);
    return path.includes("/B/") ? b.promise : json(profiles("C"));
  });
  h.S.serviceForm = { id: "B", name: "B" };
  const findButton = (tree) => {
    if (tree?.props?.text === "设为当前") return tree;
    for (const child of tree?.children ?? []) {
      const found = findButton(child);
      if (found) return found;
    }
    return null;
  };
  const button = findButton(h.settingsTab());
  assert.ok(button);
  const settingsSwitch = button.props.on.click();
  assert.equal(h.S.services.active, "B");
  const dropdownSwitch = h.selectService("C");
  await nextTick();
  assert.deepEqual(calls, ["/soda_chat/services/B/activate"]);
  b.resolve(json(profiles("B")));
  await Promise.all([settingsSwitch, dropdownSwitch]);
  assert.deepEqual(calls, ["/soda_chat/services/B/activate", "/soda_chat/services/C/activate"]);
  assert.equal(h.S.services.active, "C");
});
