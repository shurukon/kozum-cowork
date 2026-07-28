/**
 * MemoryVault — Obsidian-style local memory vault.
 *
 * Plain markdown files on disk, YAML frontmatter + [[wikilinks]].
 * An _index.md hub lists every note; _hot-cache.md holds recent session summaries.
 * A pure-JS inverted index handles search (no native modules needed).
 */

import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  unlink,
  stat,
} from "node:fs/promises";
import { join, basename } from "node:path";
import type { MemoryType, MemoryNote } from "../../shared/types.ts";
import { parseFrontmatter } from "../agent/frontmatter.ts";

/* ----------------------------------------------------------------- types --- */

interface NoteInput {
  title: string;
  type: MemoryType;
  description: string;
  tags?: string[];
  body: string;
  links?: string[];
}

interface SearchIndex {
  /** word → { noteId → count } */
  postings: Record<string, Record<string, number>>;
  /** noteId → word count (for IDF) */
  docLen: Record<string, number>;
  /** total docs */
  N: number;
}

interface LintReport {
  orphans: string[];       // note ids with no inbound links
  deadLinks: Array<{ from: string; target: string }>;
  missingDescription: string[];
}

/* --------------------------------------------------------------- helpers --- */

const TYPE_DIRS: Record<MemoryType, string> = {
  user: "user",
  feedback: "feedback",
  project: "projects",
  reference: "reference",
};

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "its", "be", "was", "are",
  "were", "been", "as", "this", "that", "have", "has", "had", "will",
  "can", "do", "does", "did",
]);

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function extractWikilinks(body: string): string[] {
  const matches = body.match(/\[\[([^\]]+)\]\]/g) ?? [];
  return matches.map((m) => m.slice(2, -2).trim());
}

function buildFrontmatter(note: MemoryNote): string {
  const tags = note.tags.length > 0 ? `[${note.tags.join(", ")}]` : "[]";
  const links = note.links.length > 0 ? `[${note.links.join(", ")}]` : "[]";
  return [
    "---",
    `id: ${note.id}`,
    `title: ${note.title}`,
    `type: ${note.type}`,
    `description: ${note.description}`,
    `tags: ${tags}`,
    `links: ${links}`,
    `updatedAt: ${note.updatedAt}`,
    "---",
    "",
  ].join("\n");
}

function noteToMarkdown(note: MemoryNote, body: string): string {
  return buildFrontmatter(note) + body;
}


async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/* ============================================================= MemoryVault == */

export class MemoryVault {
  /** Vault root on disk. Exposed so callers can derive sibling paths. */
  readonly root: string;
  private index: Map<string, MemoryNote> = new Map();
  private searchIdx: SearchIndex = { postings: {}, docLen: {}, N: 0 };
  private loaded = false;
  private readonly HOT_CACHE_LIMIT: number;

  constructor(root: string, hotCacheLimit = 5) {
    this.root = root;
    this.HOT_CACHE_LIMIT = hotCacheLimit;
  }

  /* ----------------------------------------------------------------- init --- */

  async init(): Promise<void> {
    // Create directories
    await mkdir(this.root, { recursive: true });
    for (const dir of Object.values(TYPE_DIRS)) {
      await mkdir(join(this.root, dir), { recursive: true });
    }
    await mkdir(join(this.root, "knowledge"), { recursive: true });
    await mkdir(join(this.root, "sessions"), { recursive: true });

    // Create index if absent
    const indexPath = join(this.root, "_index.md");
    if (!(await exists(indexPath))) {
      await writeFile(
        indexPath,
        "# Memory Vault Index\n\nThis file is auto-managed. Each note is listed below.\n\n",
        "utf8",
      );
    }

    // Create hot-cache if absent
    const hotCachePath = join(this.root, "_hot-cache.md");
    if (!(await exists(hotCachePath))) {
      await writeFile(
        hotCachePath,
        "# Recent Sessions\n\nLast few session summaries, most recent first.\n\n",
        "utf8",
      );
    }

    await this._loadAll();
  }

  /* --------------------------------------------------------------- write --- */

  async write(input: NoteInput): Promise<MemoryNote> {
    if (!this.loaded) await this._loadAll();

    const baseSlug = slugify(input.title);
    let slug = baseSlug;
    let suffix = 1;

    // Collision handling: increment suffix until unique
    // Never overwrite: an identical title yields a suffixed sibling, so a
    // second note about the same subject cannot silently clobber the first.
    while (this.index.has(slug)) {
      suffix += 1;
      slug = `${baseSlug}-${suffix}`;
    }

    const note: MemoryNote = {
      id: slug,
      title: input.title,
      type: input.type,
      path: join(this.root, TYPE_DIRS[input.type], `${slug}.md`),
      description: input.description,
      tags: input.tags ?? [],
      updatedAt: Date.now(),
      links: input.links ?? [],
    };

    const markdown = noteToMarkdown(note, input.body);
    await writeFile(note.path, markdown, "utf8");

    this.index.set(note.id, note);
    this._indexNote(note, input.body);
    await this._rebuildIndexFile();

    return note;
  }

