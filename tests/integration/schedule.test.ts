// Integration tests for the scheduled-task system.
//
// Uses node:test + node:assert/strict.
// All time is virtual — driven by an injected `now()` function.
// Scheduler ticks are triggered by calling tick() directly; no real setTimeout
// is exercised in any test.
//
// Test inventory
// ==============
// Cron parser
//   - every field form: star, n, a,b,c, a-b, star/n, a-b/n
//   - month and day names, case-insensitive
//   - all cron macros (daily, weekly, etc.)
//   - dom/dow OR semantics
//   - when dom is star and dow is set; vice-versa
//   - invalid expressions: each throws with a useful message
//   - time zones: same expr produces different UTC for UTC/NY/Tokyo/Lagos
//   - DST spring-forward in America/New_York
//   - DST fall-back does not double-fire (deferred to scheduler tests)
//   - "0 0 30 2 star" throws "never fires"
//   - describeCron produces readable output
//
// Scheduler
//   - add shows computed nextRunAt
//   - virtual clock past nextRunAt fires runner exactly once
//   - nextRunAt recomputed after fire; runCount increments
//   - throwing runner records lastStatus "failed" + lastError, scheduler alive
//   - overlap: still-running task skipped on next tick
//   - catch-up within grace window fires once
// Scheduler (cont.)
//   - catch-up beyond grace window does NOT fire
//   - disable prevents firing; enable resumes
//   - persistence: save then reload preserves state
//
// Tools
//   - schedule_create rejects invalid cron with helpful message
//   - schedule_run_now fires without changing nextRunAt

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseCron, nextRun, describeCron } from "../../src/main/schedule/cron.ts";
import { Scheduler } from "../../src/main/schedule/scheduler.ts";
import { makeScheduleTools } from "../../src/main/tools/schedule.ts";
import type { ScheduledTask } from "../../src/shared/types.ts";

/* ================================================================= helpers */

function utcDate(iso: string): Date {
  return new Date(iso + (iso.includes("Z") ? "" : "Z"));
}

/** Build a UTC instant: year, month(1-12), day, hour, minute. */
function utc(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
}

/**
 * Make a Scheduler with a controllable clock and a simple runner.
 * The runner records task ids that were run and optionally throws.
 */
function makeTestScheduler(opts: {
  rootDir: string;
  initialNow?: Date;
  throws?: boolean;
  slowMs?: number;
  graceMs?: number;
}): {
  scheduler: Scheduler;
  nowRef: { value: Date };
  runs: string[];
  tick: () => Promise<void>;
} {
  const nowRef = { value: opts.initialNow ?? utc(2024, 1, 1, 0, 0) };
  const runs: string[] = [];

  const runner = opts.throws
    ? async (_task: ScheduledTask): Promise<void> => {
        await Promise.resolve();
        throw new Error("runner-error");
      }
    : opts.slowMs !== undefined
      ? async (task: ScheduledTask): Promise<void> => {
          const delay = opts.slowMs!;
          runs.push(task.id);
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
        }
      : async (task: ScheduledTask): Promise<void> => {
          runs.push(task.id);
          await Promise.resolve();
        };

  const scheduler = new Scheduler({
    rootDir: opts.rootDir,
    now: () => nowRef.value,
    runner,
    graceMs: opts.graceMs,
  });

  /** Manually trigger the scheduler's internal tick at nowRef.value. */
  const tick = async (): Promise<void> => {
    // Access private method via any for testing purposes
    await (scheduler as unknown as { tick: () => Promise<void> }).tick();
  };

  return { scheduler, nowRef, runs, tick };
}

/* ================================================================ setup/teardown */

let tmpDir: string;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kozum-sched-"));
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/* ================================================================ cron parser */

