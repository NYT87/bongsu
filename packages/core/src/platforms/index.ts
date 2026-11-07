// The platforms Bongsu knows. A new network registers here (and its provider in providers/); nothing else in the
// core names a platform. docs/platforms.md: how to add one.
import { instagram } from "./instagram";
import type { Platform } from "./types";
import { youtube } from "./youtube";

const registry = new Map<string, Platform>([
  [instagram.id, instagram],
  [youtube.id, youtube],
]);

/** Adds (or replaces) a platform: a deployment's own network, or a test's fake one. */
export function registerPlatform(p: Platform) {
  registry.set(p.id, p);
}

export const platform = (id: string) => registry.get(id) ?? null;
export const platforms = () => [...registry.values()];

/** A platform that must exist (an account's): throws on an unknown one. */
export function requirePlatform(id: string): Platform {
  const p = registry.get(id);
  if (!p) throw new Error(`unknown platform ${id}`);
  return p;
}

/** The platforms Bongsu can publish to (not only comment on). */
export const publishing = () => platforms().filter((p) => p.formats.length > 0);

/** The longest lead of any platform: the tick selects jobs due within it, then filters by their own lead. */
export const MAX_LEAD_S: number = Math.max(0, ...platforms().map((p) => p.uploadLeadS ?? 0));

/** The lead of a job's platform, 0 when it has none. */
export const leadOf = (platformId: string | null | undefined) =>
  platformId ? (platform(platformId)?.uploadLeadS ?? 0) : 0;
