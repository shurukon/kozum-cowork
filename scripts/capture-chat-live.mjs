import { _electron as electron } from "playwright";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";

const ROOT = join(import.meta.dirname, "..");
const MAIN_BUNDLE = join(ROOT, "out", "main", "index.js");
const USERDATA = join(ROOT, ".live-userdata");
const OUT = join(ROOT, "artifacts", "chat-ui");
const apiBase = process.env.OPENAI_API_BASE;
const apiKey = process.env.OPENAI_API_KEY;

if (!existsSync(MAIN_BUNDLE)) throw new Error("Build missing: run npm run build first");
if (!apiBase || !apiKey) throw new Error("OPENAI-compatible test environment is unavailable");
rmSync(USERDATA, { recursive: true, force: true });

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
  await modelButton.click();
  const refresh = page.getByRole("button", { name: /refresh models/i });
  if (await visible(refresh, 1500)) {
    await refresh.click();
    await page.waitForTimeout(1800);
  }

  const options = page.getByRole("option");
  const visibleOptions = await options.allInnerTexts().catch(() => []);
  // The proxy exposes stable display names while model IDs remain internal.
  // Prefer the fast live model for UI capture, then fall back to GPT-5 mini or the first real model.
  const preferred = page.getByRole("option", { name: /GPT-5 nano/i }).first();
  const secondary = page.getByRole("option", { name: /GPT-5 mini/i }).first();
  const modelOption = (await visible(preferred, 3000)) ? preferred : (await visible(secondary, 1500)) ? secondary : options.first();
  if (!(await visible(modelOption, 3000))) {
    await page.screenshot({ path: join(OUT, "chat-live-model-selection-debug.png"), fullPage: false });
    throw new Error(`No live model was available after refresh; options=${JSON.stringify(visibleOptions)}`);
  }
  await modelOption.click();
}

await selectProviderAndModel();

const composer = page.getByRole("textbox", { name: /message/i });
await composer.waitFor({ state: "visible", timeout: 5000 });
await composer.fill("Create a single file named live-ui-smoke.html containing a short landing page, then confirm that you created it.");
await composer.press("Enter");

const permissionPath = join(OUT, "chat-live-permission.png");
const runningPath = join(OUT, "chat-live-tool-running.png");
const completePath = join(OUT, "chat-live-done.png");
const noToolPath = join(OUT, "chat-live-no-tool.png");
let sawPermission = false;
let sawRunning = false;
let sawDone = false;
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
    if (composerValue === "" && /live-ui-smoke\.html/i.test(body)) break;
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
      latestMessages: messages.map((m) => ({ role: m.role, content: String(m.content ?? "").slice(0, 240), toolCalls: m.toolCalls?.length ?? 0, stopReason: m.stopReason ?? null })),
    };
  }).catch((error) => ({ bridgeError: String(error) }));
  console.log(JSON.stringify({ captured: sawRunning ? "running-without-done" : "no-tool-state", bodyText, sessionDiagnostics, rendererDiagnostics, mainDiagnostics }));
}
console.log(JSON.stringify({ sawPermission, sawRunning, sawDone, output: OUT }));
await app.close();
