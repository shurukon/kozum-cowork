import { _electron as electron } from "playwright";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const ROOT = join(import.meta.dirname, "..");
const MAIN_BUNDLE = join(ROOT, "out", "main", "index.js");
const USERDATA = join(ROOT, ".live-userdata");
const OUT = join(ROOT, "artifacts", "chat-ui");
const LIVE_WORKSPACE = join(OUT, "live-workspace");
const apiBase = process.env.OPENAI_API_BASE;
const apiKey = process.env.OPENAI_API_KEY;

if (!existsSync(MAIN_BUNDLE)) throw new Error("Build missing: run npm run build first");
if (!apiBase || !apiKey) throw new Error("OPENAI-compatible test environment is unavailable");
rmSync(USERDATA, { recursive: true, force: true });
rmSync(LIVE_WORKSPACE, { recursive: true, force: true });
mkdirSync(LIVE_WORKSPACE, { recursive: true });

// BrowserEngine intentionally blocks file:// navigation to prevent arbitrary
// local-file reads. Serve the real live workspace over localhost instead; the
// agent still writes the file on disk and the embedded Chromium loads it via
// a genuine HTTP request.
const workspaceRoot = resolve(LIVE_WORKSPACE);
const liveServer = createServer((req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    const filePath = resolve(join(workspaceRoot, pathname.replace(/^\/+/, "")));
    if (!filePath.startsWith(`${workspaceRoot}/`) || !existsSync(filePath)) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", filePath.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8");
    res.end(readFileSync(filePath));
  } catch {
    res.statusCode = 400;
    res.end("Bad request");
  }
});
await new Promise((resolveReady) => liveServer.listen(0, "127.0.0.1", resolveReady));
const liveAddress = liveServer.address();
if (!liveAddress || typeof liveAddress === "string") throw new Error("Live HTTP server did not expose a port");
const liveUrl = `http://127.0.0.1:${liveAddress.port}/long-live-demo.html`;

const app = await electron.launch({
  args: [MAIN_BUNDLE, "--password-store=basic"],
  env: {
    ...process.env,
    KOZUM_USERDATA: USERDATA,
    NODE_ENV: "test",
  },
});
const mainDiagnostics = [];
const child = app.process();
child.stdout?.on("data", (chunk) => mainDiagnostics.push(String(chunk)));
child.stderr?.on("data", (chunk) => mainDiagnostics.push(String(chunk)));
const page = await app.firstWindow();
const rendererDiagnostics = [];
page.on("console", (msg) => rendererDiagnostics.push(`console:${msg.type()}:${msg.text()}`));
page.on("pageerror", (error) => rendererDiagnostics.push(`pageerror:${error.message}`));
await page.waitForLoadState("domcontentloaded");
await page.waitForSelector("[aria-label='Toggle sidebar']", { timeout: 15000 });
await page.evaluate(async (folder) => {
  const settings = await window.kozum.settings.get();
  await window.kozum.settings.set({
    general: {
      ...settings.general,
      defaultFolders: { ...settings.general.defaultFolders, cowork: folder },
      autoOpenPreviews: true,
      autoOpenBrowserPreview: true,
    },
    cowork: {
      ...settings.cowork,
      permissionMode: "accept_edits",
      enabledToolNames: [
        "web_search",
        "web_fetch",
        "file_write",
        "file_edit",
        "browser_navigate",
        "browser_get_content",
        "browser_scroll",
        "browser_screenshot",
        "task_create",
        "task_get",
        "task_list",
        "task_update",
      ],
    },
  });
}, LIVE_WORKSPACE);

async function visible(locator, timeout = 1500) {
  return locator.isVisible({ timeout }).catch(() => false);
}

async function clickIfVisible(locator, timeout = 1500) {
  if (await visible(locator, timeout)) {
    await locator.click();
    return true;
  }
  return false;
}

