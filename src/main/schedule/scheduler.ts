/**
 * Kozum Cowork — Scheduler
 *
 * Manages a persistent list of ScheduledTask records, fires them at their
 * cron-computed times, and handles overlap/catch-up/failure gracefully.
 *
 * Design notes
 * ============
 * OVERLAP: If a task's previous run is still executing when the next tick is
 * due, the new invocation is SKIPPED (status "skipped"). Running two copies of
 * the same agent session concurrently could trash shared state, waste tokens,
 * and confuse users. A simple mutex-per-task is the right call here.
 *
 * CATCH-UP: When the app is closed over a scheduled time, we do NOT fire a
 * burst of missed runs. On start() we fire at most ONE catch-up run per task,
 * and only if the miss is within a configurable grace window (default 1 hour).
 * Silently replaying a week of missed runs would spam the user, waste API quota,
 * and interact badly with tasks that assume they run once per period.
 *
 * TIMER: A single timer always sleeps until the earliest next-run rather than
 * polling every minute. This is kinder on battery and CPU.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { parseCron, nextRun } from "./cron.ts";
import type { CronSpec } from "./cron.ts";
import type { ScheduledTask, Mode, ModelSelection } from "../../shared/types.ts";

/* ============================================================= types ==== */

export type TaskPatch = Partial<
  Pick<
    ScheduledTask,
    | "name"
    | "prompt"
    | "cron"
    | "timezone"
    | "enabled"
    | "mode"
    | "workingFolder"
    | "selection"
  >
>;

/** Internal runtime state per task. */
interface TaskState {
  task: ScheduledTask;
  spec: CronSpec;
  /** Resolves when the current run finishes; null when not running. */
  running: Promise<void> | null;
}

/* ========================================================= defaults ==== */

/** Grace window in milliseconds: only catch up if missed by less than this. */
const DEFAULT_GRACE_MS = 60 * 60 * 1000; // 1 hour

const TASKS_FILE = "scheduled-tasks.json";

/* ========================================================= Scheduler === */

export class Scheduler {
  private states = new Map<string, TaskState>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private readonly rootDir: string;
  private readonly now: () => Date;
  private readonly runner: (task: ScheduledTask) => Promise<void>;
  private readonly graceMs: number;
  /** Serialize persistence writes so rapid CRUD operations cannot race. */
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(opts: {
    rootDir: string;
    now?: () => Date;
    runner: (task: ScheduledTask) => Promise<void>;
    graceMs?: number;
  }) {
    this.rootDir = opts.rootDir;
    this.now     = opts.now ?? (() => new Date());
    this.runner  = opts.runner;
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  }

  /* -------------------------------------------------- lifecycle ------- */

  /** Load persisted tasks and start the timer. */
  async start(): Promise<void> {
    await this.load();
    this.started = true;
    // Compute nextRunAt for every enabled task, handling catch-up.
    const now = this.now();
    for (const state of this.states.values()) {
      if (!state.task.enabled) continue;
      this.handleCatchUp(state, now);
    }
    this.scheduleNext();
  }

