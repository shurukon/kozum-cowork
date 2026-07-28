/**
 * ProjectKnowledgeBase — per-project code knowledge base.
 *
 * Walks a real code tree (skipping node_modules, .git, dist, out, build),
 * builds a file map, detects the stack, and writes structured markdown files.
 * Subsequent calls diff against the stored file map and only rewrite what changed.
 */

import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  stat,
} from "node:fs/promises";
import { join, extname, relative } from "node:path";
import { parseFrontmatter } from "../agent/frontmatter.ts";

/* ----------------------------------------------------------------- types --- */

interface FileEntry {
  path: string;
  size: number;
  mtime: number;
  language: string;
}

interface FileMap {
  projectId: string;
  rootDir: string;
  builtAt: number;
  files: FileEntry[];
}

interface IncrementalResult {
  added: number;
  modified: number;
  removed: number;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "out", "build", ".next", ".nuxt",
  ".svelte-kit", "target", "__pycache__", ".venv", "venv", ".tox",
  "coverage", ".nyc_output", ".turbo", ".cache",
]);

const LANGUAGE_MAP: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript (JSX)",
  ".js": "JavaScript",
  ".jsx": "JavaScript (JSX)",
  ".mjs": "JavaScript (ESM)",
  ".cjs": "JavaScript (CJS)",
  ".py": "Python",
  ".rs": "Rust",
  ".go": "Go",
  ".java": "Java",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".c": "C",
  ".cpp": "C++",
  ".cc": "C++",
  ".h": "C/C++ Header",
  ".hpp": "C++ Header",
  ".cs": "C#",
  ".rb": "Ruby",
  ".php": "PHP",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".html": "HTML",
  ".css": "CSS",
  ".scss": "SCSS",
  ".sass": "Sass",
  ".less": "Less",
  ".json": "JSON",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".toml": "TOML",
  ".md": "Markdown",
  ".sh": "Shell",
  ".bash": "Bash",
  ".zsh": "Zsh",
  ".fish": "Fish",
  ".sql": "SQL",
  ".graphql": "GraphQL",
  ".proto": "Protobuf",
  ".xml": "XML",
};

function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return LANGUAGE_MAP[ext] ?? "Unknown";
}

/* ======================================================= stack detection === */

interface StackInfo {
  name: string;
  manifestFile: string;
}

const STACK_MANIFESTS: Array<StackInfo> = [
  { name: "Node.js / npm", manifestFile: "package.json" },
  { name: "Python / pyproject", manifestFile: "pyproject.toml" },
  { name: "Python / setup.py", manifestFile: "setup.py" },
  { name: "Rust / Cargo", manifestFile: "Cargo.toml" },
  { name: "Go", manifestFile: "go.mod" },
  { name: "Ruby / Bundler", manifestFile: "Gemfile" },
  { name: "PHP / Composer", manifestFile: "composer.json" },
  { name: "Java / Maven", manifestFile: "pom.xml" },
  { name: "Java / Gradle", manifestFile: "build.gradle" },
  { name: "Java / Gradle (kts)", manifestFile: "build.gradle.kts" },
  { name: "Dotnet", manifestFile: "*.csproj" },
  { name: "Elixir / Mix", manifestFile: "mix.exs" },
  { name: "Swift / SPM", manifestFile: "Package.swift" },
];

async function detectStack(rootDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const { name, manifestFile } of STACK_MANIFESTS) {
    if (manifestFile.includes("*")) continue; // skip glob patterns
    try {
      await stat(join(rootDir, manifestFile));
      found.push(`${name} (${manifestFile})`);
    } catch {
      // not found
    }
  }
  return found;
}

/* ======================================================= file tree walker === */

async function walkDir(rootDir: string): Promise<FileEntry[]> {
  const results: FileEntry[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith(".") && entry !== ".github") {
        // Skip hidden files/dirs except .github
        const s = await stat(join(dir, entry)).catch(() => null);
        if (s?.isDirectory()) continue;
        // For hidden files, still skip them
        continue;
      }

      const fullPath = join(dir, entry);
      let s: Awaited<ReturnType<typeof stat>>;
      try {
        s = await stat(fullPath);
      } catch {
        continue;
      }

      if (s.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        await walk(fullPath);
      } else if (s.isFile()) {
        results.push({
          path: fullPath,
          size: s.size,
          mtime: s.mtimeMs,
          language: detectLanguage(fullPath),
        });
      }
    }
  }

  await walk(rootDir);
  return results;
}

/* ======================================================== ProjectKnowledgeBase === */

export class ProjectKnowledgeBase {
  private projectId: string;
  private kbDir: string;

