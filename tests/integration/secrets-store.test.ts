import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SecretStore, type SafeStorageFacade } from "../../src/main/store/secrets.ts";

const storage: SafeStorageFacade = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, "utf8"),
  decryptString: (value) => value.toString("utf8"),
};

describe("SecretStore bootstrap persistence", () => {
  it("loads one persisted file correctly for concurrent provider list calls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kozum-secrets-"));
    const file = join(dir, "keys.json");
    try {
      const writer = new SecretStore(file, storage);
      await writer.add("provider-a", "Primary", "provider-a-secret");
      await writer.add("provider-b", "Primary", "provider-b-secret");

      // App bootstrap calls listKeys for every preset via Promise.all. This must
      // share the same in-flight disk read instead of returning empty arrays.
      const reader = new SecretStore(file, storage);
      const [providerA, providerB] = await Promise.all([
        reader.list("provider-a"),
        reader.list("provider-b"),
      ]);

      assert.equal(providerA.length, 1);
      assert.equal(providerB.length, 1);
      assert.equal(providerA[0]?.providerId, "provider-a");
      assert.equal(providerB[0]?.providerId, "provider-b");
      assert.ok(providerA[0]?.maskedKey);
      assert.ok(providerB[0]?.maskedKey);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
