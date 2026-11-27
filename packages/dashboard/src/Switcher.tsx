// The sidebar's workspace token: the workspace's image, name and the person's role there. With more than one workspace
// it opens a menu of them, with a search field on top (DESIGN.md, Sidebar); picking one switches the session to it.
// ⌘K (Ctrl+K) opens it with the search focused.
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { State } from "./App";

type Workspace = State["workspaces"][number];

/** A workspace without an icon of its own: a gradient picked from its id, so each one looks different (no brand mark). */
const placeholder = (id: string) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${h} 70% 62%), hsl(${(h + 50) % 360} 65% 42%))`;
};

function Avatar({ w }: { w: { id: string; iconUrl: string | null } }) {
  return w.iconUrl ? (
    <img className="ws-avatar" src={w.iconUrl} alt="" width={22} height={22} />
  ) : (
    <span className="ws-avatar" aria-hidden="true" style={{ background: placeholder(w.id) }} />
  );
}

/** Up and down chevrons: the token opens a list. */
const CHEVRONS = (
  <svg
    className="ws-chevrons"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />
  </svg>
);

const CHECK = (
  <svg
    className="ws-check"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

function Token({ w, role }: { w: { id: string; name: string; iconUrl: string | null }; role: string | null }) {
  return (
    <>
      <Avatar w={w} />
      <span className="ws-name">{w.name}</span>
      {role && <span className="ws-role">{role}</span>}
    </>
  );
}

/** A name as the search compares it: lower case, accents dropped ("Café" is found with "cafe"). */
const folded = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();

export function Switcher({ state, onSwitch }: { state: State; onSwitch: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const current = state.workspace;
  const several = state.workspaces.length > 1;
  // ⌘K / Ctrl+K, anywhere on the page: open the menu with the search focused (again: back to the search)
  useEffect(() => {
    if (!several) return;
    const shortcut = (e: globalThis.KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      setOpen(true);
      search.current?.focus();
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [several]);
  // a click anywhere else closes the menu
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  // opening it puts the keyboard in the search, empty
  useEffect(() => {
    if (!open) return;
    setQuery("");
    search.current?.focus();
  }, [open]);
  if (!current) return null;
  if (!several)
    return (
      <div className="ws-token" title={current.name}>
        <Token w={current} role={state.role} />
      </div>
    );
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const shown = state.workspaces.filter((w) => folded(w.name).includes(folded(query.trim())));
  const items = () => [...(root.current?.querySelectorAll<HTMLElement>("[role='menuitemradio']") ?? [])];
  // Escape closes and goes back to the token; in the search, ↓ goes to the first workspace and Enter picks it
  const searchKeys = (e: KeyboardEvent) => {
    if (e.key === "Escape") return close();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items()[0]?.focus();
    } else if (e.key === "Enter" && shown[0]) {
      e.preventDefault();
      pick(shown[0]);
    }
  };
  // in the list, the arrow keys move between the workspaces; ↑ from the first goes back to the search
  const listKeys = (e: KeyboardEvent) => {
    if (e.key === "Escape") return close();
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowUp" && at === 0) return search.current?.focus();
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1)) % all.length;
    all[next]?.focus();
  };
  const pick = (w: Workspace) => {
    setOpen(false);
    if (w.id === current.id) return button.current?.focus();
    onSwitch(w.id);
  };
  return (
    <div className="ws-switcher" ref={root}>
      <button
        ref={button}
        type="button"
        className="ws-token"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Workspace: ${current.name}. Switch workspace`}
        aria-keyshortcuts="Meta+K Control+K"
        title={current.name}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Token w={current} role={state.role} />
        {CHEVRONS}
      </button>
      {open && (
        <div className="ws-menu">
          <div className="ws-search">
            <input
              ref={search}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={searchKeys}
              placeholder="Find a workspace…"
              aria-label="Find a workspace"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="ws-esc" aria-hidden="true">
              Esc
            </span>
          </div>
          {shown.length === 0 ? (
            <p className="ws-empty" role="status">
              No workspace matches “{query.trim()}”.
            </p>
          ) : (
            <div role="menu" aria-label="Workspaces" tabIndex={-1} onKeyDown={listKeys}>
              {shown.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={w.id === current.id}
                  tabIndex={-1}
                  onClick={() => pick(w)}
                >
                  <Token w={w} role={w.role} />
                  {w.id === current.id && CHECK}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
