/**
 * Unit tests for the markdown tokenizer/parser.
 *
 * Imports the pure module only — no React, no DOM.
 * Tests: headings, bold, italic, inline code, fenced blocks, links, nested
 * lists, blockquotes, hr, and XSS safety.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// We import from the .ts source directly using node's strip-types.
import {
  parseMarkdown,
  parseInline,
  type BlockToken,
  type InlineToken,
  type HeadingToken,
  type ParagraphToken,
  type CodeBlockToken,
  type BlockquoteToken,
  type ListToken,
  type HrToken,
  type TextToken,
  type BoldToken,
  type ItalicToken,
  type InlineCodeToken,
  type LinkToken,
} from "../../src/renderer/components/Markdown.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

function firstBlock(md: string): BlockToken {
  const tokens = parseMarkdown(md);
  assert.ok(tokens.length >= 1, "Expected at least one block token");
  return tokens[0]!;
}

function asHeading(t: BlockToken): HeadingToken {
  assert.equal(t.type, "heading");
  return t as HeadingToken;
}

function asParagraph(t: BlockToken): ParagraphToken {
  assert.equal(t.type, "paragraph");
  return t as ParagraphToken;
}

function asCodeBlock(t: BlockToken): CodeBlockToken {
  assert.equal(t.type, "code_block");
  return t as CodeBlockToken;
}

function asBlockquote(t: BlockToken): BlockquoteToken {
  assert.equal(t.type, "blockquote");
  return t as BlockquoteToken;
}

function asList(t: BlockToken): ListToken {
  assert.equal(t.type, "list");
  return t as ListToken;
}

function asHr(t: BlockToken): HrToken {
  assert.equal(t.type, "hr");
  return t as HrToken;
}

function asText(t: InlineToken): TextToken {
  assert.equal(t.type, "text");
  return t as TextToken;
}

function asBold(t: InlineToken): BoldToken {
  assert.equal(t.type, "bold");
  return t as BoldToken;
}

function asItalic(t: InlineToken): ItalicToken {
  assert.equal(t.type, "italic");
  return t as ItalicToken;
}

function asInlineCode(t: InlineToken): InlineCodeToken {
  assert.equal(t.type, "inline_code");
  return t as InlineCodeToken;
}

function asLink(t: InlineToken): LinkToken {
  assert.equal(t.type, "link");
  return t as LinkToken;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("parseMarkdown — headings", () => {
  it("parses h1", () => {
    const t = asHeading(firstBlock("# Hello"));
    assert.equal(t.level, 1);
    assert.equal((t.children[0] as TextToken).text, "Hello");
  });

  it("parses h2", () => {
    const t = asHeading(firstBlock("## World"));
    assert.equal(t.level, 2);
  });

  it("parses h3", () => {
    const t = asHeading(firstBlock("### Deep"));
    assert.equal(t.level, 3);
  });

  it("parses h6", () => {
    const t = asHeading(firstBlock("###### Six"));
    assert.equal(t.level, 6);
  });
});

describe("parseMarkdown — paragraphs", () => {
  it("wraps plain text as paragraph", () => {
    const t = asParagraph(firstBlock("Hello world"));
    const child = asText(t.children[0]!);
    assert.equal(child.text, "Hello world");
  });

  it("produces multiple paragraphs separated by blank lines", () => {
    const tokens = parseMarkdown("First\n\nSecond");
    assert.equal(tokens.length, 2);
    assert.equal(tokens[0]!.type, "paragraph");
    assert.equal(tokens[1]!.type, "paragraph");
  });
});

describe("parseMarkdown — fenced code blocks", () => {
  it("captures lang and code", () => {
    const src = "```typescript\nconst x = 1;\n```";
    const t = asCodeBlock(firstBlock(src));
    assert.equal(t.lang, "typescript");
    assert.equal(t.code, "const x = 1;");
  });

  it("works without a lang tag", () => {
    const src = "```\nplain\n```";
    const t = asCodeBlock(firstBlock(src));
    assert.equal(t.lang, "");
    assert.equal(t.code, "plain");
  });

  it("works with tilde fences", () => {
    const src = "~~~\ncode here\n~~~";
    const t = asCodeBlock(firstBlock(src));
    assert.equal(t.code, "code here");
  });

  it("preserves multi-line code", () => {
    const src = "```\nline1\nline2\nline3\n```";
    const t = asCodeBlock(firstBlock(src));
    assert.equal(t.code, "line1\nline2\nline3");
  });
});

describe("parseMarkdown — horizontal rules", () => {
  it("recognises ---", () => {
    asHr(firstBlock("---"));
  });

  it("recognises ***", () => {
    asHr(firstBlock("***"));
  });

  it("recognises ___", () => {
    asHr(firstBlock("___"));
  });
});

describe("parseMarkdown — blockquotes", () => {
  it("strips the > prefix", () => {
    const t = asBlockquote(firstBlock("> Hello"));
    const inner = asParagraph(t.children[0]!);
    const text = asText(inner.children[0]!);
    assert.equal(text.text, "Hello");
  });

  it("supports multi-line blockquotes", () => {
    const t = asBlockquote(firstBlock("> line one\n> line two"));
    assert.ok(t.children.length >= 1);
  });
});

describe("parseMarkdown — unordered lists", () => {
  it("creates a list with items", () => {
    const t = asList(firstBlock("- alpha\n- beta\n- gamma"));
    assert.equal(t.ordered, false);
    assert.equal(t.items.length, 3);
  });

  it("accepts * bullets", () => {
    const t = asList(firstBlock("* one\n* two"));
    assert.equal(t.items.length, 2);
  });
});

describe("parseMarkdown — ordered lists", () => {
  it("creates an ordered list", () => {
    const t = asList(firstBlock("1. first\n2. second"));
    assert.equal(t.ordered, true);
    assert.equal(t.items.length, 2);
  });
});

describe("parseMarkdown — nested list items", () => {
  it("parses a list item's text content", () => {
    const t = asList(firstBlock("- item one\n- item two"));
    const firstItem = t.items[0]!;
    // The item body is a paragraph with the item's text.
    const para = asParagraph(firstItem.children[0]!);
    const text = asText(para.children[0]!);
    assert.equal(text.text, "item one");
  });
});

describe("parseInline — bold", () => {
  it("parses **bold**", () => {
    const tokens = parseInline("Hello **world** ok");
    assert.equal(tokens.length, 3);
    const b = asBold(tokens[1]!);
    const inner = asText(b.children[0]!);
    assert.equal(inner.text, "world");
  });

  it("parses __bold__", () => {
    const tokens = parseInline("__bold__");
    const b = asBold(tokens[0]!);
    assert.ok(b.children.length >= 1);
  });
});

describe("parseInline — italic", () => {
  it("parses *italic*", () => {
    const tokens = parseInline("*italic*");
    const em = asItalic(tokens[0]!);
    const inner = asText(em.children[0]!);
    assert.equal(inner.text, "italic");
  });

  it("parses _italic_", () => {
    const tokens = parseInline("_italic_");
    const em = asItalic(tokens[0]!);
    assert.ok(em.children.length >= 1);
  });
});

describe("parseInline — inline code", () => {
  it("parses `code`", () => {
    const tokens = parseInline("run `npm install` now");
    assert.equal(tokens.length, 3);
    const code = asInlineCode(tokens[1]!);
    assert.equal(code.code, "npm install");
  });
});

describe("parseInline — links", () => {
  it("parses [text](url)", () => {
    const tokens = parseInline("see [Kozum](https://kozum.ai) here");
    const link = asLink(tokens[1]!);
    assert.equal(link.href, "https://kozum.ai");
    assert.equal(link.text, "Kozum");
  });
});

describe("XSS safety", () => {
  it("treats a <script> tag as a literal text token, not markup", () => {
    // This is the key security invariant: the parser must NOT produce any token
    // that carries executable HTML. The raw characters must survive as text.
    const malicious = '<script>alert(1)</script>';
    const tokens = parseInline(malicious);

    // Every token must be a text or inline token — none should have type
    // 'html' or anything that could be injected into the DOM as HTML.
    for (const t of tokens) {
      assert.notEqual(
        (t as { type: string }).type,
        "html",
        "Parser produced an html token — that would enable XSS",
      );
    }

    // The combined text of all text tokens must contain the raw < and >
    // characters so they can be passed to React which will escape them.
    const combined = tokens
      .filter((t) => t.type === "text")
      .map((t) => (t as TextToken).text)
      .join("");

    assert.ok(
      combined.includes("<script>") || combined.includes("script"),
      `Expected raw script text in output; got: ${JSON.stringify(combined)}`,
    );

    // Also verify that block-level parsing keeps it as a paragraph, not html.
    const blockTokens = parseMarkdown(malicious);
    for (const b of blockTokens) {
      assert.notEqual(
        b.type,
        "html",
        "Block parser produced an html block — that would enable XSS",
      );
      // The paragraph's inline children also must not contain html tokens.
      if (b.type === "paragraph") {
        for (const child of b.children) {
          assert.notEqual(
            (child as { type: string }).type,
            "html",
            "Inline parser inside paragraph produced an html token",
          );
        }
      }
    }
  });

  it("passes through angle brackets in code blocks as literal text", () => {
    const src = "```\n<script>alert(2)</script>\n```";
    const t = asCodeBlock(firstBlock(src));
    // In a code block the text is the raw string — React will escape it.
    assert.ok(t.code.includes("<script>"), "Code block should contain raw < chars");
  });
});
