// Generation of the Cloudflare secrets: pure, so the command can be tested without wrangler.
import { randomBytes, webcrypto } from "node:crypto";

export interface Secrets {
  SETUP_TOKEN: string;
  ENCRYPTION_KEY: string;
  MEDIA_SIGNING_KEY: string;
  VAPID_PRIVATE_KEY: string;
  /** Not a secret: it goes in `[vars]` of both wrangler configs. */
  vapidPublicKey: string;
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** A VAPID pair in the format `web-push` uses: the public key is the raw uncompressed point, the private one is `d`. */
async function vapidPair(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  const point = Buffer.concat([
    Buffer.of(0x04),
    Buffer.from(jwk.x as string, "base64url"),
    Buffer.from(jwk.y as string, "base64url"),
  ]);
  return { publicKey: b64url(point), privateKey: jwk.d as string };
}

export async function generateSecrets(): Promise<Secrets> {
  const vapid = await vapidPair();
  return {
    SETUP_TOKEN: b64url(randomBytes(24)),
    ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    MEDIA_SIGNING_KEY: randomBytes(32).toString("hex"),
    VAPID_PRIVATE_KEY: vapid.privateKey,
    vapidPublicKey: vapid.publicKey,
  };
}
