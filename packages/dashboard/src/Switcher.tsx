// The sidebar's workspace token: the workspace's image, name and the person's role there. With more than one workspace
// it opens a menu of them (DESIGN.md, Sidebar); picking one switches the session to it.
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

export function Switcher({ state, onSwitch }: { state: State; onSwitch: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const current = state.workspace;
  // a click anywhere else closes the menu
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  // opening it puts the keyboard on the current workspace
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>("[aria-checked='true']")?.focus();
  }, [open]);
  if (!current) return null;
  if (state.workspaces.length < 2)
    return (
      <div className="ws-token" title={current.name}>
        <Token w={current} role={state.role} />
      </div>
    );
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  // arrow keys move between the workspaces, Escape closes and goes back to the token
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") return close();
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const items = [...(root.current?.querySelectorAll<HTMLElement>("[role='menuitemradio']") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
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
        <div className="ws-menu" role="menu" aria-label="Workspaces" tabIndex={-1} onKeyDown={keys}>
          {state.workspaces.map((w) => (
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
  );
}
