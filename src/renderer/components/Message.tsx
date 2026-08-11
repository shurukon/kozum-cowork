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
import { ChevronDown, ChevronRight, FileText, Zap, AlertTriangle, CircleStop } from "lucide-react";
import type { ReactNode } from "react";
import type {
  Message as MessageType,
  ContentBlock,
  TokenUsage,
  StopReason,
} from "@shared/types.ts";
import { useTranslation } from "react-i18next";
import type { ToolCard as ToolCardType, PendingQuestion, PendingPermission } from "../store/session.ts";
import { ToolCard } from "./ToolCard.tsx";
import { QuestionFormView } from "./QuestionFormView.tsx";
import { PermissionBanner } from "./PermissionBanner.tsx";
import { Markdown } from "./Markdown.tsx";
import styles from "./Message.module.css";

// ── ThinkingBlock ─────────────────────────────────────────────────────────

interface ThinkingBlockProps {
  text: string;
  isStreaming: boolean;
}

function ThinkingBlock({ text, isStreaming }: ThinkingBlockProps) {
  const { t } = useTranslation();
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
          {/* kz-think-orb from glass.css: gradient breathing dot.
             Wrap in positioned span so kz-orb-pulse can halo it. */}
          <span className={styles.thinkingOrbWrap}>
            <span className="kz-orb-pulse" aria-hidden={true} />
            <span className="kz-think-orb" aria-hidden={true} />
         </span>
          <span className={styles.thinkingLiveLabel}>{t("message.thinking")}</span>
        </div>
        {text.length > 0 && (
          <p className={styles.thinkingStream}>{text}</p>
        )}
      </div>
    );
  }

  // Settled state: collapsible summary with glass treatment.
  const summary = elapsed > 0 ? t("message.thought", { seconds: elapsed }) : t("message.thinking");
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
  /** Pending question prompts whose messageId === this message's id. */
  pendingQuestions?: PendingQuestion[];
  /** Pending permission prompts whose messageId === this message's id. */
  pendingPermissions?: PendingPermission[];
  /** Optional: emit when a file chip is clicked in a ToolCard */
  onOpenFile?: (path: string) => void;
  /** Reply to a pending question / permission from the browser IPC. */
  onReply?: (requestId: string, answer: string[]) => void;
  /** Resolve a pending question in the local store (collapses the form). */
  onResolveQuestion?: (requestId: string) => void;
}

function isToolResultOnly(content: ContentBlock[]): boolean {
  return content.length > 0 && content.every((b) => b.type === "tool_result");
}

