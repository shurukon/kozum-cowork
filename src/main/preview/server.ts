import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import { contains } from "../tools/paths.ts";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".xhtml": "application/xhtml+xml; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

const PREVIEW_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "connect-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "media-src 'self' blob: https:",
].join("; ");

export interface LocalPreviewHandle {
  url: string;
  path: string;
}

/**
 * Serves one user-selected local HTML tree over loopback for Chromium preview.
 *
 * The server never exposes a directory listing, binds beyond 127.0.0.1, or
 * accepts a path outside the selected file's canonical parent. A random route
 * token prevents unrelated local clients from guessing the active preview.
 * The CSP permits local scripts/styles/assets and passive remote design assets,
 * but blocks frames, plugins, network APIs, and form submission.
 */
export class LocalPreviewServer {
  private server: ReturnType<typeof createServer> | null = null;
  private port: number | null = null;
  private active: { root: string; token: string; entry: string } | null = null;

  async open(filePath: string): Promise<LocalPreviewHandle> {
    const canonicalFile = await realpath(filePath);
    const fileStat = await stat(canonicalFile);
    if (!fileStat.isFile()) throw new Error("Preview target is not a file.");
    if (!/^\.(?:html?|xhtml)$/i.test(extname(canonicalFile))) {
      throw new Error("Live HTML preview requires an .html, .htm, or .xhtml file.");
    }

    const root = await realpath(dirname(canonicalFile));
    const token = randomBytes(18).toString("base64url");
    this.active = { root, token, entry: basename(canonicalFile) };
    await this.ensureServer();
    return {
      url: `http://127.0.0.1:${this.port}/__kozum_preview/${token}/${encodeURIComponent(basename(canonicalFile))}`,
      path: canonicalFile,
    };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    this.active = null;
    if (!server) return;
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }

  private async ensureServer(): Promise<void> {
    if (this.server && this.port !== null) return;
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolveListen, reject) => {
      const server = this.server!;
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Could not determine local preview port."));
          return;
        }
        this.port = address.port;
        // The preview server must not keep the app alive after Electron quits.
        server.unref();
        resolveListen();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
  }

  private async handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const active = this.active;
    if (!active || !req.url) {
      this.respondText(res, 404, "Preview is not active.\n");
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(req.url, "http://127.0.0.1");
    } catch {
      this.respondText(res, 400, "Bad preview URL.\n");
      return;
    }

    const prefix = `/__kozum_preview/${active.token}/`;
    if (!parsed.pathname.startsWith(prefix)) {
      this.respondText(res, 404, "Preview route not found.\n");
      return;
    }

    const encodedRelative = parsed.pathname.slice(prefix.length);
    let relativePath: string;
    try {
      relativePath = decodeURIComponent(encodedRelative);
    } catch {
      this.respondText(res, 400, "Bad preview path.\n");
      return;
    }
    if (!relativePath || relativePath.includes("\0")) {
      this.respondText(res, 400, "Bad preview path.\n");
      return;
    }

    const candidate = resolve(active.root, relativePath);
    const canonicalRoot = await realpath(active.root).catch(() => active.root);
    const canonicalCandidate = await realpath(candidate).catch(() => candidate);
    if (!contains(canonicalRoot, canonicalCandidate)) {
      this.respondText(res, 403, "Preview path is outside the selected folder.\n");
      return;
    }

    let info;
    try {
      info = await stat(canonicalCandidate);
    } catch {
      this.respondText(res, 404, "Preview asset not found.\n");
      return;
    }
    if (!info.isFile()) {
      this.respondText(res, 404, "Preview asset not found.\n");
      return;
    }

    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      this.respondText(res, 405, "Method not allowed.\n", { Allow: "GET, HEAD" });
      return;
    }

    const contentType = MIME_TYPES[extname(canonicalCandidate).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": String(info.size),
      "Cache-Control": "no-store",
      "Content-Security-Policy": PREVIEW_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    if (method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(canonicalCandidate).on("error", () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }).pipe(res);
  }

  private respondText(
    res: import("node:http").ServerResponse,
    status: number,
    body: string,
    extra: Record<string, string> = {},
  ): void {
    res.writeHead(status, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": PREVIEW_CSP,
      ...extra,
    });
    res.end(body);
  }
}
