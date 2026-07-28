/**
 * Kozum Cowork — one message turn.
 *
 * Renders user messages (plain text, right-aligned) and assistant turns
 * (markdown, tool cards, thinking blocks). Streaming text gets the kz-caret
 * class while in-flight.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Message as MessageType } from "@shared/types.ts";
import type { ToolCard as ToolCardType } from "../store/session.ts";
import { ToolCard } from "./ToolCard.tsx";
import { Markdown } from "./Markdown.tsx";
import styles from "./Message.module.css";

interface Props {
  message: MessageType;
  isStreaming: boolean;
  toolCards: Map<string, ToolCardType>;
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.thinking}>
      <button
        className={styles.thinkingToggle}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>Thinking</span>
      </button>
      {open && (
        <pre className={styles.thinkingBody}>{text}</pre>
      )}
    </div>
  );
}

export function Message({ message, isStreaming, toolCards }: Props) {
  if (message.role === "user") {
    return (
      <div className={styles.userRow}>
        <div className={styles.userBubble}>
          {message.content.map((block, i) => {
            if (block.type === "text") {
              return <p key={i} className={styles.userText}>{block.text}</p>;
            }
            return null;
          })}
        </div>
      </div>
    );
  }

  // Assistant turn
  const textBlocks = message.content.filter((b) => b.type === "text");
  const thinkingBlocks = message.content.filter((b) => b.type === "thinking");
  const toolUseBlocks = message.content.filter((b) => b.type === "tool_use");

  const fullText = textBlocks
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");

  return (
    <div className={`${styles.assistantRow} kz-anim-rise`}>
      {thinkingBlocks.map((b, i) =>
        b.type === "thinking" ? (
          <ThinkingBlock key={i} text={b.text} />
        ) : null,
      )}

      {/* Tool cards — render before the final text so they appear in turn order */}
      {toolUseBlocks.map((b) => {
        if (b.type !== "tool_use") return null;
        const card = toolCards.get(b.id);
        if (!card) return null;
        return <ToolCard key={b.id} card={card} />;
      })}

      {/* Also render any cards that haven't yet been reflected back as tool_use blocks */}
      {Array.from(toolCards.values())
        .filter((c) => !toolUseBlocks.some((b) => b.type === "tool_use" && b.id === c.toolUseId))
        .map((c) => (
          <ToolCard key={c.toolUseId} card={c} />
        ))}

      {fullText.length > 0 && (
        <div
          className={`${styles.assistantText} ${isStreaming ? "kz-caret" : ""}`}
        >
          <Markdown content={fullText} />
        </div>
      )}

      {message.error && (
        <p className={styles.errorMsg}>{message.error}</p>
      )}
    </div>
  );
}
