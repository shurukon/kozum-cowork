/**
 * Kozum Cowork — chat transcript + composer.
 *
 * Composes: Message list (with kz-send-ack and thinking animation) + AskDock
 * (the single fixed panel above the composer for pending asks/permissions) +
 * ComposerBar (with AddMenu and SelectorBar). Manages auto-scroll and the
 * jump-to-latest pill.
 *
 * Props are a superset of the old interface to remain wirable by App.tsx:
 * - The old onAttach: () => void is replaced by onAttach: (kind) => void
 *   so the parent decides what each AddMenu item does.
 * - onPickModel is removed — model selection is now inline in SelectorBar.
 * - selection, presets, keysByProvider, modelsByProvider, onSelectionChange,
 *   onRefreshModels are new (passed through to ComposerBar → SelectorBar).
 * - permissionSlot is passed through in BOTH modes now (Cowork gets its own
 *   two-posture picker).
 * - onOpenFile is new (forwarded to ToolCard file chips).
 * - Pending prompts render exclusively in AskDock — never inline in the
 *   transcript.
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
  McpServerConfig,
  Plugin,
  Skill,
} from "@shared/types.ts";
import { reconstructToolCards, useSessionStore } from "../store/session.ts";
import { Message } from "./Message.tsx";
import { ComposerBar } from "./ComposerBar.tsx";
import { AskDock } from "./AskDock.tsx";
import type { AddMenuKind } from "./AddMenu.tsx";
import type { PreviewTarget } from "./PreviewPanel.tsx";
import styles from "./ChatView.module.css";

// ── Props ──────────────────────────────────────────────────────────────────

export interface ChatViewProps {
  mode: Mode;
  sessionId: string;
  /** Renderer/action error shown inside the transcript instead of a popup. */
  inlineError?: string | null;
  /** T6: clear the renderer-side inline error without a restart. */
  onDismissInlineError?: () => void;

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

  /** Extension catalogues and actions for the in-chat QuickPanel. */

  /** Extension catalogues and actions for the in-chat QuickPanel. */
  skills?: Skill[];
  connectors?: McpServerConfig[];
  plugins?: Plugin[];
  onToggleSkill?: (id: string, enabled: boolean) => void;
  onToggleConnector?: (id: string, enabled: boolean) => void;
  onTogglePlugin?: (id: string, enabled: boolean) => void;
  onInvokeExtension?: (command: string) => void;

  /** Called when the user clicks a file chip inside a tool card. */
  onOpenFile?: (path: string) => void;

  /** Open a preview for a tool-produced image, file, URL, or browser result. */
  onPreview?: (target: PreviewTarget) => void;

  /** Reply to a pending question/permission via the bridge. */
  onReply?: (requestId: string, answer: string[]) => void;

  /** Drop a pending question from the local store (collapses the form). */
  onResolveQuestion?: (requestId: string) => void;

  /** User-message actions shared by Cowork and Code. */
  onCopyMessage?: (text: string) => void;
  /** T8: enter inline editing on this user bubble (in-place, not composer). */
  onEditMessage?: (messageId: string) => void;
  /** T8: save the inline edit — truncates history from the message and resends. */
  onEditSave?: (messageId: string, newText: string) => void;
  onEditCancel?: () => void;
  /** Message id currently being edited inline. */
  editingMessageId?: string | null;
  onRetryMessage?: (messageId: string, text: string) => void;
  /** Draft injected by send-failure restore for this mode. */
  composerDraft?: string | null;
}

// ── Constants ──────────────────────────────────────────────────────────────

const SCROLL_THRESHOLD = 80; // px from bottom before "scrolled up"
const TAKING_LONGER_MS = 15_000;

// ── ChatView ───────────────────────────────────────────────────────────────