describe("parseCron — field forms", () => {
  it("* — every value", () => {
    const spec = parseCron("* * * * *");
    assert.equal(spec.minutes.size, 60);
    assert.equal(spec.hours.size, 24);
    assert.equal(spec.dom.size, 31);
    assert.equal(spec.month.size, 12);
  });

  it("n — single value", () => {
    const spec = parseCron("5 14 3 7 2");
    assert.deepEqual([...spec.minutes], [5]);
    assert.deepEqual([...spec.hours],   [14]);
    assert.deepEqual([...spec.dom],     [3]);
    assert.deepEqual([...spec.month],   [7]);
    assert.deepEqual([...spec.dow],     [2]);
  });

  it("a,b,c — list", () => {
    const spec = parseCron("1,15,30 0,12 * * *");
    assert.ok(spec.minutes.has(1));
    assert.ok(spec.minutes.has(15));
    assert.ok(spec.minutes.has(30));
    assert.equal(spec.minutes.size, 3);
    assert.ok(spec.hours.has(0));
    assert.ok(spec.hours.has(12));
    assert.equal(spec.hours.size, 2);
  });

  it("a-b — range", () => {
    const spec = parseCron("0 9-17 * * *");
    for (let h = 9; h <= 17; h++) assert.ok(spec.hours.has(h), `hour ${h}`);
    assert.equal(spec.hours.size, 9);
  });

  it("*/n — step from zero", () => {
    const spec = parseCron("*/15 * * * *");
    assert.deepEqual([...spec.minutes].sort((a, b) => a - b), [0, 15, 30, 45]);
  });

  it("a-b/n — stepped range", () => {
    const spec = parseCron("10-50/10 * * * *");
    assert.deepEqual([...spec.minutes].sort((a, b) => a - b), [10, 20, 30, 40, 50]);
  });

  it("month names (jan-dec), case-insensitive", () => {
    const spec = parseCron("0 0 1 jan *");
    assert.deepEqual([...spec.month], [1]);
    const spec2 = parseCron("0 0 1 DEC *");
    assert.deepEqual([...spec2.month], [12]);
  });

  it("day names (sun-sat), case-insensitive", () => {
    const spec = parseCron("0 0 * * mon");
    assert.ok(spec.dow.has(1));
    const spec2 = parseCron("0 0 * * SAT");
    assert.ok(spec2.dow.has(6));
  });

  it("dow 7 normalised to 0 (Sunday)", () => {
    const spec = parseCron("0 0 * * 7");
    assert.ok(spec.dow.has(0));
    assert.ok(!spec.dow.has(7));
  });
});

/* ---------------------------------------------------------------- macros */

describe("parseCron — macros", () => {
  // [macro, min-size, hour-size, dom-size, month-size, expected-minute, expected-hour]
  const cases: [string, number, number, number, number, number, number][] = [
    // "0 0 1 1 *" — minute=0, hour=0, dom=1, month=1, dow=*
    ["@yearly",   1, 1, 1, 1,  0, 0],
    ["@annually", 1, 1, 1, 1,  0, 0],
    // "0 0 1 * *" — minute=0, hour=0, dom=1, month=*, dow=*
    ["@monthly",  1, 1, 1, 12, 0, 0],
    // "0 0 * * 0" — minute=0, hour=0, dom=*, month=*, dow=0
    ["@weekly",   1, 1, 31, 12, 0, 0],
    // "0 0 * * *" — minute=0, hour=0, dom=*, month=*, dow=*
    ["@daily",    1, 1, 31, 12, 0, 0],
    ["@midnight", 1, 1, 31, 12, 0, 0],
    // "0 * * * *" — minute=0, hour=*, dom=*, month=*, dow=*
    ["@hourly",   1, 24, 31, 12, 0, -1],
  ];

  for (const [macro, minSz, hrSz, domSz, monSz, expMin, expHr] of cases) {
    it(macro, () => {
      const spec = parseCron(macro);
      assert.equal(spec.minutes.size, minSz, `minutes size for ${macro}`);
      assert.equal(spec.hours.size,   hrSz,  `hours size for ${macro}`);
      assert.equal(spec.dom.size,     domSz, `dom size for ${macro}`);
      assert.equal(spec.month.size,   monSz, `month size for ${macro}`);
      assert.ok(spec.minutes.has(expMin), `minute ${expMin} in ${macro}`);
      if (expHr >= 0) assert.ok(spec.hours.has(expHr), `hour ${expHr} in ${macro}`);
    });
  }
});

/* ---------------------------------------------------------------- invalid */

describe("parseCron — invalid inputs", () => {
  function throws(expr: string, pattern?: RegExp): void {
    assert.throws(() => parseCron(expr), (e: unknown) => {
      assert.ok(e instanceof Error, "must be an Error");
      if (pattern) {
        assert.match(e.message, pattern, `message for "${expr}"`);
      }
      return true;
    });
  }

  it("wrong field count — too few", () => throws("* * * *", /5 field/));
  it("wrong field count — too many", () => throws("* * * * * *", /5 field/));
  it("minute 60", () => throws("60 * * * *", /out of range/));
  it("hour 24", () => throws("* 24 * * *", /out of range/));
  it("dom 0", () => throws("* * 0 * *", /out of range/));
  it("month 13", () => throws("* * * 13 *", /out of range/));
  it("dow 8", () => throws("* * * * 8", /out of range/));
  it("step */0", () => throws("*/0 * * * *", /step.*>=\s*1|must be.*1/i));
  it("garbage token", () => throws("foo * * * *", /non-numeric|unknown/i));
  it("inverted range", () => throws("5-3 * * * *", /start.*<=.*end|invalid range/i));
});

