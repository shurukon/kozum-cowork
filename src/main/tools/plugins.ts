/**
 * Plugin management tools.
 *
 * Exposes the PluginManager to the agent loop as Tool instances.
 *
 * plugin_install  — install from a GitHub ref/URL or absolute path to a .zip
 * plugin_list     — list all installed plugins
 * plugin_enable   — enable a disabled plugin
 * plugin_disable  — disable an enabled plugin
 * plugin_uninstall — remove a plugin completely
 * marketplace_add  — add a marketplace by source (owner/repo or URL)
 * marketplace_list — list plugins available in a marketplace
 */

import { readFile } from "node:fs/promises";

import type { Tool } from "./registry.ts";
import { ok, fail } from "./registry.ts";
import type { PluginManager } from "../plugins/manager.ts";

/* ----------------------------------------------------------------- tools --- */

export function makePluginTools(manager: PluginManager): Tool[] {
  return [
    /* ------------------------------------------------------- plugin_install */
    {
      definition: {
        name: "plugin_install",
        title: "Install Plugin",
        description:
          "Install a plugin from a GitHub repository reference or an absolute path to " +
          "a .zip file. GitHub refs: \"owner/repo\", \"owner/repo@ref\", " +
          "\"https://github.com/owner/repo\", or \"https://github.com/owner/repo/tree/<ref>/<subpath>\". " +
          "The plugin is installed immediately — no restart required. " +
          "Reports discovered skills, agents, commands, and MCP servers.",
        inputSchema: {
          type: "object",
          properties: {
            source: {
              type: "string",
              description:
                "A GitHub ref (e.g. owner/repo or owner/repo@main) or an absolute path " +
                "to a .zip file on the local filesystem.",
            },
            ref: {
              type: "string",
              description: "Optional git ref (branch, tag, or SHA) when source is a GitHub ref.",
            },
            subPath: {
              type: "string",
              description:
                "Optional sub-path within the repository, for monorepo plugins. " +
                "E.g. \"packages/my-plugin\".",
            },
          },
          required: ["source"],
        },
        icon: "package",
        group: "plugin",
        dangerous: true,
        modes: ["cowork", "code"],
      },
      async handler(input, _ctx) {
        const source = String(input["source"] ?? "").trim();
        if (!source) return fail("source is required.");

        const ref = input["ref"] ? String(input["ref"]).trim() : undefined;
        const subPath = input["subPath"] ? String(input["subPath"]).trim() : undefined;

        try {
          let plugin;

          if (source.startsWith("/") || source.match(/^[A-Za-z]:\\/)) {
            // Local .zip file
            if (!source.endsWith(".zip")) {
              return fail(
                `Local source "${source}" does not end in .zip. ` +
                  `Provide an absolute path to a .zip file, or a GitHub ref.`,
              );
            }
            let buf: Buffer;
            try {
              buf = await readFile(source);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              return fail(`Cannot read .zip file: ${msg}`);
            }
            plugin = await manager.installFromZip(buf, source);
          } else {
            // GitHub ref — possibly incorporate ref/subPath
            let gitRef = source;
            if (ref && !gitRef.includes("@")) {
              gitRef = `${gitRef}@${ref}`;
            }
            if (subPath && !source.includes("/tree/")) {
              // Check if subPath is already in the source
              const parts = gitRef.split("/");
              if (parts.length === 2 || (parts.length === 2 && gitRef.includes("@"))) {
                gitRef = `${gitRef}/${subPath}`;
              }
            }
            plugin = await manager.installFromGitHub(gitRef);
          }

          const lines: string[] = [
            `Installed plugin: ${plugin.name} v${plugin.version}`,
            `ID: ${plugin.id}`,
            `Path: ${plugin.path}`,
          ];
          if (plugin.description) lines.push(`Description: ${plugin.description}`);
          if (plugin.author) lines.push(`Author: ${plugin.author}`);

          const contributions: string[] = [];
          if (plugin.skills.length > 0) contributions.push(`Skills: ${plugin.skills.join(", ")}`);
          if (plugin.agents.length > 0) contributions.push(`Agents: ${plugin.agents.join(", ")}`);
          if (plugin.commands.length > 0)
            contributions.push(`Commands: ${plugin.commands.join(", ")}`);
          if (plugin.mcpServers.length > 0)
            contributions.push(`MCP servers: ${plugin.mcpServers.join(", ")}`);
          if (plugin.hasHooks) contributions.push("Hooks: yes");

          if (contributions.length > 0) {
            lines.push("", "Contributions:", ...contributions.map((c) => `  ${c}`));
          } else {
            lines.push("", "No skills, agents, or other contributions discovered.");
          }

          return ok(lines.join("\n"), {
            summary: `Installed plugin: ${plugin.name} v${plugin.version}`,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return fail(`Plugin installation failed: ${msg}`);
        }
      },
    },

    /* --------------------------------------------------------- plugin_list */
    {
      definition: {
        name: "plugin_list",
        title: "List Plugins",
        description: "List all installed plugins with their status and contributions.",
        inputSchema: {
          type: "object",
          properties: {},
        },
        icon: "package",
        group: "plugin",
        modes: ["cowork", "code"],
      },
      async handler(_input, _ctx) {
        try {
          const plugins = await manager.list();
          if (plugins.length === 0) {
            return ok("No plugins installed.", { summary: "No plugins" });
          }
          const lines = plugins.map((p) => {
            const status = p.error
              ? `ERROR: ${p.error}`
              : p.enabled
              ? "enabled"
              : "disabled";
            const contrib: string[] = [];
            if (p.skills.length > 0) contrib.push(`${p.skills.length} skill(s)`);
            if (p.agents.length > 0) contrib.push(`${p.agents.length} agent(s)`);
            if (p.commands.length > 0) contrib.push(`${p.commands.length} command(s)`);
            if (p.mcpServers.length > 0) contrib.push(`${p.mcpServers.length} MCP server(s)`);
            const contribStr = contrib.length > 0 ? ` [${contrib.join(", ")}]` : "";
            return `${p.id}  ${p.name} v${p.version}  ${status}${contribStr}`;
          });
          return ok(lines.join("\n"), {
            summary: `${plugins.length} plugin(s)`,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return fail(`Failed to list plugins: ${msg}`);
        }
      },
    },

    /* ------------------------------------------------------- plugin_enable */
    {
      definition: {
        name: "plugin_enable",
        title: "Enable Plugin",
        description: "Enable a previously disabled plugin.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The plugin ID as shown by plugin_list.",
            },
          },
          required: ["id"],
        },
        icon: "package",
        group: "plugin",
        modes: ["cowork", "code"],
      },
      async handler(input, _ctx) {
        const id = String(input["id"] ?? "").trim();
        try {
          const plugin = await manager.enable(id);
          return ok(`Plugin "${plugin.name}" (${id}) is now enabled.`, {
            summary: `Enabled: ${plugin.name}`,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return fail(`Failed to enable plugin: ${msg}`);
        }
      },
    },

    /* ------------------------------------------------------ plugin_disable */
    {
      definition: {
        name: "plugin_disable",
        title: "Disable Plugin",
        description: "Disable a plugin without uninstalling it.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The plugin ID as shown by plugin_list.",
            },
          },
          required: ["id"],
        },
        icon: "package",
        group: "plugin",
        modes: ["cowork", "code"],
      },
      async handler(input, _ctx) {
        const id = String(input["id"] ?? "").trim();
        try {
          const plugin = await manager.disable(id);
          return ok(`Plugin "${plugin.name}" (${id}) is now disabled.`, {
            summary: `Disabled: ${plugin.name}`,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return fail(`Failed to disable plugin: ${msg}`);
        }
      },
    },

    /* ---------------------------------------------------- plugin_uninstall */
    {
      definition: {
        name: "plugin_uninstall",
        title: "Uninstall Plugin",
        description: "Completely remove a plugin, deleting its files and state.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The plugin ID as shown by plugin_list.",
            },
          },
          required: ["id"],
        },
        icon: "package",
        group: "plugin",
        dangerous: true,
        modes: ["cowork", "code"],
      },
      async handler(input, _ctx) {
        const id = String(input["id"] ?? "").trim();
        try {
          // Capture name before uninstall
          const plugins = await manager.list();
          const plugin = plugins.find((p) => p.id === id);
          await manager.uninstall(id);
          const name = plugin ? plugin.name : id;
          return ok(`Plugin "${name}" (${id}) has been uninstalled.`, {
            summary: `Uninstalled: ${name}`,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return fail(`Failed to uninstall plugin: ${msg}`);
        }
      },
    },

    /* ---------------------------------------------------- marketplace_add */
    {
      definition: {
        name: "marketplace_add",
        title: "Add Marketplace",
        description:
          "Add a plugin marketplace by its GitHub owner/repo or a full URL to its " +
          ".claude-plugin/marketplace.json. The manifest is fetched and cached.",
        inputSchema: {
          type: "object",
          properties: {
            source: {
              type: "string",
              description:
                "GitHub owner/repo (e.g. acme/my-plugins) or a full URL to the marketplace.",
            },
          },
          required: ["source"],
        },
        icon: "store",
        group: "plugin",
        modes: ["cowork", "code"],
      },
      async handler(input, _ctx) {
        const source = String(input["source"] ?? "").trim();
        if (!source) return fail("source is required.");
        try {
          const marketplace = await manager.addMarketplace(source);
          return ok(
            `Marketplace added: ${marketplace.name} (${marketplace.id})\n` +
              `Source: ${marketplace.source}\n` +
              `Plugins available: ${marketplace.pluginCount}`,
            { summary: `Marketplace: ${marketplace.name}` },
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return fail(`Failed to add marketplace: ${msg}`);
        }
      },
    },

    /* --------------------------------------------------- marketplace_list */
    {
      definition: {
        name: "marketplace_list",
        title: "List Marketplace",
        description: "List plugins available in a marketplace.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The marketplace ID as returned by marketplace_add.",
            },
          },
          required: ["id"],
        },
        icon: "store",
        group: "plugin",
        modes: ["cowork", "code"],
      },
      async handler(input, _ctx) {
        const id = String(input["id"] ?? "").trim();
        try {
          const manifest = await manager.listMarketplace(id);
          if (!manifest) {
            return fail(`Marketplace "${id}" not found. Use marketplace_add first.`);
          }
          if (manifest.plugins.length === 0) {
            return ok(`Marketplace "${manifest.name}" has no plugins.`, {
              summary: `${manifest.name}: 0 plugins`,
            });
          }
          const lines = manifest.plugins.map((p) => {
            const ver = p.version ? ` v${p.version}` : "";
            const cat = p.category ? ` [${p.category}]` : "";
            return `• ${p.name}${ver}${cat}  ${p.description}`;
          });
          return ok(
            `Marketplace: ${manifest.name} (${manifest.owner})\n\n${lines.join("\n")}`,
            { summary: `${manifest.name}: ${manifest.plugins.length} plugin(s)` },
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return fail(`Failed to list marketplace: ${msg}`);
        }
      },
    },
  ];
}
