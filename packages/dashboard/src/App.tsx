// The dashboard (DESIGN.md): signed out, the bootstrap or sign-in card; signed in, a sidebar of sections and the
// page. Paths live under /dashboard/ (the Worker serves index.html for each).
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { APP_ONLY, api, manages } from "./api";
import { Guide, GuideLink } from "./docs";
import {
  AcceptInvite,
  Accounts,
  Audit,
  Connections,
  Devices,
  FirstWorkspace,
  GetStarted,
  Keys,
  Media,
  Members,
  OAuthApps,
  Overview,
  Settings,
  Videos,
  Workspaces,
} from "./pages";
import { Brand, Card, Field, Loading, SecretOnce, Toasts } from "./ui";

export interface State {
  bootstrapNeeded: boolean;
  setupTokenSet: boolean;
  signedIn: boolean;
  user: { id: string; email: string | null; name: string | null } | null;
  /** Instance admins also see the Instance group (Workspaces, Media, OAuth apps). */
  instanceAdmin: boolean;
  /** The role in the workspace: admin, editor or creator (who uses the app instead). */
  role: string | null;
  /** Signed in, in no workspace: the first run's "create one" (an instance admin), or waiting for an invite. */
  noWorkspace: boolean;
  /** Whether the instance has a workspace at all (archived ones too): an instance admin in none of them gets the
   *  Instance pages, not the first run's "create your first workspace". */
  anyWorkspace: boolean;
  dryRun: boolean;
  publicUrl: string;
}

const SECTIONS = [
  ["", "Overview", Overview],
  ["connections", "Connections", Connections],
  ["accounts", "Accounts", Accounts],
  ["videos", "Videos", Videos],
  ["devices", "Devices & passkeys", Devices],
  ["keys", "Keys & tokens", Keys],
  ["members", "Members", Members],
  ["audit", "Audit", Audit],
  ["settings", "Settings", Settings],
] as const;
/** What's instance-wide: the sidebar's Instance group, an instance admin's only. */
const INSTANCE = [
  ["workspaces", "Workspaces", Workspaces],
  ["media", "Media", Media],
  ["apps", "OAuth apps", OAuthApps],
] as const;
/** What an editor doesn't see (the server refuses them too): the workspace's connections, members and settings. */
const ADMINS_ONLY: readonly string[] = ["connections", "members", "settings"];
/** What an instance admin in no workspace has besides the Instance group: their own passkeys and devices, and the
 *  instance's audit. */
const OUTSIDE: readonly string[] = ["devices", "audit"];
/** Pages reached from other pages, not the sidebar. */
const HIDDEN = [["start", "Get started", GetStarted]] as const;

/** After a section change, the new page's heading takes focus, so the keyboard and screen readers start there (not on
 *  the sidebar link). The first load leaves focus alone. */
const focusHeading = () => requestAnimationFrame(() => document.querySelector<HTMLElement>("#main h1")?.focus());