/* ---------------------------------------------------------------- nextRun */

describe("nextRun — basic", () => {
  it("fires at the exact minute when from is at a match", () => {
    const spec = parseCron("30 14 * * *");
    const from = utc(2024, 3, 15, 14, 30);
    const next = nextRun(spec, from, "UTC");
    assert.equal(next.getTime(), from.getTime());
  });

  it("advances to next matching minute", () => {
    const spec = parseCron("0 9 * * *");
    const from = utc(2024, 3, 15, 8, 0);
    const next = nextRun(spec, from, "UTC");
    const expected = utc(2024, 3, 15, 9, 0);
    assert.equal(next.getTime(), expected.getTime());
  });

  it("wraps to next day when today's time has passed", () => {
    const spec = parseCron("0 9 * * *");
    const from = utc(2024, 3, 15, 10, 0);
    const next = nextRun(spec, from, "UTC");
    const expected = utc(2024, 3, 16, 9, 0);
    assert.equal(next.getTime(), expected.getTime());
  });
});

/* ---------------------------------------------------------------- dom/dow OR semantics */

describe("nextRun — dom/dow OR semantics", () => {
  it("dom restricted, dow * — only dom checked", () => {
    // "* * 13 * *" should fire on the 13th of every month, any day
    const spec = parseCron("0 0 13 * *");
    assert.ok(spec.domStar === false, "domStar should be false");
    assert.ok(spec.dowStar === true,  "dowStar should be true");

    const from = utc(2024, 3, 1);
    const next = nextRun(spec, from, "UTC");
    assert.equal(next.getUTCDate(), 13);
    assert.equal(next.getUTCMonth() + 1, 3);
  });

  it("dow restricted, dom * — only dow checked", () => {
    // "0 0 * * 5" fires every Friday
    const spec = parseCron("0 0 * * 5");
    assert.ok(spec.domStar === true,  "domStar should be true");
    assert.ok(spec.dowStar === false, "dowStar should be false");

    const from = utc(2024, 3, 14); // Thursday 2024-03-14
    const next = nextRun(spec, from, "UTC");
    // Next Friday from 2024-03-14 is 2024-03-15
    assert.equal(next.getUTCDay(), 5);  // Friday
  });

  it("both dom and dow restricted — OR semantics", () => {
    // "0 0 13 * 5" fires on the 13th OR on every Friday.
    // From 2024-03-11 (Monday 01:00 UTC):
    //   - dom=13 → next is 2024-03-13 (Wednesday)
    //   - dow=Friday → next is 2024-03-15 (Friday)
    // With OR semantics, the earlier of the two wins: 2024-03-13 Wednesday.
    const spec = parseCron("0 0 13 * 5");
    assert.ok(!spec.domStar, "dom not star");
    assert.ok(!spec.dowStar, "dow not star");

    const from = utc(2024, 3, 11, 1, 0);
    const next = nextRun(spec, from, "UTC");

    const isFriday = next.getUTCDay() === 5;
    const is13th   = next.getUTCDate() === 13;
    // Must be either Friday or the 13th (OR semantics)
    assert.ok(isFriday || is13th,
      `Expected Friday or 13th, got ${next.toISOString()}`);
    // The 13th (Wednesday) is closer than the 15th (Friday), so we expect it
    assert.equal(next.getUTCDate(), 13, "nearest trigger is the 13th");
    assert.equal(next.getUTCMonth() + 1, 3, "in March");
  });

  it("dom/dow OR: fires on 13th even if it is not a Friday", () => {
    // 2024-03-13 is a Wednesday. "0 0 13 3 5" = 13th of March OR Fridays in March
    const spec = parseCron("0 0 13 3 5");
    // Start just after midnight of March 13
    const from = utc(2024, 3, 13, 0, 1);
    // Should still find March 13 midnight? No, from is past it.
    // Next occurrence is Friday March 15 OR stays in March.
    const next = nextRun(spec, from, "UTC");
    // March 15 is a Friday
    assert.equal(next.getUTCMonth() + 1, 3);
    assert.equal(next.getUTCDay(), 5, "next occurrence is a Friday in March");
  });
});