async function selectProviderAndModel() {
  const skip = page.getByRole("button", { name: /skip for now/i });
  if (await visible(skip, 2500)) await skip.click();

  const settingsAccount = page.getByTitle("Settings");
  if (!(await clickIfVisible(settingsAccount, 4000))) {
    throw new Error("Settings account row was not visible");
  }
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.waitFor({ state: "visible", timeout: 5000 });
  await settings.getByRole("button", { name: /^providers$/i }).click();

  await settings.getByRole("button", { name: /add custom/i }).click();
  const customDialog = page.getByRole("dialog", { name: "Add custom provider" });
  await customDialog.getByLabel("Provider name").fill("Manus Live Test");
  await customDialog.getByLabel("Base URL").fill(apiBase);
  await customDialog.getByRole("button", { name: /add provider/i }).click();
  await customDialog.waitFor({ state: "detached", timeout: 5000 });

  const providerSection = settings.locator("div").filter({ hasText: "Manus Live Test" }).last();
  await providerSection.getByRole("button", { name: /add key/i }).click();
  await settings.locator("input[type='password']").last().fill(apiKey);
  await settings.getByRole("button", { name: /^save$/i }).last().click();
  await page.waitForTimeout(700);

  await settings.getByRole("button", { name: /close/i }).click();
  await page.waitForTimeout(500);

  const providerButton = page.getByRole("button", { name: /^Provider:/ }).first();
  const currentProviderLabel = await providerButton.innerText();
  if (!/Manus Live Test/i.test(currentProviderLabel)) {
    await providerButton.click();
    await page.getByRole("option", { name: /Manus Live Test/ }).first().click();
  }

  const modelButton = page.getByRole("button", { name: /^Model:/ }).first();
  const modelAria = await modelButton.getAttribute("aria-label").catch(() => null);
  console.log(JSON.stringify({ modelControlFound: Boolean(modelAria), modelLooksLikeKnownModel: /gpt|claude|gemini|kilo|llama|qwen/i.test(modelAria ?? "") }));
  await modelButton.click();
  const refresh = page.getByRole("button", { name: /refresh models/i });
  if (await visible(refresh, 1500)) {
    await refresh.click();
    await page.waitForTimeout(1800);
  }

  let options = page.getByRole("option");
  for (let attempt = 0; attempt < 6 && (await options.count()) === 0; attempt += 1) {
    // The catalogue is fetched asynchronously; close/reopen the real menu so
    // the popover observes the refreshed React state rather than a stale mount.
    if (await visible(modelButton, 800)) {
      await modelButton.click().catch(() => undefined);
      await page.waitForTimeout(180);
      await modelButton.click().catch(() => undefined);
    }
    await page.waitForTimeout(500);
  }
  options = page.getByRole("option");
  const visibleOptions = await options.allInnerTexts().catch(() => []);
  // The proxy exposes stable display names while model IDs remain internal.
  // Prefer GPT-5 mini for a stable live UI round, then fall back to nano or the first real model.
  const preferred = page.getByRole("option", { name: /GPT[- ]5[- ]mini/i }).first();
  const secondary = page.getByRole("option", { name: /GPT[- ]5[- ]nano/i }).first();
  const modelOption = (await visible(preferred, 3000)) ? preferred : (await visible(secondary, 1500)) ? secondary : options.first();
  if (!(await visible(modelOption, 3000))) {
    await page.screenshot({ path: join(OUT, "chat-live-model-selection-debug.png"), fullPage: false });
    const refreshDiagnostics = await page.evaluate(async () => {
      const presets = await window.kozum.providers.presets();
      const provider = presets.find((p) => p.name === "Manus Live Test");
      if (!provider) return { provider: null };
      const keys = await window.kozum.providers.listKeys(provider.id);
      const result = await window.kozum.providers.refreshModels(provider.id);
      return {
        provider: { id: provider.id, baseUrl: provider.baseUrl, modelsPath: provider.modelsPath },
        keyCount: keys.length,
        result: result.ok
          ? { ok: true, count: result.value.length, ids: result.value.slice(0, 8).map((m) => m.id) }
          : { ok: false, error: result.error },
      };
    }).catch((error) => ({ bridgeError: String(error) }));
    console.log(JSON.stringify({ modelOptions: visibleOptions, refreshDiagnostics, rendererDiagnostics, mainDiagnostics }));
    throw new Error(`No live model was available after refresh; options=${JSON.stringify(visibleOptions)}`);
  }
  await modelOption.click();
}

