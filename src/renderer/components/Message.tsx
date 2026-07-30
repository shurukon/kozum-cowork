/**
 * Kozum Cowork — one message turn.
 *
 * Renders user messages (plain text, right-aligned) and assistant turns
 * (markdown, tool cards, thinking blocks). Streaming text gets the kz-caret
 * class while in-flight.
 *
 * Changes in this version:
 * - User bubbles gain `kz-send-ack` on first mount for the "message received"
 *   light-ring feedback the user was missing.
 * - Thinking block live state uses `.kz-think-orb` breathing dot from glass.css
 *   plus a glass-panel treatment around the reasoning text.
 * - Settled thinking block gains the glass surface class for consistency.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Message as MessageType } from "@shared/types.ts";
import type { ToolCard as ToolCardType } from "../store/session.ts";
import { ToolCard } from "./ToolCard.tsx";
import { Markdown } from "./Markdown.tsx";
import styles from "./Message.module.css";

// ── ThinkingBlock ─────────────────────────────────────────────────────────

interface ThinkingBlockProps {
  text: string;
  isStreaming: boolean;
}

function ThinkingBlock({ text, isStreaming }: ThinkingBlockProps) {
  const [open, setOpen] = useState(false);
  const startRef = useRef<number>(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isStreaming) {
      setElapsed(Math.round((Date.now() - startRef.current) / 1000));
      return;
    }
    const id = setInterval(() => {
      setElapsed(Math.round((Date.now() - startRef.current) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [isStreaming]);

  if (isStreaming) {
    // Live state: kz-think-orb breathing dot + glass panel + streaming italic text.
    return (
      <div
        className={`${styles.thinkingLive} kz-glass kz-glass-busy`}
        aria-live="polite"
        aria-label="Thinking"
      >
        <div className={styles.thinkingLiveHeader}>
          {/* kz-think-orb from glass.css: gradient breathing dot */}
          <span className="kz-think-orb" aria-hidden={true} />
          <span className={styles.thinkingLiveLabel}>Thinking…</span>
        </div>
        {text.length > 0 && (
          <p className={styles.thinkingStream}>{text}</p>
        )}
      </div>
    );
  }

  // Settled state: collapsible summary with glass treatment.
  const summary = elapsed > 0 ? `Thought for ${elapsed}s` : "Thought";
  return (
    <div className={`${styles.thinking} kz-glass kz-glass-sweep`}>
      <button
        className={styles.thinkingToggle}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{summary}</span>
      </button>
      {open && (
        <pre className={styles.thinkingBody}>{text}</pre>
      )}
    </div>
  );
}

// ── Message ───────────────────────────────────────────────────────────────

interface Props {
  message: MessageType;
  isStreaming: boolean;
  toolCards: Map<string, ToolCardType>;
  /** Optional: emit when a file chip is clicked in a ToolCard */
  onOpenFile?: (path: string) => void;
}

export function Message({ message, isStreaming, toolCards, onOpenFile }: Props) {
  // Track whether this is the very first mount so we can add kz-send-ack once.
  const isMountedRef = useRef(false);
  const [sendAck, setSendAck] = useState(false);

  useEffect(() => {
    if (message.role === "user" && !isMountedRef.current) {
      isMountedRef.current = true;
      setSendAck(true);
      // Remove the class after the animation ends so it doesn't replay.
      const timer = setTimeout(() => setSendAck(false), 900);
      return () => clearTimeout(timer);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — intentionally run once

  if (message.role === "user") {
    return (
      <div className={styles.userRow}>
        <div className={`${styles.userBubble} ${sendAck ? "kz-send-ack" : ""}`}>
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
          <ThinkingBlock key={i} text={b.text} isStreaming={isStreaming} />
        ) : null,
      )}

      {/* Tool cards — render before the final text so they appear in turn order */}
      {toolUseBlocks.map((b) => {
        if (b.type !== "tool_use") return null;
        const card = toolCards.get(b.id);
        if (!card) return null;
        return <ToolCard key={b.id} card={card} onOpenFile={onOpenFile} />;
      })}

      {/* Also render any cards that haven't yet been reflected back as tool_use blocks */}
      {Array.from(toolCards.values())
        .filter((c) => !toolUseBlocks.some((b) => b.type === "tool_use" && b.id === c.toolUseId))
        .map((c) => (
          <ToolCard key={c.toolUseId} card={c} onOpenFile={onOpenFile} />
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