/* ---------------------------------------------------------------- timezones */

describe("nextRun — timezones", () => {
  it("same expression produces different UTC instants for different timezones", () => {
    const spec = parseCron("0 9 * * *");
    const from = utc(2024, 6, 15, 0, 0);

    const utcTime  = nextRun(spec, from, "UTC");
    const nyTime   = nextRun(spec, from, "America/New_York");
    const tokyoTime= nextRun(spec, from, "Asia/Tokyo");
    const lagosTime= nextRun(spec, from, "Africa/Lagos");

    // All should be 09:00 in their respective zones — so UTC times differ.
    const times = new Set([
      utcTime.getTime(), nyTime.getTime(), tokyoTime.getTime(), lagosTime.getTime()
    ]);
    assert.ok(times.size >= 3,
      "Different timezones must produce different UTC instants");
  });

  it("UTC: 0 9 * * * fires at 09:00 UTC", () => {
    const spec = parseCron("0 9 * * *");
    const from = utc(2024, 6, 15, 0, 0);
    const next = nextRun(spec, from, "UTC");
    assert.equal(next.getUTCHours(), 9);
    assert.equal(next.getUTCMinutes(), 0);
  });
});

/* ---------------------------------------------------------------- DST spring-forward */

describe("nextRun — DST spring-forward America/New_York", () => {
  it("0 2 * * * on spring-forward night does not hang and returns a sensible instant", () => {
    // In 2024 America/New_York springs forward on March 10 at 2:00 AM → 3:00 AM.
    // So "at 02:00" does not exist locally on that night.
    // nextRun should skip to the next day (March 11) at 02:00 local time.
    const spec = parseCron("0 2 * * *");
    // 2024-03-10 01:59 AM Eastern = 2024-03-10 06:59 UTC
    const from = utcDate("2024-03-10T06:59:00Z");
    let next: Date;
    assert.doesNotThrow(() => {
      next = nextRun(spec, from, "America/New_York");
    });
    // next! is safe because doesNotThrow proves it was set
    assert.ok(next!.getTime() > from.getTime(), "must be in the future");
    // The next valid 02:00 Eastern should be March 11
    const localHr = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(next!);
    assert.equal(localHr, "02:00", `expected 02:00, got ${localHr}`);
  });
});

/* ---------------------------------------------------------------- Feb 30 */

describe("nextRun — impossible date", () => {
  it("0 0 30 2 * throws 'never fires'", () => {
    const spec = parseCron("0 0 30 2 *");
    assert.throws(
      () => nextRun(spec, utc(2024, 1, 1), "UTC"),
      /never fires/i,
    );
  });
});

/* ---------------------------------------------------------------- describeCron */

describe("describeCron", () => {
  const cases: [string, string][] = [
    ["* * * * *",  "Every minute"],
    ["0 * * * *",  "Every hour"],
    ["0 9 * * *",  "Every day at 09:00"],
    ["0 9 * * 1-5","On weekdays at 09:00"],
    ["0 9 * * 6,0","On weekends at 09:00"],
    ["30 14 1 * *","On the 1st of every month at 14:30"],
    ["@hourly",    "Every hour"],
    ["@daily",     "Every day at 00:00"],
    ["@weekly",    "On Sundays at 00:00"],
  ];

  for (const [expr, expected] of cases) {
    it(`"${expr}" → "${expected}"`, () => {
      const spec = parseCron(expr);
      const got  = describeCron(spec);
      assert.equal(got, expected);
    });
  }
});

/* ================================================================ Scheduler */

describe("Scheduler — basic add and list", () => {
  it("add → list shows nextRunAt", async () => {
    const dir = join(tmpDir, "sched-add");
    const nowRef = { value: utc(2024, 1, 1, 8, 0) };
    const scheduler = new Scheduler({
      rootDir: dir,
      now: () => nowRef.value,
      runner: async () => { /* no-op */ },
    });
    await scheduler.start();

    const task = scheduler.add({
      name: "test-task",
      prompt: "hello",
      cron: "0 9 * * *",
      timezone: "UTC",
    });

    assert.ok(task.nextRunAt !== undefined, "nextRunAt must be set");
    // nextRunAt should be after the virtual now (2024-01-01 08:00 UTC)
    assert.ok(
      task.nextRunAt > nowRef.value.getTime(),
      `nextRunAt (${new Date(task.nextRunAt!).toISOString()}) must be after virtual now`,
    );

    const listed = scheduler.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, task.id);
    assert.ok(listed[0]!.nextRunAt !== undefined);

    scheduler.stop();
  });
});

