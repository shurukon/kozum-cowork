/**
 * Unit tests for the markdown table tokenizer.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseMarkdown, type TableToken } from "../../src/renderer/components/Markdown.ts";

describe("parseMarkdown — tables", () => {
  it("parses a two-column table", () => {
    const tokens = parseMarkdown("| Name | Value |\n| --- | --- |\n| a | 1 |\n| b | 2 |");
    assert.equal(tokens[0].type, "table");
    const t = tokens[0] as TableToken;
    assert.equal(t.header.length, 2);
    assert.equal(t.rows.length, 2);
  });

  it("parses alignment markers", () => {
    const tokens = parseMarkdown("| L | C | R |\n| :--- | :---: | ---: |\n| a | b | c |");
    const t = tokens[0] as TableToken;
    assert.deepEqual(t.align, ["left", "center", "right"]);
  });

  it("does not treat plain pipe text as a table", () => {
    const tokens = parseMarkdown("echo | not a table");
    assert.ok(!tokens.some((t: any) => t.type === "table"));
  });

  it("stops table rows on blank line", () => {
    const tokens = parseMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |\n\nNext paragraph");
    assert.equal(tokens[0].type, "table");
    assert.equal(tokens[1].type, "paragraph");
  });

  it("plain --- separator defaults to left alignment", () => {
    const tokens = parseMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
    const t = tokens[0] as TableToken;
    assert.deepEqual(t.align, ["left", "left"]);
  });
});
