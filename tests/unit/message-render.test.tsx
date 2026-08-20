/**
 * Component test for Message.tsx — verifies the P0-3a/3b/3c/§4.1/§4.2
 * surface area: image blocks render as <img>, and a user message containing
 * only tool_result blocks renders the compact chip row instead of an empty
 * bubble.
 *
 * Uses renderToString so we do not need a DOM (jsdom) — runs under the
 * standard `npm run test` node:test runner.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";

import { Message } from "../../src/renderer/components/Message.tsx";
import type { Message as MsgType } from "../../src/shared/types.ts";

describe("Message — inline previews (§4.1)", () => {
  it("renders an <img> for an assistant message containing an image block", () => {
    const msg: MsgType = {
      id: "m1",
      role: "assistant",
      content: [
        { type: "text", text: "Here it is:" },
        { type: "image", mimeType: "image/png", data: "BASE64PAYLOAD" },
      ],
      createdAt: 0,
    };

    const html = renderToString(
      <Message message={msg} isStreaming={false} toolCards={new Map()} />,
    );

    assert.match(html, /<img/);
    assert.match(html, /data:image\/png;base64,BASE64PAYLOAD/);
  });

  it("does not render a global tool card in an unrelated assistant turn", () => {
    const msg: MsgType = {
      id: "assistant-follow-up",
      role: "assistant",
      content: [{ type: "text", text: "The plan is ready." }],
      createdAt: 0,
    };
    const toolCards = new Map([
      [
        "task-tool",
        {
          toolUseId: "task-tool",
          name: "task_create",
          input: { subject: "research" },
          status: "ok" as const,
          notes: [],
          result: {
            ok: true,
            content: "Created task",
            display: { summary: "Task created: research" },
          },
        },
      ],
    ]);

    const html = renderToString(
      <Message message={msg} isStreaming={false} toolCards={toolCards} />,
    );

    assert.doesNotMatch(html, /Task created: research/);
  });

  it("renders a compact tool-result row for a user message with ONLY tool_result blocks", () => {
    const msg: MsgType = {
      id: "m1",
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "t1",
          isError: false,
          content: [{ type: "text", text: "OK" }],
        },
      ],
      createdAt: 0,
    };

    const toolCards = new Map([
      [
        "t1",
        {
          toolUseId: "t1",
          name: "file_write",
          input: {},
          status: "ok" as const,
          notes: [],
          result: {
            ok: true,
            content: "OK",
            display: { summary: "Wrote 4 chars", files: ["/tmp/hi.txt"] },
          },
        },
      ],
    ]);

    const html = renderToString(
      <Message
        message={msg}
        isStreaming={false}
        toolCards={toolCards}
        onOpenFile={() => undefined}
      />,
    );

    // No empty user bubble — the compact chip row is rendered instead.
    assert.doesNotMatch(html, /userBubble/);
    assert.match(html, /hi\.txt/);
    assert.match(html, /toolResultChip/);
  });
});