  /** Stop the timer (tasks remain in memory but won't fire). */
  stop(): void {
    this.started = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /* ------------------------------------------ CRUD operations -------- */

  add(opts: {
    name: string;
    prompt: string;
    cron: string;
    timezone?: string;
    mode?: Mode;
    workingFolder?: string | null;
    selection?: ModelSelection | null;
  }): ScheduledTask {
    const spec = parseCron(opts.cron); // throws on invalid
    const tz = opts.timezone ?? "UTC";
    const now = this.now();
    // Start search 1 minute ahead so add() never returns a nextRunAt in the past.
    const from = new Date(now.getTime() + 60_000);
    const task: ScheduledTask = {
      id: randomUUID(),
      name: opts.name,
      prompt: opts.prompt,
      cron: opts.cron,
      timezone: tz,
      enabled: true,
      mode: opts.mode ?? "cowork",
      projectId: null,
      workingFolder: opts.workingFolder ?? null,
      selection: opts.selection ?? null,
      createdAt: now.getTime(),
      runCount: 0,
      nextRunAt: nextRun(spec, from, tz).getTime(),
    };
    this.states.set(task.id, { task, spec, running: null });
    void this.persist();
    if (this.started) this.scheduleNext();
    return task;
  }

  remove(id: string): boolean {
    const had = this.states.has(id);
    this.states.delete(id);
    if (had) void this.persist();
    if (this.started) this.scheduleNext();
    return had;
  }

  enable(id: string): boolean {
    const state = this.states.get(id);
    if (!state) return false;
    if (state.task.enabled) return true;
    state.task.enabled = true;
    const from = new Date(this.now().getTime() + 60_000);
    try {
      state.task.nextRunAt = nextRun(state.spec, from, state.task.timezone).getTime();
    } catch {
      // expression never fires — leave nextRunAt undefined
    }
    void this.persist();
    if (this.started) this.scheduleNext();
    return true;
  }

  disable(id: string): boolean {
    const state = this.states.get(id);
    if (!state) return false;
    state.task.enabled = false;
    void this.persist();
    if (this.started) this.scheduleNext();
    return true;
  }

  update(id: string, patch: TaskPatch): ScheduledTask | undefined {
    const state = this.states.get(id);
    if (!state) return undefined;

    const t = state.task;
    if (patch.name         !== undefined) t.name         = patch.name;
    if (patch.prompt       !== undefined) t.prompt       = patch.prompt;
    if (patch.timezone     !== undefined) t.timezone     = patch.timezone;
    if (patch.enabled      !== undefined) t.enabled      = patch.enabled;
    if (patch.mode         !== undefined) t.mode         = patch.mode;
    if (patch.workingFolder !== undefined) t.workingFolder = patch.workingFolder ?? null;
    if (patch.selection    !== undefined) t.selection    = patch.selection ?? null;

    if (patch.cron !== undefined) {
      state.spec = parseCron(patch.cron);
      t.cron = patch.cron;
    }

    if (t.enabled) {
      try {
        t.nextRunAt = nextRun(state.spec, this.now(), t.timezone).getTime();
      } catch {
        t.nextRunAt = undefined;
      }
    }

    void this.persist();
    if (this.started) this.scheduleNext();
    return t;
  }

  list(): ScheduledTask[] {
    return [...this.states.values()].map((s) => ({ ...s.task }));
  }

  /** Wait until all mutations issued so far are durably written. */
  async flush(): Promise<void> {
    await this.persistQueue;
  }

  get(id: string): ScheduledTask | undefined {
    const s = this.states.get(id);
    return s ? { ...s.task } : undefined;
  }

  /**
   * Fire a task immediately without disturbing its scheduled cadence.
   * The nextRunAt is NOT changed.
   */
  async runNow(id: string): Promise<void> {
    const state = this.states.get(id);
    if (!state) throw new Error(`Task not found: ${id}`);
    await this.fire(state, false);
  }

  /* ------------------------------------------ internal timer --------- */

  /**
   * Set (or reset) the timer to fire at the earliest nextRunAt among enabled
   * tasks.  Called whenever the task list changes or after a run completes.
   */
  private scheduleNext(): void {
    if (!this.started) return;

    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const now = this.now().getTime();
    let earliest = Infinity;

    for (const state of this.states.values()) {
      if (!state.task.enabled) continue;
      const nr = state.task.nextRunAt;
      if (nr !== undefined && nr < earliest) earliest = nr;
    }

    if (!isFinite(earliest)) return; // nothing to schedule

    const delay = Math.max(0, earliest - now);
    this.timer = setTimeout(() => {
      void this.tick();
    }, delay);
    // Unref the timer so it does not keep the Node.js event loop alive by itself.
    // In production (Electron) the process stays alive anyway; in tests this
    // prevents a dangling timer from blocking process exit.
    this.timer.unref();
  }

  /**
   * Called when the timer fires.  Runs all tasks whose nextRunAt has arrived.
   * Must be re-entrant-safe (multiple tasks may be due at the same instant).
   */
  private async tick(): Promise<void> {
    this.timer = null;
    if (!this.started) return;

    const now = this.now();

    const due: TaskState[] = [];
    for (const state of this.states.values()) {
      if (!state.task.enabled) continue;
      const nr = state.task.nextRunAt;
      if (nr !== undefined && nr <= now.getTime()) {
        due.push(state);
      }
    }

    // Fire all due tasks in parallel (each guarded by its own overlap check).
    await Promise.all(due.map((s) => this.fire(s, true)));

    this.scheduleNext();
  }

  /* ----------------------------------------------- run one task ------ */

  private async fire(state: TaskState, advanceNext: boolean): Promise<void> {
    // OVERLAP CHECK: skip if previous run is still going.
    if (state.running !== null) {
      state.task.lastStatus = "skipped";
      if (advanceNext) this.advanceNextRun(state);
      void this.persist();
      return;
    }

    const task = state.task;

    let resolve!: () => void;
    state.running = new Promise<void>((res) => { resolve = res; });

    try {
      await this.runner(task);
      task.lastStatus  = "success";
      task.lastError   = undefined;
    } catch (e: unknown) {
      task.lastStatus = "failed";
      task.lastError  = e instanceof Error ? e.message : String(e);
    } finally {
      task.lastRunAt = this.now().getTime();
      task.runCount  = (task.runCount ?? 0) + 1;
      state.running  = null;
      resolve();
    }

    if (advanceNext) this.advanceNextRun(state);
    void this.persist();
  }

  private advanceNextRun(state: TaskState): void {
    // Advance by 1 minute past the current time so we never re-fire the same
    // minute that just ran.
    const nowMs = this.now().getTime();
    const from  = new Date(nowMs + 60_000);
    try {
      state.task.nextRunAt = nextRun(state.spec, from, state.task.timezone).getTime();
    } catch {
      state.task.nextRunAt = undefined;
      state.task.enabled   = false;
    }
  }

  /* --------------------------------------------- catch-up logic ------ */

  /**
   * On startup, check whether the task missed a scheduled run while the app
   * was closed.  Fire at most one catch-up run — and only if the miss is
   * within the grace window.
   *
   * Why: replaying every missed run would be unexpected, expensive, and could
   * leave the user facing dozens of agent sessions they never asked for.  A
   * single catch-up within the grace window is a sensible compromise.
   */
  private handleCatchUp(state: TaskState, now: Date): void {
    const task = state.task;
    if (!task.nextRunAt) return;

    const missedBy = now.getTime() - task.nextRunAt;

    if (missedBy > 0) {
      if (missedBy <= this.graceMs) {
        // Missed recently — fire once.
        void this.fire(state, true);
      } else {
        // Missed too long ago — skip and just advance nextRun.
        this.advanceNextRun(state);
      }
    }
  }

  /* ----------------------------------------------- persistence ------- */

  private persist(): Promise<void> {
    // Capture an immutable snapshot at the call site. The queue preserves the
    // order of mutations, so a delete that follows an add cannot be overwritten
    // by the add's slower filesystem write.
    const snapshot = [...this.states.values()].map((s) => ({ ...s.task }));
    this.persistQueue = this.persistQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          await mkdir(this.rootDir, { recursive: true });
          await writeFile(
            join(this.rootDir, TASKS_FILE),
            JSON.stringify(snapshot, null, 2),
            "utf8",
          );
        } catch {
          // Persist errors must not crash the scheduler or stop later writes.
        }
      });
    return this.persistQueue;
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(join(this.rootDir, TASKS_FILE), "utf8");
      const tasks = JSON.parse(raw) as ScheduledTask[];
      for (const task of tasks) {
        try {
          const spec = parseCron(task.cron);
          this.states.set(task.id, { task, spec, running: null });
        } catch {
          // Skip tasks whose cron is no longer valid (edge case: app upgrade).
        }
      }
    } catch {
      // File not found or corrupt — start fresh.
    }
  }
}
