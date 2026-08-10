/**
 * HTML → readable text/markdown extraction helpers.
 *
 * Pure functions, no side effects, fully unit-testable.
 * Strips noise (scripts, styles, nav, ads) while preserving semantic content
 * (headings, links, lists, paragraphs, code blocks).
 */

/* ----------------------------------------------------------------- types */

export interface HtmlToTextOptions {
  /** Max length of returned text. Defaults to 80_000 chars. */
  maxLength?: number;
  /** When true, emit Markdown (#, **, [], etc.). Defaults to true. */
  markdown?: boolean;
}

/* ------------------------------------------------------- entity decoding */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  bull: "•",
  middot: "·",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  agrave: "à",
  aacute: "á",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  ccedil: "ç",
};

/**
 * Decode HTML entities in a string.
 * Handles named, decimal, and hex numeric character references.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (_, name: string) => {
      const lower = name.toLowerCase();
      return NAMED_ENTITIES[lower] ?? `&${name};`;
    })
    .replace(/&#([0-9]{1,6});/g, (_, digits: string) => {
      const cp = parseInt(digits, 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_, hex: string) => {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    });
}

/* ------------------------------------------------------- tag stripping */

/** Tags whose entire subtree (including content) should be removed. */
const STRIP_TAG_NAMES: string[] = [
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "canvas",
  "video",
  "audio",
  "object",
  "embed",
  "applet",
  "head",
  "meta",
  "link",
  "base",
  "template",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "label",
  "fieldset",
  "legend",
  "nav",
  "header",
  "footer",
  "aside",
];

/**
 * Remove a tag and all its content (including nested occurrences).
 *
 * Works by scanning the HTML character by character (via indexOf), tracking
 * open/close depth. Handles nesting correctly. Case-insensitive.
 */
export function removeTagAndContent(html: string, tag: string): string {
  const t = tag.toLowerCase();
  // Regex to find opening tags: <TAG> or <TAG attr...> or <TAG attr.../>
  const openPattern = new RegExp(`<(${t})(\\s[^>]*)?>`, "i");
  // Regex to find closing tags: </TAG>
  const closeTag = `</${t}>`;

  let result = html;
  let searchFrom = 0;

  while (searchFrom < result.length) {
    // Find next open tag from current position
    const remaining = result.slice(searchFrom);
    const openMatch = openPattern.exec(remaining);
    if (!openMatch) break;

    const openStart = searchFrom + openMatch.index;
    const openEnd = openStart + openMatch[0].length;

    // Check if it was actually self-closing (ends with />)
    if (openMatch[0].endsWith("/>")) {
      // Self-closing: just remove the tag itself, no content
      result = result.slice(0, openStart) + result.slice(openEnd);
      // searchFrom stays at openStart to continue scanning
      continue;
    }

    // Find the matching closing tag, accounting for nesting
    let depth = 1;
    let pos = openEnd;

    while (depth > 0 && pos < result.length) {
      // Find next open or close tag
      const nextOpenMatch = openPattern.exec(result.slice(pos));
      const nextCloseIdx = result.toLowerCase().indexOf(closeTag.toLowerCase(), pos);

      const nextOpenPos = nextOpenMatch ? pos + nextOpenMatch.index : Infinity;
      const nextClosePos = nextCloseIdx >= 0 ? nextCloseIdx : Infinity;

      if (nextOpenPos < nextClosePos && nextOpenMatch && !nextOpenMatch[0].endsWith("/>")) {
        // Nested opening tag
        depth++;
        pos = nextOpenPos + nextOpenMatch[0].length;
      } else if (nextClosePos !== Infinity) {
        depth--;
        pos = nextClosePos + closeTag.length;
      } else {
        // No matching close — remove from open to end
        pos = result.length;
        break;
      }
    }

    // Remove from openStart to pos
    result = result.slice(0, openStart) + result.slice(pos);
    // Don't advance searchFrom — there may be more tags at this position
  }

  return result;
}

/**
 * Remove tags whose content should be fully deleted, keeping everything else.
 *
 * Operates on raw HTML strings without a DOM; handles nesting by tracking
 * depth. Case-insensitive.
 */
