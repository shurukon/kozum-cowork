/**
 * Kozum Cowork — previewKind.ts
 *
 * Pure (no DOM, no Node, no React) helper that decides how to render a file
 * path or extension. Used by PreviewPanel and callers that need to pick a
 * display strategy before loading any content.
 */

export type PreviewKind = "text" | "markdown" | "image" | "pdf" | "binary";

/** Extension → kind table (lower-case, without the leading dot). */
const EXT_MAP: Record<string, PreviewKind> = {
  // Text / code
  ts: "text",
  tsx: "text",
  js: "text",
  jsx: "text",
  mjs: "text",
  cjs: "text",
  json: "text",
  jsonc: "text",
  css: "text",
  scss: "text",
  less: "text",
  html: "text",
  htm: "text",
  xml: "text",
  yaml: "text",
  yml: "text",
  toml: "text",
  ini: "text",
  sh: "text",
  bash: "text",
  zsh: "text",
  py: "text",
  rb: "text",
  go: "text",
  rs: "text",
  c: "text",
  h: "text",
  cpp: "text",
  cc: "text",
  cxx: "text",
  hpp: "text",
  java: "text",
  kt: "text",
  swift: "text",
  cs: "text",
  php: "text",
  r: "text",
  lua: "text",
  sql: "text",
  graphql: "text",
  gql: "text",
  txt: "text",
  log: "text",
  csv: "text",
  tsv: "text",
  env: "text",
  gitignore: "text",
  gitattributes: "text",
  editorconfig: "text",
  eslintrc: "text",
  prettierrc: "text",
  babelrc: "text",

  // Markdown
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",

  // Images
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  bmp: "image",
  ico: "image",
  tiff: "image",
  tif: "image",
  avif: "image",

  // PDF
  pdf: "pdf",

  // Binary
  exe: "binary",
  dll: "binary",
  so: "binary",
  dylib: "binary",
  zip: "binary",
  tar: "binary",
  gz: "binary",
  bz2: "binary",
  xz: "binary",
  "7z": "binary",
  rar: "binary",
  bin: "binary",
  dat: "binary",
  iso: "binary",
  dmg: "binary",
  pkg: "binary",
  deb: "binary",
  rpm: "binary",
  wasm: "binary",
  mp3: "binary",
  mp4: "binary",
  mov: "binary",
  avi: "binary",
  mkv: "binary",
  wav: "binary",
  ogg: "binary",
  flac: "binary",
  ttf: "binary",
  otf: "binary",
  woff: "binary",
  woff2: "binary",
  eot: "binary",
};

/**
 * Derive the lowercase extension from a path (without leading dot).
 * Returns an empty string when there is no extension or the path has no basename.
 */
function extOf(path: string): string {
  // Strip query strings or fragments (for URLs used as paths)
  const clean = path.split("?")[0]?.split("#")[0] ?? path;
  const base = clean.split("/").pop()?.split("\\").pop() ?? clean;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return ""; // no ext or leading-dot hidden files without ext
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Return the preview kind for a file path or URL-like string.
 *
 * Rule: unknown extension → "text" (best-effort; callers can gate binary
 * detection by checking isPreviewable separately).
 */
export function previewKindForPath(path: string): PreviewKind {
  const ext = extOf(path);
  if (ext === "") return "text";
  return EXT_MAP[ext] ?? "text";
}

/**
 * True when the file can be meaningfully displayed inline.
 * Binary files (exe, zip, etc.) return false and should show
 * a "type + open externally" affordance instead.
 */
export function isPreviewable(path: string): boolean {
  return previewKindForPath(path) !== "binary";
}
