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
import type { ModeState, ToolCard } from "./sessionTypes.ts";

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
      return {
        ...mode,
        messages,
        streamingMessageId: null,
        streamingText: "",
        streamingThinking: "",
      };
    }

    case "error": {
      return {
        ...mode,
        streamingMessageId: null,
        error: e.message,
      };
    }

    case "session_status": {
      return mode;
    }

    case "task_update": {
      return { ...mode, tasks: e.tasks };
    }

    case "permission_request":
    case "question": {
      return mode;
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
    messages: [],
    streamingMessageId: null,
    streamingText: "",
    streamingThinking: "",
    toolCards: new Map(),
    tasks: [],
    error: null,
  };
}
