/**
 * Windows computer-use backend.
 *
 * Strategy: zero native modules — all OS interaction goes through PowerShell
 * scripts so there is no node-gyp, no Visual Studio Build Tools dependency,
 * and no installer that can fail to compile native code.
 *
 * Design:
 *   - ComputerBackend: injectable interface (testable seam).
 *   - PowerShellComputerBackend: concrete impl; runs PowerShell via child_process.
 *   - buildCaptureScript / buildInputScript: pure functions returning PS text.
 *   - isAppBlocked: pure, case-insensitive blocklist check.
 *   - BackendUnavailableError re-exported for callers that handle it uniformly.
 *
 * HARD RULE: child_process is imported lazily inside PowerShellComputerBackend
 * so the module loads cleanly in any environment.
 */

export { BackendUnavailableError } from "../browser/engine.ts";
import { BackendUnavailableError } from "../browser/engine.ts";

/* ============================================================ interfaces === */

export interface CaptureOptions {
  /** Region to capture. When omitted, captures the full primary screen. */
  region?: { x: number; y: number; width: number; height: number };
  /** JPEG quality 1-100. Default: 85. */
  quality?: number;
}

export interface CaptureResult {
  /** base64-encoded JPEG. */
  data: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
}

export type MouseButton = "left" | "right" | "middle";

export interface WindowInfo {
  handle: number;
  title: string;
  processName: string;
  visible: boolean;
}

export interface ScreenSize {
  width: number;
  height: number;
}

export interface ComputerBackend {
  capture(opts?: CaptureOptions): Promise<CaptureResult>;
  moveMouse(x: number, y: number): Promise<void>;
  clickMouse(button: MouseButton, x?: number, y?: number): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKeys(keys: string[]): Promise<void>;
  screenSize(): Promise<ScreenSize>;
  activeWindow(): Promise<WindowInfo | null>;
  listWindows(): Promise<WindowInfo[]>;
}

/* ======================================= pure helper — isAppBlocked ========= */

/**
 * Strip a trailing `.exe` (case-insensitive) from an executable name so we
 * can compare names returned by `Get-Process` (which omits the extension)
 * against the default blocklist entries (which include `.exe`).
 */
function stripExeExt(name: string): string {
  return name.toLowerCase().endsWith(".exe") ? name.slice(0, -4) : name;
}

/**
 * Case-insensitive check whether an executable name matches any entry in the
 * blocklist.  Both the exe name and blocklist entries have their `.exe`
 * extension stripped before comparison so that `"keepass"` (as returned by
 * PowerShell's `Get-Process .Name`) correctly matches `"keepass.exe"` in the
 * defaults list.
 */
export function isAppBlocked(exeName: string, blocklist: string[]): boolean {
  const normalised = stripExeExt(exeName).toLowerCase();
  for (const entry of blocklist) {
    if (stripExeExt(entry).toLowerCase() === normalised) return true;
  }
  return false;
}

/* ===================================== pure helper — PowerShell escaping ===== */

/**
 * Escape a string for embedding inside a PowerShell single-quoted string.
 *
 * PowerShell single-quoted strings treat ' as the only special character
 * (doubled to escape). No variable expansion, no subexpressions.
 *
 * This is the ONLY correct escaping for untrusted values in PS strings.
 * Never embed untrusted text in double-quoted strings or in command
 * arguments without this function.
 */
