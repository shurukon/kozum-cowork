/**
 * AskDock — the fixed ask/permission panel directly above the composer.
 *
 * Product decisions baked in here:
 * - ONE request at a time (FIFO). The first pending permission or question is
 *   shown; everything else collapses into an "n of m" counter until answered.
 * - Neutral surfaces only (--bg-card / --border-subtle) with NO blue accent,
 *   in both Cowork and Code shells.
 * - Permission cards use full-width stacked option rows and a shield icon.
 *   Question cards reuse QuestionFormView's full-width selectable rows.
 *
 * The dock replaces all inline transcript prompt rendering: tool cards simply
 * show their running state while awaiting approval.
 */

import { useState } from "react";
import { Check, ShieldQuestion } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PendingPermission, PendingQuestion } from "../store/session.ts";
import { QuestionFormView } from "./QuestionFormView.tsx";
import styles from "./AskDock.module.css";

export type AskDockDecision = "allow_once" | "allow_always" | "deny";

export interface AskDockProps {
  permissions: PendingPermission[];
  questions: PendingQuestion[];
  /** Send the decision through the existing reply path. */
  onPermissionDecision: (requestId: string, decision: AskDockDecision) => void;
  /** Send chosen values through the existing reply path ("__skipped__" = skip). */
  onQuestionAnswer: (requestId: string, values: string[]) => void;
}

/** Compact monospace preview of the pending input, capped at ~3 lines. */
function InputPreview({ input }: { input: unknown }) {
  let text: string;
  if (
    input !== null &&
    typeof input === "object" &&
    typeof (input as Record<string, unknown>)["command"] === "string"
  ) {
    const rec = input as Record<string, unknown>;
    const rest = Object.entries(rec).filter(([k]) => k !== "command");
    text =
      `$ ${(rec["command"] as string).trim()}` +
      (rest.length > 0 ? `\n${JSON.stringify(Object.fromEntries(rest), null, 2)}` : "");
  } else {
    try {
      text = JSON.stringify(input, null, 2) ?? String(input);
    } catch {
      text = String(input);
    }
  }
  const lines = text.split("\n");
  const clipped = lines.slice(0, 3);
  return (
    <pre className={styles.preview}>
      {clipped.join("\n")}
      {lines.length > 3 ? "\n…" : ""}
    </pre>
  );
}

function Counter({ current, total }: { current: number; total: number }) {
  if (total <= 1) return null;
  return (
    <span className={styles.counter}>
      {current} of {total}
    </span>
  );
}

export function AskDock({
  permissions,
  questions,
  onPermissionDecision,
  onQuestionAnswer,
}: AskDockProps) {
  const { t } = useTranslation();
  const [expandedPreview, setExpandedPreview] = useState(false);

  // Permissions are the serialized gate, so they take precedence; questions
  // queue behind them. Total drives the "n of m" counter either way.
  const total = permissions.length + questions.length;
  if (total === 0) return null;

  const permission = permissions[0];
  const question = permission ? undefined : questions[0];

  return (
    <div className={styles.dock} role="region" aria-label={t("askDock.title")}>
      <div className={styles.headerRow}>
        <span className={styles.headerLabel}>{t("askDock.title")}</span>
        <Counter current={1} total={total} />
        <span className={styles.queueNote}>
          {total > 1 ? t("askDock.queued", { count: total - 1 }) : ""}
        </span>
      </div>

      {permission && (
        <section className={styles.card} aria-live="assertive">
          <div className={styles.titleRow}>
            <ShieldQuestion size={15} className={styles.shield} aria-hidden="true" />
            <span className={styles.title}>
              <strong>{permission.toolName}</strong> {t("askDock.needsApproval")}
            </span>
          </div>
          {permission.reason && <p className={styles.reason}>{permission.reason}</p>}
          {permission.input !== null && permission.input !== undefined && (
            <button
              type="button"
              className={`${styles.previewToggle} ${expandedPreview ? styles.previewExpanded : ""}`}
              onClick={() => setExpandedPreview((v) => !v)}
              aria-expanded={expandedPreview}
              title={expandedPreview ? t("askDock.collapseInput") : t("askDock.expandInput")}
            >
              {expandedPreview ? (
                <span className={styles.previewFull}>{JSON.stringify(permission.input, null, 2)}</span>
              ) : (
                <InputPreview input={permission.input} />
              )}
            </button>
          )}
          <div className={styles.rows}>
            <button
              type="button"
              className={`${styles.rowBtn} ${styles.allowOnce}`}
              onClick={() => onPermissionDecision(permission.requestId, "allow_once")}
            >
              <Check size={14} aria-hidden="true" />
              {t("askDock.allowOnce")}
            </button>
            <button
              type="button"
              className={`${styles.rowBtn} ${styles.allowAlways}`}
              onClick={() => onPermissionDecision(permission.requestId, "allow_always")}
            >
              {t("askDock.allowAlways")}
            </button>
            <button
              type="button"
              className={`${styles.rowBtn} ${styles.deny}`}
              onClick={() => onPermissionDecision(permission.requestId, "deny")}
            >
              {t("common.deny")}
            </button>
          </div>
        </section>
      )}

      {!permission && question && (
        <section className={styles.card} aria-live="assertive">
          <div className={styles.questionWrap}>
            <QuestionFormView
              question={question}
              onAnswer={(values) => onQuestionAnswer(question.requestId, values)}
            />
          </div>
        </section>
      )}
    </div>
  );
}

export default AskDock;