const sectionOf = () => location.pathname.replace(/^\/dashboard\/?/, "").split("/")[0] ?? "";

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState(sectionOf);
  // the first page once in a workspace: Get started
  const toStart = () => {
    history.replaceState(null, "", "/dashboard/start");
    setSection("start");
  };
  // a 403 with `app: true` (api.ts): this person is a creator, who works in the app
  const [appOnly, setAppOnly] = useState(false);
  useEffect(() => {
    const f = () => setAppOnly(true);
    addEventListener(APP_ONLY, f);
    return () => removeEventListener(APP_ONLY, f);
  }, []);
  const load = useCallback(() => {
    api<State>("state")
      .then((s) => {
        setState(s);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const f = () => {
      setSection(sectionOf());
      focusHeading();
    };
    addEventListener("popstate", f);
    return () => removeEventListener("popstate", f);
  }, []);
  const go = (s: string) => {
    history.pushState(null, "", `/dashboard/${s}`);
    setSection(s);
    scrollTo(0, 0);
    focusHeading();
  };

  // The guides read the same signed in or not (the first visit's setup token points at one).
  if (section === "docs") return <Guide name={location.pathname.split("/")[3] || "README"} />;
  // An invite link, signed in or not: joining signs in as the person invited, in the workspace they join.
  if (section === "invite")
    return (
      <AcceptInvite
        token={location.pathname.split("/")[3] ?? ""}
        onDone={() => {
          history.replaceState(null, "", "/dashboard/");
          setSection("");
          load();
        }}
      />
    );
  if (!state)
    return (
      <main className="centered">
        <Brand />
        <Loading error={error} retry={load} />
      </main>
    );
  if (state.bootstrapNeeded)
    return (
      <Bootstrap
        state={state}
        onDone={() => {
          // the instance admin creates the first workspace (state.noWorkspace), then lands on Get started
          toStart();
          load();
        }}
      />
    );
  if (!state.signedIn) return <SignIn onDone={load} />;
  // an instance admin in no workspace, on an instance that has some: the Instance pages (Shell), to open or restore one
  if (state.noWorkspace && !(state.instanceAdmin && state.anyWorkspace))
    return (
      <FirstWorkspace
        state={state}
        onDone={() => {
          toStart();
          load();
        }}
        onSignOut={load}
      />
    );
  if (appOnly || (state.role === "creator" && !state.instanceAdmin))
    return (
      <AppOnly
        onSignOut={() => {
          setAppOnly(false);
          load();
        }}
      />
    );
  return (
    <Toasts>
      <Shell state={state} section={section} go={go} onSignOut={load} />
    </Toasts>
  );
}

function Shell({
  state,
  section,
  go,
  onSignOut,
}: {
  state: State;
  section: string;
  go: (s: string) => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const instance = state.instanceAdmin ? INSTANCE : [];
  // an instance admin in no workspace: nothing of a workspace's, so the Instance group is where they land
  const outside = state.noWorkspace;
  const sections = outside
    ? SECTIONS.filter(([s]) => OUTSIDE.includes(s))
    : manages(state)
      ? SECTIONS
      : SECTIONS.filter(([s]) => !ADMINS_ONLY.includes(s));
  const hidden = manages(state) && !outside ? HIDDEN : [];
  const current =
    [...sections, ...instance, ...hidden].find(([s]) => s === section) ?? (outside ? INSTANCE[0] : SECTIONS[0]);
  const link = ([s, label]: (typeof SECTIONS | typeof INSTANCE)[number]) => (
    <a
      key={s}
      href={`/dashboard/${s}`}
      aria-current={s === current[0] ? "page" : undefined}
      onClick={(e) => {
        e.preventDefault();
        setOpen(false);
        go(s);
      }}
    >
      {label}
    </a>
  );
  const Body = current[2];
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className={`sidebar${open ? " open" : ""}`}>
        <Brand />
        <button type="button" className="menu-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
          Menu
        </button>
        <nav className="nav" aria-label="Sections">
          {sections.map(link)}
          {instance.length > 0 && (
            <>
              <h2 className="nav-group">Instance</h2>
              {instance.map(link)}
            </>
          )}
        </nav>
        {/* Who is signed in, and the way out: an icon button with its name for screen readers and as a tooltip. */}
        <div className="user">
          <div className="who">
            <div className="name">{state.user?.name ?? state.user?.email}</div>
            <div className="muted">{state.user?.email}</div>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Sign out"
            title="Sign out"
            onClick={async () => {
              await api("signout", {});
              onSignOut();
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
          </button>
        </div>
      </aside>
      <main className="main" id="main" tabIndex={-1}>
        <div className="content">
          {state.dryRun && (
            <div className="banner" role="status">
              <strong>Dry run:</strong> nothing is published.{" "}
              <span className="banner-more">
                Every step runs and notifies instead (set <code>DRY_RUN = "0"</code> in the wrangler files to go live).
              </span>{" "}
              {!outside && (
                <a
                  className="banner-short"
                  href="/dashboard/settings"
                  onClick={(e) => {
                    e.preventDefault();
                    go("settings");
                  }}
                >
                  How to go live
                </a>
              )}
            </div>
          )}
          <Body state={state} go={go} />
        </div>
      </main>
    </div>
  );
}

/** A creator signed in: the dashboard isn't theirs, the app is. */
function AppOnly({ onSignOut }: { onSignOut: () => void }) {
  useEffect(() => {
    document.title = "Bongsu dashboard";
  }, []);
  return (
    <main className="centered">
      <Brand />
      <Card>
        <h1>Creators use the Bongsu app</h1>
        <p className="muted">Your posts, approvals and accounts are in the app.</p>
        <div className="actions stacked">
          <a className="button primary" href="/">
            Open the app
          </a>
          <button
            type="button"
            className="link"
            onClick={async () => {
              await api("signout", {});
              onSignOut();
            }}
          >
            Sign out
          </button>
        </div>
      </Card>
    </main>
  );
}

/** The first visit: the setup token, a name and email, a passkey, then the recovery codes. */
function Bootstrap({ state, onDone }: { state: State; onDone: () => void }) {
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  useEffect(() => {
    document.title = "Set up · Bongsu dashboard";
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const o = await api<{ options: never; challengeId: string }>("bootstrap/options", { token, email, name });
      const response = await startRegistration({ optionsJSON: o.options });
      const r = await api<{ recoveryCodes: string[] }>("bootstrap/verify", {
        challengeId: o.challengeId,
        response,
        device: navigator.userAgent.includes("Mac") ? "Mac" : "this computer",
      });
      setCodes(r.recoveryCodes);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (codes)
    return (
      <main className="centered">
        <Brand />
        <Card>
          <h1>You're in</h1>
          <p className="muted">
            If you ever lose every passkey, one of these codes signs you in (each works once). Keep them somewhere safe,
            away from this computer.
          </p>
          <SecretOnce title="Recovery codes" lines={codes} onDone={onDone} />
        </Card>
      </main>
    );
  return (
    <main className="centered">
      <Brand />
      <Card>
        <h1>Set up Bongsu</h1>
        <p className="muted">
          You're the first one here: you'll run this instance and create its workspaces. Your passkey (this device's
          fingerprint, face or PIN) signs you in from now on; no password.
        </p>
        {!state.setupTokenSet && (
          <p className="error" role="alert">
            SETUP_TOKEN isn't set on the Worker yet: see <GuideLink doc="deploy-cloudflare">the deploy guide</GuideLink>
            .
          </p>
        )}
        <form onSubmit={submit}>
          <Field label="Setup token" help="The SETUP_TOKEN secret you set when deploying.">
            {(p) => (
              <input
                {...p}
                className="mono"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                required
              />
            )}
          </Field>
          <Field label="Your name">
            {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
          </Field>
          <Field label="Email" help="It's how you sign in: nothing is sent to it.">
            {(p) => (
              <input
                {...p}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            )}
          </Field>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="actions stacked">
            <button className="primary" type="submit" aria-disabled={busy}>
              {busy ? "Waiting for the passkey…" : "Create my passkey"}
            </button>
          </div>
        </form>
      </Card>
    </main>
  );
}

/** Email, then the passkey; a recovery code when every passkey is lost. */
function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    document.title = "Sign in · Bongsu dashboard";
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (recovery) await api("signin/recovery", { email, code });
      else {
        const o = await api<{ options: never; challengeId: string }>("signin/options", { email });
        const response = await startAuthentication({ optionsJSON: o.options });
        await api("signin/verify", { challengeId: o.challengeId, response });
      }
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="centered">
      <Brand />
      <Card>
        <h1>Sign in</h1>
        <p className="muted">The Bongsu dashboard: connections, accounts, devices and keys.</p>
        <form onSubmit={submit}>
          <Field label="Email">
            {(p) => (
              <input
                {...p}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username webauthn"
                required
              />
            )}
          </Field>
          {recovery && (
            <Field label="Recovery code" help="One of the codes you saved when you signed up.">
              {(p) => (
                <input
                  {...p}
                  className="mono"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="one-time-code"
                  required
                />
              )}
            </Field>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="actions stacked">
            <button className="primary" type="submit" aria-disabled={busy}>
              {recovery ? "Sign in with the code" : busy ? "Waiting for the passkey…" : "Continue with passkey"}
            </button>
            <button type="button" className="link" onClick={() => setRecovery(!recovery)}>
              {recovery ? "Use my passkey" : "Lost your passkeys?"}
            </button>
          </div>
        </form>
      </Card>
    </main>
  );
}
