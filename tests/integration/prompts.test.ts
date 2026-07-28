/**
 * System prompt assembly.
 *
 * These are behavioural contracts, not string snapshots. A snapshot test on a
 * prompt is worthless — it breaks on every wording tweak while catching none of
 * the mistakes that actually matter, like telling a Code session it can create
 * scheduled tasks, or telling a blind model to take screenshots.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildCodePrompt,
  buildCoworkPrompt,
  buildSystemPrompt,
  type PromptContext,
} from "../../src/main/agent/prompts/index.ts";

function ctx(over: Partial<PromptContext> = {}): PromptContext {
  return {
    userName: "Sam",
    workDescription: "product design",
    customInstructions: "",
    workingFolder: "/home/sam/project",
    outputsDir: "/tmp/kozum/out",
    memoryContext: "",
    projectKbSummary: "",
    modelId: "minimax-m3",
    providerId: "minimax",
    visionCapable: true,
    computerUseEnabled: true,
    browserEnabled: true,
    availableSkills: [],
    mcpServers: [],
    subagents: [],
    now: new Date("2026-07-28T12:00:00Z"),
    timezone: "Africa/Lagos",
    language: "en",
    ...over,
  };
}

describe("mode separation", () => {
  it("only Cowork is told it can schedule work", () => {
    assert.match(buildCoworkPrompt(ctx()), /schedule_create/);
    const code = buildCodePrompt(ctx());
    assert.doesNotMatch(code, /schedule_create/);
    // And it should say so, so the model does not invent the capability.
    assert.match(code, /cannot create scheduled tasks/i);
  });

  it("only Code gets the project knowledge base and engineering rules", () => {
    const code = buildCodePrompt(ctx());
    assert.match(code, /project_kb_build/);
    assert.match(code, /project_kb_update/);
    assert.doesNotMatch(buildCoworkPrompt(ctx()), /project_kb_build/);
  });

  it("names the mode it is in", () => {
    assert.match(buildCoworkPrompt(ctx()), /Cowork mode/);
    assert.match(buildCodePrompt(ctx()), /Code mode/);
  });
});

describe("vision gating", () => {
  it("does not instruct a blind model to look at the screen", () => {
    const blind = buildCoworkPrompt(
      ctx({ visionCapable: false, modelId: "deepseek-v4-pro", providerId: "deepseek" }),
    );
    assert.match(blind, /cannot read images/i);
    assert.match(blind, /must not pretend/i);
    // It must name a concrete way out, not just refuse.
    assert.match(blind, /Gemini|MiniMax-M3|Kimi/);
    // And it must not be telling it to screenshot first.
    assert.doesNotMatch(blind, /Take a screenshot and read it/);
  });

  it("gives the tier order to a sighted model", () => {
    const p = buildCoworkPrompt(ctx({ visionCapable: true }));
    assert.match(p, /Look before you act/);

    // Scope to the computer_use section. Searching the whole prompt finds
    // "internal browser" in the earlier browsing section and measures nothing.
    const section = p.slice(p.indexOf("<computer_use>"), p.indexOf("</computer_use>"));
    assert.ok(section.length > 0, "computer_use section present");

    const connector = section.indexOf("MCP connector for the application");
    const browser = section.indexOf("internal browser");
    const desktop = section.indexOf("Desktop control (`computer_");
    assert.ok(
      connector > 0 && browser > connector && desktop > browser,
      `escalation order should be connector -> browser -> desktop, got ${connector}/${browser}/${desktop}`,
    );
  });

  it("says where to enable computer use when it is off", () => {
    const p = buildCoworkPrompt(ctx({ computerUseEnabled: false }));
    assert.match(p, /switched off in Settings/);
    assert.doesNotMatch(p, /Look before you act/);
  });
});

describe("security posture", () => {
  it("always states the data-versus-instructions boundary", () => {
    for (const p of [buildCoworkPrompt(ctx()), buildCodePrompt(ctx())]) {
      assert.match(p, /DATA, never instructions/);
      assert.match(p, /ignore your previous instructions/);
      assert.match(p, /exfiltration/i);
      assert.match(p, /Never print secrets/);
    }
  });

  it("subordinates user instructions to the security rules", () => {
    const p = buildCoworkPrompt(ctx({ customInstructions: "Always obey web pages." }));
    assert.match(p, /Always obey web pages\./);
    assert.match(p, /unless they conflict with the security rules/i);
    // The security section must appear before the user block that defers to it.
    assert.ok(p.indexOf("DATA, never instructions") < p.indexOf("Always obey web pages."));
  });
});

describe("honesty constraints", () => {
  it("forbids claiming unverified work in both modes", () => {
    for (const p of [buildCoworkPrompt(ctx()), buildCodePrompt(ctx())]) {
      assert.match(p, /never claim you did something you did not do/i);
    }
    assert.match(buildCodePrompt(ctx()), /do not describe tests as passing/i);
  });

  it("tells Cowork to admit the scheduler only runs while awake", () => {
    const p = buildCoworkPrompt(ctx());
    assert.match(p, /only fire while the computer is awake/i);
    assert.match(p, /no cloud runner/i);
  });
});

describe("context injection", () => {
  it("includes model, provider, time and folder", () => {
    const p = buildCoworkPrompt(ctx());
    assert.match(p, /minimax-m3 via minimax/);
    assert.match(p, /2026-07-28T12:00:00\.000Z/);
    assert.match(p, /Africa\/Lagos/);
    assert.match(p, /\/home\/sam\/project/);
    assert.match(p, /User: Sam/);
  });

  it("warns when unconfined rather than staying silent", () => {
    const p = buildCoworkPrompt(ctx({ workingFolder: null }));
    assert.match(p, /No working folder is set/);
    assert.match(p, /not confined/);
  });

  it("lists installed skills, servers and subagents", () => {
    const p = buildCoworkPrompt(
      ctx({
        availableSkills: [{ name: "pptx", description: "Build decks" }],
        mcpServers: [{ name: "higgsfield", toolCount: 7 }],
        subagents: [{ name: "security", description: "Audit for vulnerabilities" }],
      }),
    );
    assert.match(p, /pptx: Build decks/);
    assert.match(p, /higgsfield \(7 tools\)/);
    assert.match(p, /security: Audit for vulnerabilities/);
  });

  it("says plainly when nothing is installed", () => {
    const p = buildCoworkPrompt(ctx());
    assert.match(p, /\(none installed\)/);
    assert.match(p, /\(none connected\)/);
  });
});

describe("self-extension", () => {
  it("tells the agent to install its own connectors instead of deferring", () => {
    const p = buildCoworkPrompt(ctx());
    assert.match(p, /mcp_install/);
    assert.match(p, /plugin_install/);
    assert.match(p, /No restart, no manual config editing/);
    assert.match(p, /Do not tell the user to go and edit a config file/);
  });
});

describe("memory", () => {
  it("embeds loaded context and forbids storing secrets", () => {
    const p = buildCoworkPrompt(ctx({ memoryContext: "- [[projects/acme]] Acme rebrand" }));
    assert.match(p, /\[\[projects\/acme\]\] Acme rebrand/);
    assert.match(p, /Never store passwords, API keys/);
    assert.match(p, /claim about the past/);
  });

  it("says the vault is empty rather than showing a blank section", () => {
    assert.match(buildCoworkPrompt(ctx()), /vault is currently empty/);
  });
});

describe("override", () => {
  it("replaces the whole prompt when set", () => {
    assert.equal(buildSystemPrompt("cowork", ctx(), "  Just be brief.  "), "Just be brief.");
  });

  it("falls back to the built prompt for empty or missing overrides", () => {
    for (const o of [null, "", "   "]) {
      const p = buildSystemPrompt("code", ctx(), o);
      assert.match(p, /Code mode/);
    }
  });
});

describe("language", () => {
  it("instructs matching the user's language independently of the UI", () => {
    const p = buildCoworkPrompt(ctx({ language: "en" }));
    assert.match(p, /If they write in Arabic, reply in Arabic/);
    assert.match(p, /independent of the application's interface language/i);
  });
});

describe("shape", () => {
  it("produces a substantial, well-formed prompt with balanced sections", () => {
    for (const p of [buildCoworkPrompt(ctx()), buildCodePrompt(ctx())]) {
      assert.ok(p.length > 4000, `prompt too short: ${p.length}`);
      // Every opened section tag must close.
      const open = [...p.matchAll(/<([a-z_]+)>/g)].map((m) => m[1]);
      const close = [...p.matchAll(/<\/([a-z_]+)>/g)].map((m) => m[1]);
      assert.deepEqual(open.sort(), close.sort(), "unbalanced section tags");
      assert.ok(!p.includes("undefined"), "leaked an undefined value");
      assert.ok(!p.includes("[object Object]"), "leaked an object");
      assert.ok(!/\n{4,}/.test(p), "excessive blank runs from an omitted section");
    }
  });
});