export function Message({
  message,
  isStreaming,
  toolCards,
  pendingQuestions,
  pendingPermissions,
  onOpenFile,
  onReply,
  onResolveQuestion,
}: Props) {
  const { t } = useTranslation();
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
    // Pure tool_result user messages are the tool-result echoes that close each
    // tool round. Rendering them as empty right-aligned bubbles looked broken,
    // so render a compact inline result list instead (§4.1). A mix of text +
    // tool_result (rare) renders the text bubble normally.
    if (isToolResultOnly(message.content)) {
      return (
        <div className={styles.toolResultRow}>
          {message.content.map((block, i) => {
            if (block.type !== "tool_result") return null;
            const card = toolCards.get(block.toolUseId);
            const file = card?.result?.display?.files?.[0];
            const summary = card?.result?.display?.summary ?? `tool ${block.toolUseId}`;
            return (
              <div key={i} className={styles.toolResultChip}>
                <span className={styles.toolResultArrow} aria-hidden="true">→</span>
                {file ? (
                  <button
                    type="button"
                    className={styles.toolResultFileChip}
                    onClick={() => onOpenFile?.(file)}
                    title={file}
                  >
                    <FileText size={11} aria-hidden="true" />
                    <span className={styles.toolResultFileName}>{file.split(/[\\/]/).pop()}</span>
                  </button>
                ) : (
                  <span className={styles.toolResultSummary}>{summary}</span>
                )}
              </div>
            );
          })}
        </div>
      );
    }

    const hasText = message.content.some((b) => b.type === "text");
    return (
      <div className={styles.userRow}>
        <div className={`${styles.userBubble} ${sendAck ? "kz-send-ack" : ""}`}>
          {message.content.map((block, i) => {
            if (block.type === "text") {
              return <p key={i} className={styles.userText}>{block.text}</p>;
            }
            if (block.type === "image" && !hasText) {
              return (
                <img
                  key={i}
                  src={`data:${block.mimeType};base64,${block.data}`}
                  alt=""
                  className={styles.inlineImage}
                />
              );
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
  const imageBlocks = message.content.filter((b) => b.type === "image");

  const fullText = textBlocks
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");

  // Pending questions/permissions anchored to THIS message (matched by id).
  const myQuestions = (pendingQuestions ?? []).filter(
    (q) => q.messageId === message.id,
  );
  const myPermissions = (pendingPermissions ?? []).filter(
    (p) => p.messageId === message.id,
  );

  // P1-1: show a subtle badge when the message was produced by a subagent.
  const isSubagentMessage = Boolean(message.runId);

  return (
    <div className={`${styles.assistantRow} kz-anim-rise`}>
      {isSubagentMessage && (
        <span className={styles.subagentBadge}>{t("message.bySubagent")}</span>
      )}
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
        return (
          <ToolCard
            key={b.id}
            card={card}
            onOpenFile={onOpenFile}
            pendingPermissions={myPermissions.filter((p) => p.toolUseId === b.id)}
            onReply={onReply}
          />
        );
      })}

      {/* Also render any cards that haven't yet been reflected back as tool_use blocks */}
      {Array.from(toolCards.values())
        .filter((c) => !toolUseBlocks.some((b) => b.type === "tool_use" && b.id === c.toolUseId))
        .map((c) => (
          <ToolCard
            key={c.toolUseId}
            card={c}
            onOpenFile={onOpenFile}
            pendingPermissions={myPermissions.filter((p) => p.toolUseId === c.toolUseId)}
            onReply={onReply}
          />
        ))}

      {/* Pending questions appear after the tool cards, before final text (§2.4) */}
      {myQuestions.map((q) => (
        <QuestionFormView
          key={q.requestId}
          question={q}
          onAnswer={(values) => {
            onReply?.(q.requestId, values);
            onResolveQuestion?.(q.requestId);
          }}
        />
      ))}

      {/* Any permission prompts that did not match a tool card render inline at
          the bottom of the message (degraded-but-safe fallback, §8 edge case). */}
      {myPermissions
        .filter((p) => !toolUseBlocks.some((b) => b.type === "tool_use" && b.id === p.toolUseId))
        .map((p) => (
          <PendingPermissionInline
            key={p.requestId}
            permission={p}
            onReply={onReply}
          />
        ))}

      {/* Image blocks (screenshots returned into context) render inline (§4.1) */}
      {imageBlocks.length > 0 && (
        <div className={styles.imageRow}>
          {imageBlocks.map((b, i) =>
            b.type === "image" ? (
              <img
                key={i}
                src={`data:${b.mimeType};base64,${b.data}`}
                alt=""
                className={styles.inlineImage}
              />
            ) : null,
          )}
        </div>
      )}

      {fullText.length > 0 && (
        <div
          className={`${styles.assistantText} ${isStreaming ? "kz-caret" : ""}`}
        >
          <Markdown content={fullText} />
        </div>
      )}

      {!isStreaming && (message.usage || message.stopReason) && (
        <TurnFooter usage={message.usage} stopReason={message.stopReason} model={message.model} />
      )}

      {message.error && (
        <p className={styles.errorMsg}>{message.error}</p>
      )}
    </div>
  );
}

// ── PendingPermissionInline fallback ─────────────────────────────────────────
//
// Rendered only when a permission_request event's toolUseId did not match any
// tool card's id (e.g. the tool_use block for that tool was already pruned).
// Uses the same PermissionBanner component the ToolCard renders for the matched
// case, so the visuals stay consistent across both paths.

function PendingPermissionInline({
  permission,
  onReply,
}: {
  permission: PendingPermission;
  onReply?: (requestId: string, answer: string[]) => void;
}) {
  return (
    <PermissionBanner
      reason={permission.reason}
      toolName={permission.toolName}
      onAllow={() => onReply?.(permission.requestId, ["yes"])}
      onDeny={() => onReply?.(permission.requestId, ["no"])}
    />
  );
}

// ── TurnFooter ───────────────────────────────────────────────────────────────
//
// F-3: compact muted footer appended to a settled assistant turn. Shows the
// input/output/cache token counts, the stop reason, and the model name.

function formatTokens(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return String(n);
}

const STOP_REASON_KEY: Record<StopReason, string> = {
  end_turn: "message.stopCompleted",
  tool_use: "message.stopToolCall",
  max_tokens: "message.stopMaxTokens",
  stop_sequence: "message.stopCompleted",
  cancelled: "message.stopCancelled",
  error: "message.stopErrored",
};

interface TurnFooterProps {
  usage?: TokenUsage;
  stopReason?: StopReason;
  model?: string;
}

function TurnFooter({ usage, stopReason, model }: TurnFooterProps): ReactNode {
  const { t } = useTranslation();
  return (
    <div className={styles.turnFooter} aria-label="Turn metadata">
      <Zap size={11} className={styles.footerIcon} aria-hidden={true} />
      <span className={styles.footerTokens}>
        {usage ? (
          <>
            <span className={styles.footerTokenIn}>
              {t("message.tokensIn")} {formatTokens(usage.inputTokens)}
            </span>
            <span className={styles.footerTokenArrow} aria-hidden={true}>→</span>
            <span className={styles.footerTokenOut}>
              {t("message.tokensOut")} {formatTokens(usage.outputTokens)}
            </span>
            {usage.cacheReadTokens !== undefined && usage.cacheReadTokens > 0 && (
              <span className={styles.footerTokenCache}>
                · {t("message.cached")} {formatTokens(usage.cacheReadTokens)}
              </span>
            )}
          </>
        ) : null}
      </span>
      {stopReason && (
        <span className={`${styles.footerStop} ${stopReason === "error" || stopReason === "cancelled" ? styles.footerStopWarn : ""}`}>
          {stopReason === "error" || stopReason === "cancelled" ? (
            <AlertTriangle size={10} aria-hidden={true} />
          ) : (
            <CircleStop size={10} aria-hidden={true} />
          )}
          {t(STOP_REASON_KEY[stopReason])}
        </span>
      )}
      {model && (
        <span className={styles.footerModel} title={model}>{model}</span>
      )}
    </div>
  );
}
