import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";

// Reuse an installed Playwright and browser; this suite never installs dependencies.
const require = createRequire(import.meta.url);
let playwright;
if (process.env.PLAYWRIGHT_PACKAGE_JSON) {
  playwright = createRequire(process.env.PLAYWRIGHT_PACKAGE_JSON)("playwright");
} else {
  try { playwright = require("playwright"); }
  catch (error) {
    throw new Error("Set PLAYWRIGHT_PACKAGE_JSON to an installed Playwright package.json", { cause: error });
  }
}

const source = (await readFile(new URL("../web/soda_chat.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "")
  .replaceAll("import.meta.url", '"http://soda-chat.test/extensions/soda-chat/soda_chat.js"');
const css = await readFile(new URL("../web/soda_chat.css", import.meta.url), "utf8");
const onePixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
let browser;

before(async () => {
  const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || (existsSync(edge) ? edge : undefined);
  browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
});
after(async () => { await browser?.close(); });

async function openHarness(t) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], "no browser runtime errors"));
  await page.route("**/*", (route) => route.request().resourceType() === "image"
    ? route.fulfill({ status: 200, contentType: "image/png", body: onePixel })
    : route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><html><head></head><body><div id="host" class="soda-chat-host"></div></body></html>' }));
  await page.goto("http://soda-chat.test/");
  await page.addStyleTag({ content: `${css}\nbody { margin: 0; } #host { width: 480px; height: 620px; }` });
  await page.evaluate(() => {
    window.__requests = [];
    window.__notices = [];
    window.confirm = () => true;
    window.app = {
      registerExtension() {}, nodeOutputs: {},
      extensionManager: { toast: { add: (notice) => window.__notices.push(notice) } },
    };
    window.mockAPI = async (path, options, body) => {
      const state = window.subject.S;
      if (path === "/soda_chat/settings") return { ...state.settings, ...body };
      if (path === "/soda_chat/services/models") return { models: ["test-model"] };
      if (path === "/soda_chat/state") return { presets: state.presets, services: state.services };
      if (path === "/history?max_items=20") return {};
      if (path === "/soda_chat/attachments/from-output") return { attachment: { id: `selected-${body.filename}`, name: body.filename, width: 512, height: 512, url: `/soda_chat/attachments/${body.filename}` } };
      throw new Error(`Unexpected mock API request: ${options.method ?? "GET"} ${path}`);
    };
    window.api = {
      apiURL: (path) => path,
      fetchApi: async (path, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        window.__requests.push({ path, method: options.method ?? "GET", body });
        const result = await window.mockAPI(path, options, body);
        return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    };
  });
  await page.addScriptTag({ content: `${source}\nwindow.subject = { S, render, updateStreaming, setSession, openImagePicker, chooseOutput };` });
  await page.evaluate(() => {
    Object.assign(window.subject.S, {
      host: document.getElementById("host"), ready: true, tab: "chat", presetId: "preset",
      settings: { history_turns: 6, user_name: "用户", char_name: "角色", target_label: "", use_ai_size: true },
      services: { active: "local-test", profiles: [{ id: "local-test", name: "Local fixture", model: "fixture", base_url: "http://127.0.0.1:1/v1" }] },
      presets: [{ id: "preset", name: "Test preset", enabled_count: 1, entry_count: 1 }],
    });
    window.subject.render();
  });
  await settle(page);
  return page;
}

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function scrollPosition(page, selector) {
  return page.locator(selector).evaluate((element) => ({ top: element.scrollTop, gap: element.scrollHeight - element.clientHeight - element.scrollTop }));
}

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= 3, `${label}: expected ${expected}, received ${actual}`);
}

