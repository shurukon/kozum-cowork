/**
 * ProjectStore — persists Project records to projects.json.
 *
 * All mutations are atomic (via writeJson). Ids are of the form
 * proj_<timestamp><random> so they sort roughly by creation time and
 * are globally unique without needing a UUID library.
 *
 * The `create` method validates that `folder` exists and is a directory
 * before persisting, returning a clear error string when it is not.
 */

import { stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { Project, Mode } from "../../shared/types.ts";
import { readJson, writeJson } from "./json.ts";

/* ---------------------------------------------------------------- types --- */

export interface CreateProjectInput {
  name: string;
  folder: string;
  mode: Mode;
  instructions?: string;
}

export interface UpdateProjectPatch {
  name?: string;
  folder?: string;
  mode?: Mode;
  instructions?: string;
  icon?: string;
}

interface ProjectsFile {
  projects: Project[];
}

/* ------------------------------------------------------------- helpers --- */

function newId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `proj_${ts}${rand}`;
}

/* -------------------------------------------------------------- class --- */

export class ProjectStore {
  private readonly filePath: string;
  private records: Project[] = [];
  private loaded = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const data = await readJson<ProjectsFile>(this.filePath, { projects: [] });
    this.records = Array.isArray(data.projects) ? data.projects : [];
  }

  private async persist(): Promise<void> {
    await writeJson(this.filePath, { projects: this.records });
  }

  /** All non-archived projects. */
  async list(): Promise<Project[]> {
    await this.ensureLoaded();
    return this.records.filter((p) => !p.archived);
  }

  /** Single project by id; null when not found. */
  async get(id: string): Promise<Project | null> {
    await this.ensureLoaded();
    return this.records.find((p) => p.id === id) ?? null;
  }

  /**
   * Create a new project.
   *
   * Returns `{ ok: true, value: Project }` on success or
   * `{ ok: false, error: string }` when validation fails.
   */
  async create(
    input: CreateProjectInput,
  ): Promise<{ ok: true; value: Project } | { ok: false; error: string }> {
    await this.ensureLoaded();

    // Validate that folder exists and is a directory.
    try {
      const s = await stat(input.folder);
      if (!s.isDirectory()) {
        return { ok: false, error: `Path is not a directory: ${input.folder}` };
      }
    } catch {
      return { ok: false, error: `Folder does not exist: ${input.folder}` };
    }

    const now = Date.now();
    const project: Project = {
      id: newId(),
      name: input.name,
      folder: input.folder,
      mode: input.mode,
      instructions: input.instructions ?? "",
      createdAt: now,
      updatedAt: now,
      archived: false,
    };

    this.records.push(project);
    await this.persist();
    return { ok: true, value: project };
  }

  /**
   * Apply a partial patch to a project.
   *
   * When `folder` is in the patch it is validated before saving.
   * Returns `{ ok: true, value: Project }` or `{ ok: false, error: string }`.
   */
  async update(
    id: string,
    patch: UpdateProjectPatch,
  ): Promise<{ ok: true; value: Project } | { ok: false; error: string }> {
    await this.ensureLoaded();
    const idx = this.records.findIndex((p) => p.id === id);
    if (idx === -1) return { ok: false, error: `Project "${id}" not found` };

    // If folder is being changed, validate it.
    if (patch.folder !== undefined) {
      try {
        const s = await stat(patch.folder);
        if (!s.isDirectory()) {
          return { ok: false, error: `Path is not a directory: ${patch.folder}` };
        }
      } catch {
        return { ok: false, error: `Folder does not exist: ${patch.folder}` };
      }
    }

    const existing = this.records[idx]!;
    const updated: Project = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.folder !== undefined ? { folder: patch.folder } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
      ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
      updatedAt: Date.now(),
    };

    this.records[idx] = updated;
    await this.persist();
    return { ok: true, value: updated };
  }

  /** Soft-delete: set archived = true. */
  async archive(id: string): Promise<{ ok: true; value: Project } | { ok: false; error: string }> {
    await this.ensureLoaded();
    const idx = this.records.findIndex((p) => p.id === id);
    if (idx === -1) return { ok: false, error: `Project "${id}" not found` };

    const updated: Project = { ...this.records[idx]!, archived: true, updatedAt: Date.now() };
    this.records[idx] = updated;
    await this.persist();
    return { ok: true, value: updated };
  }

  /** Hard-delete. */
  async remove(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    await this.ensureLoaded();
    const idx = this.records.findIndex((p) => p.id === id);
    if (idx === -1) return { ok: false, error: `Project "${id}" not found` };
    this.records.splice(idx, 1);
    await this.persist();
    return { ok: true };
  }
}
