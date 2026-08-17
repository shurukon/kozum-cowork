import { _electron as electron } from "playwright";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = "/home/ubuntu/kozum-cowork";
const outDir = "/home/ubuntu/kozum-cowork/artifacts/chat-ui";
mkdirSync(outDir, { recursive: true });
const assetsDir = join(root, "out/renderer/assets");
const rendererFile = readdirSync(assetsDir).find((name) => /^index-.*\.js$/.test(name));
if (!rendererFile) throw new Error("renderer bundle not found");
const rendererBundle = readFileSync(join(assetsDir, rendererFile), "utf8");
const moduleClass = (name) => {
  const match = rendererBundle.match(new RegExp(`const ${name} = "([^"]+)"`));
  if (!match) throw new Error(`CSS module class not found: ${name}`);
  return match[1];
};

const app = await electron.launch({
  args: [join(root, "out/main/index.js")],
  env: {
    ...process.env,
    KOZUM_USERDATA: join(root, ".screenshot-userdata"),
    NODE_ENV: "test",
  },
});
const page = await app.firstWindow();
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(1200);

const skip = page.getByRole("button", { name: /skip for now/i });
if (await skip.isVisible({ timeout: 2500 }).catch(() => false)) {
  await skip.click();
  await page.waitForTimeout(800);
}

await page.screenshot({ path: join(outDir, "chat-home-baseline.png"), fullPage: true });

const css = {
  cowork: moduleClass("coworkAssistantRow"),
  timeline: moduleClass("activityTimeline"),
  step: moduleClass("activityStep"),
  marker: moduleClass("activityMarker"),
  markerLive: moduleClass("activityMarkerLive"),
  markerDone: moduleClass("activityMarkerDone"),
  content: moduleClass("activityContent"),
  pulse: moduleClass("activityPulse"),
  check: moduleClass("activityCheck"),
  question: moduleClass("activityQuestion"),
  thinking: moduleClass("thinking"),
  thinkingLive: moduleClass("thinkingLive"),
  thinkingHeader: moduleClass("thinkingLiveHeader"),
  thinkingLabel: moduleClass("thinkingLiveLabel"),
  thinkingStream: moduleClass("thinkingStream"),
};

await page.evaluate((css) => {

  const svg = (kind) => {
    const paths = {
      shell: '<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h5M8 16h3"/>',
      file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/>',
      tasks: '<path d="M5 6h2M10 6h9M5 12h2M10 12h9M5 18h2M10 18h9"/><path d="m6 6 .5.5L8 5M6 12l.5.5L8 11M6 18l.5.5L8 17"/>',
    };
    return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[kind] ?? paths.tasks}</svg>`;
  };
  const marker = (kind, live = false, done = false) => `<div class="${css.marker} ${live ? css.markerLive : done ? css.markerDone : ""}" aria-hidden="true">${live ? `<span class="${css.pulse}"></span>` : done ? `<span class="${css.check}"></span>` : svg(kind)}</div>`;
  const step = (markerHtml, contentHtml) => `<div class="${css.step}">${markerHtml}<div class="${css.content}">${contentHtml}</div></div>`;
  const label = (text) => `<div style="font-size:var(--fs-base);color:var(--text-secondary);line-height:1.45;">${text}</div>`;
  const thinking = `<div class="${css.thinkingLive}" aria-live="polite"><div class="${css.thinkingHeader}"><span class="${css.thinkingLabel}">Thought process</span></div><p class="${css.thinkingStream}">The user wants me to continue. I’m checking the workspace state and preparing the next action.</p></div>`;
  const tool = (name, body) => `<div style="display:flex;flex-direction:column;gap:5px"><div style="display:flex;align-items:center;gap:9px;font-size:var(--fs-base);color:var(--text-secondary);line-height:1.45"><span style="display:inline-grid;place-items:center;color:var(--text-muted)">${svg(name === "Shell exec" ? "shell" : "file")}</span><span>${name}</span></div><div style="font-family:var(--font-sans);font-size:var(--fs-base);line-height:1.65;color:var(--text-muted);max-width:680px">${body}</div></div>`;

  const overlay = document.createElement("main");
  overlay.id = "kozum-chat-visual-qa";
  overlay.style.cssText = "position:fixed;z-index:99999;inset:36px 260px 0 220px;overflow:auto;background:var(--bg-primary);padding:72px 74px 120px;color:var(--text-primary);font-family:var(--font-sans);";
  overlay.innerHTML = `<div class="${css.cowork}" style="max-width:760px;margin:0 auto"><div class="${css.timeline}" aria-label="Activity timeline">
    ${step(marker("tasks", false, true), thinking)}
    ${step(marker("shell"), tool("Shell exec", "The workspace is ready. I’m inspecting the current project before making the requested change."))}
    ${step(marker("file"), tool("File write", "Updated the chat activity renderer and kept the event details available inline."))}
    ${step(marker("tasks", false, true), label("Completed task"))}
    ${step(marker("tasks", false, true), label("Completed task"))}
    ${step(marker("tasks", false, true), label("Completed task"))}
    ${step(marker("tasks", false, true), label("The task is complete. Let me summarize the results for the user."))}
    <div class="${css.step}">${marker("tasks", false, true)}<div class="${css.content}"><div style="font-size:var(--fs-base);line-height:1.72;color:var(--text-primary);max-width:680px">Done</div></div></div>
  </div></div>`;
  document.body.appendChild(overlay);
}, css);
await page.waitForTimeout(250);
await page.screenshot({ path: join(outDir, "chat-activity-timeline.png"), fullPage: true });
console.log(JSON.stringify({
  title: await page.title(),
  baseline: join(outDir, "chat-home-baseline.png"),
  activity: join(outDir, "chat-activity-timeline.png"),
}, null, 2));
await app.close();
