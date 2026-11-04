// A push opens the app at /?w=<workspace>#/item/… (core/notify.ts withWorkspace): the app switches to that workspace
// before it routes. `w` sits in the search, before the hash route, so it survives the hash router and is taken off
// once read, leaving the address the app would have had anyway.

/** The workspace a link names (null: none), and the same address without it. */
export function takeWorkspaceParam(loc: { pathname?: string; search: string; hash: string }): {
  w: string | null;
  cleaned: string;
} {
  const params = new URLSearchParams(loc.search);
  const w = params.get("w") || null;
  params.delete("w");
  const rest = params.toString();
  return { w, cleaned: `${loc.pathname ?? "/"}${rest ? `?${rest}` : ""}${loc.hash}` };
}