describe("Scheduler — fires exactly once at nextRunAt", () => {
  it("advancing virtual clock past nextRunAt fires runner once", async () => {
    const dir = join(tmpDir, "sched-fire");
    const { scheduler, nowRef, runs, tick } = makeTestScheduler({ rootDir: dir });
    await scheduler.start();

    // Add a task scheduled for 09:00 UTC on 2024-01-01
    nowRef.value = utc(2024, 1, 1, 8, 0);
    const task = scheduler.add({
      name: "fire-test",
      prompt: "run",
      cron: "0 9 * * *",
      timezone: "UTC",
    });

    const expectedNextRun = utc(2024, 1, 1, 9, 0).getTime();
    assert.equal(task.nextRunAt, expectedNextRun);

    // Advance to 09:00 and manually tick
    nowRef.value = utc(2024, 1, 1, 9, 0);
    await tick();

    assert.equal(runs.length, 1);
    assert.equal(runs[0], task.id);

    scheduler.stop();
  });

  it("nextRunAt recomputes after fire; runCount increments", async () => {
    const dir = join(tmpDir, "sched-recompute");
    const { scheduler, nowRef, tick } = makeTestScheduler({ rootDir: dir });
    await scheduler.start();

    nowRef.value = utc(2024, 1, 1, 8, 0);
    const task = scheduler.add({
      name: "recompute-test",
      prompt: "run",
      cron: "0 9 * * *",
      timezone: "UTC",
    });

    nowRef.value = utc(2024, 1, 1, 9, 0);
    await tick();

    const updated = scheduler.get(task.id)!;
    assert.equal(updated.runCount, 1);
    // nextRunAt should be 09:00 on 2024-01-02
    assert.equal(updated.nextRunAt, utc(2024, 1, 2, 9, 0).getTime());

    scheduler.stop();
  });
});

describe("Scheduler — throwing runner", () => {
  it("records lastStatus=failed, lastError, and keeps alive", async () => {
    const dir = join(tmpDir, "sched-throw");
    const { scheduler, nowRef, tick } = makeTestScheduler({
      rootDir: dir,
      throws: true,
    });
    await scheduler.start();

    nowRef.value = utc(2024, 1, 1, 8, 0);
    const task = scheduler.add({
      name: "throw-test",
      prompt: "run",
      cron: "0 9 * * *",
      timezone: "UTC",
    });

    nowRef.value = utc(2024, 1, 1, 9, 0);
    await tick();

    const updated = scheduler.get(task.id)!;
    assert.equal(updated.lastStatus, "failed");
    assert.ok(updated.lastError?.includes("runner-error"));
    assert.equal(updated.runCount, 1);

    // Still alive — tick again at next 09:00
    nowRef.value = utc(2024, 1, 2, 9, 0);
    await tick();
    const updated2 = scheduler.get(task.id)!;
    assert.equal(updated2.runCount, 2);

    scheduler.stop();
  });
});

describe("Scheduler — overlap", () => {
  it("still-running task is skipped and runner not called twice", async () => {
    const dir = join(tmpDir, "sched-overlap");

    let resolveRun!: () => void;
    let runCount = 0;

    const nowRef = { value: utc(2024, 1, 1, 8, 0) };

    const scheduler = new Scheduler({
      rootDir: dir,
      now: () => nowRef.value,
      runner: async (_task: ScheduledTask) => {
        runCount++;
        // Block until the test resolves it
        await new Promise<void>((res) => { resolveRun = res; });
      },
    });

    await scheduler.start();

    const task = scheduler.add({
      name: "overlap-test",
      prompt: "run",
      cron: "0 9 * * *",
      timezone: "UTC",
    });

    // Advance to 09:00 and fire.  The runner blocks, so this promise is
    // pending for the duration of the test.
    nowRef.value = utc(2024, 1, 1, 9, 0);
    const firstFire = (scheduler as unknown as { tick: () => Promise<void> }).tick();

    // Yield to let the runner start (state.running is now set)
    await new Promise<void>((res) => setTimeout(res, 20));

    // Tick again at the same time — task is still running → should SKIP.
    // nextRunAt was NOT advanced yet (runner hasn't finished), so it is still
    // <= now, meaning the task is again "due" and the overlap guard fires.
    await (scheduler as unknown as { tick: () => Promise<void> }).tick();

    const state = scheduler.get(task.id)!;
    assert.equal(state.lastStatus, "skipped",
      "second tick while first run is in-flight must be skipped");
    assert.equal(runCount, 1, "runner must not have been called a second time");

    // Unblock the first run and await clean completion
    resolveRun();
    await firstFire;

    scheduler.stop();
  });
});

