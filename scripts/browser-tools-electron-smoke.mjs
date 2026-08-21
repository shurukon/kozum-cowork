import { createServer } from "node:http";
import { app, BrowserWindow } from "electron";
import { BrowserEngine, ElectronBrowserBackend } from "../src/main/browser/engine.ts";
import { makeBrowserTools } from "../src/main/tools/browser.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outputDir = join(process.cwd(), "artifacts", "tool-smoke");
mkdirSync(outputDir, { recursive: true });

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Kozum Browser Smoke</title>
<style>body{font-family:sans-serif;height:4000px;margin:0;padding:24px}#status{margin-top:800px}</style>
<script>window.addEventListener('DOMContentLoaded',()=>setTimeout(()=>{const e=document.createElement('p');e.id='delayed';e.textContent='delayed marker';document.body.append(e)},80))</script>
</head><body>
<h1 id="heading">Browser smoke page</h1>
<p id="message">initial message</p>
<form id="form"><label>Query <input id="query" name="query"></label><button id="submit" type="button" onclick="document.querySelector('#message').textContent='clicked:'+document.querySelector('#query').value">Submit</button></form>
<a href="/second.html">Second page</a><div id="status">scroll target</div>
</body></html>`;
const second = `<!doctype html><html><head><title>Second page</title></head><body><h1>Second</h1><p>second page content</p></body></html>`;

async function main() {
  console.log("starting local server");
  const server = createServer((req, res) => {
    const body = req.url === "/second.html" ? second : html;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  console.log("local server ready");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP server did not start");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  console.log("waiting for electron ready");
  await app.whenReady();
  console.log("electron ready");
  const window = new BrowserWindow({ show: true, width: 1024, height: 720, webPreferences: { sandbox: false } });
  const backend = new ElectronBrowserBackend(1024, 720);
  const engine = new BrowserEngine(backend, { timeoutMs: 15_000, retries: 0 });
  const tools = new Map(makeBrowserTools(engine).map((tool) => [tool.definition.name, tool]));
  const progress = [];
  const ctx = {
    sessionId: "electron-browser-smoke",
    mode: "cowork",
    workingFolder: process.cwd(),
    outputsDir: outputDir,
    capabilities: { vision: "yes" },
    modelId: "smoke",
    providerId: "local",
    signal: new AbortController().signal,
    onProgress: (note) => progress.push(note),
  };
  const report = { ok: true, baseUrl, tools: {}, progress };
  const writeReport = () => writeFileSync(join(outputDir, "browser-tools-electron-smoke.json"), JSON.stringify(report, null, 2));

  async function run(name, input) {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Missing browser tool ${name}`);
    const result = await tool.handler(input, ctx);
    if (!result.ok) throw new Error(`${name} failed: ${result.error ?? result.content}`);
    return result;
  }

  try {
    console.log("step: navigate");
    await run("browser_navigate", { url: `${baseUrl}/index.html` });
    const view = backend.getWebContentsView();
    if (!view) throw new Error("Browser backend did not create WebContentsView");
    window.contentView.addChildView(view);
    await new Promise((resolve) => setTimeout(resolve, 300));

    console.log("step: get content");
    const content = await run("browser_get_content", { type: "text" });
    if (!content.content.includes("Browser smoke page")) throw new Error("browser_get_content returned unexpected text");
    report.tools.browser_navigate = "passed";
    report.tools.browser_get_content = "passed";

    console.log("step: type and click");
    await run("browser_type", { selector: "#query", text: "hello from smoke" });
    await run("browser_click", { selector: "#submit" });
    const afterClick = await run("browser_get_content", { type: "text", selector: "#message" });
    if (!afterClick.content.includes("hello from smoke")) throw new Error("browser_type/browser_click did not update the page");
    report.tools.browser_type = "passed";
    report.tools.browser_click = "passed";

    console.log("step: scroll");
    await run("browser_scroll", { direction: "down", amount: 500 });
    const scrollY = await engine.evaluate("window.scrollY");
    if (typeof scrollY !== "number" || scrollY < 100) throw new Error(`browser_scroll did not move page: ${scrollY}`);
    report.tools.browser_scroll = "passed";

    console.log("step: wait");
    await run("browser_wait", { selector: "#delayed" });
    report.tools.browser_wait = "passed";

    console.log("step: extract");
    const extracted = await run("browser_extract", { instruction: "return the title, headings and links" });
    if (!extracted.content.includes("Browser smoke page") || !extracted.content.includes("Second page")) throw new Error("browser_extract returned incomplete data");
    report.tools.browser_extract = "passed";

    console.log("step: screenshot");
    const screenshot = await run("browser_screenshot", { fullPage: false });
    if (!screenshot.images?.[0]?.data) throw new Error("browser_screenshot returned no image");
    writeFileSync(join(outputDir, "browser-page.jpg"), Buffer.from(screenshot.images[0].data, "base64"));
    report.tools.browser_screenshot = "passed";

    console.log("step: history");
    await run("browser_navigate", { url: `${baseUrl}/second.html` });
    await run("browser_back", {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    const backUrl = await engine.currentUrl();
    if (!backUrl.endsWith("/index.html")) throw new Error(`browser_back ended at ${backUrl}`);
    await run("browser_forward", {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    const forwardUrl = await engine.currentUrl();
    if (!forwardUrl.endsWith("/second.html")) throw new Error(`browser_forward ended at ${forwardUrl}`);
    report.tools.browser_back = "passed";
    report.tools.browser_forward = "passed";

    console.log("step: close");
    await run("browser_close", {});
    report.tools.browser_close = "passed";
  } catch (error) {
    report.ok = false;
    report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    console.log("step: cleanup");
    await engine.close().catch(() => undefined);
    if (!window.isDestroyed()) window.destroy();
    await new Promise((resolve) => server.close(resolve));
    writeReport();
    await app.quit();
  }

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  app.quit().catch(() => undefined);
  process.exitCode = 1;
});
