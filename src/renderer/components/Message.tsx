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
 * - Thinking block live and settled states stay inline in the transcript with
 *   a quiet status treatment; no separate thinking window or overlay is used.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Copy, Pencil, RotateCcw } from "lucide-react";
import type {
  Message as MessageType,
  ContentBlock,
  Mode,
} from "@shared/types.ts";
import { useTranslation } from "react-i18next";
import type { ToolCard as ToolCardType, PendingQuestion, PendingPermission } from "../store/session.ts";
import { ToolCard } from "./ToolCard.tsx";
import { QuestionFormView } from "./QuestionFormView.tsx";
import { PermissionBanner } from "./PermissionBanner.tsx";
import { Markdown } from "./Markdown.tsx";
import { ToolGlyph } from "./ToolGlyph.tsx";
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
    // Live state: compact inline status row + streaming reasoning text.
    return (
      <div
        className={styles.thinkingLive}
        aria-live="polite"
        aria-label="Thinking"
      >
        <div className={styles.thinkingLiveHeader}>
          <span className={styles.thinkingOrbWrap}>
            <video
              className={styles.thinkingHalo}
              src="/assets/thinking-halo.mp4"
              autoPlay
              loop
              muted
              playsInline
              aria-hidden="true"
            />
            <span className={`${styles.thinkingFallbackOrb} kz-orb-pulse`} aria-hidden={true} />
          </span>
          <span className={styles.thinkingLiveLabel}>{t("message.thinking")}</span>
        </div>
        {text.length > 0 && (
          <p className={styles.thinkingStream}>{text}</p>
        )}
      </div>
    );
  }

  // Settled state: collapsible inline summary inside the assistant turn.
  const summary = elapsed > 0 ? t("message.thought", { seconds: elapsed }) : t("message.thinking");
  return (
    <div className={styles.thinking}>
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
  mode: Mode;
  message: MessageType;
  isStreaming: boolean;
  toolCards: Map<string, ToolCardType>;
  /** Tool cards that have no persisted tool_use block; supplied once by ChatView. */
  orphanToolCards?: ToolCardType[];
  /** Pending question prompts whose messageId === this message's id. */
  pendingQuestions?: PendingQuestion[];
  /** Pending permission prompts whose messageId === this message's id. */
  pendingPermissions?: PendingPermission[];
  /** Optional: emit when a file chip is clicked in a ToolCard */
  onOpenFile?: (path: string) => void;
  /** Optional: open a preview for an image, file, URL, or browser result. */
  onPreview?: (target: import("./PreviewPanel.tsx").PreviewTarget) => void;
  /** Reply to a pending question / permission from the browser IPC. */
  onReply?: (requestId: string, answer: string[]) => void;
  /** Resolve a pending question in the local store (collapses the form). */
  onResolveQuestion?: (requestId: string) => void;
  /** Copy a user message's text without opening a popup. */
  onCopyMessage?: (text: string) => void;
  /** Replace a user turn by branching before it and pre-filling the composer. */
  onEditMessage?: (messageId: string, text: string) => void;
  /** Retry a user turn through the existing send path. */
  onRetryMessage?: (text: string) => void;
}

function isToolResultOnly(content: ContentBlock[]): boolean {
  return content.length > 0 && content.every((b) => b.type === "tool_result");
}

