// Web Push test helpers: a real VAPID pair and subscription keys, and the decryption a browser does (RFC 8291).
import type { PushNote } from "@bongsu/core/push";

export const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** A VAPID pair as the Worker keeps it, and a browser subscription's keys (both real P-256 keys: the payload is really
 *  encrypted and signed). */
export async function keys() {
  const vapid = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", vapid.privateKey)) as JsonWebKey;
  const client = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const clientPublic = new Uint8Array((await crypto.subtle.exportKey("raw", client.publicKey)) as ArrayBuffer);
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return {
    VAPID_PUBLIC_KEY: b64url((await crypto.subtle.exportKey("raw", vapid.publicKey)) as ArrayBuffer),
    VAPID_PRIVATE_KEY: jwk.d!,
    p256dh: b64url(clientPublic),
    auth: b64url(authSecret),
    client,
    clientPublic,
    authSecret,
  };
}

/** What the browser reads from a push: the body decrypted as RFC 8291 says (aes128gcm, one record), as JSON. */
export async function decrypt(body: Uint8Array, k: PushKeys): Promise<PushNote> {
  const salt = body.slice(0, 16);
  const idLen = body[20];
  const serverPublic = body.slice(21, 21 + idLen);
  const server = await crypto.subtle.importKey("raw", serverPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits(
    // the Workers types spell `public` as `$public`; the runtime takes the standard name
    { name: "ECDH", public: server } as unknown as SubtleCryptoDeriveKeyAlgorithm,
    k.client.privateKey,
    256,
  );
  const hkdf = async (salt: Uint8Array, ikm: ArrayBuffer | Uint8Array, info: Uint8Array, bytes: number) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt, info },
        await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]),
        bytes * 8,
      ),
    );
  const text = (s: string) => new TextEncoder().encode(s);
  const keyInfo = new Uint8Array([...text("WebPush: info\0"), ...k.clientPublic, ...serverPublic]);
  const ikm = await hkdf(k.authSecret, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, text("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, body.slice(21 + idLen)),
  );
  // the last record ends with 0x02, then zeroes
  return JSON.parse(new TextDecoder().decode(padded.slice(0, padded.lastIndexOf(2))));
}

export type PushKeys = Awaited<ReturnType<typeof keys>>;