  /* ---------------------------------------------------------------- read --- */

  async read(id: string): Promise<{ note: MemoryNote; body: string } | null> {
    if (!this.loaded) await this._loadAll();
    const note = this.index.get(id);
    if (!note) return null;

    const raw = await readFile(note.path, "utf8");
    const { body } = parseFrontmatter(raw);
    return { note, body };
  }

  /* ---------------------------------------------------------------- list --- */

  async list(type?: MemoryType): Promise<MemoryNote[]> {
    if (!this.loaded) await this._loadAll();
    const all = Array.from(this.index.values());
    if (!type) return all;
    return all.filter((n) => n.type === type);
  }

  /* -------------------------------------------------------------- delete --- */

  async delete(id: string): Promise<boolean> {
    if (!this.loaded) await this._loadAll();
    const note = this.index.get(id);
    if (!note) return false;

    try {
      await unlink(note.path);
    } catch {
      // file may already be gone
    }

    this.index.delete(id);
    this._removeFromIndex(id);
    await this._rebuildIndexFile();
    return true;
  }

  /* -------------------------------------------------------------- search --- */

  async search(query: string, limit = 10): Promise<Array<{ id: string; score: number }>> {
    if (!this.loaded) await this._loadAll();
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];

    const scores: Record<string, number> = {};
    const N = Math.max(this.searchIdx.N, 1);

    for (const token of tokens) {
      const postings = this.searchIdx.postings[token];
      if (!postings) continue;

      const df = Object.keys(postings).length;
      const idf = Math.log((N + 1) / (df + 1));

      for (const [noteId, tf] of Object.entries(postings)) {
        const docLen = Math.max(this.searchIdx.docLen[noteId] ?? 1, 1);
        scores[noteId] = (scores[noteId] ?? 0) + tf * idf / docLen;
      }
    }

