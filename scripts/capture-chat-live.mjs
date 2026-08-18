import { _electron as electron } from "playwright";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";

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
  const preferred = page.getByRole("option", { name: /GPT-5 mini/i }).first();
  const secondary = page.getByRole("option", { name: /GPT-5 nano/i }).first();
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

const composer = page.getByRole("textbox", { name: /message/i });
await composer.waitFor({ state: "visible", timeout: 5000 });
await composer.fill("Do not create a task and do not use task_create. Use the file_write tool directly to create an actual file named live-ui-smoke.html in the current working folder, containing a short landing page. After the file_write tool succeeds, reply with a concise confirmation.");
await composer.press("Enter");

const permissionPath = join(OUT, "chat-live-permission.png");
const runningPath = join(OUT, "chat-live-tool-running.png");
const completePath = join(OUT, "chat-live-done.png");
const previewPath = join(OUT, "chat-live-preview.png");
const noToolPath = join(OUT, "chat-live-no-tool.png");
let sawPermission = false;
let sawRunning = false;
let sawDone = false;
let sawPreview = false;
const deadline = Date.now() + 60000;
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
  if (!sawRunning && (await running.count()) > 0) {
    await page.screenshot({ path: runningPath, fullPage: false });
    sawRunning = true;
    console.log("captured=running");
  }
  if ((await ok.count()) > 0) {
    if (!sawDone) {
      await page.screenshot({ path: completePath, fullPage: false });
      sawDone = true;
      console.log("captured=done");
    }
    const composerValue = await composer.inputValue().catch(() => "");
    const body = await page.locator("body").innerText().catch(() => "");
    if (!sawPreview && /live-ui-smoke\.html/i.test(body)) {
      const fileChip = page.getByRole("button", { name: /live-ui-smoke\.html/i }).first();
      if (await visible(fileChip, 1200)) {
        await fileChip.click();
        await page.waitForTimeout(900);
        await page.screenshot({ path: previewPath, fullPage: false });
        sawPreview = true;
        console.log("captured=preview");
      }
    }
    if (composerValue === "" && /live-ui-smoke\.html/i.test(body) && sawPreview) break;
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
console.log(JSON.stringify({ sawPermission, sawRunning, sawDone, sawPreview, output: OUT }));
await app.close();
