import { describe, expect, it } from "vitest";
import { CryptoError, decryptSecret, encryptSecret } from "../src/crypto";

const KEY = "a-long-random-encryption-key-for-tests";

describe("credential encryption", () => {
  it("round-trips, with a fresh IV each time", async () => {
    const a = await encryptSecret(KEY, '{"refresh_token":"r"}');
    const b = await encryptSecret(KEY, '{"refresh_token":"r"}');
    expect(a).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(await decryptSecret(KEY, a)).toBe('{"refresh_token":"r"}');
  });

  it("refuses a wrong key, a damaged value and a missing key", async () => {
    const v = await encryptSecret(KEY, "secret");
    await expect(decryptSecret("another-long-random-key-123", v)).rejects.toThrow(CryptoError);
    await expect(decryptSecret(KEY, `${v.slice(0, -4)}AAAA`)).rejects.toThrow(CryptoError);
    await expect(decryptSecret(KEY, "plain text")).rejects.toThrow(/not an encrypted value/);
    await expect(encryptSecret(undefined, "x")).rejects.toThrow(/ENCRYPTION_KEY/);
  });
});
