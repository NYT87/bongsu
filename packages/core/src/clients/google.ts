// Google access tokens from OAuth refresh tokens (the YouTube channels, the connected Drive). Cached per isolate.
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
