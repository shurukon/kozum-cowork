/**
 * Linux/X11 computer-use backend.
 *
 * The Windows implementation remains PowerShell-based. This backend provides
 * the same ComputerBackend contract on Linux desktops (including Xvfb) using
 * xdotool for input/window control and ffmpeg's x11grab for screenshots.
 * All commands use execFile rather than a shell so model-provided values never
 * become shell syntax.
 */

import { BackendUnavailableError } from "../browser/engine.ts";
import type {
  CaptureOptions,
  CaptureResult,
  ComputerBackend,
  MonitorInfo,
  MouseButton,
  ScreenSize,
  SelfTestReport,
  WindowInfo,
} from "./windows.ts";

interface ExecResult {
  stdout: string | Buffer;
  stderr: string | Buffer;
}

type ExecFile = (
  file: string,
  args: string[],
  options?: { timeout?: number; maxBuffer?: number; encoding?: BufferEncoding | "buffer" },
) => Promise<ExecResult>;

const KEY_ALIASES: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  enter: "Return",
  return: "Return",
  backspace: "BackSpace",
  delete: "Delete",
  tab: "Tab",
  space: "space",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  shift: "shift",
  win: "super",
  meta: "super",
  command: "super",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  pageup: "Page_Up",
  pagedown: "Page_Down",
};

function normaliseKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("computer_key received an empty key");
  const lower = trimmed.toLowerCase();
  return KEY_ALIASES[lower] ?? (/^f(?:[1-9]|1[0-2])$/i.test(trimmed) ? trimmed.toUpperCase() : trimmed);
}

function parseDimensions(text: string): ScreenSize {
  const width = /^\s*Width:\s*(\d+)/im.exec(text)?.[1];
  const height = /^\s*Height:\s*(\d+)/im.exec(text)?.[1];
  const dimensions = /dimensions:\s*(\d+)\s*x\s*(\d+)/i.exec(text);
  if (width && height) return { width: Number(width), height: Number(height) };
  if (dimensions) return { width: Number(dimensions[1]), height: Number(dimensions[2]) };
  throw new Error(`Could not determine X11 screen size from: ${text.slice(0, 200)}`);
}

function parseShellValue(text: string, key: string): number | null {
  const match = new RegExp(`^${key}=(\\d+)`, "m").exec(text);
  return match ? Number(match[1]) : null;
}

export class X11ComputerBackend implements ComputerBackend {
  private exec: ExecFile | null = null;
  private detected = false;

  private async getExec(): Promise<ExecFile> {
    if (this.exec) return this.exec;
    if (this.detected) throw new BackendUnavailableError("Computer use (X11)");
    this.detected = true;
    try {
      const cp = await import("node:child_process");
      const util = await import("node:util");
      this.exec = util.promisify(cp.execFile) as unknown as ExecFile;
      await this.exec("xdotool", ["version"], { timeout: 5_000 });
      return this.exec;
    } catch (error) {
      this.exec = null;
      const reason = error instanceof Error ? `: ${error.message}` : "";
      throw new BackendUnavailableError(`Computer use (X11/xdotool)${reason}`);
    }
  }

  private async run(file: string, args: string[], timeout = 15_000): Promise<string> {
    const exec = await this.getExec();
    const result = await exec(file, args, { timeout, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
    const stdout = typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf8");
    const stderr = typeof result.stderr === "string" ? result.stderr : result.stderr.toString("utf8");
    if (stderr.trim() && /error|failed|cannot|unable/i.test(stderr)) {
      throw new Error(`${file}: ${stderr.trim()}`);
    }
    return stdout.trim();
  }

  async screenSize(): Promise<ScreenSize> {
    const output = await this.run("xwininfo", ["-root"]);
    return parseDimensions(output);
  }

  async capture(opts?: CaptureOptions): Promise<CaptureResult> {
    const size = await this.screenSize();
    const region = opts?.region;
    const width = region?.width ?? size.width;
    const height = region?.height ?? size.height;
    const x = region?.x ?? 0;
    const y = region?.y ?? 0;
    if (![width, height, x, y].every(Number.isFinite) || width <= 0 || height <= 0) {
      throw new Error("Invalid screenshot region");
    }
    const quality = Math.max(1, Math.min(100, Math.round(opts?.quality ?? 85)));
    const qv = Math.max(2, Math.min(31, Math.round(31 - quality * 0.29)));
    const display = process.env.DISPLAY ?? ":0";
    const exec = await this.getExec();
    const result = await exec(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "x11grab",
        "-video_size",
        `${Math.round(width)}x${Math.round(height)}`,
        "-i",
        `${display}+${Math.round(x)},${Math.round(y)}`,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-q:v",
        String(qv),
        "pipe:1",
      ],
      { timeout: 20_000, maxBuffer: 16 * 1024 * 1024, encoding: "buffer" },
    );
    const stderr = typeof result.stderr === "string" ? result.stderr : result.stderr.toString("utf8");
    if (stderr.trim() && /error|failed|cannot|unable/i.test(stderr)) {
      throw new Error(`ffmpeg: ${stderr.trim()}`);
    }
    if (!result.stdout) throw new Error(`ffmpeg returned an empty screenshot`);
    const bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout, "binary");
    return {
      data: bytes.toString("base64"),
      mimeType: "image/jpeg",
      width: Math.round(width),
      height: Math.round(height),
    };
  }

