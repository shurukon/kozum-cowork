/**
 * Kozum Cowork — pure markdown tokenizer/parser.
 *
 * Exported as a plain module (no JSX) so the pure logic can be tested under
 * node:test without a DOM. The React renderer lives in Markdown.tsx and
 * imports this.
 *
 * SECURITY: This parser deliberately never produces HTML strings. Every leaf
 * value is a plain string that React will escape when it renders it as a text
 * node. No dangerouslySetInnerHTML is used anywhere. Content coming from a
 * model that has read untrusted web pages cannot inject markup through this
 * renderer.
 */

// ── Token types ────────────────────────────────────────────────────────────

export interface HeadingToken {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  children: InlineToken[];
}

export interface ParagraphToken {
  type: "paragraph";
  children: InlineToken[];
}

export interface CodeBlockToken {
  type: "code_block";
  lang: string;
  code: string;
}

export interface BlockquoteToken {
  type: "blockquote";
  children: BlockToken[];
}

export interface ListToken {
  type: "list";
  ordered: boolean;
  items: ListItemToken[];
}

export interface ListItemToken {
  type: "list_item";
  children: BlockToken[];
}

export interface HrToken {
  type: "hr";
}

/**
 * Table token. The first row is the header; each row is an array of cells,
 * and each cell is its own array of inline tokens (so cell contents support
 * bold/italic/code/links/images independently). The alignment array matches
 * column count; values are "left" | "center" | "right" | null.
 */
export interface TableToken {
  type: "table";
  header: InlineToken[][];
  rows: InlineToken[][][];
  align: Array<"left" | "center" | "right" | null>;
}

/**
 * Task list — a list whose items carry a boolean `checked` flag. Markdown
 * source uses `- [ ]` (unchecked) and `- [x]` (checked). Regular lists (no
 * checkbox glyph) keep using ListToken so they render with standard bullets.
 */
export interface TaskListToken {
  type: "task_list";
  items: TaskListItemToken[];
}

export interface TaskListItemToken {
  type: "task_item";
  checked: boolean;
  children: BlockToken[];
}

// Inline tokens
export interface TextToken {
  type: "text";
  text: string;
}

export interface BoldToken {
  type: "bold";
  children: InlineToken[];
}

export interface ItalicToken {
  type: "italic";
  children: InlineToken[];
}

export interface InlineCodeToken {
  type: "inline_code";
  code: string;
}

export interface LinkToken {
  type: "link";
  href: string;
  text: string;
}

/**
 * Inline image: ![alt](src). The `src` is the raw URL; the renderer validates
 * it is http/https before emitting a real <img> (file: is blocked). Cap the
 * URL length here to keep parsing linear (plan ReDoS note).
 */
export interface ImageToken {
  type: "image";
  src: string;
  alt: string;
}

export type InlineToken =
  | TextToken
  | BoldToken
  | ItalicToken
  | InlineCodeToken
  | LinkToken
  | ImageToken;

export type BlockToken =
  | HeadingToken
  | ParagraphToken
  | CodeBlockToken
  | BlockquoteToken
  | ListToken
  | HrToken
  | TableToken
  | TaskListToken;

// ── Inline parser ──────────────────────────────────────────────────────────

export function parseInline(src: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;

  while (i < src.length) {
    // Inline code: `...`
    if (src[i] === "`") {
      const end = src.indexOf("`", i + 1);
      if (end !== -1) {
        const code = src.slice(i + 1, end);
        tokens.push({ type: "inline_code", code });
        i = end + 1;
        continue;
      }
    }

    // Image: ![alt](src) — must be checked before the link rule so the leading
    // `!` is consumed here, otherwise the alt text would also emit a link.
    // Cap the URL length to keep parsing linear (ReDoS guard in the plan).
    if (src[i] === "!" && src[i + 1] === "[") {
      const closeB = src.indexOf("]", i + 2);
      if (closeB !== -1 && src[closeB + 1] === "(") {
        const closeP = src.indexOf(")", closeB + 2);
        if (closeP !== -1 && closeP - (closeB + 2) <= 2048) {
          const alt = src.slice(i + 2, closeB);
          const srcUrl = src.slice(closeB + 2, closeP);
          tokens.push({ type: "image", src: srcUrl, alt });
          i = closeP + 1;
          continue;
        }
      }
    }

    // Link: [text](href)
    if (src[i] === "[") {
      const closeB = src.indexOf("]", i + 1);
      if (closeB !== -1 && src[closeB + 1] === "(") {
        const closeP = src.indexOf(")", closeB + 2);
        if (closeP !== -1) {
          const text = src.slice(i + 1, closeB);
          const href = src.slice(closeB + 2, closeP);
          tokens.push({ type: "link", href, text });
          i = closeP + 1;
          continue;
        }
      }
    }

    // Bold: **...** or __...__
    if (
      (src[i] === "*" && src[i + 1] === "*") ||
      (src[i] === "_" && src[i + 1] === "_")
    ) {
      const marker = src.slice(i, i + 2);
      const end = src.indexOf(marker, i + 2);
      if (end !== -1) {
        const inner = src.slice(i + 2, end);
        tokens.push({ type: "bold", children: parseInline(inner) });
        i = end + 2;
        continue;
      }
    }

    // Italic: *...* or _..._
    if (src[i] === "*" || src[i] === "_") {
      const marker = src[i] as string;
      const end = src.indexOf(marker, i + 1);
      if (end !== -1) {
        const inner = src.slice(i + 1, end);
        tokens.push({ type: "italic", children: parseInline(inner) });
        i = end + 1;
        continue;
      }
    }

    // Accumulate plain text (including any HTML-like chars — kept as literal text).
    let j = i + 1;
    while (j < src.length) {
      const c = src[j];
      if (c === "`" || c === "[" || c === "*" || c === "_") break;
      j++;
    }
    const text = src.slice(i, j);
    if (text.length > 0) {
      const last = tokens[tokens.length - 1];
      if (last && last.type === "text") {
        // Merge adjacent text tokens.
        tokens[tokens.length - 1] = { type: "text", text: last.text + text };
      } else {
        tokens.push({ type: "text", text });
      }
    }
    i = j;
  }

  return tokens;
}

