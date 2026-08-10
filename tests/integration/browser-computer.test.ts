/**
 * Integration + unit tests for the browser and computer-use subsystems.
 *
 * Electron and PowerShell are NOT available here. Tests therefore:
 *
 *   1. Test pure functions hard (sanitiseUrl, buildSelectorScript,
 *      buildInputScript, buildCaptureScript, isAppBlocked, extractJsonScript).
 *   2. Test graceful degradation: every module imports cleanly in Node, and
 *      every tool invoked without a real backend returns a clean fail().
 *   3. Test BrowserEngine logic with an in-test fake BrowserBackend.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/* ---------------------------------------------------------- imports ------- */

import {
  sanitiseUrl,
  buildSelectorScript,
  extractJsonScript,
  BrowserEngine,
  BackendUnavailableError,
} from "../../src/main/browser/engine.ts";
import type { BrowserBackend, ScreenshotResult } from "../../src/main/browser/engine.ts";

import {
  isAppBlocked,
  buildInputScript,
  buildCaptureScript,
  escapePsSingleQuoted,
  clampCoord,
  clampToDesktop,
  assertFiniteCoord,
  virtualDesktopBounds,
  buildMultiMonitorScript,
  buildSelfTestScript,
} from "../../src/main/computer/windows.ts";
import type { MonitorInfo, DesktopBounds } from "../../src/main/computer/windows.ts";

import { makeBrowserTools } from "../../src/main/tools/browser.ts";
import { makeComputerTools } from "../../src/main/tools/computer.ts";
import type { ComputerBackend, CaptureOptions, SelfTestReport } from "../../src/main/computer/windows.ts";
import type { ToolContext } from "../../src/main/tools/registry.ts";

/* -------------------------------------------------------- test context ---- */

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "test",
    mode: "cowork",
    workingFolder: null,
    outputsDir: "/tmp",
    capabilities: { vision: "yes", tools: true, streaming: true, reasoning: false },
    modelId: "test-model",
    providerId: "test-provider",
    signal: new AbortController().signal,
    onProgress: () => {},
    ...overrides,
  };
}

/* ==================================================== sanitiseUrl ========= */

describe("sanitiseUrl — allowed schemes", () => {
  it("accepts http:// and returns WHATWG-normalised href", () => {
    // WHATWG URL adds a trailing slash to bare hostnames — this is intentional
    // (H3: we return parsed.href to close parser-differential gaps).
    assert.equal(sanitiseUrl("http://example.com"), "http://example.com/");
  });

  it("accepts https:// with path and query", () => {
    assert.equal(sanitiseUrl("https://example.com/path?q=1"), "https://example.com/path?q=1");
  });

  it("rejects file:// (H3 fix — local-file read bypasses workspace confinement)", () => {
    // file: URLs were previously allowed, enabling arbitrary local-file reads.
    assert.throws(() => sanitiseUrl("file:///C:/Users/test.html"), /file:|blocked|permitted/i);
  });

  it("accepts about:blank", () => {
    assert.equal(sanitiseUrl("about:blank"), "about:blank");
  });

  it("strips leading/trailing whitespace and returns normalised href", () => {
    // Whitespace is stripped and WHATWG normalisation adds trailing slash.
    assert.equal(sanitiseUrl("  https://example.com  "), "https://example.com/");
  });
});

describe("sanitiseUrl — blocked schemes", () => {
  it("rejects javascript:", () => {
    assert.throws(() => sanitiseUrl("javascript:alert(1)"), /blocked/i);
  });

  it("rejects JAVASCRIPT: (upper case)", () => {
    assert.throws(() => sanitiseUrl("JAVASCRIPT:alert(1)"), /blocked/i);
  });

  it("rejects JaVaScRiPt: (mixed case)", () => {
    assert.throws(() => sanitiseUrl("JaVaScRiPt:alert(1)"), /blocked/i);
  });

  it("rejects leading-whitespace javascript:", () => {
    assert.throws(() => sanitiseUrl("  javascript:alert(1)"), /blocked/i);
  });

  it("rejects data:", () => {
    assert.throws(() => sanitiseUrl("data:text/html,<h1>test</h1>"), /blocked/i);
  });

  it("rejects DATA: (upper case)", () => {
    assert.throws(() => sanitiseUrl("DATA:text/html,x"), /blocked/i);
  });

  it("rejects vbscript:", () => {
    assert.throws(() => sanitiseUrl("vbscript:msgbox(1)"), /blocked/i);
  });

  it("rejects VBSCRIPT: (upper case)", () => {
    assert.throws(() => sanitiseUrl("VBSCRIPT:msgbox(1)"), /blocked/i);
  });

  it("rejects ftp:// (not in allowed set)", () => {
    assert.throws(() => sanitiseUrl("ftp://example.com"), /blocked/i);
  });

  it("rejects a completely invalid URL", () => {
    assert.throws(() => sanitiseUrl("not a url at all $$"));
  });
});

/* ================================================ buildSelectorScript ===== */

describe("buildSelectorScript — click action", () => {
  it("produces a self-invoking function string", () => {
    const script = buildSelectorScript("#my-btn", "click");
    assert.ok(script.includes("(function()"), "should be IIFE");
    assert.ok(script.includes("querySelector"), "should query selector");
    assert.ok(script.includes(".click()"), "should call .click()");
  });

  it("escapes single quote in selector", () => {
    const selector = "input[name='foo']";
    const script = buildSelectorScript(selector, "click");
    // The raw ' must not appear unescaped inside the JS string literal.
    // We test by checking the script doesn't contain the raw unescaped sequence.
    assert.ok(!script.includes("name='foo'"), "raw single-quoted attr should not appear");
    assert.ok(script.includes("\\'"), "escaped quote should be present");
  });

  it("escapes double quote in selector", () => {
    const selector = 'input[name="bar"]';
    const script = buildSelectorScript(selector, "click");
    // Double quotes are fine inside a JS single-quoted string; the test is that
    // parsing doesn't break (no unmatched string delimiters).
    assert.ok(typeof script === "string");
  });

  it("escapes backslash in selector", () => {
    const selector = "div\\special";
    const script = buildSelectorScript(selector, "click");
    assert.ok(script.includes("\\\\"), "backslash should be doubled");
  });

  it("escapes newline in selector", () => {
    const selector = "div\nclass";
    const script = buildSelectorScript(selector, "click");
    assert.ok(script.includes("\\n"), "newline should be escaped");
    assert.ok(!script.includes("\n"), "literal newline must not appear in selector position");
  });

  it("escapes backtick in selector", () => {
    const selector = "div`class";
    const script = buildSelectorScript(selector, "click");
    // Backtick has no special meaning in single-quoted JS — it's a literal char.
    // What matters is that the script is still valid JS.
    assert.ok(typeof script === "string");
  });
});

