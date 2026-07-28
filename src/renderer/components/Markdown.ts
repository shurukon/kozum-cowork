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

export type InlineToken =
  | TextToken
  | BoldToken
  | ItalicToken
  | InlineCodeToken
  | LinkToken;

export type BlockToken =
  | HeadingToken
  | ParagraphToken
  | CodeBlockToken
  | BlockquoteToken
  | ListToken
  | HrToken;

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
        pl.startsWith("> ")
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
