/**
 * SessionStore — persisted sessions and messages.
 *
 * Each session lives in its own directory under `sessions/`:
 *   sessions/<id>/session.json
 *   sessions/<id>/messages.json
 *
 * This avoids one giant JSON file that grows unbounded.
 */

import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { Session, Message, Mode, ModelSelection, PermissionMode, TokenUsage } from "../../shared/types.ts";
import { readJson, writeJson } from "../store/json.ts";

/* -------------------------------------------------------------- helpers --- */

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0) || undefined,
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) || undefined,
  };
}

/* -------------------------------------------------------------- class --- */

export class SessionStore {
  private readonly sessionsDir: string;

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
  }

  private sessionDir(sessionId: string): string {
    return join(this.sessionsDir, sessionId);
  }

  private sessionFilePath(sessionId: string): string {
    return join(this.sessionDir(sessionId), "session.json");
  }

  private messagesFilePath(sessionId: string): string {
    return join(this.sessionDir(sessionId), "messages.json");
  }

  /** List sessions for a mode, newest first. */
  async list(mode: Mode): Promise<Session[]> {
    let entries: string[];
    try {
      entries = await readdir(this.sessionsDir);
    } catch {
      return [];
    }

    const sessions: Session[] = [];
    for (const id of entries) {
      const session = await this.get(id);
      if (session && session.mode === mode && !session.archived) {
        sessions.push(session);
      }
    }

    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Get a single session by id. */
  async get(sessionId: string): Promise<Session | null> {
    return readJson<Session | null>(this.sessionFilePath(sessionId), null);
  }

  /** Create a new session. */
  async create(mode: Mode, selection: ModelSelection): Promise<Session> {
    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      mode,
      title: "New session",
      createdAt: now,
      updatedAt: now,
      status: "idle",
      workingFolder: null,
      projectId: null,
      selection,
      messageCount: 0,
      totalUsage: emptyUsage(),
      archived: false,
      permissionMode: "manual",
    };

    await mkdir(this.sessionDir(session.id), { recursive: true });
    await writeJson(this.sessionFilePath(session.id), session);
    await writeJson(this.messagesFilePath(session.id), []);

    return session;
  }

  /** Archive a session (soft-delete). */
  async archive(sessionId: string): Promise<boolean> {
    const session = await this.get(sessionId);
    if (!session) return false;
    const updated: Session = { ...session, archived: true, updatedAt: Date.now() };
    await writeJson(this.sessionFilePath(sessionId), updated);
    return true;
  }

  /** Hard-delete a session and all its messages from disk. */
  async delete(sessionId: string): Promise<boolean> {
    const session = await this.get(sessionId);
    if (!session) return false;
    try {
      await rm(this.sessionDir(sessionId), { recursive: true, force: true });
    } catch {
      // Ignore errors — may already be gone
    }
    return true;
  }

  /**
   * Branch (fork) a session. Creates a new session copying the source session's
   * mode, selection, and permissionMode, along with messages up to and
   * including `uptoMessageId` (or all messages when omitted). Returns the new Session.
   */
  async branch(sessionId: string, uptoMessageId?: string): Promise<Session | null> {
    const source = await this.get(sessionId);
    if (!source) return null;

    const allMessages = await this.messages(sessionId);

    // Determine which messages to copy
    let messagesToCopy: Message[];
    if (uptoMessageId) {
      const idx = allMessages.findIndex((m) => m.id === uptoMessageId);
      messagesToCopy = idx === -1 ? allMessages : allMessages.slice(0, idx + 1);
    } else {
      messagesToCopy = allMessages;
    }

    // Compute usage from copied messages
    let totalUsage = emptyUsage();
    for (const msg of messagesToCopy) {
      if (msg.usage) totalUsage = addUsage(totalUsage, msg.usage);
    }

    const now = Date.now();
    const newSession: Session = {
      id: randomUUID(),
      mode: source.mode,
      title: source.title !== "New session" ? `${source.title} (branch)` : "New session",
      createdAt: now,
      updatedAt: now,
      status: "idle",
      workingFolder: source.workingFolder,
      projectId: source.projectId,
      selection: { ...source.selection },
      messageCount: messagesToCopy.length,
      totalUsage,
      archived: false,
      permissionMode: source.permissionMode,
    };

    await mkdir(this.sessionDir(newSession.id), { recursive: true });
    await writeJson(this.sessionFilePath(newSession.id), newSession);
    // Deep-clone messages to ensure edits to the branch never touch the original.
    await writeJson(this.messagesFilePath(newSession.id), structuredClone(messagesToCopy));

    return newSession;
  }

  /** Rename a session. */
  async rename(sessionId: string, title: string): Promise<boolean> {
    const session = await this.get(sessionId);
    if (!session) return false;
    const updated: Session = { ...session, title, updatedAt: Date.now() };
    await writeJson(this.sessionFilePath(sessionId), updated);
    return true;
  }

  /** Update the permissionMode on a session. */
  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<boolean> {
    const session = await this.get(sessionId);
    if (!session) return false;
    const updated: Session = { ...session, permissionMode: mode, updatedAt: Date.now() };
    await writeJson(this.sessionFilePath(sessionId), updated);
    return true;
  }

  /** Get all messages for a session. */
  async messages(sessionId: string): Promise<Message[]> {
    return readJson<Message[]>(this.messagesFilePath(sessionId), []);
  }

  /** Append messages to a session and update counts/usage. */
  async appendMessages(sessionId: string, newMessages: Message[]): Promise<void> {
    if (newMessages.length === 0) return;

    const session = await this.get(sessionId);
    if (!session) return;

    const existing = await this.messages(sessionId);
    const all = [...existing, ...newMessages];

    // Compute usage delta from new messages
    let deltaUsage = emptyUsage();
    for (const msg of newMessages) {
      if (msg.usage) {
        deltaUsage = addUsage(deltaUsage, msg.usage);
      }
    }

    const updated: Session = {
      ...session,
      messageCount: all.length,
      totalUsage: addUsage(session.totalUsage, deltaUsage),
      updatedAt: Date.now(),
    };

    // Derive a title from the first user message if the session title is still default
    if (session.title === "New session") {
      const firstUser = newMessages.find((m) => m.role === "user");
      if (firstUser) {
        const textBlock = firstUser.content.find((b) => b.type === "text");
        if (textBlock && textBlock.type === "text") {
          updated.title = textBlock.text.slice(0, 80);
        }
      }
    }

    await writeJson(this.messagesFilePath(sessionId), all);
    await writeJson(this.sessionFilePath(sessionId), updated);
  }

  /** Update session usage totals (e.g. at end of turn). */
  async updateUsage(sessionId: string, usage: TokenUsage): Promise<void> {
    const session = await this.get(sessionId);
    if (!session) return;
    const updated: Session = {
      ...session,
      totalUsage: addUsage(session.totalUsage, usage),
      updatedAt: Date.now(),
    };
    await writeJson(this.sessionFilePath(sessionId), updated);
  }

  /** Update session status. */
  async updateStatus(sessionId: string, status: Session["status"]): Promise<void> {
    const session = await this.get(sessionId);
    if (!session) return;
    const updated: Session = { ...session, status, updatedAt: Date.now() };
    await writeJson(this.sessionFilePath(sessionId), updated);
  }
}