// ── Table helper ───────────────────────────────────────────────────────────

/**
 * Split a table row `| a | b |` into an array of cell strings `["a", "b"]`.
 * Handles leading/trailing pipes and escaped pipes `\|` inside cells.
 */
function splitTableRow(row: string): string[] {
  let r = row.trim();
  // Strip one leading and one trailing pipe if present.
  if (r.startsWith("|")) r = r.slice(1);
  if (r.endsWith("|")) r = r.slice(0, -1);
  // Split on `|` but respect `\|` escapes. Cell contents arbitrarily containing
  // pipes are rare in this app; the escape handles the common case.
  const cells: string[] = [];
  let cur = "";
  for (let k = 0; k < r.length; k++) {
    const c = r[k];
    if (c === "\\" && r[k + 1] === "|") {
      cur += "|";
      k++;
      continue;
    }
    if (c === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * Parse the alignment out of a separator cell like `---`, `:---`, `:---:`,
 * or `---:`. Plain `---` (no colons) returns "left" — that is the markdown
 * default. Returns null when the cell is not a valid separator at all.
 */
function parseAlignCell(cell: string): "left" | "center" | "right" | null {
  const c = cell.trim();
  if (!/^[ :|-]+$/.test(c)) return null;
  const noColons = c.replace(/:/g, "");
  // Must be at least one dash character.
  if (noColons.length === 0) return null;
  // Plain dashes with no colons → default left alignment.
  if (!/^-+$/.test(noColons)) return null;
  const startsColon = c.startsWith(":");
  const endsColon = c.endsWith(":");
  if (startsColon && endsColon) return "center";
  if (endsColon) return "right";
  if (startsColon) return "left";
  return "left";
}

/**
 * Try to parse a table starting at lines[start]. Returns the token + the index
 * of the next un-consumed line, or null if this is not actually a table
 * (separator row invalid → fall back to paragraph).
 */
function parseTable(
  lines: string[],
  start: number,
): { token: TableToken; next: number } | null {
  const headerRow = lines[start] ?? "";
  const sepRow = lines[start + 1] ?? "";
  const headerCells = splitTableRow(headerRow);
  const sepCells = splitTableRow(sepRow);

  // The separator must have the same column count as the header and every
  // cell must be a valid `---`/`:---:` etc.
  if (sepCells.length !== headerCells.length) return null;
  const align: Array<"left" | "center" | "right" | null> = [];
  for (const sc of sepCells) {
    const a = parseAlignCell(sc);
    if (a === null) return null;
    align.push(a);
  }

  const header: InlineToken[][] = headerCells.map((c) => parseInline(c));

  // Collect body rows until a non-pipe line (or end of input).
  // Each row is an array of cells; each cell is its own InlineToken[].
  const rows: InlineToken[][][] = [];
  let k = start + 2;
  while (k < lines.length) {
    const r = lines[k] ?? "";
    if (r.trim() === "" || !r.includes("|")) break;
    const cells = splitTableRow(r);
    // Pad / truncate body rows to header column count.
    const padded = cells.slice(0, headerCells.length);
    while (padded.length < headerCells.length) padded.push("");
    rows.push(padded.map((c) => parseInline(c)));
    k++;
  }

  return {
    token: { type: "table", header, rows, align },
    next: k,
  };
}

// ── Block parser ───────────────────────────────────────────────────────────

export function parseMarkdown(src: string): BlockToken[] {
  const tokens: BlockToken[] = [];
  const lines = src.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Skip blank lines.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block: ```lang
    const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const fence = fenceMatch[1] ?? "```";
      const lang = (fenceMatch[2] ?? "").trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const cl = lines[i] ?? "";
        if (cl.startsWith(fence)) {
          i++;
          break;
        }
        codeLines.push(cl);
        i++;
      }
      tokens.push({ type: "code_block", lang, code: codeLines.join("\n") });
      continue;
    }

    // Heading: # ## ### ...
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const level = (headingMatch[1] ?? "#").length as 1 | 2 | 3 | 4 | 5 | 6;
      const text = headingMatch[2] ?? "";
      tokens.push({ type: "heading", level, children: parseInline(text) });
      i++;
      continue;
    }

    // HR: ---, ***, ___
    if (/^[-*_]{3,}\s*$/.test(line)) {
      tokens.push({ type: "hr" });
      i++;
      continue;
    }

    // Table: a header row followed by a separator row of dashes/colons, then
    // at least one body row. A line that merely contains pipes (with no
    // following separator) is NOT a table — it falls through to paragraph.
    // The check requires lines[i+1] to be a valid separator.
    const tableHeaderMatch = /^\|(.+)\|$/.test(line) && /=*\|/.test(lines[i + 1] ?? "") && /^\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? "");
    if (tableHeaderMatch && /\|/.test(lines[i + 1] ?? "")) {
      const tokens_table = parseTable(lines, i);
      if (tokens_table) {
        tokens.push(tokens_table.token);
        i = tokens_table.next;
        continue;
      }
    }

    // Blockquote: > ...
    if (line.startsWith("> ") || line === ">") {
      const bqLines: string[] = [];
      while (i < lines.length) {
        const bl = lines[i] ?? "";
        if (bl.startsWith("> ")) {
          bqLines.push(bl.slice(2));
          i++;
        } else if (bl === ">") {
          bqLines.push("");
          i++;
        } else {
          break;
        }
      }
      tokens.push({ type: "blockquote", children: parseMarkdown(bqLines.join("\n")) });
      continue;
    }

    // Task list: - [ ] item or - [x] item (case-insensitive x).
    // Detected before the plain unordered-list branch so checkbox glyphs
    // produce a TaskListToken (rendered with checkbox UI), not a list.
    if (/^[-*+]\s+\[[ xX]\]\s+/.test(line)) {
      const items: TaskListItemToken[] = [];
      while (i < lines.length) {
        const ll = lines[i] ?? "";
        const m = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(ll);
        if (!m) break;
        const mark = m[1] ?? " ";
        const content = m[2] ?? "";
        const checked = mark.toLowerCase() === "x";
        const itemLines: string[] = [content];
        i++;
        while (i < lines.length) {
          const nl = lines[i] ?? "";
          if (/^\s{2,}(.*)$/.test(nl)) {
            itemLines.push(nl.trim());
            i++;
          } else {
            break;
          }
        }
        items.push({
          type: "task_item",
          checked,
          children: parseMarkdown(itemLines.join("\n")),
        });
      }
      tokens.push({ type: "task_list", items });
      continue;
    }

    // Unordered list: - item or * item
    if (/^[-*+]\s+/.test(line)) {
      const items: ListItemToken[] = [];
      while (i < lines.length) {
        const ll = lines[i] ?? "";
        const m = /^[-*+]\s+(.*)$/.exec(ll);
        if (!m) break;
        const content = m[1] ?? "";
        // Collect continuation lines (indented).
        const itemLines: string[] = [content];
        i++;
        while (i < lines.length) {
          const nl = lines[i] ?? "";
          if (/^\s{2,}(.*)$/.test(nl)) {
            itemLines.push(nl.trim());
            i++;
          } else {
            break;
          }
        }
        items.push({
          type: "list_item",
          children: parseMarkdown(itemLines.join("\n")),
        });
      }
      tokens.push({ type: "list", ordered: false, items });
      continue;
    }

    // Ordered list: 1. item
    if (/^\d+\.\s+/.test(line)) {
      const items: ListItemToken[] = [];
      while (i < lines.length) {
        const ll = lines[i] ?? "";
        const m = /^\d+\.\s+(.*)$/.exec(ll);
        if (!m) break;
        const content = m[1] ?? "";
        const itemLines: string[] = [content];
        i++;
        while (i < lines.length) {
          const nl = lines[i] ?? "";
          if (/^\s{2,}/.test(nl)) {
            itemLines.push(nl.trim());
            i++;
          } else {
            break;
          }
        }
        items.push({
          type: "list_item",
          children: parseMarkdown(itemLines.join("\n")),
        });
      }
      tokens.push({ type: "list", ordered: true, items });
      continue;
    }

    // Paragraph: accumulate until blank line.
    const paraLines: string[] = [];
    while (i < lines.length) {
      const pl = lines[i] ?? "";
      if (
        pl.trim() === "" ||
        /^#{1,6}\s/.test(pl) ||
        /^[-*_]{3,}\s*$/.test(pl) ||
        /^(`{3,}|~{3,})/.test(pl) ||
        /^[-*+]\s+/.test(pl) ||
        /^\d+\.\s+/.test(pl) ||
        pl.startsWith("> ") ||
        // A table row starts with `|` — stop so the table parser gets it.
        /^\|.*\|/.test(pl)
      ) {
        break;
      }
      paraLines.push(pl);
      i++;
    }
    if (paraLines.length > 0) {
      tokens.push({ type: "paragraph", children: parseInline(paraLines.join(" ")) });
    }
  }

  return tokens;
}