export function ChatView({
  mode,
  sessionId,
  inlineError,
  onDismissInlineError,
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
  skills,
  connectors,
  plugins,
  onToggleSkill,
  onToggleConnector,
  onTogglePlugin,
  onInvokeExtension,
  onOpenFile,
  onPreview,
  onReply,
  onResolveQuestion,
  onCopyMessage,
  onEditMessage,
  onEditSave,
  onEditCancel,
  editingMessageId,
  onRetryMessage,
  composerDraft = null,
}: ChatViewProps) {
  const modeState = useSessionStore((s) => s[mode]);
  const { messages, streamingMessageId, toolCards } = modeState;
  const transcriptToolCards = reconstructToolCards(messages);
  const visibleToolCards = new Map(transcriptToolCards);
  for (const [toolUseId, card] of toolCards) visibleToolCards.set(toolUseId, card);

  // A live tool event can briefly arrive before its persisted tool_use block.
  // Keep that fallback visible, but attach it to one assistant turn only. If it
  // were calculated inside Message from the global map, every later assistant
  // turn would render the same card again.
  const persistedToolUseIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") persistedToolUseIds.add(block.id);
    }
  }
  const orphanToolCards = Array.from(visibleToolCards.values()).filter(
    (card) => !persistedToolUseIds.has(card.toolUseId),
  );
  const latestAssistantMessageId = [...messages]
    .reverse()
    .find((message) => message.role === "assistant")?.id;

  // Pending prompts live ONLY in the AskDock above the composer. The store's
  // pending arrays (anchored by the reducer) are the single source of truth;
  // the dock is always visible, so a prompt can never be missed even when its
  // transcript anchor scrolled away.
  const pendingPermissions = modeState.pendingPermissions;
  const pendingQuestions = modeState.pendingQuestions;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  // Track run start time for the "taking longer" governor (P1-5 / §7)
  const [runStartTime, setRunStartTime] = useState<number | null>(null);
  const isActive = modeState.status === "running" || modeState.status === "waiting_input";
  useEffect(() => {
    if (isActive && !runStartTime) {
      setRunStartTime(Date.now());
    } else if (!isActive) {
      setRunStartTime(null);
    }
  }, [isActive, runStartTime]);

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

  const isRunning = isActive;

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
              orphanToolCards={
                msg.id === latestAssistantMessageId ? orphanToolCards : undefined
              }
              onOpenFile={onOpenFile}
              onPreview={onPreview}
              onCopyMessage={onCopyMessage}
              editActive={editingMessageId === msg.id}
              onEditMessage={msg.role === "user" ? onEditMessage : undefined}
              onEditSave={onEditSave}
              onEditCancel={onEditCancel}
              onRetryMessage={onRetryMessage}
            />
          ))}
          {(modeState.error || inlineError) && (
            <div className={styles.inlineError} role="alert" aria-live="assertive">
              <strong>Something went wrong</strong>
              <span>{modeState.error || inlineError}</span>
              {onDismissInlineError && (
                <button
                  type="button"
                  className={styles.inlineErrorDismiss}
                  aria-label="Dismiss error"
                  title="Dismiss"
                  onClick={onDismissInlineError}
                >
                  ×
                </button>
              )}
            </div>
          )}
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

      {/* AskDock — the single fixed panel above the composer for pending
          asks and permissions. One card at a time (FIFO) with an "n of m"
          counter; answers reuse the same onReply path as before, plus an
          optimistic local resolve so the dock advances immediately. */}
      <AskDock
        permissions={pendingPermissions}
        questions={pendingQuestions}
        onPermissionDecision={(requestId, decision) => {
          onReply?.(requestId, [decision]);
          useSessionStore.getState().resolvePermission(mode, requestId);
        }}
        onQuestionAnswer={(requestId, values) => {
          onReply?.(requestId, values);
          onResolveQuestion?.(requestId);
        }}
      />

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
        skills={skills}
        connectors={connectors}
        plugins={plugins}
        onToggleSkill={onToggleSkill}
        onToggleConnector={onToggleConnector}
        onTogglePlugin={onTogglePlugin}
        onInvokeExtension={onInvokeExtension}
        placeholder={mode === "cowork" ? "Give Kozum a followup..." : undefined}
        initialText={composerDraft}
        takingLonger={takingLonger}
        elapsedMs={elapsedMs}
      />
    </div>
  );
}
