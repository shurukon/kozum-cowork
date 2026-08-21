/**
 * Unit tests for previewKind.ts
 *
 * Run with:
 *   node --experimental-strip-types --test tests/unit/previewKind.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  previewKindForPath,
  isPreviewable,
} from "../../src/renderer/lib/previewKind.ts";

// ── text kinds ─────────────────────────────────────────────────────────────

describe("previewKindForPath — text files", () => {
  it(".ts → text", () => assert.equal(previewKindForPath("foo.ts"), "text"));
  it(".tsx → text", () => assert.equal(previewKindForPath("foo.tsx"), "text"));
  it(".js → text", () => assert.equal(previewKindForPath("bar.js"), "text"));
  it(".jsx → text", () => assert.equal(previewKindForPath("bar.jsx"), "text"));
  it(".json → text", () => assert.equal(previewKindForPath("package.json"), "text"));
  it(".css → text", () => assert.equal(previewKindForPath("styles.css"), "text"));
  it(".html → text", () => assert.equal(previewKindForPath("index.html"), "text"));
  it(".py → text", () => assert.equal(previewKindForPath("script.py"), "text"));
  it(".rs → text", () => assert.equal(previewKindForPath("main.rs"), "text"));
  it(".go → text", () => assert.equal(previewKindForPath("server.go"), "text"));
  it(".yaml → text", () => assert.equal(previewKindForPath("config.yaml"), "text"));
  it(".yml → text", () => assert.equal(previewKindForPath("config.yml"), "text"));
  it(".sh → text", () => assert.equal(previewKindForPath("setup.sh"), "text"));
  it(".sql → text", () => assert.equal(previewKindForPath("query.sql"), "text"));
  it(".txt → text", () => assert.equal(previewKindForPath("readme.txt"), "text"));
  it(".log → text", () => assert.equal(previewKindForPath("app.log"), "text"));
  it(".csv → text", () => assert.equal(previewKindForPath("data.csv"), "text"));
  it(".env → text", () => assert.equal(previewKindForPath(".env"), "text"));
});

// ── markdown kind ─────────────────────────────────────────────────────────

describe("previewKindForPath — markdown files", () => {
  it(".md → markdown", () => assert.equal(previewKindForPath("README.md"), "markdown"));
  it(".mdx → markdown", () => assert.equal(previewKindForPath("page.mdx"), "markdown"));
  it(".markdown → markdown", () => assert.equal(previewKindForPath("doc.markdown"), "markdown"));
});

// ── image kind ────────────────────────────────────────────────────────────

describe("previewKindForPath — image files", () => {
  it(".png → image", () => assert.equal(previewKindForPath("photo.png"), "image"));
  it(".jpg → image", () => assert.equal(previewKindForPath("photo.jpg"), "image"));
  it(".jpeg → image", () => assert.equal(previewKindForPath("photo.jpeg"), "image"));
  it(".webp → image", () => assert.equal(previewKindForPath("icon.webp"), "image"));
  it(".gif → image", () => assert.equal(previewKindForPath("anim.gif"), "image"));
  it(".svg → image", () => assert.equal(previewKindForPath("logo.svg"), "image"));
  it(".bmp → image", () => assert.equal(previewKindForPath("shot.bmp"), "image"));
  it(".ico → image", () => assert.equal(previewKindForPath("favicon.ico"), "image"));
});

// ── pdf kind ──────────────────────────────────────────────────────────────

describe("previewKindForPath — pdf files", () => {
  it(".pdf → pdf", () => assert.equal(previewKindForPath("report.pdf"), "pdf"));
  it("absolute .pdf path → pdf", () => assert.equal(previewKindForPath("/home/user/docs/report.pdf"), "pdf"));
});

// ── binary kind ───────────────────────────────────────────────────────────

describe("previewKindForPath — binary files", () => {
  it(".exe → binary", () => assert.equal(previewKindForPath("app.exe"), "binary"));
  it(".zip → binary", () => assert.equal(previewKindForPath("archive.zip"), "binary"));
  it(".bin → binary", () => assert.equal(previewKindForPath("firmware.bin"), "binary"));
  it(".dll → binary", () => assert.equal(previewKindForPath("lib.dll"), "binary"));
  it(".so → binary", () => assert.equal(previewKindForPath("lib.so"), "binary"));
  it(".tar → binary", () => assert.equal(previewKindForPath("source.tar"), "binary"));
  it(".gz → binary", () => assert.equal(previewKindForPath("file.gz"), "binary"));
  it(".wasm → binary", () => assert.equal(previewKindForPath("module.wasm"), "binary"));
  it(".mp4 → video", () => assert.equal(previewKindForPath("video.mp4"), "video"));
  it(".ttf → binary", () => assert.equal(previewKindForPath("font.ttf"), "binary"));
});

// ── edge cases ────────────────────────────────────────────────────────────

describe("previewKindForPath — edge cases", () => {
  it("no extension → text (best effort)", () => {
    assert.equal(previewKindForPath("Makefile"), "text");
  });

  it("hidden file without extension → text", () => {
    assert.equal(previewKindForPath(".gitignore"), "text");
  });

  it("case-insensitive: .PNG → image", () => {
    assert.equal(previewKindForPath("PHOTO.PNG"), "image");
  });

  it("case-insensitive: .TS → text", () => {
    assert.equal(previewKindForPath("App.TS"), "text");
  });

  it("case-insensitive: .MD → markdown", () => {
    assert.equal(previewKindForPath("README.MD"), "markdown");
  });

  it("case-insensitive: .PDF → pdf", () => {
    assert.equal(previewKindForPath("Doc.PDF"), "pdf");
  });

  it("case-insensitive: .EXE → binary", () => {
    assert.equal(previewKindForPath("Setup.EXE"), "binary");
  });

  it("path with directories is handled correctly", () => {
    assert.equal(previewKindForPath("/home/user/project/src/app.tsx"), "text");
  });

  it("URL-like path with query string is stripped", () => {
    assert.equal(previewKindForPath("file.md?v=1"), "markdown");
  });

  it("unknown extension → text (best effort)", () => {
    assert.equal(previewKindForPath("data.xyz123"), "text");
  });

  it("empty string → text", () => {
    assert.equal(previewKindForPath(""), "text");
  });
});

// ── isPreviewable ──────────────────────────────────────────────────────────

describe("isPreviewable", () => {
  it("text file is previewable", () => assert.ok(isPreviewable("app.ts")));
  it("markdown file is previewable", () => assert.ok(isPreviewable("README.md")));
  it("image file is previewable", () => assert.ok(isPreviewable("photo.png")));
  it("pdf file is previewable", () => assert.ok(isPreviewable("doc.pdf")));
  it("exe is not previewable", () => assert.equal(isPreviewable("app.exe"), false));
  it("zip is not previewable", () => assert.equal(isPreviewable("archive.zip"), false));
  it("binary is not previewable", () => assert.equal(isPreviewable("fw.bin"), false));
  it("mp4 is previewable", () => assert.equal(isPreviewable("video.mp4"), true));
  it("no-extension is previewable (text fallback)", () => assert.ok(isPreviewable("Makefile")));
});
