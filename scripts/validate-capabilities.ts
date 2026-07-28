/**
 * Validates the curated vision table against ground truth.
 *
 * OpenRouter and Kilo publish explicit input modalities for every model, which
 * gives us 689 labelled examples. We run the *inference* path against those ids
 * (deliberately ignoring the metadata) and compare to the published answer.
 *
 * This is the only honest way to know whether the pattern table is any good:
 * NVIDIA NIM and Wafer publish no modality data at all, so on those providers
 * inference is all we have.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { looksVisionCapable, resolveCapabilities } from "../src/main/providers/capabilities.ts";

const FIX = join(import.meta.dirname, "..", "tests", "fixtures");

interface Labelled {
  id: string;
  truth: boolean;
}

function load(file: string): any[] {
  const j = JSON.parse(readFileSync(join(FIX, file), "utf8"));
  return Array.isArray(j) ? j : (j.data ?? j.models ?? []);
}

function labelled(file: string): Labelled[] {
  const out: Labelled[] = [];
  for (const m of load(file)) {
    const mods: string[] | undefined =
      m?.architecture?.input_modalities ?? m?.modalities?.input;
    if (!Array.isArray(mods) || mods.length === 0) continue;
    out.push({ id: String(m.id), truth: mods.some((x) => /image|vision/i.test(x)) });
  }
  return out;
}

/**
 * Scores the *inference* path (metadata deliberately withheld) against truth.
 *
 * The metric that matters is `wronglyBlocked`: models we would resolve to a
 * hard "no" that actually do accept images. Those are the users who get locked
 * out of computer use for no reason. "unknown" is not a failure — it means the
 * agent tries and the provider adjudicates.
 */
function evaluate(name: string, rows: Labelled[]) {
  let confirmedYes = 0,
    wronglyAllowed = 0,
    correctlyNo = 0,
    wronglyBlocked = 0,
    unknownVision = 0,
    unknownText = 0;
  const blocked: string[] = [];

  for (const r of rows) {
    const v = resolveCapabilities(r.id, "openrouter").capabilities.vision;
    if (v === "yes" && r.truth) confirmedYes++;
    else if (v === "yes" && !r.truth) wronglyAllowed++;
    else if (v === "no" && !r.truth) correctlyNo++;
    else if (v === "no" && r.truth) {
      wronglyBlocked++;
      if (blocked.length < 10) blocked.push(r.id);
    } else if (v === "unknown" && r.truth) unknownVision++;
    else unknownText++;
  }

  console.log(`\n=== ${name} (${rows.length} labelled models) ===`);
  console.log(`  yes  -> correct ${confirmedYes}, wrongly allowed ${wronglyAllowed}`);
  console.log(`  no   -> correct ${correctlyNo}, WRONGLY BLOCKED ${wronglyBlocked}`);
  console.log(`  unknown -> ${unknownVision} vision, ${unknownText} text (agent may attempt)`);
  if (blocked.length) console.log(`  wrongly blocked:\n   - ${blocked.join("\n   - ")}`);

  return { wronglyBlocked, wronglyAllowed, total: rows.length };
}

const orRows = labelled("openrouter-models.json");
const kiloRows = labelled("kilo-models.json");
const a = evaluate("OpenRouter", orRows);
const b = evaluate("Kilo Gateway", kiloRows);

// Providers with no modality metadata: confirm the explicit path is not
// silently claiming knowledge it does not have.
console.log("\n=== metadata-free providers (inference is the only signal) ===");
for (const [file, pid] of [
  ["nvidia-nim-models.json", "nvidia-nim"],
  ["wafer-models.json", "wafer"],
] as const) {
  const models = load(file);
  const vis = models.filter((m: any) => looksVisionCapable(String(m.id), pid));
  const res = resolveCapabilities(String(models[0]?.id ?? ""), pid, models[0]);
  console.log(
    `${pid}: ${models.length} models, ${vis.length} inferred vision, inferred-flag=${res.inferred}`,
  );
  console.log(`   e.g. ${vis.slice(0, 6).map((m: any) => m.id).join(", ") || "(none)"}`);
}

// Guard the provider-wide override.
console.log("\n=== text-only provider override ===");
for (const pid of ["cerebras", "deepseek"]) {
  const r = resolveCapabilities("gemini-2.5-pro", pid); // deliberately a vision id
  console.log(`${pid} + vision-looking id -> vision="${r.capabilities.vision}" (must be "no")`);
  // Note: with a tri-state, truthiness is meaningless here — "no" is a truthy
  // string. Compare explicitly.
  if (r.capabilities.vision !== "no") {
    console.error("FAIL: text-only override did not hold");
    process.exit(1);
  }
}

if (a.wronglyBlocked + b.wronglyBlocked > 0 || a.wronglyAllowed + b.wronglyAllowed > 0) {
  console.error("\nFAIL: capability gate misclassified at least one model");
  process.exit(1);
}

const totalFn = a.wronglyBlocked + b.wronglyBlocked;
console.log(
  `\nTOTAL wrongly hard-blocked: ${totalFn} / ${a.total + b.total}  (target: 0)`,
);
