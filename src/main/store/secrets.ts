/**
 * SecretStore — encrypted API key storage.
 *
 * Keys are encrypted with Electron's safeStorage (OS keychain-backed on
 * Windows/macOS, libsecret on Linux). Only the ciphertext (base64) and
 * metadata are persisted; the raw key is never written to disk.
 *
 * The encryptor is injected so tests can supply a fake without Electron.
 */

import type { ApiKeyEntry } from "../../shared/types.ts";
import { readJson, writeJson } from "./json.ts";

/* ---------------------------------------------------------- interfaces --- */

/** Inject interface so tests can pass a fake instead of real Electron safeStorage. */
export interface SafeStorageFacade {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(buf: Buffer): string;
}

interface PersistedKeyRecord {
  id: string;
  providerId: string;
  label: string;
  maskedKey: string;
  createdAt: number;
  lastUsedAt?: number;
  status: ApiKeyEntry["status"];
  statusMessage?: string;
  meta?: Record<string, string>;
  /** base64-encoded ciphertext from safeStorage.encryptString */
  ciphertext: string;
}

interface KeysFile {
  keys: PersistedKeyRecord[];
}

/* ------------------------------------------------------------- helpers --- */

function maskKey(raw: string): string {
  if (raw.length <= 10) return "***";
  return `${raw.slice(0, 6)}…${raw.slice(-4)}`;
}

let idSeq = 0;
function newId(): string {
  idSeq += 1;
  return `key_${Date.now().toString(36)}_${idSeq.toString(36)}`;
}

/* --------------------------------------------------------------- class --- */

export class SecretStore {
  private readonly filePath: string;
  private readonly storage: SafeStorageFacade;
  private records: PersistedKeyRecord[] = [];
  private loaded = false;

  constructor(filePath: string, storage: SafeStorageFacade) {
    this.filePath = filePath;
    this.storage = storage;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const data = await readJson<KeysFile>(this.filePath, { keys: [] });
    this.records = Array.isArray(data.keys) ? data.keys : [];
  }

  private async persist(): Promise<void> {
    await writeJson(this.filePath, { keys: this.records });
  }

  /** Add a new API key. Returns the entry (key stored encrypted). */
  async add(
    providerId: string,
    label: string,
    rawKey: string,
    meta?: Record<string, string>,
  ): Promise<ApiKeyEntry> {
    await this.ensureLoaded();

    if (!this.storage.isEncryptionAvailable()) {
      throw new Error(
        "Encryption is not available on this system. " +
          "Cannot store API keys securely. " +
          "This usually means the OS keychain is not accessible.",
      );
    }

    const encrypted = this.storage.encryptString(rawKey);
    const ciphertext = encrypted.toString("base64");

    const record: PersistedKeyRecord = {
      id: newId(),
      providerId,
      label,
      maskedKey: maskKey(rawKey),
      createdAt: Date.now(),
      status: "untested",
      ciphertext,
      ...(meta !== undefined ? { meta } : {}),
    };

    this.records.push(record);
    await this.persist();

    return this.toEntry(record);
  }

  /** Remove a key by id. */
  async remove(keyId: string): Promise<boolean> {
    await this.ensureLoaded();
    const idx = this.records.findIndex((r) => r.id === keyId);
    if (idx === -1) return false;
    this.records.splice(idx, 1);
    await this.persist();
    return true;
  }

  /** List entries for a provider. Returns only safe metadata, never the raw key. */
  async list(providerId: string): Promise<ApiKeyEntry[]> {
    await this.ensureLoaded();
    return this.records
      .filter((r) => r.providerId === providerId)
      .map((r) => this.toEntry(r));
  }

  /** All entries regardless of provider. */
  async listAll(): Promise<ApiKeyEntry[]> {
    await this.ensureLoaded();
    return this.records.map((r) => this.toEntry(r));
  }

  /**
   * Reveal the raw key. Main-process only — never send over IPC.
   */
  async reveal(keyId: string): Promise<string | null> {
    await this.ensureLoaded();
    const record = this.records.find((r) => r.id === keyId);
    if (!record) return null;
    const buf = Buffer.from(record.ciphertext, "base64");
    return this.storage.decryptString(buf);
  }

  /** Update status and optional message. */
  async setStatus(
    keyId: string,
    status: ApiKeyEntry["status"],
    statusMessage?: string,
  ): Promise<boolean> {
    await this.ensureLoaded();
    const record = this.records.find((r) => r.id === keyId);
    if (!record) return false;
    record.status = status;
    record.statusMessage = statusMessage;
    await this.persist();
    return true;
  }

  /** Get a single entry by id (metadata only). */
  async getEntry(keyId: string): Promise<ApiKeyEntry | null> {
    await this.ensureLoaded();
    const record = this.records.find((r) => r.id === keyId);
    return record ? this.toEntry(record) : null;
  }

  private toEntry(record: PersistedKeyRecord): ApiKeyEntry {
    return {
      id: record.id,
      providerId: record.providerId,
      label: record.label,
      maskedKey: record.maskedKey,
      createdAt: record.createdAt,
      ...(record.lastUsedAt !== undefined ? { lastUsedAt: record.lastUsedAt } : {}),
      status: record.status,
      ...(record.statusMessage !== undefined ? { statusMessage: record.statusMessage } : {}),
      ...(record.meta !== undefined ? { meta: record.meta } : {}),
    };
  }
}
