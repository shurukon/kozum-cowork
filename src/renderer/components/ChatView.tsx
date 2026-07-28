/**
 * Kozum Cowork — chat transcript + composer.
 *
 * Manages auto-scroll: follows the latest message but stops if the user
 * scrolls up. A "Jump to latest" pill appears when not at the bottom.
 */

import { useEffect, useRef, useState, useCallback, type KeyboardEvent, type ChangeEvent } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Plus, Square } from "lucide-react";
import type { Mode } from "@shared/types.ts";
import { useSessionStore } from "../store/session.ts";
import { Message } from "./Message.tsx";
import styles from "./ChatView.module.css";

interface Props {
  mode: Mode;
  sessionId: string;
  onSend: (text: string) => void;
  onCancel: () => void;
  onPickModel: () => void;
  modelLabel: string;
}

const SCROLL_THRESHOLD = 80; // px from bottom before we consider "scrolled up"

export function ChatView({ mode, sessionId, onSend, onCancel, onPickModel, modelLabel }: Props) {
  const modeState = useSessionStore((s) => s[mode]);
  const { messages, streamingMessageId, toolCards } = modeState;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [value, setValue] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Track whether the user has scrolled up.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distFromBottom < SCROLL_THRESHOLD);
  }, []);

  // Auto-scroll when new content arrives, unless user scrolled up.
  useEffect(() => {
    if (!atBottom) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, atBottom, toolCards]);

  function jumpToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setAtBottom(true);
  }

  const isRunning = streamingMessageId !== null;

  function submit() {
    const text = value.trim();
    if (!text || isRunning) return;
    onSend(text);
    setValue("");
    if (taRef.current) taRef.current.style.height = "auto";
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  function autoGrow(e: ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }


  return (
    <div className={styles.wrap}>
      {/* Transcript */}
      <div
        className={styles.transcript}
        ref={scrollRef}
        onScroll={handleScroll}
        data-session={sessionId}
      >
        <div className={styles.messages}>
          {messages.length === 0 && (
            <p className={styles.emptyHint}>
              {mode === "cowork"
                ? "Describe a task and Kozum will get to work."
                : "Describe what you want to build or fix."}
            </p>
          )}
          {messages.map((msg) => (
            <Message
              key={msg.id}
              message={msg}
              isStreaming={streamingMessageId === msg.id}
              toolCards={streamingMessageId === msg.id ? toolCards : new Map()}
            />
          ))}
        </div>
      </div>

      {/* Jump-to-latest pill */}
      {!atBottom && (
        <button
          className={styles.jumpPill}
          onClick={jumpToBottom}
          aria-label="Jump to latest"
        >
          <ArrowDown size={14} />
          <span>Latest</span>
        </button>
      )}

      {/* Composer */}
      <div className={styles.composerWrap}>
        <div className={styles.composer}>
          <textarea
            ref={taRef}
            className={styles.input}
            placeholder={isRunning ? "Waiting for agent…" : "Message…"}
            value={value}
            onChange={autoGrow}
            onKeyDown={onKeyDown}
            rows={1}
            disabled={isRunning}
            spellCheck={false}
            aria-label="Message"
          />

          <div className={styles.row}>
            <button className={styles.attach} aria-label="Add context" disabled={isRunning}>
              <Plus size={16} />
            </button>

            <div className={styles.rowRight}>
              <button className={styles.model} onClick={onPickModel}>
                <span>{modelLabel}</span>
                <ChevronDown size={13} />
              </button>

              {isRunning ? (
                <button
                  className={styles.stop}
                  onClick={onCancel}
                  aria-label="Stop"
                >
                  <Square size={12} />
                </button>
              ) : (
                <button
                  className={styles.send}
                  onClick={submit}
                  disabled={!value.trim()}
                  aria-label="Send"
                >
                  <ArrowUp size={15} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
