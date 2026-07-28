/**
 * Cowork / Code home screen.
 *
 * Deliberately sparse: a greeting, one input, and the model selector. The
 * reference app earns its calm by resisting the urge to put anything else on
 * this screen, and the dot field does the visual work that chrome would
 * otherwise have to.
 */

import { useRef, useState } from "react";
import { ArrowUp, ChevronDown, FolderOpen, Plus } from "lucide-react";

import type { Mode } from "@shared/types.ts";
import styles from "./HomeView.module.css";

interface Props {
  mode: Mode;
  userName: string;
  modelLabel: string;
  onSubmit: (text: string) => void;
  onPickModel: () => void;
}

export function HomeView({ mode, userName, modelLabel, onSubmit, onPickModel }: Props) {
  const [value, setValue] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);

  const heading =
    mode === "cowork"
      ? "What can I take off your plate?"
      : userName
        ? `What's up next, ${userName}?`
        : "What are we building?";

  function submit() {
    const text = value.trim();
    if (!text) return;
    onSubmit(text);
    setValue("");
    // Collapse the grown textarea back to one row after sending.
    if (ta.current) ta.current.style.height = "auto";
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline. IME composition must never be
    // interrupted, or Arabic/CJK input gets sent mid-word.
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

        <p className={styles.sub}>
          <a href="#" onClick={(e) => e.preventDefault()}>
            Learn how to use Kozum safely.
          </a>
        </p>

        <div className={styles.composerShell}>
          <div className={styles.composer}>
            <textarea
              ref={ta}
              className={styles.input}
              placeholder="How can I help you today?"
              value={value}
              onChange={autoGrow}
              onKeyDown={onKeyDown}
              rows={1}
              spellCheck={false}
              aria-label="Message"
            />

            <div className={styles.row}>
              <button className={styles.attach} aria-label="Add context">
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
                  disabled={!value.trim()}
                  aria-label="Send"
                >
                  <ArrowUp size={16} />
                </button>
              </div>
            </div>
          </div>

          <button className={styles.folder}>
            <FolderOpen size={14} />
            <span>Work in a project or folder</span>
            <ChevronDown size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