export function stripNoiseTags(html: string): string {
  let result = html;

  for (const tag of STRIP_TAG_NAMES) {
    result = removeTagAndContent(result, tag);
  }

  // Remove elements with role="navigation", role="banner", etc.
  result = result.replace(
    /<[a-z][a-z0-9]*\s[^>]*role=["']?(navigation|banner|complementary|contentinfo)["']?[^>]*>[\s\S]*?<\/[a-z][a-z0-9]*>/gi,
    " ",
  );

  // Remove common ad/tracking class patterns
  result = result.replace(
    /<[a-z][a-z0-9]*\s[^>]*class=["'][^"']*(?:advertisement|adsbygoogle|cookie-banner|popup|overlay|modal)[^"']*["'][^>]*>[\s\S]*?<\/[a-z][a-z0-9]*>/gi,
    " ",
  );

  return result;
}

/* ------------------------------------------------------- html to text */

/**
 * Convert HTML to readable plain text or Markdown.
 *
 * Not a full HTML parser — uses regexes on well-formed markup.
 * Good enough for web content extraction.
 */
export function htmlToText(html: string, opts: HtmlToTextOptions = {}): string {
  const maxLen = opts.maxLength ?? 80_000;
  const md = opts.markdown !== false;

  // 1. Strip noise tags and their content entirely
  let text = stripNoiseTags(html);

  // 2. Convert semantic tags to Markdown equivalents before stripping all tags
  if (md) {
    // Headings
    for (let h = 6; h >= 1; h--) {
      const prefix = "#".repeat(h) + " ";
      text = text.replace(
        new RegExp(`<h${h}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/h${h}>`, "gi"),
        (_m, inner: string) => `\n\n${prefix}${extractText(inner)}\n\n`,
      );
    }

    // Bold / strong
    text = text.replace(/<(?:strong|b)(?:\s[^>]*)?>([^<]*)<\/(?:strong|b)>/gi, "**$1**");

    // Italic / em
    text = text.replace(/<(?:em|i)(?:\s[^>]*)?>([^<]*)<\/(?:em|i)>/gi, "_$1_");

    // Code (inline)
    text = text.replace(/<code(?:\s[^>]*)?>([^<]*)<\/code>/gi, "`$1`");

    // Pre / code blocks
    text = text.replace(
      /<pre(?:\s[^>]*)?>[\s\S]*?<code(?:\s[^>]*)?>([^]*?)<\/code>[\s\S]*?<\/pre>/gi,
      (_m, inner: string) => `\n\`\`\`\n${decodeEntities(stripAllTags(inner)).trim()}\n\`\`\`\n`,
    );
    text = text.replace(
      /<pre(?:\s[^>]*)?>([^]*?)<\/pre>/gi,
      (_m, inner: string) => `\n\`\`\`\n${decodeEntities(stripAllTags(inner)).trim()}\n\`\`\`\n`,
    );

    // Anchors — keep link text and URL
    text = text.replace(
      /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, inner: string) => {
        const linkText = extractText(inner).trim();
        if (!linkText || linkText === href) return href;
        return `[${linkText}](${href})`;
      },
    );

    // Images — alt text
    text = text.replace(
      /<img\s[^>]*alt=["']([^"']+)["'][^>]*/gi,
      (_m, alt: string) => (alt.trim() ? `![${alt.trim()}]` : ""),
    );

    // Unordered list items
    text = text.replace(/<li(?:\s[^>]*)?>([^]*?)<\/li>/gi, (_m, inner: string) => {
      return `\n- ${extractText(inner).trim()}`;
    });

    // Ordered list — simple numbered
    text = text.replace(/<ol(?:\s[^>]*)?>([\s\S]*?)<\/ol>/gi, (_m, inner: string) => {
      let n = 0;
      return inner.replace(/<li(?:\s[^>]*)?>([^]*?)<\/li>/gi, (_lm, li: string) => {
        n++;
        return `\n${n}. ${extractText(li).trim()}`;
      });
    });

    // Table cells — separate with |
    text = text.replace(/<t[dh](?:\s[^>]*)?>([\s\S]*?)<\/t[dh]>/gi, (_m, inner: string) => {
      return `| ${extractText(inner).trim()} `;
    });
    text = text.replace(/<\/tr>/gi, "|\n");

    // Blockquote
    text = text.replace(/<blockquote(?:\s[^>]*)?>([^]*?)<\/blockquote>/gi, (_m, inner: string) => {
      const lines = extractText(inner)
        .trim()
        .split("\n")
        .map((l) => `> ${l}`);
      return `\n${lines.join("\n")}\n`;
    });

    // Horizontal rule
    text = text.replace(/<hr(?:\s[^>]*)?\/?>|<hr>/gi, "\n---\n");
  }

  // Block-level elements → newlines
  const BLOCK_TAGS =
    "p|div|section|article|main|details|summary|dl|dt|dd|ul|ol|li|table|thead|tbody|tr|th|td|caption|figure|figcaption|address|blockquote|h[1-6]";
  text = text.replace(new RegExp(`<(?:${BLOCK_TAGS})(?:\\s[^>]*)?>`, "gi"), "\n");
  text = text.replace(new RegExp(`</(?:${BLOCK_TAGS})>`, "gi"), "\n");

  // <br> → newline
  text = text.replace(/<br(?:\s[^>]*)?\/?>|<br>/gi, "\n");

  // Strip all remaining tags
  text = stripAllTags(text);

  // Decode entities
  text = decodeEntities(text);

  // Normalise whitespace: collapse multiple blanks, trim lines
  text = text
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n");

  // Collapse more than 2 consecutive blank lines
  text = text.replace(/\n{3,}/g, "\n\n");

  text = text.trim();

  if (text.length > maxLen) {
    text = text.slice(0, maxLen) + `\n\n[... truncated at ${maxLen} chars]`;
  }

  return text;
}

/** Strip all HTML tags from a string. */
export function stripAllTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

/** Extract text content from an HTML fragment. */
function extractText(html: string): string {
  return decodeEntities(stripAllTags(html));
}
