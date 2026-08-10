/**
 * Pure reducer for session state.
 *
 * Split from the zustand store so the logic can be unit-tested under plain
 * Node without needing a DOM, React, or zustand installed.
 */

import type {
  AgentEvent,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  TokenUsage,
  StopReason,
} from "@shared/types.ts";
import type {
  ModeState,
  ToolCard,
  PendingQuestion,
  PendingPermission,
  SubagentView,
} from "./sessionTypes.ts";

export type { ModeState, ToolCard };

export function applyEventToMode(mode: ModeState, e: AgentEvent): ModeState {
  switch (e.type) {
    case "turn_start": {
      const shell = {
        id: e.messageId,
        role: "assistant" as const,
        content: [] as ContentBlock[],
        createdAt: Date.now(),
        model: e.model,
      };
      return {
        ...mode,
        status: "running",
        streamingMessageId: e.messageId,
        streamingText: "",
        streamingThinking: "",
        toolCards: new Map(),
        error: null,
        messages: [...mode.messages, shell],
      };
    }

    case "text_delta": {
      if (mode.streamingMessageId !== e.messageId) return mode;
      const newText = mode.streamingText + e.delta;
      const messages = mode.messages.map((msg) => {
        if (msg.id !== e.messageId) return msg;
        const existing = msg.content.find(
          (b): b is TextBlock => b.type === "text",
        );
        let newContent: ContentBlock[];
        if (existing) {
          newContent = msg.content.map((b) =>
            b.type === "text" ? { ...b, text: newText } : b,
          );
        } else {
          const textBlock: TextBlock = { type: "text", text: newText };
          newContent = [...msg.content, textBlock];
        }
        return { ...msg, content: newContent };
      });
      return { ...mode, streamingText: newText, messages };
    }

    case "thinking_delta": {
      if (mode.streamingMessageId !== e.messageId) return mode;
      const newThinking = mode.streamingThinking + e.delta;
      const messages = mode.messages.map((msg) => {
        if (msg.id !== e.messageId) return msg;
        const existing = msg.content.find(
          (b): b is ThinkingBlock => b.type === "thinking",
        );
        let newContent: ContentBlock[];
        if (existing) {
          newContent = msg.content.map((b) =>
            b.type === "thinking" ? { ...b, text: newThinking } : b,
          );
        } else {
          const block: ThinkingBlock = { type: "thinking", text: newThinking };
          newContent = [...msg.content, block];
        }
        return { ...msg, content: newContent };
      });
      return { ...mode, streamingThinking: newThinking, messages };
    }

    case "tool_start": {
      const card: ToolCard = {
        toolUseId: e.toolUseId,
        name: e.name,
        input: e.input,
        status: "running",
        notes: [],
        result: null,
      };
      const cards = new Map(mode.toolCards);
      cards.set(e.toolUseId, card);
      return { ...mode, toolCards: cards };
    }

    case "tool_progress": {
      const existing = mode.toolCards.get(e.toolUseId);
      if (!existing) return mode;
      const updated: ToolCard = { ...existing, notes: [...existing.notes, e.note] };
      const cards = new Map(mode.toolCards);
      cards.set(e.toolUseId, updated);
      return { ...mode, toolCards: cards };
    }

    case "tool_end": {
      const existing = mode.toolCards.get(e.toolUseId);
      if (!existing) return mode;
      const updated: ToolCard = {
        ...existing,
        status: e.result.ok ? "ok" : "error",
        result: e.result,
      };
      const cards = new Map(mode.toolCards);
      cards.set(e.toolUseId, updated);
      return { ...mode, toolCards: cards };
    }

    case "turn_end": {
      const usage: TokenUsage = e.usage;
      const stopReason: StopReason = e.stopReason;
      const messages = mode.messages.map((msg) => {
        if (msg.id !== e.messageId) return msg;
        return { ...msg, usage, stopReason };
      });
      // P1-4: once the turn ends, ok tool cards collapse so the transcript
      // stays readable; error cards deliberately stay open. The user can still
      // re-expand any card manually.
      const toolCards = new Map(mode.toolCards);
      for (const [key, card] of toolCards) {
        if (card.status === "ok") {
          toolCards.set(key, { ...card, autoCollapse: true });
        }
      }
      return {
        ...mode,
        messages,
        streamingMessageId: null,
        streamingText: "",
        streamingThinking: "",
        toolCards,
      };
    }

    case "error": {
      return {
        ...mode,
        status: "error",
        streamingMessageId: null,
        error: e.message,
        pendingQuestions: [],
        pendingPermissions: [],
      };
    }

    case "session_status": {
      const isRunning = e.status === "running";
      return {
        ...mode,
        status: e.status,
        ...(isRunning ? { error: null } : {}),
        ...(!isRunning ? { streamingMessageId: null } : {}),
        // Drop any unanswered question/permission prompts when the turn ends:
        // the backend AskBroker will have been rejected by abort, so the
        // pending arrays would otherwise dangle forever in the UI.
        ...(!isRunning
          ? { pendingQuestions: [], pendingPermissions: [] }
          : {}),
      };
    }

    case "task_update": {
      return { ...mode, tasks: e.tasks };
    }

    /* ─────────────────────────── Subagent live stream (P1-1) ─────────────── */

    case "subagent_start": {
      const run = e.run;
      const view: SubagentView = {
        id: run.id,
        parentSessionId: run.parentSessionId,
        ...(run.parentMessageId !== undefined ? { parentMessageId: run.parentMessageId } : {}),
        name: run.name,
        description: run.description,
        status: run.status,
        startedAt: run.startedAt,
        relativeStartedAt: Date.now(),
        ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
        ...(run.result !== undefined ? { result: run.result } : {}),
        ...(run.error !== undefined ? { error: run.error } : {}),
        emitHistory: [],
      };
      return { ...mode, subagents: { ...mode.subagents, [run.id]: view } };
    }

    case "subagent_progress": {
      const existing = mode.subagents[e.runId];
      if (!existing) return mode;
      const entry = { note: e.note, t: Date.now() };
      const history = [...existing.emitHistory, entry].slice(-20);
      return {
        ...mode,
        subagents: {
          ...mode.subagents,
          [e.runId]: {
            ...existing,
            ...(e.progress !== undefined ? { progress: e.progress } : {}),
            lastNote: e.note,
            emitHistory: history,
          },
        },
      };
    }

    case "subagent_end": {
      const existing = mode.subagents[e.runId];
      if (!existing) return mode;
      const entry = {
        note:
          e.status === "completed"
            ? "Completed"
            : e.status === "cancelled"
              ? "Cancelled"
              : `Failed${e.error ? `: ${e.error}` : ""}`,
        t: Date.now(),
      };
      return {
        ...mode,
        subagents: {
          ...mode.subagents,
          [e.runId]: {
            ...existing,
            status: e.status,
            ...(e.result !== undefined ? { result: e.result } : {}),
            ...(e.error !== undefined ? { error: e.error } : {}),
            endedAt: Date.now(),
            lastNote: entry.note,
            emitHistory: [...existing.emitHistory, entry].slice(-20),
          },
        },
      };
    }

    case "permission_request": {
      const pending: PendingPermission = {
        requestId: e.requestId,
        toolName: e.toolName,
        input: e.input,
        reason: e.reason,
        // Attach to the currently-streaming assistant message so Message.tsx can
        // host the inline banner; the backend event does not carry ids itself.
        messageId: mode.streamingMessageId ?? undefined,
      };
      return {
        ...mode,
        pendingPermissions: [...mode.pendingPermissions, pending],
      };
    }

    case "question": {
      const pending: PendingQuestion = {
        requestId: e.requestId,
        question: e.question,
        options: e.options,
        multiSelect: e.multiSelect,
        messageId: mode.streamingMessageId ?? undefined,
      };
      return {
        ...mode,
        pendingQuestions: [...mode.pendingQuestions, pending],
      };
    }

    default: {
      const _never: never = e;
      void _never;
      return mode;
    }
  }
}

export function emptyModeState(): ModeState {
  return {
    status: "idle",
    messages: [],
    streamingMessageId: null,
    streamingText: "",
    streamingThinking: "",
    toolCards: new Map(),
    tasks: [],
    error: null,
    pendingQuestions: [],
    pendingPermissions: [],
    subagents: {},
  };
}