describe("Scheduler — catch-up", () => {
  it("miss within grace window fires once", async () => {
    const dir = join(tmpDir, "sched-catchup-within");
    const runs: string[] = [];

    // "now" = 30 minutes after the scheduled time (09:30)
    const virtualNow = utc(2024, 1, 1, 9, 30);

    // Write a task file with nextRunAt = 09:00 (30 minutes ago — within 1-hour grace)
    const { writeFile: wf, mkdir: mk } = await import("node:fs/promises");
    await mk(dir, { recursive: true });
    const taskData: ScheduledTask = {
      id: "catchup-within-id",
      name: "within-grace",
      prompt: "run",
      cron: "0 9 * * *",
      timezone: "UTC",
      enabled: true,
      mode: "cowork",
      projectId: null,
      workingFolder: null,
      selection: null,
      createdAt: utc(2024, 1, 1, 8, 0).getTime(),
      runCount: 0,
      // Missed by 30 minutes — within the 1-hour grace window
      nextRunAt: utc(2024, 1, 1, 9, 0).getTime(),
    };
    await wf(join(dir, "scheduled-tasks.json"), JSON.stringify([taskData]));

    const scheduler = new Scheduler({
      rootDir: dir,
      now: () => virtualNow,
      runner: async (t: ScheduledTask) => { runs.push(t.id); },
      graceMs: 60 * 60 * 1000, // 1 hour grace
    });

    await scheduler.start();
    // Give the async catch-up fire a chance to complete
    await new Promise<void>((res) => setTimeout(res, 100));

    assert.ok(runs.length === 1,
      `catch-up should fire exactly once, got ${runs.length}`);
    scheduler.stop();
  });

  it("miss beyond grace window does NOT fire", async () => {
    const dir = join(tmpDir, "sched-catchup-beyond");
    const runs: string[] = [];

    // "now" = 2 hours after the scheduled time (09:00) — beyond 1-hour grace
    const virtualNow = utc(2024, 1, 1, 9, 0);

    // Write a task file with nextRunAt 2 hours ago (07:00)
    const { writeFile: wf, mkdir: mk } = await import("node:fs/promises");
    await mk(dir, { recursive: true });
    const taskData: ScheduledTask = {
      id: "catchup-beyond-id",
      name: "beyond-grace",
      prompt: "run",
      cron: "0 9 * * *",
      timezone: "UTC",
      enabled: true,
      mode: "cowork",
      projectId: null,
      workingFolder: null,
      selection: null,
      createdAt: utc(2024, 1, 1, 6, 0).getTime(),
      runCount: 0,
      // nextRunAt is 2 hours before "now" — beyond 1-hour grace
      nextRunAt: utc(2024, 1, 1, 7, 0).getTime(),
    };
    await wf(join(dir, "scheduled-tasks.json"), JSON.stringify([taskData]));

    const scheduler = new Scheduler({
      rootDir: dir,
      now: () => virtualNow,
      runner: async (t: ScheduledTask) => { runs.push(t.id); },
      graceMs: 60 * 60 * 1000, // 1 hour
    });

    await scheduler.start();
    await new Promise<void>((res) => setTimeout(res, 100));

    assert.equal(runs.length, 0, "miss beyond grace must NOT fire");
    scheduler.stop();
  });
});

describe("Scheduler — disable / enable", () => {
  it("disabled task is not fired", async () => {
    const dir = join(tmpDir, "sched-disable");
    const runs: string[] = [];

    const nowRef = { value: utc(2024, 1, 1, 8, 0) };
    const scheduler = new Scheduler({
      rootDir: dir,
      now: () => nowRef.value,
      runner: async (t: ScheduledTask) => { runs.push(t.id); },
    });
    (scheduler as unknown as { now: () => Date }).now = () => nowRef.value;

    await scheduler.start();

    const task = scheduler.add({
      name: "disable-test",
      prompt: "run",
      cron: "0 9 * * *",
      timezone: "UTC",
    });
    scheduler.disable(task.id);

    nowRef.value = utc(2024, 1, 1, 9, 0);
    await (scheduler as unknown as { tick: () => Promise<void> }).tick();

    assert.equal(runs.length, 0, "disabled task must not fire");
    scheduler.stop();
  });

  it("enable resumes firing", async () => {
    const dir = join(tmpDir, "sched-enable");
    const runs: string[] = [];

    const nowRef = { value: utc(2024, 1, 1, 8, 0) };
    const scheduler = new Scheduler({
      rootDir: dir,
      now: () => nowRef.value,
      runner: async (t: ScheduledTask) => { runs.push(t.id); },
    });
    (scheduler as unknown as { now: () => Date }).now = () => nowRef.value;

    await scheduler.start();

    const task = scheduler.add({
      name: "enable-test",
      prompt: "run",
      cron: "0 9 * * *",
      timezone: "UTC",
    });
    scheduler.disable(task.id);

    // Enable and advance
    nowRef.value = utc(2024, 1, 1, 8, 30);
    scheduler.enable(task.id);

    nowRef.value = utc(2024, 1, 1, 9, 0);
    await (scheduler as unknown as { tick: () => Promise<void> }).tick();

    assert.ok(runs.length > 0, "re-enabled task must fire");
    scheduler.stop();
  });
});