export function Message({
  mode,
  message,
  isStreaming,
  toolCards,
  orphanToolCards = [],
  pendingQuestions,
  pendingPermissions,
  onOpenFile,
  onPreview,
  onReply,
  onResolveQuestion,
  onCopyMessage,
  onEditMessage,
  onRetryMessage,
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

    const userText = message.content
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    const hasText = userText.length > 0;
    return (
      <div className={styles.userRow}>
        <div className={styles.userMessageGroup}>
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
          {hasText && (onCopyMessage || onEditMessage || onRetryMessage) && (
            <div className={styles.userMessageActions} aria-label="Message actions">
              {onCopyMessage && (
                <button type="button" className={styles.messageAction} onClick={() => onCopyMessage(userText)} aria-label="Copy message" title="Copy message">
                  <Copy size={13} aria-hidden="true" />
                </button>
              )}
              {onEditMessage && (
                <button type="button" className={styles.messageAction} onClick={() => onEditMessage(message.id, userText)} aria-label="Edit message" title="Edit message">
                  <Pencil size={13} aria-hidden="true" />
                </button>
              )}
              {onRetryMessage && (
                <button type="button" className={styles.messageAction} onClick={() => onRetryMessage(userText)} aria-label="Retry message" title="Retry message">
                  <RotateCcw size={13} aria-hidden="true" />
                </button>
              )}
            </div>
          )}
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
  // ChatView assigns orphan cards to exactly one assistant turn. Do not derive
  // this from the global toolCards map here: every later assistant message would
  // otherwise render the same live card again (the visible task duplication bug).
  const unreflectedToolCards = orphanToolCards;
  const unmatchedPermissions = myPermissions.filter(
    (p) => !toolUseBlocks.some((b) => b.type === "tool_use" && b.id === p.toolUseId),
  );
  const hasActivity =
    thinkingBlocks.length > 0 ||
    toolUseBlocks.length > 0 ||
    unreflectedToolCards.length > 0 ||
    myQuestions.length > 0 ||
    unmatchedPermissions.length > 0;

  return (
    <div className={`${styles.assistantRow} ${mode === "cowork" ? styles.coworkAssistantRow : ""} kz-anim-rise`}>
      {isSubagentMessage && (
        <span className={styles.subagentBadge}>{t("message.bySubagent")}</span>
      )}

      {hasActivity && (
        <div className={styles.activityTimeline} aria-label="Activity timeline">
          {thinkingBlocks.map((b, i) =>
            b.type === "thinking" ? (
              <div className={styles.activityStep} key={`thinking-${i}`}>
                <div
                  className={`${styles.activityMarker} ${isStreaming ? styles.activityMarkerLive : styles.activityMarkerDone}`}
                  aria-hidden="true"
                >
                  <span className={isStreaming ? styles.activityPulse : styles.activityCheck} />
                </div>
                <div className={styles.activityContent}>
                  <ThinkingBlock text={b.text} isStreaming={isStreaming} />
                </div>
              </div>
            ) : null,
          )}

          {/* Tool calls stay in the same vertical timeline as thinking. */}
          {toolUseBlocks.map((b) => {
            if (b.type !== "tool_use") return null;
            const card = toolCards.get(b.id);
            if (!card) return null;
            return (
              <div className={styles.activityStep} key={b.id}>
                <div className={`${styles.activityMarker} ${styles.activityMarkerTool}`} aria-hidden="true">
                  <ToolGlyph toolName={card.name} size={15} />
                </div>
                <div className={styles.activityContent}>
                  <ToolCard
                    card={card}
                    inline
                    onOpenFile={onOpenFile}
                    onPreview={onPreview}
                    pendingPermissions={myPermissions.filter((p) => p.toolUseId === b.id)}
                    onReply={onReply}
                  />
                </div>
              </div>
            );
          })}

          {unreflectedToolCards.map((card) => (
            <div className={styles.activityStep} key={card.toolUseId}>
              <div className={styles.activityMarker} aria-hidden="true">
                <ToolGlyph toolName={card.name} size={15} />
              </div>
              <div className={styles.activityContent}>
                <ToolCard
                  card={card}
                  inline
                  onOpenFile={onOpenFile}
                  onPreview={onPreview}
                  pendingPermissions={myPermissions.filter((p) => p.toolUseId === card.toolUseId)}
                  onReply={onReply}
                />
              </div>
            </div>
          ))}

          {myQuestions.map((q) => (
            <div className={styles.activityStep} key={q.requestId}>
              <div className={styles.activityMarker} aria-hidden="true"><span className={styles.activityQuestion}>?</span></div>
              <div className={styles.activityContent}>
                <QuestionFormView
                  question={q}
                  onAnswer={(values) => {
                    onReply?.(q.requestId, values);
                    onResolveQuestion?.(q.requestId);
                  }}
                />
              </div>
            </div>
          ))}

          {unmatchedPermissions.map((p) => (
            <div className={styles.activityStep} key={p.requestId}>
              <div className={styles.activityMarker} aria-hidden="true"><span className={styles.activityQuestion}>!</span></div>
              <div className={styles.activityContent}>
                <PendingPermissionInline permission={p} onReply={onReply} />
              </div>
            </div>
          ))}
        </div>
      )}

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
        <div className={styles.assistantBubbleLine}>
          {hasActivity && (
            <span
              className={styles.contextDot}
              title="Context used"
              aria-label="Context used"
            />
          )}
          <div
            className={`${styles.assistantText} ${isStreaming ? "kz-caret" : ""}`}
          >
            <Markdown content={fullText} />
          </div>
        </div>
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
