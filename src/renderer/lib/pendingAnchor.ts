/**
 * Pure helpers that guarantee pending permission/question prompts always have
 * a renderable anchor in the transcript.
 *
 * The reducer stamps messageId/toolUseId when the event arrives, but a prompt
 * can still end up unanchored (hydrated transcript replacing messages, events
 * racing ahead of turn_start, legacy events without ids). ChatView applies
 * these helpers before handing pending items down so every prompt renders
 * exactly once:
 *   - anchorPendingItems fills a missing messageId with the latest assistant id;
 *   - selectStranded returns prompts whose anchor no longer exists in the
 *     transcript — the ChatView "Action required" strip renders those instead,
 *     so this class of silent AskBroker deadlock can never recur.
 */

import type { PendingQuestion, PendingPermission } from "../store/sessionTypes.ts";

type Anchorable = { requestId: string; messageId?: string };

export function anchorPendingItems<T extends Anchorable>(
  items: readonly T[],
  latestAssistantId?: string,
): T[] {
  if (items.length === 0) return [];
  return items.map((item) =>
    item.messageId || !latestAssistantId
      ? item
      : { ...item, messageId: latestAssistantId },
  );
}

export function selectStranded<T extends Anchorable>(
  items: readonly T[],
  messageIds: ReadonlySet<string>,
): T[] {
  return items.filter((item) => !item.messageId || !messageIds.has(item.messageId));
}

export type StrandedPrompt = PendingQuestion | PendingPermission;

/** Convenience wrapper used by ChatView for its safety-net strip. */
export function collectStrandedPrompts(
  permissions: readonly PendingPermission[],
  questions: readonly PendingQuestion[],
  messageIds: ReadonlySet<string>,
): { permissions: PendingPermission[]; questions: PendingQuestion[] } {
  return {
    permissions: selectStranded(permissions, messageIds),
    questions: selectStranded(questions, messageIds),
  };
}
