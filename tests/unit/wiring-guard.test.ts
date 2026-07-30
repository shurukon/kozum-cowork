/**
 * Guard against inert UI.
 *
 * The v0.2.0 build shipped a complete backend — 82 tools, 666 passing tests —
 * behind a UI whose every callback was `() => {/* wire bridge *\/}`. Providers
 * rendered blank because `presets={[]}` was hardcoded; sending a message added
 * it locally and never called the backend; "Customize" routed to the home
 * screen instead of Settings. Every test passed, because no test asserted that
 * the renderer actually talks to the main process.
 *
 * These are static checks on source text, which is unusual for a test — but the
 * defect class is precisely "the code looks finished and does nothing", and
 * that is invisible to unit tests of the parts. Running React here is not
 * possible (no DOM, no Electron), so this is the honest substitute.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const RENDERER = join(import.meta.dirname, "..", "..", "src", "renderer");
const APP = readFileSync(join(RENDERER, "App.tsx"), "utf8");

// Dialog files that now own the bridge calls that moved out of App.tsx.
const SCHEDULE_DIALOG = readFileSync(
  join(RENDERER, "components", "ScheduleDialog.tsx"),
  "utf8",
);
const CONNECTOR_DIALOG = readFileSync(
  join(RENDERER, "components", "ConnectorDialog.tsx"),
  "utf8",
);
const PLUGIN_DIALOG = readFileSync(
  join(RENDERER, "components", "PluginDialog.tsx"),
  "utf8",
);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const SOURCES = walk(RENDERER).map((p) => ({ path: p, text: readFileSync(p, "utf8") }));

describe("no placeholder handlers survive", () => {
  it("has no 'wire bridge' style TODO comments left in any handler", () => {
    const offenders: string[] = [];
    for (const { path, text } of SOURCES) {
      // The exact shapes that shipped inert.
      const bad = [
        /\{\s*\/\*\s*wire\b[^*]*\*\/\s*\}/i,
        /\/\/\s*In a real wiring/i,
        /\{\s*\/\*\s*open [a-z-]+ (form|flow|view)\s*\*\/\s*\}/i,
        /\{\s*\/\*\s*create [a-z ]+ task\s*\*\/\s*\}/i,
      ];
      for (const re of bad) {
        if (re.test(text)) offenders.push(`${path.replace(RENDERER, "renderer")} :: ${re}`);
      }
    }
    assert.deepEqual(offenders, [], `placeholder handlers found:\n${offenders.join("\n")}`);
  });

  it("App.tsx passes no hardcoded empty catalogue to Settings", () => {
    // `presets={[]}` is why the Providers pane rendered blank.
    for (const prop of ["presets", "keys", "skills", "connectors", "plugins"]) {
      const empty = new RegExp(`${prop}=\\{(\\[\\]|\\{\\})\\}`);
      assert.ok(
        !empty.test(APP),
        `${prop} is hardcoded empty in App.tsx — it must come from the bridge`,
      );
    }
  });
});

describe("App.tsx actually calls the backend", () => {
  // These calls must appear in App.tsx (or via `const b = bridge(); b.x.y()`)
  const requiredInApp = [
    "bridge().settings.get",
    "bridge().settings.set",
    "bridge().providers.presets",
    "bridge().providers.listKeys",
    "bridge().providers.addKey",
    "bridge().providers.removeKey",
    "bridge().providers.refreshModels",
    "bridge().sessions.create",
    "bridge().sessions.send",
    "bridge().sessions.cancel",
    "bridge().sessions.list",
    "bridge().sessions.onEvent",
    "bridge().schedule.list",
    "bridge().mcp.list",
    "bridge().plugins.list",
    "bridge().skills.list",
    "bridge().projects.create",
    "bridge().dialog.selectFolder",
  ];

  for (const call of requiredInApp) {
    it(`calls ${call}`, () => {
      // Tolerate `const b = bridge(); b.x.y()` by also accepting the method path.
      const method = call.replace("bridge().", "");
      assert.ok(
        APP.includes(call) || new RegExp(`\\b${method.replace(/\./g, "\\.")}\\(`).test(APP),
        `App.tsx never calls ${call}`,
      );
    });
  }

  // These three calls moved into their respective dialog components.
  // The guard now confirms they exist there.

  it("calls bridge().schedule.create (in ScheduleDialog)", () => {
    assert.ok(
      SCHEDULE_DIALOG.includes("bridge().schedule.create"),
      "ScheduleDialog.tsx never calls bridge().schedule.create",
    );
  });

  it("calls bridge().mcp.add (in ConnectorDialog)", () => {
    assert.ok(
      CONNECTOR_DIALOG.includes("bridge().mcp.add"),
      "ConnectorDialog.tsx never calls bridge().mcp.add",
    );
  });

  it("calls bridge().plugins.installFromUrl (in PluginDialog)", () => {
    assert.ok(
      PLUGIN_DIALOG.includes("bridge().plugins.installFromUrl"),
      "PluginDialog.tsx never calls bridge().plugins.installFromUrl",
    );
  });

  it("calls bridge().dialog.selectFolder (in ScheduleDialog for working folder)", () => {
    assert.ok(
      SCHEDULE_DIALOG.includes("bridge().dialog.selectFolder"),
      "ScheduleDialog.tsx never calls bridge().dialog.selectFolder",
    );
  });

  // Major new controls added in the integration pass — these must not ship inert.

  it("calls bridge().sessions.branch", () => {
    assert.ok(
      APP.includes("bridge().sessions.branch"),
      "App.tsx never calls bridge().sessions.branch",
    );
  });

  it("calls bridge().sessions.delete", () => {
    assert.ok(
      APP.includes("bridge().sessions.delete"),
      "App.tsx never calls bridge().sessions.delete",
    );
  });

  it("calls bridge().providers.addCustom", () => {
    assert.ok(
      APP.includes("bridge().providers.addCustom"),
      "App.tsx never calls bridge().providers.addCustom",
    );
  });

  it("calls bridge().memory.setRules", () => {
    assert.ok(
      APP.includes("bridge().memory.setRules"),
      "App.tsx never calls bridge().memory.setRules",
    );
  });
});

describe("navigation and settings reachability", () => {
  it("Customize opens Settings rather than routing to a page", () => {
    assert.match(
      APP,
      /key === "customize"[\s\S]{0,200}openSettings\(\)/,
      "Customize must open the Settings modal",
    );
  });

  it("the account row opens Settings", () => {
    assert.match(APP, /onAccountClick=\{openSettings\}/);
  });

  it("Settings is not reachable only via the model picker", () => {
    // The old flow required two clicks through 'customize' to reach Settings.
    assert.ok(
      !/onPickModel=\{\(\) => setNav\("customize"\)\}/.test(APP),
      "model picker must not route through the customize nav key",
    );
  });
});

describe("removed surfaces stay removed", () => {
  it("Artifacts is gone from the renderer entirely", () => {
    for (const { path, text } of SOURCES) {
      assert.ok(
        !/from "\.\.?\/pages\/Artifacts/.test(text),
        `${path} still imports the deleted Artifacts page`,
      );
    }
  });

  it("no Arabic or RTL handling remains", () => {
    for (const { path, text } of SOURCES) {
      assert.ok(!/documentElement\.dir\s*=/.test(text), `${path} still sets text direction`);
      assert.ok(!/"ar"/.test(text), `${path} still references the Arabic locale`);
    }
  });

  it("Privacy and Usage panes are gone from Settings", () => {
    const settings = readFileSync(join(RENDERER, "components", "Settings.tsx"), "utf8");
    assert.ok(!/PanePrivacy|PaneUsage/.test(settings));
  });
});

describe("errors are surfaced", () => {
  it("App.tsx renders a banner and sets it from failed Results", () => {
    assert.match(APP, /setBanner\(/, "no error surfacing at all");
    // A failed Result must reach the user, not be swallowed.
    assert.match(
      APP,
      /if \(!res\.ok\)[\s\S]{0,80}setBanner\(res\.error\)/,
      "failed Results must be shown to the user",
    );
  });

  it("subscribes to agent error events", () => {
    assert.match(APP, /e\.type === "error"[\s\S]{0,60}setBanner/);
  });
});
