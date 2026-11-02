// Credentials at rest: AES-GCM with a key derived from the ENCRYPTION_KEY secret (any long random string; SHA-256 of
// it is the 256-bit key). Stored as "v1:<iv base64>:<ciphertext base64>". The version prefix leaves room for key
// rotation: a later "v2" can name another key while old values still decrypt.

const utf8 = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class CryptoError extends Error {}

async function aesKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret || secret.length < 16) throw new CryptoError("ENCRYPTION_KEY is not set (or shorter than 16 characters)");
  const raw = await crypto.subtle.digest("SHA-256", utf8.encode(secret));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(secret: string | undefined, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), utf8.encode(plain));
  return `v1:${b64(iv)}:${b64(new Uint8Array(ct))}`;
}

export async function decryptSecret(secret: string | undefined, stored: string): Promise<string> {
  const [v, iv, ct] = stored.split(":");
  if (v !== "v1" || !iv || !ct) throw new CryptoError("not an encrypted value (expected v1:<iv>:<data>)");
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(secret), unb64(ct));
    return new TextDecoder().decode(plain);
  } catch (e) {
    if (e instanceof CryptoError) throw e;
    throw new CryptoError("can't decrypt: wrong ENCRYPTION_KEY or damaged value");
  }
}