await selectProviderAndModel();

const liveToolSettings = await page.evaluate(async () => {
  const current = await window.kozum.settings.get();
  return {
    enabledToolNames: current.cowork.enabledToolNames,
    autoOpenBrowserPreview: current.general.autoOpenBrowserPreview,
  };
});
console.log(JSON.stringify({ liveToolSettings }));
if (
  !Array.isArray(liveToolSettings.enabledToolNames) ||
  !liveToolSettings.enabledToolNames.includes("browser_navigate") ||
  !liveToolSettings.enabledToolNames.includes("task_create") ||
  liveToolSettings.autoOpenBrowserPreview !== true
) {
  throw new Error(`Live settings did not persist the browser allowlist: ${JSON.stringify(liveToolSettings)}`);
}

const composer = page.getByRole("textbox", { name: /message/i });
await composer.waitFor({ state: "visible", timeout: 5000 });
await composer.fill("Run this genuinely long autonomous task and execute it for real. First use task_create to split the work into exactly six concrete subtasks: research, content plan, visual implementation, browser verification, accessibility review, and final polish. Keep the task list visible. Immediately use file_write to create an actual file named long-live-demo.html in the current working folder with a polished single-file landing page for an open-source AI coworking app, including responsive layout, hero, feature cards, workflow section, testimonials, and footer. Then immediately use browser_navigate to open " + liveUrl + " in the internal browser, followed by browser_get_content, browser_scroll, and browser_screenshot so the rendered landing page is visible early in the run. After that, use web_search with the simple query Anthropic and continue even if one result fails; use web_fetch on https://github.com/nexu-io/open-design to inspect the real design reference. Use task_update after each subtask changes state and mark each completed only after doing the work; use task_list or task_get when useful. Apply the accessibility review and final polish with file_edit, then use browser_navigate again to reload " + liveUrl + " and verify the final page. Keep progress updates concise, do not skip the task split, and finish with a concise summary only after all six tasks are completed or explicitly failed.");
await composer.press("Enter");