test("settings save preserves real scroll position and unsaved service fields", async (t) => {
  const page = await openHarness(t);
  await page.evaluate(() => { window.subject.S.tab = "settings"; window.subject.render(); });
  await page.locator('[data-ui-key="service-field:local-test:model"]').fill("unsaved-model");
  await page.locator('[data-ui-key="settings:history_turns"]').fill("17");
  await page.getByRole("button", { name: "保存设置", exact: true }).scrollIntoViewIfNeeded();
  const before = await scrollPosition(page, ".sc-scroll");
  assert.ok(before.top > 0, "fixture genuinely scrolls");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.waitForFunction(() => window.subject.S.settings.history_turns === 17);
  await settle(page);
  near((await scrollPosition(page, ".sc-scroll")).top, before.top, "settings scroll after save");
  assert.equal(await page.locator('[data-ui-key="service-field:local-test:model"]').inputValue(), "unsaved-model");
});

test("async preset checkbox render preserves expansion, scroll and variable draft", async (t) => {
  const page = await openHarness(t);
  await page.evaluate(() => {
    const state = window.subject.S;
    state.tab = "presets";
    state.presetDetail = {
      id: "preset", name: "Test preset", variables: [{ name: "style", default: "default", override: "" }],
      entries: Array.from({ length: 14 }, (_, i) => ({ id: `entry-${i}`, name: `Entry ${i}`, role: "system", enabled: true, content: "Long preset text\n".repeat(10) })),
    };
    const fallback = window.mockAPI;
    window.mockAPI = async (path, options, body) => {
      if (path === "/soda_chat/presets/preset" && options.method === "PATCH") {
        await new Promise((resolve) => { window.releasePreset = resolve; });
        const detail = structuredClone(state.presetDetail);
        for (const entry of detail.entries) if (entry.id in body.entries) entry.enabled = body.entries[entry.id];
        return detail;
      }
      return fallback(path, options, body);
    };
    window.subject.render();
  });
  await page.locator('[data-ui-key="preset-variable:preset:style"]').fill("unsaved watercolor");
  const entry = page.locator('[data-ui-key="entry:entry-7"]');
  await entry.locator("summary").click();
  await settle(page);
  await entry.locator('input[type="checkbox"]').scrollIntoViewIfNeeded();
  const before = await scrollPosition(page, ".sc-scroll");
  await entry.locator('input[type="checkbox"]').uncheck();
  await page.waitForFunction(() => Boolean(window.releasePreset));
  await page.evaluate(() => window.releasePreset());
  await page.waitForFunction(() => window.subject.S.presetDetail.entries[7].enabled === false);
  await settle(page);
  assert.equal(await entry.evaluate((element) => element.open), true);
  assert.equal(await page.locator('[data-ui-key="preset-variable:preset:style"]').inputValue(), "unsaved watercolor");
  near((await scrollPosition(page, ".sc-scroll")).top, before.top, "preset scroll after checkbox response");
});

test("deleting an earlier character preserves later character and nested expansion", async (t) => {
  const page = await openHarness(t);
  await page.evaluate(() => {
    const side = () => ({ base: "description", upper_sfw: "shirt", upper_nsfw: "", lower_sfw: "trousers", lower_nsfw: "" });
    window.subject.S.tab = "characters";
    window.subject.S.characters = ["Alice", "Bob", "Carol"].map((name) => ({ name, aliases: [], kind: "specific", enabled: true, summary: "", front: side(), back: side() }));
    window.subject.render();
  });
  const cards = page.locator("details.sc-card");
  await cards.nth(0).locator(":scope > summary").click();
  await cards.nth(1).locator(":scope > summary").click();
  await cards.nth(1).locator('[data-ui-key="front"] > summary').click();
  await cards.nth(0).getByRole("button", { name: "删除", exact: true }).click();
  await settle(page);
  assert.equal(await cards.count(), 2);
  assert.equal(await cards.nth(0).locator('[data-ui-key="name"]').inputValue(), "Bob");
  assert.equal(await cards.nth(0).evaluate((element) => element.open), true);
  assert.equal(await cards.nth(0).locator('[data-ui-key="front"]').evaluate((element) => element.open), true);
});

