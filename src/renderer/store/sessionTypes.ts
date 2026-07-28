/**
 * Pure types for session state — no zustand, no React imports.
 * Shared by the reducer and the store.
 */

import type { Message, AgentTask, ToolResult } from "@shared/types.ts";

export type ToolStatus = "running" | "ok" | "error";

export interface ToolCard {
  toolUseId: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  notes: string[];
  result: ToolResult | null;
}

export interface ModeState {
  messages: Message[];
  streamingMessageId: string | null;
  streamingText: string;
  streamingThinking: string;
  toolCards: Map<string, ToolCard>;
  tasks: AgentTask[];
  error: string | null;
}