const permissionPath = join(OUT, "chat-live-permission.png");
const runningPath = join(OUT, "chat-live-tool-running.png");
const completePath = join(OUT, "chat-live-done.png");
const previewPath = join(OUT, "chat-live-preview.png");
const longRunningPath = join(OUT, "chat-live-long-running.png");
const browserPreviewPath = join(OUT, "chat-live-browser-preview.png");
const browserNativePath = join(OUT, "chat-live-browser-native.jpg");
const longDonePath = join(OUT, "chat-live-long-done.png");
const noToolPath = join(OUT, "chat-live-no-tool.png");
let sawPermission = false;
let sawRunning = false;
let sawLongRunning = false;
let sawTaskProgress = false;
let sawDone = false;
let sawPreview = false;
let sawBrowserPreview = false;
let sawBrowserNativeScreenshot = false;
const deadline = Date.now() + 240000;
while (Date.now() < deadline) {
  const permission = page.getByRole("alert").filter({ hasText: /needs your approval/i }).first();
  if (!sawPermission && (await permission.count()) > 0 && await permission.isVisible().catch(() => false)) {
    await page.screenshot({ path: permissionPath, fullPage: false });
    sawPermission = true;
    console.log("captured=permission");
    await permission.getByRole("button", { name: /^Allow$/i }).click();
    await page.waitForTimeout(250);
  }
  const running = page.locator("[data-tool-state='running']");
  const ok = page.locator("[data-tool-state='ok']");
  const toolCount = await page.locator("[data-tool-state]").count();
  const taskItems = page.locator("[data-status]");
  const taskProgressText = await page.locator("body").innerText().catch(() => "");
  const hasTaskProgress = (await taskItems.count()) > 0 && /Tasks|of .* done|research|visual|accessibility/i.test(taskProgressText);
  const browserArea = page.locator("[aria-label='Live browser area']").first();
  if (!sawRunning && (await running.count()) > 0) {
    await page.screenshot({ path: runningPath, fullPage: false });
    sawRunning = true;
    console.log("captured=running");
  }
  if (!sawLongRunning && toolCount >= 2) {
    await page.screenshot({ path: longRunningPath, fullPage: false });
    sawLongRunning = true;
    console.log(`captured=long-running tools=${toolCount}`);
  }
  if (!sawTaskProgress && hasTaskProgress) {
    await page.screenshot({ path: longRunningPath, fullPage: false });
    sawTaskProgress = true;
    console.log(`captured=task-progress tasks=${await taskItems.count()}`);
  }
  const browserPanel = page.locator("[class*='browserPreview']").first();
  const browserPanelText = await browserPanel.innerText().catch(() => "");
  const browserReady = browserPanelText.includes("127.0.0.1:") && browserPanelText.includes("/long-live-demo.html") && !browserPanelText.includes("Waiting for the agent");
  if (!sawBrowserPreview && await visible(browserArea, 1200) && browserReady) {
    await page.waitForTimeout(900);
    await page.screenshot({ path: browserPreviewPath, fullPage: false });
    const nativeCapture = await page.evaluate(async () => {
      const result = await window.kozum.browser.screenshot({ quality: 90 });
      return result.ok && result.value
        ? { ok: true, data: result.value.data, mimeType: result.value.mimeType, width: result.value.width, height: result.value.height, dataLength: typeof result.value.data === "string" ? result.value.data.length : null, resultKeys: Object.keys(result), valueKeys: Object.keys(result.value) }
        : { ok: false, error: result.error ?? "browser screenshot failed", resultKeys: Object.keys(result), valueType: typeof result.value, valueKeys: result.value && typeof result.value === "object" ? Object.keys(result.value) : null };
    }).catch((error) => ({ ok: false, error: String(error) }));
    if (nativeCapture.ok && nativeCapture.data) {
      writeFileSync(browserNativePath, Buffer.from(nativeCapture.data, "base64"));
      sawBrowserNativeScreenshot = true;
      console.log(`captured=browser-native dimensions=${nativeCapture.width}x${nativeCapture.height}`);
    } else {
      console.log(JSON.stringify({ browserNativeCaptureError: nativeCapture.error ?? "unknown", browserNativeCaptureKeys: Object.keys(nativeCapture), browserNativeCaptureResultKeys: nativeCapture.resultKeys ?? null, browserNativeCaptureValueKeys: nativeCapture.valueKeys ?? null, browserNativeCaptureValueType: nativeCapture.valueType ?? null, browserNativeCaptureDataLength: nativeCapture.dataLength ?? null }));
    }
    sawBrowserPreview = true;
    console.log("captured=browser-preview");
  }
  if ((await ok.count()) > 0) {
    if (!sawDone) {
      await page.screenshot({ path: completePath, fullPage: false });
      await page.screenshot({ path: longDonePath, fullPage: false });
      sawDone = true;
      console.log("captured=done");
    }
    const composerValue = await composer.inputValue().catch(() => "");
    const body = await page.locator("body").innerText().catch(() => "");
    if (!sawPreview && /long-live-demo\.html/i.test(body)) {
      const fileChip = page.getByRole("button", { name: /long-live-demo\.html/i }).first();
      if (await visible(fileChip, 1200)) {
        await fileChip.click();
        await page.waitForTimeout(900);
        await page.screenshot({ path: previewPath, fullPage: false });
        sawPreview = true;
        console.log("captured=preview");
      }
    }
    if (composerValue === "" && /long-live-demo\.html/i.test(body) && sawBrowserPreview) break;
  }
  await page.waitForTimeout(250);
}
if (!sawDone) {
  if (!sawRunning) await page.screenshot({ path: noToolPath, fullPage: false });
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const sessionDiagnostics = await page.evaluate(async () => {
    const sessions = await window.kozum.sessions.list("cowork");
    const latest = sessions[0];
    if (!latest) return { sessions: [] };
    const messages = await window.kozum.sessions.messages(latest.id);
    return {
      sessions: sessions.slice(0, 3).map((s) => ({ id: s.id, status: s.status, title: s.title, mode: s.mode })),
      latestMessages: messages.map((m) => ({
        role: m.role,
        blocks: Array.isArray(m.content)
          ? m.content.map((b) => ({ type: b?.type ?? null, id: b?.id ?? null, toolUseId: b?.toolUseId ?? null, name: b?.name ?? null }))
          : [],
        toolCalls: m.toolCalls?.length ?? 0,
        stopReason: m.stopReason ?? null,
      })),
    };
  }).catch((error) => ({ bridgeError: String(error) }));
  const domDiagnostics = await page.evaluate(() => ({
    activityTimelines: document.querySelectorAll('[aria-label="Activity timeline"]').length,
    coworkRows: document.querySelectorAll('[class*="coworkAssistantRow"]').length,
    toolCards: document.querySelectorAll('[data-tool-state]').length,
    toolStates: Array.from(document.querySelectorAll('[data-tool-state]')).map((node) => node.getAttribute('data-tool-state')),
  })).catch((error) => ({ error: String(error) }));
  console.log(JSON.stringify({ captured: sawRunning ? "running-without-done" : "no-tool-state", bodyText, sessionDiagnostics, domDiagnostics, rendererDiagnostics, mainDiagnostics }));
}
const finalDiagnostics = await page.evaluate(async () => {
  const sessions = await window.kozum.sessions.list("cowork");
  const messageGroups = await Promise.all(sessions.slice(0, 8).map(async (session) => {
    try { return await window.kozum.sessions.messages(session.id); } catch { return []; }
  }));
  const messages = messageGroups.flat();
  const toolNames = messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content
          .filter((block) => block?.type === "tool_use")
          .map((block) => block?.name)
          .filter((name) => typeof name === "string")
      : [],
  );
  const taskToolNames = toolNames.filter((name) => /^task_(create|update|get|list)$/.test(name));
  return { sessionCount: sessions.length, toolNames, taskToolNames, taskCreateCount: toolNames.filter((name) => name === "task_create").length, taskUpdateCount: toolNames.filter((name) => name === "task_update").length };
}).catch((error) => ({ error: String(error), toolNames: [], taskToolNames: [], taskCreateCount: 0, taskUpdateCount: 0 }));
const disallowedToolNames = [];
const browserUiDiagnostics = await page.evaluate(async () => {
  const panel = document.querySelector("[class*='browserPreview']");
  const area = document.querySelector("[aria-label='Live browser area']");
  const state = await window.kozum.browser?.state?.().catch(() => null);
  return {
    panelText: panel?.textContent ?? null,
    areaText: area?.textContent ?? null,
    state: state ?? null,
  };
}).catch((error) => ({ error: String(error) }));
await app.close();
liveServer.close();