export function escapePsSingleQuoted(value: string): string {
  // In PS single-quoted strings, a literal ' is written as ''
  return value.replace(/'/g, "''");
}

/* ===================================== pure helper — buildCaptureScript ===== */

export interface CaptureScriptOptions {
  region?: { x: number; y: number; width: number; height: number };
  quality?: number;
  /** Absolute path to write the JPEG to. */
  outputPath: string;
}

/**
 * Build the PowerShell script that captures the screen (or a region) to a
 * JPEG file at outputPath, using System.Drawing.
 *
 * outputPath is escaped so a path containing quotes or backslashes cannot
 * break out of the PS string.
 */
export function buildCaptureScript(opts: CaptureScriptOptions): string {
  const quality = Math.min(100, Math.max(1, opts.quality ?? 85));
  const safeOut = escapePsSingleQuoted(opts.outputPath);

  const captureBody = opts.region
    ? buildRegionCaptureBody(opts.region)
    : buildFullScreenCaptureBody();

  return (
    `Add-Type -AssemblyName System.Drawing\n` +
    `$outPath = '${safeOut}'\n` +
    `$quality = ${quality}\n` +
    captureBody +
    `$encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1\n` +
    `$encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)\n` +
    `$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)\n` +
    `$bmp.Save($outPath, $encoder, $encParams)\n` +
    `$bmp.Dispose()\n` +
    `Write-Output "OK:$($bmp.Width)x$($bmp.Height)"\n`
  );
}

function buildFullScreenCaptureBody(): string {
  // Add-Type must precede any reference to the type it loads.
  // System.Windows.Forms is required before [Screen]::PrimaryScreen.Bounds.
  return (
    `Add-Type -AssemblyName System.Windows.Forms\n` +
    `$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds\n` +
    `$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)\n` +
    `$g = [System.Drawing.Graphics]::FromImage($bmp)\n` +
    `$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)\n` +
    `$g.Dispose()\n`
  );
}

function buildRegionCaptureBody(r: {
  x: number;
  y: number;
  width: number;
  height: number;
}): string {
  // Add-Type must precede any System.Drawing reference.
  return (
    `Add-Type -AssemblyName System.Windows.Forms\n` +
    `$bmp = New-Object System.Drawing.Bitmap(${r.width}, ${r.height})\n` +
    `$g = [System.Drawing.Graphics]::FromImage($bmp)\n` +
    `$g.CopyFromScreen(${r.x}, ${r.y}, 0, 0, [System.Drawing.Size]::new(${r.width}, ${r.height}))\n` +
    `$g.Dispose()\n`
  );
}

/* ======================================= pure helper — buildInputScript ===== */

export type InputAction =
  | { kind: "move"; x: number; y: number }
  | { kind: "click"; button: MouseButton; x?: number; y?: number }
  | { kind: "type"; text: string }
  | { kind: "keys"; keys: string[] };

/** MOUSEEVENTF flags used with user32.dll mouse_event. */
const MOUSE_FLAGS: Record<MouseButton, { down: number; up: number }> = {
  left: { down: 0x0002, up: 0x0004 },
  right: { down: 0x0008, up: 0x0010 },
  middle: { down: 0x0020, up: 0x0040 },
};

/**
 * Build the PowerShell script that performs a single input action.
 *
 * Text is embedded in single-quoted PS strings with proper escaping so a
 * quote, semicolon, or $(...) expression in the text cannot break out.
 */
export function buildInputScript(action: InputAction): string {
  const pInvokeHeader =
    `Add-Type -TypeDefinition @'\n` +
    `using System;\n` +
    `using System.Runtime.InteropServices;\n` +
    `public class Win32Input {\n` +
    `  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);\n` +
    `  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, UIntPtr dwExtraInfo);\n` +
    `  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);\n` +
    `}\n` +
    `'@ -Language CSharp\n`;

  if (action.kind === "move") {
    return pInvokeHeader + `[Win32Input]::SetCursorPos(${action.x}, ${action.y}) | Out-Null\n`;
  }

  if (action.kind === "click") {
    const flags = MOUSE_FLAGS[action.button];
    const movePart =
      action.x !== undefined && action.y !== undefined
        ? `[Win32Input]::SetCursorPos(${action.x}, ${action.y}) | Out-Null\n`
        : "";
    return (
      pInvokeHeader +
      movePart +
      `[Win32Input]::mouse_event(${flags.down}, 0, 0, 0, [UIntPtr]::Zero)\n` +
      `Start-Sleep -Milliseconds 50\n` +
      `[Win32Input]::mouse_event(${flags.up}, 0, 0, 0, [UIntPtr]::Zero)\n`
    );
  }

  if (action.kind === "type") {
    // Use SendKeys via WScript.Shell for reliable text input.
    // The text must be escaped: special SendKeys chars and single-quote for PS.
    const safeText = escapePsSingleQuoted(escapeSendKeys(action.text));
    return (
      `$wsh = New-Object -ComObject WScript.Shell\n` +
      `$wsh.SendKeys('${safeText}')\n`
    );
  }

  // action.kind === "keys"
  // Join key names with + for SendKeys combination chords.
  const combined = action.keys
    .map((k) => mapKeyName(k))
    .join("");
  const safeKeys = escapePsSingleQuoted(combined);
  return (
    `$wsh = New-Object -ComObject WScript.Shell\n` +
    `$wsh.SendKeys('${safeKeys}')\n`
  );
}

/**
 * Escape special SendKeys characters so they are sent as literal text.
 * SendKeys treats +, ^, %, ~, (, ), {, } as special.
 */
function escapeSendKeys(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`);
}

/** Map a human key name to a SendKeys token. */
function mapKeyName(key: string): string {
  const lower = key.toLowerCase();
  const MAP: Record<string, string> = {
    enter: "{ENTER}",
    return: "{ENTER}",
    tab: "{TAB}",
    escape: "{ESC}",
    esc: "{ESC}",
    backspace: "{BACKSPACE}",
    delete: "{DELETE}",
    del: "{DELETE}",
    home: "{HOME}",
    end: "{END}",
    pgup: "{PGUP}",
    pgdn: "{PGDN}",
    up: "{UP}",
    down: "{DOWN}",
    left: "{LEFT}",
    right: "{RIGHT}",
    f1: "{F1}",
    f2: "{F2}",
    f3: "{F3}",
    f4: "{F4}",
    f5: "{F5}",
    f6: "{F6}",
    f7: "{F7}",
    f8: "{F8}",
    f9: "{F9}",
    f10: "{F10}",
    f11: "{F11}",
    f12: "{F12}",
    ctrl: "^",
    control: "^",
    alt: "%",
    shift: "+",
    win: "^{ESC}",
  };
  return MAP[lower] ?? key;
}

/* =========================================== PowerShellComputerBackend ====== */

/**
 * Runs PowerShell scripts via child_process to perform computer-use actions.
 *
 * child_process is imported lazily so this module loads cleanly in any env.
 */
export class PowerShellComputerBackend implements ComputerBackend {
  private _psExe: string | null = null;
  private _psDetected = false;

  private async getPsExe(): Promise<string> {
    if (this._psDetected) {
      if (!this._psExe) throw new BackendUnavailableError("Computer use (PowerShell)");
      return this._psExe;
    }

    let execFile: (
      file: string,
      args: string[],
      opts: object,
    ) => Promise<{ stdout: string; stderr: string }>;

    try {
      const cp = await import("node:child_process");
      const util = await import("node:util");
      execFile = util.promisify(cp.execFile) as typeof execFile;
    } catch {
      throw new BackendUnavailableError("Computer use (child_process)");
    }

    // Prefer powershell.exe (Windows PowerShell 5) over pwsh (PowerShell 7):
    // WinForms (System.Windows.Forms) is not included in PS7 by default, and
    // all screen-capture scripts rely on it.
    for (const candidate of ["powershell", "pwsh"]) {
      try {
        const { stdout } = await execFile(candidate, ["-NoProfile", "-Command", "echo OK"], {
          timeout: 5000,
        });
        if (stdout.trim().includes("OK")) {
          this._psExe = candidate;
          this._psDetected = true;
          return candidate;
        }
      } catch {
        // Try next candidate.
      }
    }

    this._psDetected = true;
    this._psExe = null;
    throw new BackendUnavailableError("Computer use (PowerShell)");
  }

  private async runScript(script: string): Promise<string> {
    const psExe = await this.getPsExe();

    let execFile: (
      file: string,
      args: string[],
      opts: object,
    ) => Promise<{ stdout: string; stderr: string }>;

    try {
      const cp = await import("node:child_process");
      const util = await import("node:util");
      execFile = util.promisify(cp.execFile) as typeof execFile;
    } catch {
      throw new BackendUnavailableError("Computer use (child_process)");
    }

    const { stdout, stderr } = await execFile(
      psExe,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 30_000 },
    );

    if (stderr.trim()) {
      const msg = stderr.trim();
      if (msg.toLowerCase().includes("error")) {
        throw new Error(`PowerShell error: ${msg}`);
      }
    }

    return stdout.trim();
  }

  async capture(opts?: CaptureOptions): Promise<CaptureResult> {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");

    const tmpFile = path.join(os.tmpdir(), `kozum_capture_${Date.now()}.jpg`);

    try {
      const script = buildCaptureScript({
        outputPath: tmpFile,
        region: opts?.region,
        quality: opts?.quality ?? 85,
      });

      const out = await this.runScript(script);

      // Parse dimensions from "OK:WxH" output
      let width = 0;
      let height = 0;
      const match = /OK:(\d+)x(\d+)/.exec(out);
      if (match) {
        width = parseInt(match[1]!, 10);
        height = parseInt(match[2]!, 10);
      }

      const bytes = await fs.readFile(tmpFile);
      const data = bytes.toString("base64");

      return { data, mimeType: "image/jpeg", width, height };
    } finally {
      // Best-effort cleanup.
      try {
        const fs2 = await import("node:fs/promises");
        await fs2.unlink(tmpFile);
      } catch {
        // Ignore cleanup failures.
      }
    }
  }

  async moveMouse(x: number, y: number): Promise<void> {
    const script = buildInputScript({ kind: "move", x, y });
    await this.runScript(script);
  }

  async clickMouse(button: MouseButton, x?: number, y?: number): Promise<void> {
    const script = buildInputScript({ kind: "click", button, x, y });
    await this.runScript(script);
  }

  async typeText(text: string): Promise<void> {
    const script = buildInputScript({ kind: "type", text });
    await this.runScript(script);
  }

  async pressKeys(keys: string[]): Promise<void> {
    const script = buildInputScript({ kind: "keys", keys });
    await this.runScript(script);
  }

  async screenSize(): Promise<ScreenSize> {
    const script =
      `Add-Type -AssemblyName System.Windows.Forms\n` +
      `$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds\n` +
      `Write-Output "$($b.Width)x$($b.Height)"\n`;

    const out = await this.runScript(script);
    const m = /(\d+)x(\d+)/.exec(out);
    if (!m) throw new Error(`Unexpected screenSize output: ${out}`);
    return { width: parseInt(m[1]!, 10), height: parseInt(m[2]!, 10) };
  }

  async activeWindow(): Promise<WindowInfo | null> {
    const script =
      `Add-Type -TypeDefinition @'\n` +
      `using System;\n` +
      `using System.Runtime.InteropServices;\n` +
      `using System.Text;\n` +
      `public class Win32Win {\n` +
      `  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();\n` +
      `  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);\n` +
      `  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);\n` +
      `}\n` +
      `'@ -Language CSharp\n` +
      `$h = [Win32Win]::GetForegroundWindow()\n` +
      `$sb = New-Object System.Text.StringBuilder(256)\n` +
      `[Win32Win]::GetWindowText($h, $sb, 256) | Out-Null\n` +
      `$procId = 0\n` +
      `[Win32Win]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null\n` +
      `$proc = Get-Process -Id $procId -ErrorAction SilentlyContinue\n` +
      `Write-Output "$($h.ToInt64())|$($sb.ToString())|$($proc.Name)"\n`;

    const out = await this.runScript(script);
    const parts = out.split("|");
    if (parts.length < 2) return null;

    return {
      handle: parseInt(parts[0]!, 10),
      title: parts[1] ?? "",
      processName: parts[2] ?? "",
      visible: true,
    };
  }

  async listWindows(): Promise<WindowInfo[]> {
    const script =
      `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ` +
      `ForEach-Object { "$($_.MainWindowHandle.ToInt64())|$($_.MainWindowTitle)|$($_.Name)" }\n`;

    const out = await this.runScript(script);
    if (!out) return [];

    return out
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const parts = line.split("|");
        return {
          handle: parseInt(parts[0] ?? "0", 10),
          title: parts[1] ?? "",
          processName: parts[2] ?? "",
          visible: true,
        };
      });
  }
}
