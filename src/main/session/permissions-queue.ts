/**
 * PermissionQueue — per-session serialization of permission prompts.
 *
 * Tool execution stays fully concurrent; only *prompting* serializes. Each
 * session owns a promise-chain mutex: a `requestPermission` call enqueues its
 * work and resolves only after every earlier request for the same session has
 * resolved or rejected. This guarantees the renderer sees at most one live
 * `permission_request` per session at any moment (the Ask/Permission Dock
 * renders exactly one card), while parallel tool calls no longer race to put
 * several prompts on screen simultaneously.
 *
 * A rejected earlier request must never block the next prompt, so the chain
 * continues on both settle paths.
 */

export class PermissionQueue {
  /** sessionId → tail of the enqueue chain; idle entries self-remove. */
  private tails = new Map<string, Promise<void>>();

  /**
   * Run `task` after all previously enqueued tasks for this session settled.
   * The returned promise settles with the task's own outcome.
   */
  run<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(sessionId) ?? Promise.resolve();
    // Previous outcome is irrelevant to the next prompt — swallow it here so
    // one denied/cancelled request cannot reject the whole chain.
    const gated = tail.then(task, task);
    const next: Promise<void> = gated.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(sessionId, next);
    void next.finally(() => {
      // Only remove our own entry; a newer task has already replaced it.
      if (this.tails.get(sessionId) === next) this.tails.delete(sessionId);
    });
    return gated;
  }

  /** Number of sessions with a non-empty queue (diagnostics/tests). */
  get activeSessionCount(): number {
    return this.tails.size;
  }
}
