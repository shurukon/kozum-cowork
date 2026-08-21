/**
 * QuestionFormView — inline question prompt embedded in an assistant message.
 *
 * Rendered by Message.tsx whenever a `question` AgentEvent is pending and the
 * event was attached to that message (matched via `messageId`). After the user
 * picks an option (or skips), the form collapses into a one-line brief and the
 * store's `pendingQuestions` entry is resolved so the card does not re-render.
 */

import { useState } from "react";
import { Check, ChevronRight, Slash } from "lucide-react";
import type { PendingQuestion } from "../store/sessionTypes.ts";
import styles from "./QuestionFormView.module.css";

export interface QuestionFormViewProps {
  question: PendingQuestion;
  /** Called with the chosen value(s). Use ["__skipped__"] for the skip path. */
  onAnswer: (values: string[]) => void;
}

const SKIPPED = "__skipped__";

export function QuestionFormView({ question, onAnswer }: QuestionFormViewProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [freeform, setFreeform] = useState("");
  const [submitted, setSubmitted] = useState<string[] | null>(null);

  if (submitted) {
    // Collapsed brief: "Answered: label1 · label2" (or Skipped).
    const isSkip = submitted.length === 1 && submitted[0] === SKIPPED;
    const labels = isSkip
      ? "Skipped"
      : submitted
          .map(
            (v) =>
              question.options.find((o) => o.value === v)?.label ??
              v,
          )
          .join(" · ");
    return (
      <div className={styles.brief} role="status" aria-live="polite">
        <ChevronRight size={12} className={styles.briefIcon} aria-hidden="true" />
        <span className={styles.briefLabel}>Answered:</span>
        <span className={styles.briefValue}>{labels}</span>
      </div>
    );
  }

  const toggle = (value: string) => {
    if (question.multiSelect) {
      setSelected((prev) =>
        prev.includes(value)
          ? prev.filter((v) => v !== value)
          : [...prev, value],
      );
    } else {
      setSelected([value]);
    }
  };

  const submit = () => {
    const values = question.allowFreeform && freeform.trim()
      ? [freeform.trim()]
      : selected;
    if (values.length === 0) return;
    setSubmitted(values);
    onAnswer(values);
  };

  const skip = () => {
    setSubmitted([SKIPPED]);
    onAnswer([SKIPPED]);
  };

  return (
    <div className={styles.root} role="group" aria-label={question.question}>
      <p className={styles.question}>{question.question}</p>

      {question.allowFreeform ? (
        <input
          type="text"
          className={styles.freeformInput}
          value={freeform}
          onChange={(event) => setFreeform(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && freeform.trim()) submit();
          }}
          placeholder="Type your answer…"
          aria-label="Answer"
        />
      ) : null}

      <div className={styles.options}>
        {question.options.map((o) => {
          const checked = selected.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              role={question.multiSelect ? "checkbox" : "radio"}
              aria-checked={checked}
              className={`${styles.option} ${checked ? styles.optionSelected : ""}`}
              onClick={() => toggle(o.value)}
            >
              <span className={styles.optionMark} aria-hidden="true">
                {checked ? <Check size={12} /> : null}
              </span>
              <span className={styles.optionLabel}>{o.label}</span>
            </button>
          );
        })}
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.submitBtn}
          onClick={submit}
          disabled={selected.length === 0 && !(question.allowFreeform && freeform.trim())}
        >
          Submit
        </button>
        <button type="button" className={styles.skipBtn} onClick={skip}>
          <Slash size={12} aria-hidden="true" />
          Skip
        </button>
      </div>
    </div>
  );
}