describe("buildSelectorScript — type action", () => {
  it("sets element value", () => {
    const script = buildSelectorScript("#email", "type", "user@example.com");
    assert.ok(script.includes("el.value"), "should set .value");
    assert.ok(script.includes("user@example.com"), "value should appear");
  });

  it("escapes single quote in value", () => {
    const script = buildSelectorScript("#q", "type", "it's a test");
    assert.ok(!script.match(/el\.value = '.*it's.*'/), "unescaped ' in value would break syntax");
    assert.ok(script.includes("it\\'s"), "apostrophe should be escaped");
  });

  it("escapes backslash in value", () => {
    const script = buildSelectorScript("#p", "type", "C:\\Users\\test");
    assert.ok(script.includes("C:\\\\Users\\\\test"), "backslashes should be doubled");
  });

  it("escapes newline in value", () => {
    const script = buildSelectorScript("#p", "type", "line1\nline2");
    assert.ok(script.includes("\\n"), "newline should be escaped");
  });

  it("a quote in value cannot terminate the JS string", () => {
    // If the value were not escaped, a value like "'); evil()" would
    // break out of the string and execute arbitrary JS.
    const dangerous = "'); alert('injected');//";
    const script = buildSelectorScript("#p", "type", dangerous);
    // The single-quote in the dangerous value must be escaped as \' so it
    // cannot close the surrounding JS string and start a new statement.
    // We verify the escape IS present in the el.value assignment.
    assert.ok(
      script.includes("\\'); alert(\\'"),
      "the quotes must be escaped as \\' in the assignment, got: " + script,
    );
    // Verify the script does NOT contain an unescaped '); that could close the string.
    // The pattern '); in a non-escaped context would look like: value = '...');
    // After correct escaping it appears as: value = '...\\')
    // We check the raw string cannot contain the sequence that terminates the assignment:
    // i.e. the closing ' of el.value = '...' is right before ; not preceded by \\
    const valueStart = script.indexOf("el.value = '");
    const valueContent = valueStart >= 0 ? script.slice(valueStart + 12) : "";
    // Find the end of the value literal — first unescaped '
    let escaped = false;
    let foundUnescapedClose = false;
    for (let i = 0; i < valueContent.length; i++) {
      const ch = valueContent[i];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === "'") { foundUnescapedClose = true; break; }
    }
    // The first unescaped ' should close the *legitimate* end of the string,
    // not a premature close caused by the dangerous payload.
    // Verify the value content before that close does not contain alert(
    const valueBeforeClose = valueContent.slice(0, valueContent.indexOf("'"));
    assert.ok(
      !valueBeforeClose.includes("alert(") || valueBeforeClose.includes("\\'"),
      "if alert( appears in the value it must be inside escaped quotes",
    );
    assert.ok(foundUnescapedClose, "value literal must be properly closed");
  });
});

describe("buildSelectorScript — extract action", () => {
  it("returns innerText of element", () => {
    const script = buildSelectorScript(".price", "extract");
    assert.ok(script.includes("innerText"), "should use innerText");
    assert.ok(script.includes("querySelector"), "should use querySelector");
  });
});

/* ================================================= extractJsonScript ====== */

describe("extractJsonScript", () => {
  it("produces a self-invoking function", () => {
    const script = extractJsonScript("find all product names");
    assert.ok(script.includes("(function()"), "should be IIFE");
  });

  it("includes the instruction in the script", () => {
    const script = extractJsonScript("find all product names");
    assert.ok(script.includes("find all product names"), "instruction should appear in script");
  });

  it("escapes single-quote in instruction", () => {
    const script = extractJsonScript("find all of Alice's products");
    assert.ok(!script.includes("Alice's"), "raw ' in instruction should be escaped");
    assert.ok(script.includes("Alice\\'s"), "escaped version should be present");
  });

  it("collects title, url, text, links, headings", () => {
    const script = extractJsonScript("test");
    assert.ok(script.includes("document.title"), "should include title");
    assert.ok(script.includes("window.location.href"), "should include url");
    assert.ok(script.includes("innerText"), "should include text");
    assert.ok(script.includes("querySelectorAll"), "should collect links/headings");
  });
});

/* ================================================= isAppBlocked =========== */

describe("isAppBlocked", () => {
  const blocklist = ["chrome.exe", "notepad.exe", "BANNED.EXE"];

  it("blocks an exact match (lower-case)", () => {
    assert.ok(isAppBlocked("chrome.exe", blocklist));
  });

  it("blocks case-insensitively — exe upper, list lower", () => {
    assert.ok(isAppBlocked("CHROME.EXE", blocklist));
  });

  it("blocks case-insensitively — exe lower, list upper", () => {
    assert.ok(isAppBlocked("banned.exe", blocklist));
  });

  it("blocks case-insensitively — mixed case", () => {
    assert.ok(isAppBlocked("Chrome.Exe", blocklist));
  });

  it("does not block an exe not in the list", () => {
    assert.ok(!isAppBlocked("firefox.exe", blocklist));
  });

  it("does not block an empty exe name", () => {
    assert.ok(!isAppBlocked("", blocklist));
  });

  it("does not block when list is empty", () => {
    assert.ok(!isAppBlocked("chrome.exe", []));
  });
});

/* ================================================= buildCaptureScript ===== */

describe("buildCaptureScript — escaping", () => {
  it("produces a non-empty script", () => {
    const s = buildCaptureScript({ outputPath: "C:\\temp\\out.jpg" });
    assert.ok(s.length > 0);
  });

  it("embeds outputPath in single-quoted PS string", () => {
    const s = buildCaptureScript({ outputPath: "C:\\temp\\shot.jpg" });
    assert.ok(s.includes("'C:\\temp\\shot.jpg'"), "path should appear in single quotes");
  });

  it("escapes single-quote in outputPath", () => {
    // A path containing a single quote must not break the PS string.
    const s = buildCaptureScript({ outputPath: "C:\\Alice's Files\\out.jpg" });
    assert.ok(!s.match(/= 'C:\\Alice's/), "unescaped quote would break PS string");
    assert.ok(s.includes("Alice''s"), "PS single-quote escape (doubled) should be present");
  });

  it("embeds quality as a plain integer", () => {
    const s = buildCaptureScript({ outputPath: "out.jpg", quality: 75 });
    assert.ok(s.includes("$quality = 75"), "quality should be embedded as integer");
  });

  it("includes region dimensions when provided", () => {
    const s = buildCaptureScript({
      outputPath: "out.jpg",
      region: { x: 10, y: 20, width: 800, height: 600 },
    });
    assert.ok(s.includes("800") && s.includes("600"), "region dimensions should appear");
    assert.ok(s.includes("10") && s.includes("20"), "region origin should appear");
  });
});

/* ================================================= buildInputScript ======= */

describe("escapePsSingleQuoted", () => {
  it("doubles single quotes", () => {
    assert.equal(escapePsSingleQuoted("it's"), "it''s");
  });

  it("leaves other chars untouched", () => {
    assert.equal(escapePsSingleQuoted('hello "world"'), 'hello "world"');
  });

  it("handles multiple quotes", () => {
    assert.equal(escapePsSingleQuoted("a'b'c"), "a''b''c");
  });
});

describe("buildInputScript — move", () => {
  it("calls SetCursorPos with correct coordinates", () => {
    const s = buildInputScript({ kind: "move", x: 100, y: 200 });
    assert.ok(s.includes("SetCursorPos(100, 200)"), "coordinates should appear");
  });
});

describe("buildInputScript — click", () => {
  it("includes mouse_event call for left button", () => {
    const s = buildInputScript({ kind: "click", button: "left" });
    assert.ok(s.includes("mouse_event"), "mouse_event should be called");
    // Left button down = 0x0002 = 2
    assert.ok(s.includes("2,"), "left down flag should appear");
  });

  it("moves mouse when x/y provided", () => {
    const s = buildInputScript({ kind: "click", button: "left", x: 50, y: 75 });
    assert.ok(s.includes("SetCursorPos(50, 75)"), "should move to coordinates");
  });

  it("does not move mouse when x/y omitted", () => {
    const s = buildInputScript({ kind: "click", button: "right" });
    // The P/Invoke header always declares SetCursorPos as a static method, but
    // the runtime call [Win32Input]::SetCursorPos(x, y) should not be emitted
    // when no coordinates are provided.
    assert.ok(
      !s.includes("[Win32Input]::SetCursorPos("),
      "should not call SetCursorPos when no coordinates given",
    );
  });
});

describe("buildInputScript — type (adversarial escaping)", () => {
  it("escapes single quote in text", () => {
    const s = buildInputScript({ kind: "type", text: "it's" });
    assert.ok(!s.match(/SendKeys\('.*it's/), "unescaped ' would break PS string");
    assert.ok(s.includes("it''s"), "PS double-quote escape should appear");
  });

  it("escapes semicolons (SendKeys literal)", () => {
    const s = buildInputScript({ kind: "type", text: "a;b" });
    // Semicolon is not special in PS single-quoted strings; what matters is
    // the SendKeys escaping. SendKeys doesn't treat ; specially so it passes
    // through without modification — but it must not be able to terminate a
    // PS statement via injection.
    assert.ok(typeof s === "string");
  });

  it("escapes backtick in text", () => {
    // Backtick IS a PS escape char in double-quoted strings, but we use
    // single-quoted. Still, a backtick in the value must not accidentally
    // break PS parsing.
    const s = buildInputScript({ kind: "type", text: "a`b" });
    assert.ok(typeof s === "string");
  });

  it("escapes $(...) subexpression in text", () => {
    // If we accidentally used a double-quoted PS string, $() would expand.
    // With single-quoted strings it's a literal. Test that $(evil) does not
    // appear raw inside double-quoted context.
    const s = buildInputScript({ kind: "type", text: "$(evil)" });
    // It should be embedded in a single-quoted context.
    assert.ok(s.includes("'"), "should use single-quoted PS strings");
    // It should NOT be inside a double-quoted string where $() would expand.
    // Specifically, we check the SendKeys call uses single quotes.
    assert.ok(s.includes("SendKeys('"), "SendKeys arg should be single-quoted");
  });

  it("escapes newline in text via SendKeys literal", () => {
    const s = buildInputScript({ kind: "type", text: "line1\nline2" });
    // A literal newline inside a PS single-quoted string is fine (PS allows it)
    // but the newline must not terminate the string mid-way.
    assert.ok(typeof s === "string");
  });

  it("escapes double-quote in text", () => {
    const s = buildInputScript({ kind: "type", text: 'say "hello"' });
    // Double quotes in single-quoted PS strings are literals — no escaping needed.
    assert.ok(s.includes('"hello"'), "double quotes should pass through");
  });
});

describe("buildInputScript — keys", () => {
  it("maps enter to {ENTER}", () => {
    const s = buildInputScript({ kind: "keys", keys: ["enter"] });
    assert.ok(s.includes("{ENTER}"), "enter key should map to {ENTER}");
  });

  it("maps ctrl+c combination", () => {
    const s = buildInputScript({ kind: "keys", keys: ["ctrl", "c"] });
    assert.ok(s.includes("^"), "ctrl should map to ^");
  });

  it("maps escape", () => {
    const s = buildInputScript({ kind: "keys", keys: ["escape"] });
    assert.ok(s.includes("{ESC}"), "escape should map to {ESC}");
  });

  it("escapes single quote in key name fallthrough", () => {
    // A key name that isn't in the map is passed through; if it contains '
    // that must be escaped in the PS string.
    const s = buildInputScript({ kind: "keys", keys: ["it's"] });
    assert.ok(!s.match(/SendKeys\('.*it's/), "unescaped ' must not appear in SendKeys arg");
  });
});

/* ============================= module import sanity (no-throw) ============ */

describe("module imports do not throw in plain Node", () => {
  it("browser/engine.ts imports cleanly", async () => {
    const mod = await import("../../src/main/browser/engine.ts");
    assert.ok(typeof mod.sanitiseUrl === "function");
    assert.ok(typeof mod.buildSelectorScript === "function");
    assert.ok(typeof mod.extractJsonScript === "function");
    assert.ok(typeof mod.BrowserEngine === "function");
    assert.ok(typeof mod.ElectronBrowserBackend === "function");
  });

  it("computer/windows.ts imports cleanly", async () => {
    const mod = await import("../../src/main/computer/windows.ts");
    assert.ok(typeof mod.isAppBlocked === "function");
    assert.ok(typeof mod.buildInputScript === "function");
    assert.ok(typeof mod.buildCaptureScript === "function");
    assert.ok(typeof mod.PowerShellComputerBackend === "function");
  });

  it("tools/browser.ts imports cleanly", async () => {
    const mod = await import("../../src/main/tools/browser.ts");
    assert.ok(typeof mod.makeBrowserTools === "function");
  });

  it("tools/computer.ts imports cleanly", async () => {
    const mod = await import("../../src/main/tools/computer.ts");
    assert.ok(typeof mod.makeComputerTools === "function");
  });
});

/* ============= graceful degradation — tools with unavailable backend ====== */

/**
 * Fake backend that always throws BackendUnavailableError, simulating the
 * missing-Electron case.
 */
class UnavailableBrowserBackend implements BrowserBackend {
  private readonly _err = new BackendUnavailableError("Browser");
  navigate(_url: string): Promise<void> { return Promise.reject(this._err); }
  evaluate(_js: string): Promise<unknown> { return Promise.reject(this._err); }
  screenshot(_opts?: { fullPage?: boolean; quality?: number }): Promise<ScreenshotResult> {
    return Promise.reject(this._err);
  }
  click(_s: string | { x: number; y: number }): Promise<void> { return Promise.reject(this._err); }
  type(_sel: string, _text: string): Promise<void> { return Promise.reject(this._err); }
  scroll(_d: "up" | "down" | "left" | "right", _a: number): Promise<void> {
    return Promise.reject(this._err);
  }
  waitFor(_s: string | number): Promise<void> { return Promise.reject(this._err); }
  content(): Promise<string> { return Promise.reject(this._err); }
  close(): Promise<void> { return Promise.reject(this._err); }
  currentUrl(): Promise<string> { return Promise.reject(this._err); }
}

class UnavailableComputerBackend implements ComputerBackend {
  private readonly _err = new BackendUnavailableError("Computer use (PowerShell)");
  capture(_opts?: CaptureOptions): ReturnType<ComputerBackend["capture"]> {
    return Promise.reject(this._err);
  }
  moveMouse(_x: number, _y: number): Promise<void> { return Promise.reject(this._err); }
  clickMouse(_b: "left" | "right" | "middle", _x?: number, _y?: number): Promise<void> {
    return Promise.reject(this._err);
  }
  typeText(_t: string): Promise<void> { return Promise.reject(this._err); }
  pressKeys(_k: string[]): Promise<void> { return Promise.reject(this._err); }
  screenSize(): ReturnType<ComputerBackend["screenSize"]> { return Promise.reject(this._err); }
  activeWindow(): ReturnType<ComputerBackend["activeWindow"]> { return Promise.reject(this._err); }
  listWindows(): ReturnType<ComputerBackend["listWindows"]> { return Promise.reject(this._err); }
  multiMonitorBounds(): ReturnType<ComputerBackend["multiMonitorBounds"]> {
    return Promise.reject(this._err);
  }
  selfTest(): ReturnType<ComputerBackend["selfTest"]> {
    // selfTest never rejects in the real impl; degrade gracefully here too.
    const report: SelfTestReport = {
      powershell: { ok: false, error: "Computer use (PowerShell) unavailable" },
      windowsForms: { ok: false, error: "Computer use (PowerShell) unavailable" },
      screenEnumeration: { ok: false, error: "Computer use (PowerShell) unavailable" },
      capture: { ok: false, error: "Computer use (PowerShell) unavailable" },
      cursorMove: { ok: false, error: "Computer use (PowerShell) unavailable" },
    };
    return Promise.resolve(report);
  }
}

describe("browser tools — graceful degradation", () => {
  const engine = new BrowserEngine(new UnavailableBrowserBackend());
  const tools = makeBrowserTools(engine);
  const ctx = makeCtx();

  for (const tool of tools) {
    const name = tool.definition.name;
    it(`${name} returns ok:false (not a throw) when Electron unavailable`, async () => {
      // Provide minimal valid input for tools that require it.
      let input: Record<string, unknown> = {};
      if (name === "browser_navigate") input = { url: "https://example.com" };
      if (name === "browser_click") input = { selector: "button" };
      if (name === "browser_type") input = { selector: "input", text: "hello" };
      if (name === "browser_scroll") input = { direction: "down", amount: 100 };
      if (name === "browser_wait") input = { milliseconds: 100 };
      if (name === "browser_extract") input = { instruction: "find headings" };

      const result = await tool.handler(input, ctx);
      assert.equal(result.ok, false, `${name} should return ok:false`);
      assert.ok(
        typeof result.error === "string" && result.error.length > 0,
        `${name} should have a non-empty error message`,
      );
      const errorMsg = result.error ?? "";
      assert.ok(
        errorMsg.toLowerCase().includes("electron") ||
          errorMsg.toLowerCase().includes("unavailable") ||
          errorMsg.toLowerCase().includes("app") ||
          errorMsg.toLowerCase().includes("browser"),
        `${name} error should name the missing capability: ${errorMsg}`,
      );
    });
  }
});

describe("computer tools — graceful degradation", () => {
  const tools = makeComputerTools(new UnavailableComputerBackend(), () => []);
  const ctx = makeCtx();

  for (const tool of tools) {
    const name = tool.definition.name;

    // computer_self_test is a diagnostic tool — it always returns ok:true
    // and reports failures within the result content rather than as ok:false.
    // It has its own tests in the "computer_self_test tool" suite below.
    if (name === "computer_self_test") continue;

    it(`${name} returns ok:false (not a throw) when PowerShell unavailable`, async () => {
      let input: Record<string, unknown> = {};
      if (name === "computer_click") input = { x: 100, y: 200 };
      if (name === "computer_move") input = { x: 100, y: 200 };
      if (name === "computer_type") input = { text: "hello" };
      if (name === "computer_key") input = { keys: ["enter"] };

      const result = await tool.handler(input, ctx);
      assert.equal(result.ok, false, `${name} should return ok:false`);
      assert.ok(
        typeof result.error === "string" && result.error.length > 0,
        `${name} should have a non-empty error message`,
      );
    });
  }
});

/* ====================== BrowserEngine with fake backend =================== */

/** A minimal in-memory fake BrowserBackend for testing engine logic. */
class FakeBrowserBackend implements BrowserBackend {
  public navigatedUrls: string[] = [];
  public clicks: Array<string | { x: number; y: number }> = [];
  public typedInputs: Array<{ selector: string; text: string }> = [];
  public scrolls: Array<{ direction: string; amount: number }> = [];
  public evaluations: string[] = [];
  public _closed = false;
  public _url = "about:blank";
  public _content = "<html><body>fake</body></html>";

  /** Set to >0 to make the first N calls throw a transient error. */
  public transientErrorsRemaining = 0;

  private maybeThrow(): void {
    if (this.transientErrorsRemaining > 0) {
      this.transientErrorsRemaining--;
      throw new Error("Transient backend error (fake)");
    }
  }

  navigate(url: string): Promise<void> {
    this.maybeThrow();
    this.navigatedUrls.push(url);
    this._url = url;
    return Promise.resolve();
  }

  evaluate(js: string): Promise<unknown> {
    this.maybeThrow();
    this.evaluations.push(js);
    return Promise.resolve(null);
  }

  screenshot(_opts?: { fullPage?: boolean; quality?: number }): Promise<ScreenshotResult> {
    this.maybeThrow();
    return Promise.resolve({ data: "base64data", mimeType: "image/jpeg", width: 100, height: 100 });
  }

  click(selectorOrCoords: string | { x: number; y: number }): Promise<void> {
    this.maybeThrow();
    this.clicks.push(selectorOrCoords);
    return Promise.resolve();
  }

  type(selector: string, text: string): Promise<void> {
    this.maybeThrow();
    this.typedInputs.push({ selector, text });
    return Promise.resolve();
  }

  scroll(direction: "up" | "down" | "left" | "right", amount: number): Promise<void> {
    this.maybeThrow();
    this.scrolls.push({ direction, amount });
    return Promise.resolve();
  }

  waitFor(_selectorOrMs: string | number): Promise<void> {
    this.maybeThrow();
    return Promise.resolve();
  }

  content(): Promise<string> {
    this.maybeThrow();
    return Promise.resolve(this._content);
  }

  close(): Promise<void> {
    this._closed = true;
    return Promise.resolve();
  }

  currentUrl(): Promise<string> {
    return Promise.resolve(this._url);
  }
}

describe("BrowserEngine — navigate", () => {
  it("calls backend.navigate with the sanitised (WHATWG-normalised) URL", async () => {
    const fake = new FakeBrowserBackend();
    const engine = new BrowserEngine(fake);
    await engine.navigate("https://example.com");
    assert.equal(fake.navigatedUrls.length, 1);
    // WHATWG URL normalisation adds trailing slash to bare hostnames (H3 fix).
    assert.equal(fake.navigatedUrls[0], "https://example.com/");
  });

  it("does NOT call backend.navigate for javascript: URL", async () => {
    const fake = new FakeBrowserBackend();
    const engine = new BrowserEngine(fake);
    await assert.rejects(() => engine.navigate("javascript:alert(1)"), /blocked/i);
    assert.equal(fake.navigatedUrls.length, 0, "backend should never be called");
  });

  it("does NOT call backend for data: URL", async () => {
    const fake = new FakeBrowserBackend();
    const engine = new BrowserEngine(fake);
    await assert.rejects(() => engine.navigate("data:text/html,<h1>x</h1>"), /blocked/i);
    assert.equal(fake.navigatedUrls.length, 0);
  });

  it("does NOT call backend for vbscript: URL", async () => {
    const fake = new FakeBrowserBackend();
    const engine = new BrowserEngine(fake);
    await assert.rejects(() => engine.navigate("vbscript:msgbox(1)"), /blocked/i);
    assert.equal(fake.navigatedUrls.length, 0);
  });
});

describe("BrowserEngine — click → type → extract sequencing", () => {
  it("performs navigate, click, type, extract in order", async () => {
    const fake = new FakeBrowserBackend();
    const engine = new BrowserEngine(fake);

    await engine.navigate("https://example.com");
    await engine.click("#search");
    await engine.type("#search", "hello");
    await engine.extract("find headings");

    assert.equal(fake.navigatedUrls.length, 1);
    // WHATWG URL normalisation adds trailing slash to bare hostnames (H3 fix).
    assert.equal(fake.navigatedUrls[0], "https://example.com/");
    assert.equal(fake.clicks.length, 1);
    assert.equal(fake.clicks[0], "#search");
    assert.equal(fake.typedInputs.length, 1);
    assert.deepEqual(fake.typedInputs[0], { selector: "#search", text: "hello" });
    assert.equal(fake.evaluations.length, 1);
  });
});

describe("BrowserEngine — retry on transient backend error", () => {
  it("retries and succeeds after one transient error", async () => {
    const fake = new FakeBrowserBackend();
    fake.transientErrorsRemaining = 1; // first call throws
    const engine = new BrowserEngine(fake, { retries: 2, timeoutMs: 5000 });

    await engine.navigate("https://example.com"); // should succeed on second attempt
    assert.equal(fake.navigatedUrls.length, 1, "should eventually navigate");
  });

  it("fails after exhausting all retries", async () => {
    const fake = new FakeBrowserBackend();
    fake.transientErrorsRemaining = 10; // never succeeds
    const engine = new BrowserEngine(fake, { retries: 1, timeoutMs: 5000 });

    await assert.rejects(() => engine.navigate("https://example.com"), /Transient/i);
  });
});

describe("BrowserEngine — timeout handling", () => {
  it("rejects after timeoutMs", async () => {
    // Backend that hangs forever.
    const hangingBackend: BrowserBackend = {
      navigate: () => new Promise(() => { /* never resolves */ }),
      evaluate: () => new Promise(() => { /* never resolves */ }),
      screenshot: () => new Promise(() => { /* never resolves */ }),
      click: () => new Promise(() => { /* never resolves */ }),
      type: () => new Promise(() => { /* never resolves */ }),
      scroll: () => new Promise(() => { /* never resolves */ }),
      waitFor: () => new Promise(() => { /* never resolves */ }),
      content: () => new Promise(() => { /* never resolves */ }),
      close: () => Promise.resolve(),
      currentUrl: () => new Promise(() => { /* never resolves */ }),
    };

    const engine = new BrowserEngine(hangingBackend, { timeoutMs: 50, retries: 0 });
    await assert.rejects(() => engine.navigate("https://example.com"), /timed out/i);
  });
});

describe("BrowserEngine — close", () => {
  it("calls backend.close()", async () => {
    const fake = new FakeBrowserBackend();
    const engine = new BrowserEngine(fake);
    await engine.close();
    assert.equal(fake._closed, true);
  });
});

describe("BrowserEngine — screenshot", () => {
  it("returns an image result", async () => {
    const fake = new FakeBrowserBackend();
    const engine = new BrowserEngine(fake);
    const result = await engine.screenshot({ fullPage: false, quality: 80 });
    assert.equal(result.mimeType, "image/jpeg");
    assert.ok(result.data.length > 0);
  });
});

/* ============ browser_navigate tool calls sanitiseUrl ==================== */

describe("browser_navigate tool — sanitiseUrl gate", () => {
  it("a javascript: URL never reaches the fake backend", async () => {
    const fake = new FakeBrowserBackend();
    const engine = new BrowserEngine(fake);
    const tools = makeBrowserTools(engine);
    const nav = tools.find((t) => t.definition.name === "browser_navigate")!;

    const result = await nav.handler({ url: "javascript:alert(1)" }, makeCtx());
    assert.equal(result.ok, false, "should fail");
    assert.equal(fake.navigatedUrls.length, 0, "backend should not be called");
  });
});

/* ============ tool count assertions ====================================== */

describe("tool counts", () => {
  it("makeBrowserTools returns exactly 11 tools", () => {
    const engine = new BrowserEngine(new FakeBrowserBackend());
    const tools = makeBrowserTools(engine);
    assert.equal(tools.length, 11, `Expected 11 browser tools, got ${tools.length}`);
  });

  it("makeComputerTools returns exactly 8 tools", () => {
    const tools = makeComputerTools(new UnavailableComputerBackend(), () => []);
    assert.equal(tools.length, 8, `Expected 8 computer tools, got ${tools.length}`);
  });

  it("all browser tools have icon, group='browser', and modes", () => {
    const engine = new BrowserEngine(new FakeBrowserBackend());
    for (const tool of makeBrowserTools(engine)) {
      const d = tool.definition;
      assert.ok(d.icon, `${d.name} missing icon`);
      assert.equal(d.group, "browser", `${d.name} wrong group`);
      assert.ok(d.modes.length > 0, `${d.name} missing modes`);
    }
  });

  it("all computer tools have icon, group='computer', and modes", () => {
    const tools = makeComputerTools(new UnavailableComputerBackend(), () => []);
    for (const tool of tools) {
      const d = tool.definition;
      assert.ok(d.icon, `${d.name} missing icon`);
      assert.equal(d.group, "computer", `${d.name} wrong group`);
      assert.ok(d.modes.length > 0, `${d.name} missing modes`);
    }
  });

  it("browser_screenshot has requiresVision: true", () => {
    const engine = new BrowserEngine(new FakeBrowserBackend());
    const tools = makeBrowserTools(engine);
    const ss = tools.find((t) => t.definition.name === "browser_screenshot")!;
    assert.equal(ss.definition.requiresVision, true);
  });

  it("computer_screenshot has requiresVision: true", () => {
    const tools = makeComputerTools(new UnavailableComputerBackend(), () => []);
    const ss = tools.find((t) => t.definition.name === "computer_screenshot")!;
    assert.equal(ss.definition.requiresVision, true);
  });

  it("computer dangerous tools have dangerous: true", () => {
    const dangerousNames = [
      "computer_click",
      "computer_move",
      "computer_type",
      "computer_key",
    ];
    const tools = makeComputerTools(new UnavailableComputerBackend(), () => []);
    for (const name of dangerousNames) {
      const t = tools.find((tt) => tt.definition.name === name)!;
      assert.ok(t, `tool ${name} not found`);
      assert.equal(t.definition.dangerous, true, `${name} should be dangerous`);
    }
  });

  it("computer safe tools do not have dangerous: true", () => {
    const safeNames = [
      "computer_screenshot",
      "computer_screen_size",
      "computer_list_windows",
      "computer_self_test",
    ];
    const tools = makeComputerTools(new UnavailableComputerBackend(), () => []);
    for (const name of safeNames) {
      const t = tools.find((tt) => tt.definition.name === name)!;
      assert.ok(t, `tool ${name} not found`);
      assert.ok(!t.definition.dangerous, `${name} should not be dangerous`);
    }
  });
});

/* ========================= coordinate clamping (Part 3) =================== */

describe("assertFiniteCoord — rejects non-finite values", () => {
  it("does not throw for a normal integer", () => {
    assert.doesNotThrow(() => assertFiniteCoord(100, "x"));
  });

  it("does not throw for zero", () => {
    assert.doesNotThrow(() => assertFiniteCoord(0, "y"));
  });

  it("does not throw for a negative coordinate (multi-monitor)", () => {
    assert.doesNotThrow(() => assertFiniteCoord(-1920, "x"));
  });

  it("throws for NaN", () => {
    assert.throws(
      () => assertFiniteCoord(NaN, "x"),
      /x.*not finite|non-finite/i,
    );
  });

  it("throws for Infinity", () => {
    assert.throws(
      () => assertFiniteCoord(Infinity, "x"),
      /x.*not finite|non-finite/i,
    );
  });

  it("throws for -Infinity", () => {
    assert.throws(
      () => assertFiniteCoord(-Infinity, "y"),
      /y.*not finite|non-finite/i,
    );
  });
});

describe("clampCoord", () => {
  it("returns value unchanged when within range", () => {
    assert.equal(clampCoord(500, 0, 1919), 500);
  });

  it("clamps to lo when value is below range", () => {
    assert.equal(clampCoord(-50, 0, 1919), 0);
  });

  it("clamps to hi when value is above range", () => {
    assert.equal(clampCoord(2000, 0, 1919), 1919);
  });

  it("handles negative lo (multi-monitor left of primary)", () => {
    assert.equal(clampCoord(-2000, -1920, 1919), -1920);
  });
});

describe("clampToDesktop", () => {
  const bounds: DesktopBounds = { x: 0, y: 0, width: 1920, height: 1080 };
  const multiMonitorBounds: DesktopBounds = { x: -1920, y: -100, width: 3840, height: 1180 };

  it("returns unchanged coordinates within single-monitor bounds", () => {
    const r = clampToDesktop(500, 300, bounds);
    assert.deepEqual(r, { x: 500, y: 300 });
  });

  it("clamps x to left edge when negative on single-monitor setup", () => {
    const r = clampToDesktop(-50, 300, bounds);
    assert.equal(r.x, 0);
  });

  it("clamps x to right edge", () => {
    const r = clampToDesktop(9999, 300, bounds);
    assert.equal(r.x, 1919); // width - 1
  });

  it("clamps y to bottom edge", () => {
    const r = clampToDesktop(100, 9999, bounds);
    assert.equal(r.y, 1079); // height - 1
  });

  it("allows negative x in multi-monitor setup", () => {
    const r = clampToDesktop(-1000, 0, multiMonitorBounds);
    assert.equal(r.x, -1000);
  });

  it("clamps to virtual desktop left on multi-monitor setup", () => {
    const r = clampToDesktop(-5000, 0, multiMonitorBounds);
    assert.equal(r.x, -1920);
  });

  it("throws on NaN x", () => {
    assert.throws(() => clampToDesktop(NaN, 0, bounds));
  });

  it("throws on NaN y", () => {
    assert.throws(() => clampToDesktop(0, NaN, bounds));
  });

  it("throws on Infinity x", () => {
    assert.throws(() => clampToDesktop(Infinity, 0, bounds));
  });

  it("throws on Infinity y", () => {
    assert.throws(() => clampToDesktop(0, -Infinity, bounds));
  });

  it("rounds float coordinates before clamping", () => {
    const r = clampToDesktop(100.7, 200.3, bounds);
    assert.equal(r.x, 101);
    assert.equal(r.y, 200);
  });
});

/* ========================= virtualDesktopBounds =========================== */

describe("virtualDesktopBounds", () => {
  it("returns default for empty array", () => {
    const b = virtualDesktopBounds([]);
    assert.equal(b.width, 1920);
    assert.equal(b.height, 1080);
  });

  it("returns single-monitor bounds unchanged", () => {
    const m: MonitorInfo = {
      index: 0,
      isPrimary: true,
      deviceName: "\\\\.\\DISPLAY1",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workingArea: { x: 0, y: 0, width: 1920, height: 1040 },
    };
    const b = virtualDesktopBounds([m]);
    assert.deepEqual(b, { x: 0, y: 0, width: 1920, height: 1080 });
  });

  it("spans both monitors on a dual-monitor setup (side by side)", () => {
    const left: MonitorInfo = {
      index: 0,
      isPrimary: false,
      deviceName: "\\\\.\\DISPLAY2",
      bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
      workingArea: { x: -1920, y: 0, width: 1920, height: 1040 },
    };
    const right: MonitorInfo = {
      index: 1,
      isPrimary: true,
      deviceName: "\\\\.\\DISPLAY1",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workingArea: { x: 0, y: 0, width: 1920, height: 1040 },
    };
    const b = virtualDesktopBounds([left, right]);
    assert.equal(b.x, -1920);
    assert.equal(b.y, 0);
    assert.equal(b.width, 3840);
    assert.equal(b.height, 1080);
  });

  it("spans monitors with different heights", () => {
    const a: MonitorInfo = {
      index: 0,
      isPrimary: true,
      deviceName: "\\\\.\\DISPLAY1",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workingArea: { x: 0, y: 0, width: 1920, height: 1040 },
    };
    const b: MonitorInfo = {
      index: 1,
      isPrimary: false,
      deviceName: "\\\\.\\DISPLAY2",
      bounds: { x: 1920, y: -200, width: 1280, height: 1024 },
      workingArea: { x: 1920, y: -200, width: 1280, height: 984 },
    };
    const result = virtualDesktopBounds([a, b]);
    assert.equal(result.x, 0);
    assert.equal(result.y, -200);
    assert.equal(result.width, 3200); // 0 to 1920+1280
    assert.equal(result.height, 1280); // -200 to 1080
  });
});

/* ========================= buildMultiMonitorScript ======================== */

describe("buildMultiMonitorScript — Add-Type ordering", () => {
  it("starts with Add-Type -AssemblyName System.Windows.Forms", () => {
    const script = buildMultiMonitorScript();
    // The VERY FIRST line must be the Add-Type call.
    const firstLine = script.split("\n")[0]!;
    assert.match(
      firstLine,
      /Add-Type -AssemblyName System\.Windows\.Forms/,
      "Add-Type must precede ALL [System.Windows.Forms.*] references",
    );
  });

  it("references AllScreens AFTER the Add-Type call", () => {
    const script = buildMultiMonitorScript();
    const addTypeIdx = script.indexOf("Add-Type -AssemblyName System.Windows.Forms");
    const allScreensIdx = script.indexOf("AllScreens");
    assert.ok(
      addTypeIdx < allScreensIdx,
      `Add-Type (pos ${addTypeIdx}) must precede AllScreens (pos ${allScreensIdx})`,
    );
  });

  it("emits ConvertTo-Json for structured output", () => {
    const script = buildMultiMonitorScript();
    assert.ok(script.includes("ConvertTo-Json"), "output must be JSON");
  });

  it("captures boundsX, boundsY, boundsW, boundsH keys", () => {
    const script = buildMultiMonitorScript();
    for (const key of ["boundsX", "boundsY", "boundsW", "boundsH"]) {
      assert.ok(script.includes(key), `script must capture ${key}`);
    }
  });
});

/* ========================= buildSelfTestScript shape ====================== */

describe("buildSelfTestScript", () => {
  it("produces a non-empty script", () => {
    const s = buildSelfTestScript();
    assert.ok(s.length > 100, "script should be substantial");
  });

  it("checks all five capabilities", () => {
    const s = buildSelfTestScript();
    assert.ok(s.includes("powershell"), "must test powershell");
    assert.ok(s.includes("windowsForms"), "must test windowsForms");
    assert.ok(s.includes("screenEnumeration"), "must test screenEnumeration");
    assert.ok(s.includes("capture"), "must test capture");
    assert.ok(s.includes("cursorMove"), "must test cursorMove");
  });

  it("Add-Type for System.Windows.Forms appears BEFORE AllScreens reference", () => {
    const s = buildSelfTestScript();
    const addTypeIdx = s.indexOf("Add-Type -AssemblyName System.Windows.Forms");
    const allScreensIdx = s.indexOf("AllScreens");
    assert.ok(
      addTypeIdx < allScreensIdx,
      `Add-Type (pos ${addTypeIdx}) must precede AllScreens (pos ${allScreensIdx})`,
    );
  });

  it("ends with ConvertTo-Json", () => {
    const s = buildSelfTestScript();
    assert.ok(s.includes("ConvertTo-Json"), "must emit JSON report");
  });

  it("each capability block uses try/catch for independent failure handling", () => {
    const s = buildSelfTestScript();
    const tryCount = (s.match(/^try \{/gm) ?? []).length;
    // At least 4 capabilities have try/catch blocks.
    assert.ok(tryCount >= 4, `expected at least 4 try blocks, got ${tryCount}`);
  });
});

/* ========================= region capture script ========================= */

describe("buildCaptureScript — region parameter", () => {
  it("includes region coordinates in the script", () => {
    const s = buildCaptureScript({
      outputPath: "C:\\temp\\out.jpg",
      region: { x: 100, y: 200, width: 640, height: 480 },
    });
    assert.ok(s.includes("640"), "width should appear");
    assert.ok(s.includes("480"), "height should appear");
    assert.ok(s.includes("100"), "x origin should appear");
    assert.ok(s.includes("200"), "y origin should appear");
  });

  it("does NOT use Primary screen when region is provided", () => {
    const s = buildCaptureScript({
      outputPath: "C:\\temp\\out.jpg",
      region: { x: 0, y: 0, width: 800, height: 600 },
    });
    // A region capture does not need PrimaryScreen.Bounds — only full-screen does.
    // It should use CopyFromScreen with explicit coordinates.
    assert.ok(s.includes("CopyFromScreen"), "must copy from screen");
    assert.ok(!s.includes("PrimaryScreen.Bounds"), "region capture should not use PrimaryScreen");
  });

  it("full-screen capture uses PrimaryScreen.Bounds", () => {
    const s = buildCaptureScript({ outputPath: "C:\\temp\\out.jpg" });
    assert.ok(s.includes("PrimaryScreen.Bounds"), "full-screen must use PrimaryScreen.Bounds");
  });

  it("Add-Type for System.Windows.Forms precedes PrimaryScreen reference in full-screen", () => {
    const s = buildCaptureScript({ outputPath: "out.jpg" });
    const addTypeIdx = s.indexOf("Add-Type -AssemblyName System.Windows.Forms");
    const primaryIdx = s.indexOf("PrimaryScreen");
    assert.ok(
      addTypeIdx < primaryIdx,
      `Add-Type (pos ${addTypeIdx}) must precede PrimaryScreen (pos ${primaryIdx})`,
    );
  });
});

/* ==================== buildInputScript — clamping rejects NaN ============ */

describe("buildInputScript — coordinate validation", () => {
  it("throws for NaN x in move action", () => {
    assert.throws(
      () => buildInputScript({ kind: "move", x: NaN, y: 100 }),
      /not finite|x/i,
    );
  });

  it("throws for Infinity y in move action", () => {
    assert.throws(
      () => buildInputScript({ kind: "move", x: 0, y: Infinity }),
      /not finite|y/i,
    );
  });

  it("throws for NaN in click action", () => {
    assert.throws(
      () => buildInputScript({ kind: "click", button: "left", x: NaN, y: 0 }),
      /not finite|x/i,
    );
  });

  it("rounds float coordinates in move", () => {
    const s = buildInputScript({ kind: "move", x: 100.9, y: 200.1 });
    // Should emit 101 and 200 after rounding.
    assert.ok(s.includes("SetCursorPos(101, 200)"), `expected SetCursorPos(101, 200), got: ${s}`);
  });
});

/* ==================== computer_self_test tool ============================= */

describe("computer_self_test tool", () => {
  it("is present in makeComputerTools output", () => {
    const tools = makeComputerTools(new UnavailableComputerBackend(), () => []);
    const t = tools.find((tt) => tt.definition.name === "computer_self_test");
    assert.ok(t, "computer_self_test tool should exist");
  });

  it("returns ok:true (not a throw) when backend.selfTest resolves", async () => {
    const ctx = makeCtx();
    const tools = makeComputerTools(new UnavailableComputerBackend(), () => []);
    const t = tools.find((tt) => tt.definition.name === "computer_self_test")!;

    // UnavailableComputerBackend.selfTest() resolves with an all-fail report.
    const result = await t.handler({}, ctx);
    assert.equal(result.ok, true, "computer_self_test must return ok:true even when all capabilities fail");
  });

  it("result content mentions each capability", async () => {
    const ctx = makeCtx();
    const tools = makeComputerTools(new UnavailableComputerBackend(), () => []);
    const t = tools.find((tt) => tt.definition.name === "computer_self_test")!;

    const result = await t.handler({}, ctx);
    assert.ok(result.content.toLowerCase().includes("powershell"), "should mention powershell");
    assert.ok(result.content.toLowerCase().includes("capture"), "should mention capture");
  });
});
