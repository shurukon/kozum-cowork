/**
 * Pure types for session state — no zustand, no React imports.
 * Shared by the reducer and the store.
 */

import type { Message, AgentTask, ToolResult, SessionStatus, SubagentRun, SessionFileInfo } from "@shared/types.ts";

export type ToolStatus = "running" | "ok" | "error";

export interface ToolCard {
  toolUseId: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  notes: string[];
  result: ToolResult | null;
  /** When true, the card defaults to collapsed after its assistant turn ends (P1-4). */
  autoCollapse?: boolean;
}

/** Live view of a subagent run, surfaced in RightPanel's "Subagents" section (P1-1). */
export interface SubagentView {
  id: string;
  parentSessionId: string;
  parentMessageId?: string;
  name: string;
  description: string;
  status: SubagentRun["status"];
  startedAt: number;
  /** Epoch ms the view was first created — used for "running · just now" labels. */
  relativeStartedAt: number;
  endedAt?: number;
  result?: string;
  error?: string;
  /** 0–1 progress hint derived from the subagent's emitted progress. */
  progress?: number;
  /** Most recent progress note from the subagent. */
  lastNote?: string;
  /** Rolling log of progress notes (capped), newest last. */
  emitHistory: Array<{ note: string; t: number }>;
}

/** Mirrors the backend `AgentEvent` `question` shape (shared/types.ts). */
export interface PendingQuestionOption {
  label: string;
  value: string;
}

export interface PendingQuestion {
  requestId: string;
  question: string;
  options: PendingQuestionOption[];
  multiSelect: boolean;
  allowFreeform?: boolean;
  /** The tool_use id whose card should host the inline form, if known. */
  toolUseId?: string;
  /** The assistant message id this question is attached to, if known. */
  messageId?: string;
}

/** Mirrors the backend `AgentEvent` `permission_request` shape (shared/types.ts). */
export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: unknown;
  reason: string;
  /** The tool_use id whose card should host the inline banner, if known. */
  toolUseId?: string;
  /** The assistant message id this permission request is attached to, if known. */
  messageId?: string;
}

export interface ModeState {
  /** Session identity used to separate a new transcript from an in-session follow-up. */
  sessionId: string | null;
  /** Stable run identity used to ignore late events from an older turn. */
  currentRunId: string | null;
  status: SessionStatus;
  messages: Message[];
  streamingMessageId: string | null;
  streamingText: string;
  streamingThinking: string;
  /** toolUseId of the most recent tool_start; used to anchor inline prompts to their card. */
  lastToolUseId: string | null;
  toolCards: Map<string, ToolCard>;
  tasks: AgentTask[];
  error: string | null;
  /** Inline ask_user_question prompts awaiting the user's answer. */
  pendingQuestions: PendingQuestion[];
  /** Per-tool permission prompts awaiting Allow/Deny (manual mode). */
  pendingPermissions: PendingPermission[];
  /** Live subagent runs keyed by run id (P1-1). */
  subagents: Record<string, SubagentView>;
  /** Newest-first snapshot of the session working folder (W4 chips + Canvas). Optional for legacy literals/tests. */
  sessionFiles?: SessionFileInfo[];
  /** Event identities already applied to this mode; bounded by the store lifecycle. */
  seenEventIds: Set<string>;
}
