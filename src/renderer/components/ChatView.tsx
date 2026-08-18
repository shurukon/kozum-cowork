/**
 * Kozum Cowork — chat transcript + composer.
 *
 * Composes: Message list (with kz-send-ack and thinking animation) + ComposerBar
 * (with AddMenu and SelectorBar). Manages auto-scroll and the jump-to-latest pill.
 *
 * Props are a superset of the old interface to remain wirable by App.tsx:
 * - The old onAttach: () => void is replaced by onAttach: (kind) => void
 *   so the parent decides what each AddMenu item does.
 * - onPickModel is removed — model selection is now inline in SelectorBar.
 * - selection, presets, keysByProvider, modelsByProvider, onSelectionChange,
 *   onRefreshModels are new (passed through to ComposerBar → SelectorBar).
 * - permissionSlot is new (Code mode injects <PermissionPicker />).
 * - onOpenFile is new (forwarded to ToolCard file chips).
 */

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { ArrowDown } from "lucide-react";
import type {
  Mode,
  ModelSelection,
  ProviderPreset,
  ApiKeyEntry,
  ModelInfo,
} from "@shared/types.ts";
import { reconstructToolCards, useSessionStore } from "../store/session.ts";
import { Message } from "./Message.tsx";
import { ComposerBar } from "./ComposerBar.tsx";
import { PinnedTodoSlot } from "./PinnedTodoSlot.tsx";
import type { AddMenuKind } from "./AddMenu.tsx";
import type { PreviewTarget } from "./PreviewPanel.tsx";
import styles from "./ChatView.module.css";

// ── Props ──────────────────────────────────────────────────────────────────

export interface ChatViewProps {
  mode: Mode;
  sessionId: string;

  // Messaging
  onSend: (text: string) => void;
  onCancel: () => void;

  // Add menu (parent decides what each kind does)
  onAttach: (kind: AddMenuKind) => void;

  // Selection / model
  selection: ModelSelection;
  presets: ProviderPreset[];
  keysByProvider: Record<string, ApiKeyEntry[]>;
  modelsByProvider: Record<string, ModelInfo[]>;
  onSelectionChange: (next: ModelSelection) => void;
  onRefreshModels: (providerId: string) => Promise<ModelInfo[] | void>;

  /** Code mode passes a <PermissionPicker />; Cowork omits. */
  permissionSlot?: ReactNode;

  /** Optional Cowork-only project/folder picker rendered in the composer. */
  projectSlot?: ReactNode;

  /** Called when the user clicks a file chip inside a tool card. */
  onOpenFile?: (path: string) => void;

  /** Open a preview for a tool-produced image, file, URL, or browser result. */
  onPreview?: (target: PreviewTarget) => void;

  /** Reply to a pending question/permission via the bridge. */
  onReply?: (requestId: string, answer: string[]) => void;

  /** Drop a pending question from the local store (collapses the form). */
  onResolveQuestion?: (requestId: string) => void;
}

// ── Constants ──────────────────────────────────────────────────────────────

const SCROLL_THRESHOLD = 80; // px from bottom before "scrolled up"
const TAKING_LONGER_MS = 15_000;

// ── ChatView ───────────────────────────────────────────────────────────────

export function ChatView({
  mode,
  sessionId,
  onSend,
  onCancel,
  onAttach,
  selection,
  presets,
  keysByProvider,
  modelsByProvider,
  onSelectionChange,
  onRefreshModels,
  permissionSlot,
  projectSlot,
  onOpenFile,
  onPreview,
  onReply,
  onResolveQuestion,
}: ChatViewProps) {
  const modeState = useSessionStore((s) => s[mode]);
  const { messages, streamingMessageId, toolCards, pendingQuestions, pendingPermissions } = modeState;
  const transcriptToolCards = reconstructToolCards(messages);
  const visibleToolCards = new Map(transcriptToolCards);
  for (const [toolUseId, card] of toolCards) visibleToolCards.set(toolUseId, card);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  // Track run start time for the "taking longer" governor (P1-5 / §7)
  const [runStartTime, setRunStartTime] = useState<number | null>(null);
  useEffect(() => {
    if (streamingMessageId && !runStartTime) {
      setRunStartTime(Date.now());
    } else if (!streamingMessageId) {
      setRunStartTime(null);
    }
  }, [streamingMessageId, runStartTime]);

  const elapsedMs = runStartTime ? Date.now() - runStartTime : 0;
  const takingLonger = elapsedMs >= TAKING_LONGER_MS;

  // ── Scroll tracking ──────────────────────────────────────────────────────

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
  }, [messages, atBottom, visibleToolCards]);

  function jumpToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setAtBottom(true);
  }

  const isRunning = streamingMessageId !== null;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className={styles.wrap}>
      {/* Transcript */}
      <div
        className={`${styles.transcript} chatTranscript`}
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
              mode={mode}
              message={msg}
              isStreaming={streamingMessageId === msg.id}
              toolCards={visibleToolCards}
              onOpenFile={onOpenFile}
              onPreview={onPreview}
              onReply={onReply}
              onResolveQuestion={onResolveQuestion}
              pendingQuestions={pendingQuestions}
              pendingPermissions={pendingPermissions}
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

      {/* Pinned task slot above composer (P1-3 / §5.2) */}
      <PinnedTodoSlot tasks={modeState.tasks} />

      {/* Composer */}
      <ComposerBar
        busy={isRunning}
        onSend={onSend}
        onCancel={onCancel}
        onAttach={onAttach}
        selection={selection}
        presets={presets}
        keysByProvider={keysByProvider}
        modelsByProvider={modelsByProvider}
        onSelectionChange={onSelectionChange}
        onRefreshModels={onRefreshModels}
        permissionSlot={permissionSlot}
        projectSlot={projectSlot}
        placeholder={mode === "cowork" ? "Give Kozum a followup..." : undefined}
        takingLonger={takingLonger}
        elapsedMs={elapsedMs}
      />
    </div>
  );
}