async function longStreamingChat(page, fresh = false) {
  await page.evaluate((isFresh) => {
    const state = window.subject.S;
    state.tab = "chat";
    state.session = isFresh ? null : { id: "long-session", title: "Long chat", turns: Array.from({ length: 25 }, (_, i) => ({ id: `turn-${i}`, user: `Question ${i}`, reply: "Earlier response\n".repeat(6), status: "ok" })) };
    state.streaming = { controller: new AbortController(), user: "Next question", material: "", images: [], text: "Streaming response\n".repeat(isFresh ? 30 : 1), reasoning: "", report: null };
    state.stickBottom = true;
    window.subject.render();
  }, fresh);
  await settle(page);
}

test("large streaming chunks follow only the bottom reader and chat repaint preserves scroll", async (t) => {
  const page = await openHarness(t);
  await longStreamingChat(page);
  await page.locator(".sc-messages").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const initialHeight = await page.locator(".sc-messages").evaluate((element) => element.scrollHeight);
  await page.evaluate(() => { window.subject.S.streaming.text += "Large delta\n".repeat(120); window.subject.updateStreaming(); });
  await settle(page);
  assert.ok(await page.locator(".sc-messages").evaluate((element) => element.scrollHeight) - initialHeight > 160, "delta grows the actual message layout beyond the following threshold");
  near((await scrollPosition(page, ".sc-messages")).gap, 0, "bottom reader follows large delta");
  await page.locator(".sc-messages").evaluate((element) => { element.scrollTop = 120; element.dispatchEvent(new Event("scroll")); });
  await page.evaluate(() => { window.subject.S.streaming.text += "Another delta\n".repeat(120); window.subject.updateStreaming(); });
  await settle(page);
  near((await scrollPosition(page, ".sc-messages")).top, 120, "reader scrolling upward stays in place");
  await page.evaluate(() => window.subject.render());
  await settle(page);
  near((await scrollPosition(page, ".sc-messages")).top, 120, "chat full repaint stays in place");
});

test("a fresh stream acquiring its session ID preserves the reader's scroll position", async (t) => {
  const page = await openHarness(t);
  await page.locator("#host").evaluate((element) => { element.style.height = "420px"; });
  await longStreamingChat(page, true);
  await page.locator(".sc-messages").evaluate((element) => { element.scrollTop = 30; element.dispatchEvent(new Event("scroll")); });
  const position = await scrollPosition(page, ".sc-messages");
  near(position.top, 30, "fixture allows scrolling away from the bottom");
  assert.ok(position.gap > 160, "reader is outside the near-bottom following region");
  await page.evaluate(() => { window.subject.setSession({ id: "assigned-session", title: "Assigned", turns: [] }); window.subject.render(); });
  await settle(page);
  near((await scrollPosition(page, ".sc-messages")).top, 30, "server session assignment preserves scroll");
});

test("focused input selection survives a full DOM replacement", async (t) => {
  const page = await openHarness(t);
  const input = page.locator('[data-ui-key="draft"]');
  await input.fill("keep this selected phrase and the rest");
  await input.evaluate((element) => { element.focus(); element.setSelectionRange(5, 25, "backward"); });
  await page.evaluate(() => window.subject.render());
  await settle(page);
  const state = await input.evaluate((element) => ({ focused: document.activeElement === element, start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection, value: element.value }));
  assert.deepEqual(state, { focused: true, start: 5, end: 25, direction: "backward", value: "keep this selected phrase and the rest" });
});

test("image picker selection and refresh preserve its scrolling thumbnail list", async (t) => {
  const page = await openHarness(t);
  await page.evaluate(async () => {
    window.app.nodeOutputs = { output: { images: Array.from({ length: 80 }, (_, i) => ({ filename: `frame-${i}.png`, subfolder: "test", type: "output" })) } };
    await window.subject.openImagePicker();
  });
  const item = page.getByRole("button", { name: "选择图片 frame-45.png", exact: true });
  await item.scrollIntoViewIfNeeded();
  const selector = '[data-ui-key="image-picker"] .sc-dialog-body';
  const before = await scrollPosition(page, selector);
  assert.ok(before.top > 0, "picker genuinely scrolls");
  await item.click();
  await page.waitForFunction(() => window.subject.S.attachments.length === 1 && !window.subject.S.imagePicker.busy);
  await settle(page);
  near((await scrollPosition(page, selector)).top, before.top, "picker scroll after selection");
  await page.getByRole("button", { name: "刷新图片", exact: true }).click();
  await page.waitForFunction(() => !window.subject.S.imagePicker.loading);
  await settle(page);
  near((await scrollPosition(page, selector)).top, before.top, "picker scroll after refresh");
});