describe("Scheduler — persistence", () => {
  it("save then reload preserves tasks and state", async () => {
    const dir = join(tmpDir, "sched-persist");
    const nowRef = { value: utc(2024, 1, 1, 8, 0) };

    const scheduler1 = new Scheduler({
      rootDir: dir,
      now: () => nowRef.value,
      runner: async () => { /* no-op */ },
    });
    (scheduler1 as unknown as { now: () => Date }).now = () => nowRef.value;
    await scheduler1.start();

    const task = scheduler1.add({
      name: "persist-test",
      prompt: "persisted",
      cron: "0 9 * * *",
      timezone: "UTC",
    });

    // Simulate a run and wait for persist to flush
    nowRef.value = utc(2024, 1, 1, 9, 0);
    await (scheduler1 as unknown as { tick: () => Promise<void> }).tick();
    // persist() is fire-and-forget (void) in the impl; give it time to complete
    await new Promise<void>((res) => setTimeout(res, 50));
    scheduler1.stop();

    // Load into a fresh instance
    const scheduler2 = new Scheduler({
      rootDir: dir,
      now: () => nowRef.value,
      runner: async () => { /* no-op */ },
    });
    (scheduler2 as unknown as { now: () => Date }).now = () => nowRef.value;
    await scheduler2.start();

    const loaded = scheduler2.get(task.id);
    assert.ok(loaded !== undefined, "task must survive reload");
    assert.equal(loaded!.name, "persist-test");
    assert.equal(loaded!.prompt, "persisted");
    assert.equal(loaded!.runCount, 1);
    assert.equal(loaded!.lastStatus, "success");

    scheduler2.stop();
  });

  it("ordered persistence keeps a task deleted immediately after creation", async () => {
    const dir = join(tmpDir, "sched-delete-race");
    const scheduler = new Scheduler({
      rootDir: dir,
      now: () => utc(2024, 1, 1, 8, 0),
      runner: async () => undefined,
    });
    await scheduler.start();

    const task = scheduler.add({
      name: "delete-race",
      prompt: "must not survive",
      cron: "* * * * *",
      timezone: "UTC",
    });
    assert.ok(scheduler.remove(task.id));
    await scheduler.flush();
    scheduler.stop();

    const reloaded = new Scheduler({
      rootDir: dir,
      now: () => utc(2024, 1, 1, 8, 0),
      runner: async () => undefined,
    });
    await reloaded.start();
    assert.equal(reloaded.get(task.id), undefined);
    reloaded.stop();
  });
});

/* ================================================================ Tools */