function collectEventToolNames(root) {
  const names = [];
  const visit = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".events.jsonl")) {
        let lines = [];
        try { lines = readFileSync(path, "utf8").split(/\n/); } catch { continue; }
        for (const line of lines) {
          try {
            const record = JSON.parse(line);
            const event = record.event ?? record;
            if (event?.type === "tool_start" && typeof event.name === "string") names.push(event.name);
          } catch { /* ignore malformed/incomplete trailing lines */ }
        }
      }
    }
  };
  visit(root);
  return names;
}
const eventToolNames = collectEventToolNames(USERDATA);
const allToolNames = [...(finalDiagnostics.toolNames ?? []), ...eventToolNames];
const eventDiagnostics = {
  eventToolNames,
  taskCreateCount: allToolNames.filter((name) => name === "task_create").length,
  taskUpdateCount: allToolNames.filter((name) => name === "task_update").length,
};
console.log(JSON.stringify({ sawPermission, sawRunning, sawLongRunning, sawTaskProgress, sawDone, sawPreview, sawBrowserPreview, sawBrowserNativeScreenshot, finalDiagnostics, eventDiagnostics, browserUiDiagnostics, disallowedToolNames, output: OUT }));
if (!sawDone || !sawTaskProgress || !sawBrowserPreview || !sawBrowserNativeScreenshot || eventDiagnostics.taskCreateCount < 6 || eventDiagnostics.taskUpdateCount < 1) process.exitCode = 2;