test("long preset content keeps its inner scroll offset after checkbox rerender", async (t) => {
  const page = await openHarness(t);
  await page.evaluate(() => {
    const state = window.subject.S;
    state.tab = "presets";
    state.presetDetail = {
      id: "preset", name: "Long preset", variables: [],
      entries: [{ id: "long-entry", name: "Long entry", role: "system", enabled: true, content: "Long inner preset content\n".repeat(100) }],
    };
    const fallback = window.mockAPI;
    window.mockAPI = async (path, options, body) => {
      if (path === "/soda_chat/presets/preset" && options.method === "PATCH") {
        const saved = structuredClone(state.presetDetail);
        saved.entries[0].enabled = body.entries["long-entry"];
        return saved;
      }
      return fallback(path, options, body);
    };
    window.subject.render();
  });
  const entry = page.locator('[data-ui-key="entry:long-entry"]');
  await entry.locator("summary").click();
  await settle(page);
  const content = entry.locator(".sc-pre");
  await content.evaluate((element) => { element.scrollTop = 160; });
  near(await content.evaluate((element) => element.scrollTop), 160, "fixture has an inner scroll offset");
  await entry.locator('input[type="checkbox"]').uncheck();
  await page.waitForFunction(() => window.subject.S.presetDetail.entries[0].enabled === false);
  await settle(page);
  assert.equal(await entry.evaluate((element) => element.open), true);
  near(await content.evaluate((element) => element.scrollTop), 160, "inner preset content offset after async render");
});

test("streaming text's inner scrollbar follows its bottom reader and preserves an upward read", async (t) => {
  const page = await openHarness(t);
  await longStreamingChat(page, true);
  await page.locator(".sc-messages").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.locator(".sc-live").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.evaluate(() => { window.subject.S.streaming.text += "Inner streaming delta\n".repeat(120); window.subject.updateStreaming(); });
  await settle(page);
  near((await scrollPosition(page, ".sc-live")).gap, 0, "inner bottom reader follows new text");
  await page.locator(".sc-live").evaluate((element) => { element.scrollTop = 100; element.dispatchEvent(new Event("scroll")); });
  assert.ok((await scrollPosition(page, ".sc-live")).gap > 160, "reader has scrolled above the following region");
  await page.evaluate(() => { window.subject.S.streaming.text += "More inner streaming delta\n".repeat(80); window.subject.updateStreaming(); });
  await settle(page);
  near((await scrollPosition(page, ".sc-live")).top, 100, "inner upward read stays in place during streaming");
  await page.evaluate(() => window.subject.render());
  await settle(page);
  near((await scrollPosition(page, ".sc-live")).top, 100, "inner upward read stays in place after full render");
  const outerBeforeCompletion = await scrollPosition(page, ".sc-messages");
  await page.evaluate(() => {
    const { S, setSession, render } = window.subject;
    setSession({ id: "completed-inner-session", title: "Completed stream", turns: [] });
    S.session.turns.push({ id: "completed-turn", user: S.streaming.user, reply: S.streaming.text, status: "ok", parsed: null });
    S.streaming = null;
    render();
  });
  await settle(page);
  const outerAfterCompletion = await scrollPosition(page, ".sc-messages");
  near(outerAfterCompletion.top, outerBeforeCompletion.top, "completing the stream preserves the upward reader's outer position");
  assert.ok(outerAfterCompletion.gap > 160, "completion does not jump to the end of the full reply");
});