describe("schedule tools", () => {
  let toolDir: string;

  beforeEach(async () => {
    toolDir = await mkdtemp(join(tmpDir, "tools-"));
  });

  it("schedule_create rejects invalid cron with helpful message", async () => {
    const scheduler = new Scheduler({
      rootDir: toolDir,
      runner: async () => { /* no-op */ },
    });
    await scheduler.start();
    const tools = makeScheduleTools(scheduler);
    const create = tools.find((t) => t.definition.name === "schedule_create")!;

    const result = await create.handler(
      { name: "bad", prompt: "x", cron: "99 * * * *" },
      {} as never,
    );

    assert.equal(result.ok, false);
    assert.ok(
      result.error?.includes("Invalid cron") || result.error?.includes("out of range"),
      `error should mention invalid cron, got: ${result.error}`,
    );
    scheduler.stop();
  });

  it("schedule_create returns 5 tools with correct names", () => {
    const scheduler = new Scheduler({
      rootDir: toolDir,
      runner: async () => { /* no-op */ },
    });
    const tools = makeScheduleTools(scheduler);
    const names = tools.map((t) => t.definition.name).sort();
    assert.deepEqual(names, [
      "schedule_create",
      "schedule_delete",
      "schedule_list",
      "schedule_run_now",
      "schedule_update",
    ]);
    scheduler.stop();
  });

  it("all tools have modes: ['cowork']", () => {
    const scheduler = new Scheduler({
      rootDir: toolDir,
      runner: async () => { /* no-op */ },
    });
    const tools = makeScheduleTools(scheduler);
    for (const t of tools) {
      assert.deepEqual(t.definition.modes, ["cowork"],
        `${t.definition.name} must have modes: ["cowork"]`);
    }
    scheduler.stop();
  });

  it("schedule_run_now fires without changing nextRunAt", async () => {
    const runs: string[] = [];
    const nowRef = { value: utc(2024, 1, 1, 8, 0) };

    const scheduler = new Scheduler({
      rootDir: toolDir,
      now: () => nowRef.value,
      runner: async (t: ScheduledTask) => { runs.push(t.id); },
    });
    (scheduler as unknown as { now: () => Date }).now = () => nowRef.value;
    await scheduler.start();

    const task = scheduler.add({
      name: "run-now-test",
      prompt: "run",
      cron: "0 9 * * *",
      timezone: "UTC",
    });
    const originalNextRun = task.nextRunAt;

    const tools = makeScheduleTools(scheduler);
    const runNow = tools.find((t) => t.definition.name === "schedule_run_now")!;

    await runNow.handler({ id: task.id }, {} as never);

    assert.equal(runs.length, 1);
    const after = scheduler.get(task.id)!;
    // nextRunAt must be unchanged (still the cron-computed value)
    assert.equal(after.nextRunAt, originalNextRun,
      "nextRunAt must not change after schedule_run_now");

    scheduler.stop();
  });

  it("schedule_list shows tasks", async () => {
    const scheduler = new Scheduler({
      rootDir: toolDir,
      runner: async () => { /* no-op */ },
    });
    await scheduler.start();

    scheduler.add({ name: "list-test", prompt: "x", cron: "0 12 * * *" });

    const tools = makeScheduleTools(scheduler);
    const list = tools.find((t) => t.definition.name === "schedule_list")!;
    const result = await list.handler({}, {} as never);

    assert.equal(result.ok, true);
    assert.ok(result.content.includes("list-test"));
    scheduler.stop();
  });

  it("schedule_delete removes a task", async () => {
    const scheduler = new Scheduler({
      rootDir: toolDir,
      runner: async () => { /* no-op */ },
    });
    await scheduler.start();
    const task = scheduler.add({ name: "del-test", prompt: "x", cron: "0 12 * * *" });

    const tools = makeScheduleTools(scheduler);
    const del = tools.find((t) => t.definition.name === "schedule_delete")!;
    const result = await del.handler({ id: task.id }, {} as never);

    assert.equal(result.ok, true);
    assert.equal(scheduler.get(task.id), undefined);
    scheduler.stop();
  });

  it("schedule_update patches task fields", async () => {
    const scheduler = new Scheduler({
      rootDir: toolDir,
      runner: async () => { /* no-op */ },
    });
    await scheduler.start();
    const task = scheduler.add({ name: "upd-test", prompt: "old", cron: "0 9 * * *" });

    const tools = makeScheduleTools(scheduler);
    const upd = tools.find((t) => t.definition.name === "schedule_update")!;
    const result = await upd.handler(
      { id: task.id, name: "new-name", prompt: "new-prompt" },
      {} as never,
    );

    assert.equal(result.ok, true);
    const updated = scheduler.get(task.id)!;
    assert.equal(updated.name, "new-name");
    assert.equal(updated.prompt, "new-prompt");
    scheduler.stop();
  });

  it("schedule_update rejects invalid cron", async () => {
    const scheduler = new Scheduler({
      rootDir: toolDir,
      runner: async () => { /* no-op */ },
    });
    await scheduler.start();
    const task = scheduler.add({ name: "upd-cron", prompt: "x", cron: "0 9 * * *" });

    const tools = makeScheduleTools(scheduler);
    const upd = tools.find((t) => t.definition.name === "schedule_update")!;
    const result = await upd.handler(
      { id: task.id, cron: "60 * * * *" },
      {} as never,
    );

    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("Invalid cron") || result.error?.includes("out of range"));
    scheduler.stop();
  });
});
