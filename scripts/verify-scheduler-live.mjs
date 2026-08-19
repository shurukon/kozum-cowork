import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Scheduler } from "../src/main/schedule/scheduler.ts";

const rootDir = await mkdtemp(join(tmpdir(), "kozum-scheduler-live-"));
const marker = join(rootDir, "real-runs.jsonl");
let scheduler;
try {
  scheduler = new Scheduler({
    rootDir,
    runner: async (task) => {
      const record = JSON.stringify({ id: task.id, name: task.name, at: new Date().toISOString() });
      await writeFile(marker, `${record}\n`, { encoding: "utf8", flag: "a" });
    },
  });

  await scheduler.start();
  const task = scheduler.add({
    name: "live-every-minute",
    prompt: "Record one real scheduled execution.",
    cron: "* * * * *",
    timezone: "UTC",
  });
  await scheduler.flush();

  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(marker, "utf8");
      if (contents.trim().length > 0) break;
    } catch {
      // The first real run has not happened yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const contents = await readFile(marker, "utf8").catch(() => "");
  const runs = contents.trim() ? contents.trim().split("\n") : [];
  const current = scheduler.get(task.id);
  if (runs.length < 1 || current?.runCount !== 1 || current.lastStatus !== "success") {
    throw new Error(`Live scheduler verification failed: runs=${runs.length}, runCount=${current?.runCount}, status=${current?.lastStatus}`);
  }

  scheduler.remove(task.id);
  await scheduler.flush();
  scheduler.stop();
  console.log(JSON.stringify({ ok: true, executions: runs.length, runCount: current.runCount, status: current.lastStatus }));
} finally {
  scheduler?.stop();
  await rm(rootDir, { recursive: true, force: true });
}
