// The dashboard's building blocks (DESIGN.md, Components).
import { createContext, type ReactNode, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { api } from "./api";

/** Loads one /admin-api resource; `reload` fetches it again. */
export function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api<T>(path)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [path]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

export function Page({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · Bongsu dashboard`;
  }, [title]);
  return (
    <>
      <div className="page-head">
        <h1 tabIndex={-1}>{title}</h1>
        {intro && <p className="muted">{intro}</p>}
      </div>
      {children}
    </>
  );
}

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** "Loading…", then after 8 s a word that it's slow (with Try again), so a slow Worker isn't a blank wait. */
export function Loading({ error, retry }: { error?: string | null; retry?: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(t);
  }, []);
  if (error)
    return (
      <p className="error" role="alert">
        {error}{" "}
        {retry && (
          <button type="button" className="link" onClick={retry}>
            Try again
          </button>
        )}
      </p>
    );
  if (slow)
    return (
      <p className="muted" role="status">
        Still loading: the server is slow to answer.{" "}
        {retry && (
          <button type="button" className="link" onClick={retry}>
            Try again
          </button>
        )}
      </p>
    );
  return <p className="muted">Loading…</p>;
}

const TONE: Record<string, string> = {
  ok: "ok",
  active: "ok",
  connected: "ok",
  expiring: "warn",
  waiting: "warn",
  public: "ok",
  scheduled: "warn",
  broken: "bad",
  revoked: "bad",
  disabled: "",
};
const WORD: Record<string, string> = { ok: "Connected" };
/** A status as a word in a pill (never colour alone): "Connected", "Expiring", "Broken"… */
export const Pill = ({ status, label }: { status: string; label?: string }) => (
  <span className={`pill ${TONE[status] ?? ""}`}>
    {label ?? WORD[status] ?? status.charAt(0).toUpperCase() + status.slice(1)}
  </span>
);

/** The mark and the name: above the signed-out cards and in the guides' header. */
export const Brand = ({ href }: { href?: string }) => {
  const inner = (
    <>
      <img src="/favicon.svg" width={32} height={32} alt="" />
      Bongsu
    </>
  );
  return href ? (
    <a className="brand" href={href}>
      {inner}
    </a>
  ) : (
    <div className="brand">{inner}</div>
  );
};

/** A labelled form field with its help text and error (wired with aria-describedby). */
export function Field({
  label,
  help,
  error,
  children,
}: {
  label: string;
  help?: ReactNode;
  error?: string | null;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode;
}) {
  const id = useId();
  const describedBy = [help ? `${id}-help` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {help && (
        <p className="help" id={`${id}-help`}>
          {help}
        </p>
      )}
      {error && (
        <p className="error" id={`${id}-err`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** A secret shown once (an agent key, recovery codes): copy it, then Done; closing without copying asks first. */
export function SecretOnce({
  title,
  value,
  lines,
  onDone,
}: {
  title: string;
  value?: string;
  lines?: string[];
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const text = value ?? (lines ?? []).join("\n");
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
  };
  const done = () => {
    if (!copied && !window.confirm("You haven't copied it. It won't be shown again: close anyway?")) return;
    onDone();
  };
  return (
    <div className="secret" role="region" aria-label={title}>
      <h2>{title}</h2>
      <p className="muted small">This won't be shown again: keep it somewhere safe.</p>
      {value && <code className="mono">{value}</code>}
      {lines && (
        <div className="codes mono">
          {lines.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </div>
      )}
      <div className="row">
        <button type="button" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
        {lines && (
          <a
            className="button"
            download="bongsu-recovery-codes.txt"
            href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}
            onClick={() => setCopied(true)}
          >
            Download
          </a>
        )}
        <button type="button" className="primary" onClick={done}>
          Done
        </button>
        <span className="vh" aria-live="polite">
          {copied ? "Copied to the clipboard" : ""}
        </span>
      </div>
    </div>
  );
}

/** A confirmation for anything destructive, naming what it does; the button repeats the verb. */
export function useConfirm() {
  const ref = useRef<HTMLDialogElement>(null);
  const [ask, setAsk] = useState<{ title: string; detail: string; verb: string; run: () => Promise<void> } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (ask) ref.current?.showModal();
    else ref.current?.close();
  }, [ask]);
  const dialog = (
    <dialog ref={ref} onClose={() => setAsk(null)} aria-labelledby="confirm-title">
      {ask && (
        <>
          <h2 id="confirm-title">{ask.title}</h2>
          <p className="muted">{ask.detail}</p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button type="button" onClick={() => setAsk(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="danger filled"
              aria-disabled={busy}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                setError(null);
                try {
                  await ask.run();
                  setAsk(null);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {ask.verb}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
  return { confirm: setAsk, dialog };
}

/** A QR code for a link, on a white tile (the QR library loads only here). */
export function QrCode({ text, label }: { text: string; label: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    import("qrcode-generator").then(({ default: qrcode }) => {
      const qr = qrcode(0, "M");
      qr.addData(text);
      qr.make();
      if (live) setSvg(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }));
    });
    return () => {
      live = false;
    };
  }, [text]);
  return (
    <div className="qr" role="img" aria-label={label}>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the SVG comes from the QR library, made from our own link */}
      {svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : <div style={{ width: 200, height: 200 }} />}
    </div>
  );
}

// ---- Toasts: a short message in the top-right corner that goes away by itself (a result, not a state to keep).

interface Toast {
  id: number;
  ok: boolean;
  text: string;
}
const ToastContext = createContext<(t: Omit<Toast, "id">) => void>(() => {});
/** Shows a toast: a success for 6 s, a failure for 12 s (both stay while hovered or focused; × closes them). */
export const useToast = () => useContext(ToastContext);

let nextToast = 0;
export function Toasts({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((t: Omit<Toast, "id">) => setToasts((all) => [...all, { ...t, id: ++nextToast }]), []);
  const close = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onClose={close} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: (id: number) => void }) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) return;
    const t = setTimeout(() => onClose(toast.id), toast.ok ? 6000 : 12000);
    return () => clearTimeout(t);
  }, [held, toast, onClose]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it has a role (status or alert); hover and focus only pause it
    <div
      className={`toast ${toast.ok ? "ok" : "bad"}`}
      role={toast.ok ? "status" : "alert"}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <span>{toast.text}</span>
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => onClose(toast.id)}>
        ×
      </button>
    </div>
  );
}