  constructor(vaultRoot: string, projectId: string) {
    this.projectId = projectId;
    this.kbDir = join(vaultRoot, "project-kb", projectId);
  }

  /* --------------------------------------------------------------- build --- */

  async build(rootDir: string): Promise<void> {
    await mkdir(this.kbDir, { recursive: true });

    const files = await walkDir(rootDir);
    const stack = await detectStack(rootDir);
    const builtAt = Date.now();

    const fileMap: FileMap = {
      projectId: this.projectId,
      rootDir,
      builtAt,
      files,
    };

    await this._writeFileMap(fileMap, rootDir);
    await this._writeArchitecture(rootDir, stack);
    await this._writeConventions(rootDir);
    await this._writeDecisions();
  }

  /* ------------------------------------------------------ updateIncremental --- */

  async updateIncremental(rootDir: string): Promise<IncrementalResult> {
    await mkdir(this.kbDir, { recursive: true });

    const mapPath = join(this.kbDir, "file-map.md");
    const oldMap = await this._loadFileMap(mapPath);

    const newFiles = await walkDir(rootDir);
    const newMap = new Map<string, FileEntry>(newFiles.map((f) => [f.path, f]));
    const oldMap2 = new Map<string, FileEntry>(
      (oldMap?.files ?? []).map((f) => [f.path, f]),
    );

    let added = 0;
    let modified = 0;
    let removed = 0;

    // Check new files vs old
    for (const [path, newEntry] of newMap) {
      const oldEntry = oldMap2.get(path);
      if (!oldEntry) {
        added++;
      } else if (oldEntry.size !== newEntry.size || oldEntry.mtime !== newEntry.mtime) {
        modified++;
      }
    }

    // Check removed
    for (const path of oldMap2.keys()) {
      if (!newMap.has(path)) {
        removed++;
      }
    }

    const stack = await detectStack(rootDir);
    const fileMap: FileMap = {
      projectId: this.projectId,
      rootDir,
      builtAt: Date.now(),
      files: newFiles,
    };

    await this._writeFileMap(fileMap, rootDir);
    // Only rewrite architecture if stack changed
    if (added > 0 || removed > 0) {
      await this._writeArchitecture(rootDir, stack);
    }

    return { added, modified, removed };
  }

  /* --------------------------------------------------------------- summary --- */

  async summary(): Promise<string> {
    const mapPath = join(this.kbDir, "file-map.md");
    const fileMap = await this._loadFileMap(mapPath);

    if (!fileMap) {
      return `Project KB: ${this.projectId} — not yet built. Run project_kb_build first.`;
    }

    const fileCount = fileMap.files.length;
    const languages: Record<string, number> = {};
    for (const f of fileMap.files) {
      languages[f.language] = (languages[f.language] ?? 0) + 1;
    }

    const langSummary = Object.entries(languages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([lang, count]) => `${lang} (${count})`)
      .join(", ");

    const age = Math.round((Date.now() - fileMap.builtAt) / 1000 / 60);
    return [
      `Project KB: ${this.projectId}`,
      `Root: ${fileMap.rootDir}`,
      `Files: ${fileCount} — ${langSummary}`,
      `Built: ${age} minutes ago`,
    ].join("\n");
  }

  /* ============================================================ internals === */

  private async _writeFileMap(fileMap: FileMap, rootDir: string): Promise<void> {
    const lines: string[] = [
      "---",
      `projectId: ${fileMap.projectId}`,
      `rootDir: ${fileMap.rootDir}`,
      `builtAt: ${fileMap.builtAt}`,
      `fileCount: ${fileMap.files.length}`,
      "---",
      "",
      "# File Map",
      "",
      `Root: \`${fileMap.rootDir}\`  `,
      `Built: ${new Date(fileMap.builtAt).toISOString()}  `,
      `Total files: ${fileMap.files.length}`,
      "",
      "## Files",
      "",
      "| path | size | language | mtime |",
      "|------|------|----------|-------|",
    ];

    for (const f of fileMap.files) {
      const relPath = relative(rootDir, f.path);
      lines.push(`| ${relPath} | ${f.size} | ${f.language} | ${f.mtime} |`);
    }

    lines.push("");
    await writeFile(join(this.kbDir, "file-map.md"), lines.join("\n"), "utf8");
  }