    return Object.entries(scores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, score]) => ({ id, score }));
  }

  /* -------------------------------------------------------- resolveLinks --- */

  async resolveLinks(id: string): Promise<{ resolved: string[]; unresolved: string[] }> {
    if (!this.loaded) await this._loadAll();
    const result = await this.read(id);
    if (!result) return { resolved: [], unresolved: [] };

    const targets = extractWikilinks(result.body);
    const resolved: string[] = [];
    const unresolved: string[] = [];

    for (const target of targets) {
      // Try exact id match, then slugified match
      const slug = slugify(target);
      if (this.index.has(target)) {
        resolved.push(target);
      } else if (this.index.has(slug)) {
        resolved.push(slug);
      } else {
        unresolved.push(target);
      }
    }

    return { resolved, unresolved };
  }

  /* ----------------------------------------------------------- backlinks --- */

  async backlinks(id: string): Promise<string[]> {
    if (!this.loaded) await this._loadAll();
    const results: string[] = [];

    for (const [noteId, note] of this.index) {
      if (noteId === id) continue;
      if (note.links.includes(id)) {
        results.push(noteId);
        continue;
      }
      // Also check body wikilinks by reading the file
      try {
        const raw = await readFile(note.path, "utf8");
        const { body } = parseFrontmatter(raw);
        const wikiTargets = extractWikilinks(body);
        if (wikiTargets.some((t) => t === id || slugify(t) === id)) {
          results.push(noteId);
        }
      } catch {
        // skip unreadable files
      }
    }

    return results;
  }

  /* ------------------------------------------------------ appendHotCache --- */

  async appendHotCache(summary: string): Promise<void> {
    const path = join(this.root, "_hot-cache.md");
    let content = "";
    try {
      content = await readFile(path, "utf8");
    } catch {
      content = "# Recent Sessions\n\n";
    }

    // Parse out the header and existing entries
    const headerEnd = content.indexOf("\n\n");
    const header = headerEnd >= 0 ? content.slice(0, headerEnd + 2) : "# Recent Sessions\n\n";
    const body = headerEnd >= 0 ? content.slice(headerEnd + 2) : "";

    // Split by separator entries
    const timestamp = new Date().toISOString();
    const entry = `## Session — ${timestamp}\n\n${summary}\n\n`;

    // Split existing entries by "## Session"
    const existingEntries = body.split(/(?=## Session)/).filter((s) => s.trim());

    // Prepend new entry and trim to limit
    const kept = [entry, ...existingEntries].slice(0, this.HOT_CACHE_LIMIT);

    await writeFile(path, header + kept.join(""), "utf8");
  }

  /* -------------------------------------------------- loadStartupContext --- */

  async loadStartupContext(): Promise<string> {
    const indexPath = join(this.root, "_index.md");
    const hotCachePath = join(this.root, "_hot-cache.md");

    let indexContent = "";
    let hotCacheContent = "";

    try {
      indexContent = await readFile(indexPath, "utf8");
    } catch {
      indexContent = "# Memory Vault Index\n\n(empty)\n";
    }

    try {
      hotCacheContent = await readFile(hotCachePath, "utf8");
    } catch {
      hotCacheContent = "# Recent Sessions\n\n(none)\n";
    }

    return `${indexContent}\n\n---\n\n${hotCacheContent}`;
  }

  /* ----------------------------------------------------------------- lint --- */

  async lint(): Promise<LintReport> {
    if (!this.loaded) await this._loadAll();

    const allIds = new Set(this.index.keys());
    const inboundLinks: Map<string, number> = new Map();
    const deadLinks: Array<{ from: string; target: string }> = [];
    const missingDescription: string[] = [];

    // Seed inbound link count at 0 for all
    for (const id of allIds) inboundLinks.set(id, 0);

    for (const [noteId, note] of this.index) {
      if (!note.description || note.description.trim() === "") {
        missingDescription.push(noteId);
      }

      // Check body wikilinks
      try {
        const raw = await readFile(note.path, "utf8");
        const { body } = parseFrontmatter(raw);
        const wikiTargets = extractWikilinks(body);

        for (const target of wikiTargets) {
          const resolvedId = this.index.has(target) ? target : slugify(target);
          if (allIds.has(resolvedId)) {
            inboundLinks.set(resolvedId, (inboundLinks.get(resolvedId) ?? 0) + 1);
          } else {
            deadLinks.push({ from: noteId, target });
          }
        }
      } catch {
        // skip unreadable
      }
    }

    const orphans = Array.from(inboundLinks.entries())
      .filter(([, count]) => count === 0)
      .map(([id]) => id);

    return { orphans, deadLinks, missingDescription };
  }

  /* ============================================================ internals === */

  private async _loadAll(): Promise<void> {
    this.loaded = true;
    this.index.clear();
    this.searchIdx = { postings: {}, docLen: {}, N: 0 };

    for (const type of Object.keys(TYPE_DIRS) as MemoryType[]) {
      const dir = join(this.root, TYPE_DIRS[type]);
      let files: string[] = [];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filePath = join(dir, file);
        try {
          const raw = await readFile(filePath, "utf8");
          const { data, body } = parseFrontmatter(raw);
          const id = String(data["id"] ?? basename(file, ".md"));
          const note: MemoryNote = {
            id,
            title: String(data["title"] ?? id),
            type,
            path: filePath,
            description: String(data["description"] ?? ""),
            tags: Array.isArray(data["tags"]) ? (data["tags"] as string[]) : [],
            updatedAt: Number(data["updatedAt"] ?? 0),
            links: Array.isArray(data["links"]) ? (data["links"] as string[]) : [],
          };
          this.index.set(id, note);
          this._indexNote(note, body);
        } catch {
          // skip malformed
        }
      }
    }
  }

  /** Add a note's tokens to the inverted index with field weights. */
  private _indexNote(note: MemoryNote, body: string): void {
    // Field weights: title=4, description=3, tags=2, body=1
    const weighted: Array<[string, number]> = [
      [note.title, 4],
      [note.description, 3],
      [note.tags.join(" "), 2],
      [body, 1],
    ];

    const totalTokens: Record<string, number> = {};

    for (const [text, weight] of weighted) {
      for (const token of tokenize(text)) {
        totalTokens[token] = (totalTokens[token] ?? 0) + weight;
      }
    }

    let docLen = 0;
    for (const [token, count] of Object.entries(totalTokens)) {
      docLen += count;
      if (!this.searchIdx.postings[token]) {
        this.searchIdx.postings[token] = {};
      }
      this.searchIdx.postings[token]![note.id] = count;
    }

    this.searchIdx.docLen[note.id] = docLen;
    this.searchIdx.N = this.index.size;
  }

  private _removeFromIndex(id: string): void {
    for (const postings of Object.values(this.searchIdx.postings)) {
      delete postings[id];
    }
    delete this.searchIdx.docLen[id];
    this.searchIdx.N = this.index.size;
  }

  private async _rebuildIndexFile(): Promise<void> {
    const path = join(this.root, "_index.md");
    const lines: string[] = [
      "# Memory Vault Index",
      "",
      `Total notes: ${this.index.size}`,
      "",
      "| id | title | type | description | tags |",
      "|----|-------|------|-------------|------|",
    ];

    const sorted = Array.from(this.index.values()).sort((a, b) =>
      a.title.localeCompare(b.title),
    );

    for (const note of sorted) {
      const tags = note.tags.join(", ");
      const desc = note.description.replace(/\|/g, "\\|");
      lines.push(`| ${note.id} | ${note.title} | ${note.type} | ${desc} | ${tags} |`);
    }

    lines.push("", `_Updated: ${new Date().toISOString()}_`, "");
    await writeFile(path, lines.join("\n"), "utf8");
  }
}
