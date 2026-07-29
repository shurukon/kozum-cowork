/**
 * Kozum Cowork — Code-mode home screen.
 *
 * Clean greeting + composer. The stats/activity grid has been removed:
 * it only ever showed zeros (the data was never wired) and the user
 * explicitly asked for it to go.
 *
 * The composer here mirrors HomeView's: auto-growing textarea, Enter sends,
 * Shift+Enter newline, IME-safe, model label, send button, and a slot for
 * the permission picker.
 */

import { useRef, useState } from "react";
import { ArrowUp, ChevronDown, Plus } from "lucide-react";
import styles from "./CodeHome.module.css";

// ── Props ─────────────────────────────────────────────────────────────────

interface Props {
  userName: string;
  modelLabel: string;
  onSubmit: (text: string) => void;
  onPickModel: () => void;
  onAttach: () => void;
  isRunning?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────

export function CodeHome({
  userName,
  modelLabel,
  onSubmit,
  onPickModel,
  onAttach,
  isRunning = false,
}: Props) {
  const [value, setValue] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);

  const heading = userName
    ? `What's up next, ${userName}?`
    : "What are we building?";

  function submit() {
    const text = value.trim();
    if (!text || isRunning) return;
    onSubmit(text);
    setValue("");
    if (ta.current) ta.current.style.height = "auto";
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  function autoGrow(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }

  return (
    <div className={`${styles.wrap} kz-dotfield kz-dotfield-fade`}>
      <div className={styles.inner}>
        {/* Greeting */}
        <h1 className={styles.heading}>
          <img
            src="./icons/mark-32.png"
            alt=""
            width={26}
            height={26}
            className={styles.mark}
          />
          <span>{heading}</span>
        </h1>

        {/* Composer */}
        <div className={styles.composerShell}>
          <div className={`${styles.composer} ${isRunning ? styles.composerRunning : ""}`}>
            <textarea
              ref={ta}
              className={styles.input}
              placeholder={isRunning ? "Waiting for agent…" : "Describe what you want to build or fix…"}
              value={value}
              onChange={autoGrow}
              onKeyDown={onKeyDown}
              rows={1}
              disabled={isRunning}
              spellCheck={false}
              aria-label="Message"
            />

            <div className={styles.row}>
              <button
                className={styles.attach}
                aria-label="Add files"
                title="Add files"
                onClick={onAttach}
                disabled={isRunning}
              >
                <Plus size={17} />
              </button>

              <div className={styles.rowRight}>
                <button className={styles.model} onClick={onPickModel}>
                  <span>{modelLabel}</span>
                  <ChevronDown size={14} />
                </button>
                <button
                  className={styles.send}
                  onClick={submit}
                  disabled={!value.trim() || isRunning}
                  aria-label="Send"
                >
                  <ArrowUp size={16} />
                </button>
              </div>
            </div>
          </div>

          {/* In-flight indicator: thin sweep along the composer's bottom edge */}
          {isRunning && (
            <div className={styles.inflight} aria-hidden={true} />
          )}
        </div>
      </div>
    </div>
  );
}