  async activeWindow(): Promise<WindowInfo | null> {
    const id = await this.run("xdotool", ["getactivewindow"]).catch(() => "");
    if (!id) return null;
    return this.windowInfo(Number(id));
  }

  private async windowInfo(handle: number): Promise<WindowInfo> {
    const [title, pid] = await Promise.all([
      this.run("xdotool", ["getwindowname", String(handle)]).catch(() => ""),
      this.run("xdotool", ["getwindowpid", String(handle)]).catch(() => "0"),
    ]);
    let processName = "unknown";
    if (pid && pid !== "0") {
      processName = await this.run("ps", ["-p", pid, "-o", "comm="]).catch(() => "unknown");
    }
    return { handle, title, processName, visible: true };
  }

  async listWindows(): Promise<WindowInfo[]> {
    const ids = await this.run("xdotool", ["search", "--onlyvisible", "--name", "."]).catch(() => "");
    const windows: WindowInfo[] = [];
    for (const rawId of ids.split(/\s+/).filter(Boolean)) {
      const id = Number(rawId);
      if (!Number.isSafeInteger(id)) continue;
      windows.push(await this.windowInfo(id));
    }
    return windows;
  }

  async multiMonitorBounds(): Promise<MonitorInfo[]> {
    const size = await this.screenSize();
    return [{
      index: 0,
      isPrimary: true,
      deviceName: process.env.DISPLAY ?? ":0",
      bounds: { x: 0, y: 0, width: size.width, height: size.height },
      workingArea: { x: 0, y: 0, width: size.width, height: size.height },
    }];
  }

  async moveMouse(x: number, y: number): Promise<void> {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Mouse coordinates must be finite");
    const size = await this.screenSize();
    const safeX = Math.max(0, Math.min(size.width - 1, Math.round(x)));
    const safeY = Math.max(0, Math.min(size.height - 1, Math.round(y)));
    await this.run("xdotool", ["mousemove", String(safeX), String(safeY)]);
  }

  async clickMouse(button: MouseButton, x?: number, y?: number): Promise<void> {
    if (x !== undefined || y !== undefined) {
      if (x === undefined || y === undefined) throw new Error("Both x and y are required together");
      await this.moveMouse(x, y);
    }
    const buttonCode = button === "left" ? "1" : button === "middle" ? "2" : "3";
    await this.run("xdotool", ["click", "--clearmodifiers", buttonCode]);
  }

  async typeText(text: string): Promise<void> {
    await this.run("xdotool", ["type", "--clearmodifiers", "--delay", "1", "--", text], 30_000);
  }

  async pressKeys(keys: string[]): Promise<void> {
    if (!Array.isArray(keys) || keys.length === 0) throw new Error("At least one key is required");
    const chord = keys.map(normaliseKey).join("+");
    await this.run("xdotool", ["key", "--clearmodifiers", chord]);
  }

  async selfTest(): Promise<SelfTestReport> {
    const report: SelfTestReport = {
      powershell: { ok: true, version: "X11 backend" },
      windowsForms: { ok: true, error: "Not applicable on Linux; X11 is active." },
      screenEnumeration: { ok: false },
      capture: { ok: false },
      cursorMove: { ok: false },
    };
    try {
      const monitors = await this.multiMonitorBounds();
      report.screenEnumeration = { ok: monitors.length > 0, count: monitors.length };
    } catch (error) {
      report.screenEnumeration = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      await this.capture({ region: { x: 0, y: 0, width: 1, height: 1 }, quality: 70 });
      report.capture = { ok: true };
    } catch (error) {
      report.capture = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      const loc = await this.run("xdotool", ["getmouselocation", "--shell"]);
      const x = parseShellValue(loc, "X");
      const y = parseShellValue(loc, "Y");
      if (x === null || y === null) throw new Error("xdotool did not return cursor coordinates");
      await this.moveMouse(x, y);
      report.cursorMove = { ok: true };
    } catch (error) {
      report.cursorMove = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return report;
  }
}

export function makeComputerBackend(): ComputerBackend {
  if (process.platform === "linux" && process.env.DISPLAY) return new X11ComputerBackend();
  // Windows is intentionally lazy and only probes PowerShell when a tool runs.
  // Importing it here keeps the platform decision in one place.
  throw new BackendUnavailableError("Computer use backend");
}
