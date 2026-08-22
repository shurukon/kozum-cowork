import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { LocalPreviewServer } from "../../src/main/preview/server.ts";

describe("LocalPreviewServer", () => {
  let root: string;
  let server: LocalPreviewServer;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kozum-preview-server-"));
    server = new LocalPreviewServer();
  });

  afterEach(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it("serves a local HTML tree with relative SVG/CSS assets and a restrictive CSP", async () => {
    const assetDir = join(root, "assets");
    await mkdir(assetDir, { recursive: true });
    const html = `<!doctype html><html><head><link rel="stylesheet" href="assets/app.css"></head><body><img src="assets/mark.svg"><button id="demo">Demo</button><script>document.querySelector('#demo').dataset.ready = 'yes'</script></body></html>`;
    await writeFile(join(root, "index.html"), html);
    await writeFile(join(assetDir, "app.css"), "body { color: rgb(1, 2, 3); }");
    await writeFile(join(assetDir, "mark.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"><circle cx=\"5\" cy=\"5\" r=\"5\"/></svg>");

    const handle = await server.open(join(root, "index.html"));
    const page = await fetch(handle.url);
    const pageText = await page.text();
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'none'/);
    assert.match(pageText, /assets\/mark\.svg/);

    const css = await fetch(new URL("assets/app.css", handle.url));
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
    assert.match(await css.text(), /rgb\(1, 2, 3\)/);

    const svg = await fetch(new URL("assets/mark.svg", handle.url));
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.match(await svg.text(), /<circle/);
  });

  it("rejects traversal outside the selected HTML directory", async () => {
    await writeFile(join(root, "index.html"), "<h1>safe</h1>");
    const outside = join(dirname(root), "kozum-preview-secret.txt");
    await writeFile(outside, "must-not-be-served");
    try {
      const handle = await server.open(join(root, "index.html"));
      const traversal = await fetch(`${handle.url.replace(/index\.html$/, "")}..%2Fkozum-preview-secret.txt`);
      assert.equal(traversal.status, 403);
      assert.doesNotMatch(await traversal.text(), /must-not-be-served/);
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("rejects non-HTML targets for live preview", async () => {
    const file = join(root, "notes.txt");
    await writeFile(file, "not html");
    await assert.rejects(() => server.open(file), /requires an \.html/);
  });
});
