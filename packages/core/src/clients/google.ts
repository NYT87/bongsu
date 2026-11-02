// Google access tokens: the Drive service account (RS256 JWT signed with Web Crypto) and the YouTube channels
// (OAuth refresh tokens). Cached per isolate.
const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const utf8 = (s: string) => new TextEncoder().encode(s);
const cache = new Map<string, { token: string; until: number }>();

async function post(
  fetcher: typeof fetch,
  url: string,
  form: Record<string, string>,
): Promise<{ access_token: string; expires_in: number }> {
  const r = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  if (!r.ok) throw new Error(`google token: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export async function serviceAccountToken(
  saJson: string,
  scope: string,
  fetcher: typeof fetch,
  now = Date.now(),
): Promise<string> {
  const key = `sa:${scope}`;
  const t = Math.floor(now / 1000);
  const hit = cache.get(key);
  if (hit && hit.until > t + 60) return hit.token;
  const sa = JSON.parse(saJson) as { client_email: string; private_key: string; token_uri: string };
  const head = b64url(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claim = b64url(utf8(JSON.stringify({ iss: sa.client_email, scope, aud: sa.token_uri, iat: t, exp: t + 3600 })));
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  const k = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k, utf8(`${head}.${claim}`)));
  const j = await post(fetcher, sa.token_uri, {
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${head}.${claim}.${sig}`,
  });
  cache.set(key, { token: j.access_token, until: t + j.expires_in });
  return j.access_token;
}

/** An access token from the OAuth refresh token (cached until shortly before it expires; `force` asks Google again,
 *  to check the refresh token still works). */
export async function refreshToken(
  oauthJson: string,
  fetcher: typeof fetch,
  now = Date.now(),
  force = false,
): Promise<string> {
  const o = JSON.parse(oauthJson) as {
    client_id: string;
    client_secret: string;
    refresh_token: string;
    token_uri: string;
  };
  const key = `oauth:${o.client_id}:${o.refresh_token.slice(-8)}`;
  const t = Math.floor(now / 1000);
  const hit = cache.get(key);
  if (hit && hit.until > t + 60 && !force) return hit.token;
  const j = await post(fetcher, o.token_uri, {
    grant_type: "refresh_token",
    client_id: o.client_id,
    client_secret: o.client_secret,
    refresh_token: o.refresh_token,
  });
  cache.set(key, { token: j.access_token, until: t + j.expires_in });
  return j.access_token;
}

export function clearTokenCache() {
  cache.clear();
}
