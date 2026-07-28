/**
 * Memory tools — exposes MemoryVault and ProjectKnowledgeBase to the agent loop.
 *
 * memory_write, memory_read, memory_search, memory_list, memory_delete,
 * project_kb_build, project_kb_update.
 */

import type { Tool } from "./registry.ts";
import { ok, fail } from "./registry.ts";
import type { MemoryVault } from "../memory/vault.ts";
import type { ProjectKnowledgeBase } from "../memory/projectKb.ts";
import type { MemoryType } from "../../shared/types.ts";

const MEMORY_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

type KbFactory = (projectId: string) => ProjectKnowledgeBase;

export function makeMemoryTools(vault: MemoryVault, kbFactory: KbFactory): Tool[] {
  return [
    /* -------------------------------------------------------- memory_write --- */
    {
      definition: {
        name: "memory_write",
        title: "Write Memory Note",
        description:
          "Create a new memory note in the vault. Notes are persisted as plain markdown and indexed for search.",
        icon: "brain",
        group: "system",
        modes: ["cowork", "code"],
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "A short, descriptive title for the note.",
            },
            type: {
              type: "string",
              enum: MEMORY_TYPES,
              description: "Note category: user, feedback, project, or reference.",
            },
            description: {
              type: "string",
              description: "One-line summary shown in the vault index.",
            },
            body: {
              type: "string",
              description: "Full markdown body of the note. May contain [[wikilinks]].",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional list of tags for search.",
            },
            links: {
              type: "array",
              items: { type: "string" },
              description: "Optional list of note IDs this note links to.",
            },
          },
          required: ["title", "type", "description", "body"],
        },
      },
      handler: async (input) => {
        const title = String(input["title"] ?? "");
        const type = String(input["type"] ?? "") as MemoryType;
        const description = String(input["description"] ?? "");
        const body = String(input["body"] ?? "");
        const tags = Array.isArray(input["tags"]) ? (input["tags"] as string[]) : [];
        const links = Array.isArray(input["links"]) ? (input["links"] as string[]) : [];

        if (!MEMORY_TYPES.includes(type)) {
          return fail(`Invalid type "${type}". Must be one of: ${MEMORY_TYPES.join(", ")}.`);
        }

        try {
          const note = await vault.write({ title, type, description, tags, body, links });
          return ok(
            `Note created: id=${note.id}\npath=${note.path}`,
            { summary: `Memory saved: ${note.title} (${note.type})`, files: [note.path] },
          );
        } catch (e) {
          return fail(`Failed to write note: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },

    /* --------------------------------------------------------- memory_read --- */
    {
      definition: {
        name: "memory_read",
        title: "Read Memory Note",
        description: "Read a note from the vault by its id.",
        icon: "book-open",
        group: "system",
        modes: ["cowork", "code"],
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The note id (slug) to retrieve.",
            },
          },
          required: ["id"],
        },
      },
      handler: async (input) => {
        const id = String(input["id"] ?? "");
        try {
          const result = await vault.read(id);
          if (!result) return fail(`Note not found: "${id}".`);
          const { note, body } = result;
          const text = [
            `# ${note.title}`,
            `id: ${note.id}`,
            `type: ${note.type}`,
            `description: ${note.description}`,
            `tags: ${note.tags.join(", ")}`,
            `updatedAt: ${new Date(note.updatedAt).toISOString()}`,
            "",
            body,
          ].join("\n");
          return ok(text, { summary: `Memory: ${note.title}`, files: [note.path] });
        } catch (e) {
          return fail(`Failed to read note: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },

    /* ------------------------------------------------------- memory_search --- */
    {
      definition: {
        name: "memory_search",
        title: "Search Memory",
        description: "Full-text search across all vault notes using an inverted index.",
        icon: "search",
        group: "system",
        modes: ["cowork", "code"],
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query. Stopwords are filtered; title matches rank highest.",
            },
            limit: {
              type: "integer",
              description: "Maximum results to return (default 10).",
              default: 10,
            },
          },
          required: ["query"],
        },
      },
      handler: async (input) => {
        const query = String(input["query"] ?? "");
        const limit = typeof input["limit"] === "number" ? Math.trunc(input["limit"]) : 10;
        try {
          const results = await vault.search(query, limit);
          if (results.length === 0) return ok(`No results for: ${query}`);

          const lines: string[] = [`Search results for "${query}" (${results.length} found):\n`];
          for (const { id, score } of results) {
            const result = await vault.read(id);
            if (!result) continue;
            const { note } = result;
            lines.push(`- **${note.title}** (${note.type}) — score: ${score.toFixed(3)}`);
            lines.push(`  id: ${id}`);
            lines.push(`  ${note.description}`);
          }
          return ok(lines.join("\n"), { summary: `Found ${results.length} notes` });
        } catch (e) {
          return fail(`Search failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },

    /* --------------------------------------------------------- memory_list --- */
    {
      definition: {
        name: "memory_list",
        title: "List Memory Notes",
        description: "List all notes in the vault, optionally filtered by type.",
        icon: "list",
        group: "system",
        modes: ["cowork", "code"],
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: MEMORY_TYPES,
              description: "Optional type filter: user, feedback, project, or reference.",
            },
          },
        },
      },
      handler: async (input) => {
        const type = input["type"] ? (String(input["type"]) as MemoryType) : undefined;
        if (type && !MEMORY_TYPES.includes(type)) {
          return fail(`Invalid type "${type}". Must be one of: ${MEMORY_TYPES.join(", ")}.`);
        }
        try {
          const notes = await vault.list(type);
          if (notes.length === 0) {
            return ok(type ? `No notes of type "${type}".` : "Vault is empty.");
          }
          const lines = notes.map(
            (n) => `- **${n.title}** (${n.type}) — ${n.description} [id: ${n.id}]`,
          );
          return ok(
            `${notes.length} note${notes.length === 1 ? "" : "s"}${type ? ` of type "${type}"` : ""}:\n\n${lines.join("\n")}`,
            { summary: `${notes.length} memory notes` },
          );
        } catch (e) {
          return fail(`List failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },

    /* ------------------------------------------------------- memory_delete --- */
    {
      definition: {
        name: "memory_delete",
        title: "Delete Memory Note",
        description: "Permanently delete a note from the vault.",
        icon: "trash-2",
        group: "system",
        dangerous: true,
        modes: ["cowork", "code"],
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The note id to delete.",
            },
          },
          required: ["id"],
        },
      },
      handler: async (input) => {
        const id = String(input["id"] ?? "");
        try {
          const deleted = await vault.delete(id);
          if (!deleted) return fail(`Note not found: "${id}".`);
          return ok(`Deleted note: ${id}`, { summary: `Memory deleted: ${id}` });
        } catch (e) {
          return fail(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },

    /* ----------------------------------------------------- project_kb_build --- */
    {
      definition: {
        name: "project_kb_build",
        title: "Build Project Knowledge Base",
        description:
          "Walk a code repository and build a project knowledge base (file map, stack detection, architecture notes). " +
          "Should be run once per project; use project_kb_update afterwards.",
        icon: "database",
        group: "system",
        modes: ["cowork", "code"],
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path to the project root directory.",
            },
            project_id: {
              type: "string",
              description:
                "Identifier for this project (used as the KB directory name). Defaults to the directory basename.",
            },
          },
          required: ["path"],
        },
      },
      handler: async (input, ctx) => {
        const rootDir = String(input["path"] ?? "");
        const projectId = input["project_id"]
          ? String(input["project_id"])
          : rootDir.split("/").filter(Boolean).pop() ?? "unknown";

        ctx.onProgress(`Building project KB for ${projectId}...`);
        try {
          const kb = kbFactory(projectId);
          await kb.build(rootDir);
          const summary = await kb.summary();
          return ok(
            `Project KB built for "${projectId}".\n\n${summary}`,
            { summary: `KB built: ${projectId}` },
          );
        } catch (e) {
          return fail(`KB build failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },

    /* ---------------------------------------------------- project_kb_update --- */
    {
      definition: {
        name: "project_kb_update",
        title: "Update Project Knowledge Base",
        description:
          "Incrementally update an existing project KB — re-scan the tree and rewrite only changed files.",
        icon: "refresh-cw",
        group: "system",
        modes: ["cowork", "code"],
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path to the project root directory.",
            },
            project_id: {
              type: "string",
              description: "Project identifier. Defaults to the directory basename.",
            },
          },
          required: ["path"],
        },
      },
      handler: async (input, ctx) => {
        const rootDir = String(input["path"] ?? "");
        const projectId = input["project_id"]
          ? String(input["project_id"])
          : rootDir.split("/").filter(Boolean).pop() ?? "unknown";

        ctx.onProgress(`Updating project KB for ${projectId}...`);
        try {
          const kb = kbFactory(projectId);
          const diff = await kb.updateIncremental(rootDir);
          const summary = await kb.summary();
          return ok(
            `Project KB updated for "${projectId}".\n` +
              `Changes: +${diff.added} added, ~${diff.modified} modified, -${diff.removed} removed.\n\n${summary}`,
            { summary: `KB updated: +${diff.added} ~${diff.modified} -${diff.removed}` },
          );
        } catch (e) {
          return fail(`KB update failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },
  ];
}