  private async _loadFileMap(mapPath: string): Promise<FileMap | null> {
    try {
      const raw = await readFile(mapPath, "utf8");
      const { data, body } = parseFrontmatter(raw);

      // Parse files from markdown table
      const files: FileEntry[] = [];
      const tableLines = body.split("\n").filter((l) => l.startsWith("|") && !l.includes("path") && !l.startsWith("|---"));

      for (const line of tableLines) {
        const cols = line.split("|").filter((_, i) => i > 0 && i < 5);
        if (cols.length < 4) continue;
        const relPath = cols[0]!.trim();
        const size = parseInt(cols[1]!.trim(), 10);
        const language = cols[2]!.trim();
        const mtime = parseFloat(cols[3]!.trim());

        const rootDir = String(data["rootDir"] ?? "");
        files.push({
          path: join(rootDir, relPath),
          size: isNaN(size) ? 0 : size,
          language,
          mtime: isNaN(mtime) ? 0 : mtime,
        });
      }

      return {
        projectId: String(data["projectId"] ?? this.projectId),
        rootDir: String(data["rootDir"] ?? ""),
        builtAt: Number(data["builtAt"] ?? 0),
        files,
      };
    } catch {
      return null;
    }
  }

  private async _writeArchitecture(rootDir: string, stack: string[]): Promise<void> {
    // Detect key config files
    const configFiles: string[] = [];
    const checkFiles = [
      "package.json", "tsconfig.json", "vite.config.ts", "vite.config.js",
      "webpack.config.js", "rollup.config.js", "jest.config.js",
      "vitest.config.ts", "eslint.config.js", ".eslintrc.js",
      "Cargo.toml", "pyproject.toml", "go.mod", "Gemfile",
    ];
    for (const f of checkFiles) {
      try {
        await stat(join(rootDir, f));
        configFiles.push(f);
      } catch {
        // not present
      }
    }

    const content = [
      "---",
      `projectId: ${this.projectId}`,
      `updatedAt: ${Date.now()}`,
      "---",
      "",
      "# Architecture Notes",
      "",
      "## Detected Stack",
      "",
      stack.length > 0 ? stack.map((s) => `- ${s}`).join("\n") : "- Unknown",
      "",
      "## Configuration Files",
      "",
      configFiles.length > 0 ? configFiles.map((f) => `- \`${f}\``).join("\n") : "- None detected",
      "",
      "## Notes",
      "",
      "_Edit this file manually to document architecture decisions and component overview._",
      "",
    ].join("\n");

    await writeFile(join(this.kbDir, "architecture.md"), content, "utf8");
  }

  private async _writeConventions(rootDir: string): Promise<void> {
    // Check for existing conventions file to not overwrite user edits
    const dest = join(this.kbDir, "conventions.md");
    try {
      const existing = await readFile(dest, "utf8");
      // If user has added content beyond the template, keep it
      if (existing.includes("_Edit this file")) {
        // Still a template — overwrite with fresh template
      } else {
        return; // Has custom content — don't overwrite
      }
    } catch {
      // File doesn't exist yet — create it
    }

    // Check for .editorconfig or similar
    const hasEditorConfig = await stat(join(rootDir, ".editorconfig")).then(() => true).catch(() => false);
    const hasPrettier = await stat(join(rootDir, ".prettierrc")).then(() => true).catch(() => false)
      || await stat(join(rootDir, "prettier.config.js")).then(() => true).catch(() => false);

    const content = [
      "---",
      `projectId: ${this.projectId}`,
      `updatedAt: ${Date.now()}`,
      "---",
      "",
      "# Code Conventions",
      "",
      "## Formatting",
      "",
      hasPrettier ? "- Prettier is configured" : "- No Prettier config detected",
      hasEditorConfig ? "- EditorConfig is present" : "",
      "",
      "## Notes",
      "",
      "_Edit this file to document naming conventions, style guides, and project-specific patterns._",
      "",
    ].filter((l) => l !== "").join("\n") + "\n";

    await writeFile(dest, content, "utf8");
  }

  private async _writeDecisions(): Promise<void> {
    const dest = join(this.kbDir, "decisions.md");
    // Only create if it doesn't exist
    try {
      await stat(dest);
      return; // exists, don't overwrite
    } catch {
      // create it
    }

    const content = [
      "---",
      `projectId: ${this.projectId}`,
      `updatedAt: ${Date.now()}`,
      "---",
      "",
      "# Architecture Decision Records",
      "",
      "Record significant decisions here. Format:",
      "",
      "## Decision: <title>",
      "",
      "**Date:** YYYY-MM-DD  ",
      "**Status:** Accepted / Superseded / Proposed  ",
      "**Context:** Why was this decision needed?  ",
      "**Decision:** What was decided?  ",
      "**Consequences:** What are the trade-offs?  ",
      "",
    ].join("\n");

    await writeFile(dest, content, "utf8");
  }
}

/* -------------------------------------------------------- factory helper --- */

export function makeProjectKb(vaultRoot: string) {
  return (projectId: string) => new ProjectKnowledgeBase(vaultRoot, projectId);
}
