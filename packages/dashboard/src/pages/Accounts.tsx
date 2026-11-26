// Accounts: each profile's and channel's capabilities, caption rules and defaults.

import { useState } from "react";
import { api, withFreshCheck } from "../api";
import { GuideLink } from "../docs";
import { Card, Loading, Page, Pill, useConfirm, useLoad, useToast } from "../ui";
import { errorText, type Props } from "./common";

// ---- Accounts

interface Account {
  id: string;
  platform: string;
  handle: string;
  name: string;
  status: string;
  connection: { id: string; provider: string; label: string | null; status: string } | null;
  trialReels: { capable: boolean; on: boolean } | null;
  captionRules: (LintRules & { defaults: LintRules }) | null;
  youtube: { madeForKids: boolean | null; category: string | null } | null;
}

/** The caption check's rules (core's formats/caption-lint.ts): what the dashboard lets the owner tune per account. */
interface LintRules {
  hashtagMax: number;
  foldChars: number;
  languageChecks: boolean;
}

interface PlatformInfo {
  id: string;
  name: string;
  accountNoun: string;
  formats: { format: string; plural: string }[];
  features: { comments: boolean };
}

/** One account's caption rules: a number field left empty means the platform's default (shown as the placeholder).
 *  Each change saves its own field only (an emptied field as null, back to the default), so two quick edits can't
 *  overwrite each other. */
function CaptionRulesCell({
  rules,
  save,
}: {
  rules: LintRules & { defaults: LintRules };
  save: (change: { [K in keyof LintRules]?: LintRules[K] | null }) => Promise<boolean>;
}) {
  const { defaults } = rules;
  const shown = (k: "hashtagMax" | "foldChars") => (rules[k] === defaults[k] ? "" : String(rules[k]));
  const [draft, setDraft] = useState({ hashtagMax: shown("hashtagMax"), foldChars: shown("foldChars") });
  const number = (k: "hashtagMax" | "foldChars", label: string, min: number, max: number) => (
    <label>
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        placeholder={String(defaults[k])}
        value={draft[k]}
        onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
        onBlur={async () => {
          const v = draft[k].trim();
          if (v === shown(k)) return;
          if (!(await save({ [k]: v === "" ? null : Number(v) }))) setDraft({ ...draft, [k]: shown(k) });
        }}
      />
    </label>
  );
  return (
    <div className="rules">
      {number("hashtagMax", "Hashtags max", 0, 30)}
      {number("foldChars", "First line chars", 50, 500)}
      <label className="check">
        <input
          type="checkbox"
          checked={rules.languageChecks}
          onChange={(e) => save({ languageChecks: e.target.checked })}
        />
        Language checks
      </label>
    </div>
  );
}

/** A YouTube channel's defaults for new videos (a video's own options win). The category is saved when the field is
 *  left; empty means back to "22" (People & Blogs). */
function YoutubeDefaultsCell({
  youtube,
  save,
}: {
  youtube: { madeForKids: boolean | null; category: string | null };
  save: (change: { madeForKids?: boolean; category?: string | null }) => Promise<boolean>;
}) {
  const [category, setCategory] = useState(youtube.category ?? "");
  return (
    <div className="rules">
      <label className="check">
        <input
          type="checkbox"
          checked={youtube.madeForKids === true}
          onChange={(e) => save({ madeForKids: e.target.checked })}
        />
        Made for kids
      </label>
      <label>
        <span>Category</span>
        <input
          inputMode="numeric"
          maxLength={3}
          placeholder="22"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          onBlur={async () => {
            const v = category.trim();
            if (v === (youtube.category ?? "")) return;
            if (!(await save({ category: v === "" ? null : v }))) setCategory(youtube.category ?? "");
          }}
        />
      </label>
      <span className="muted small">
        Until your Google project passes YouTube's audit, videos stay private (see{" "}
        <GuideLink doc="site/docs/youtube.md">the YouTube guide</GuideLink>).
      </span>
    </div>
  );
}

export function Accounts(_: Props) {
  const toast = useToast();
  const { data, error, reload } = useLoad<{ accounts: Account[]; platforms: PlatformInfo[] }>("accounts");
  const [err, setErr] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const update = async (id: string, change: Record<string, unknown>) => {
    setErr(null);
    try {
      await api(`accounts/${encodeURIComponent(id)}`, change);
      reload();
      return true;
    } catch (e) {
      setErr(errorText(e));
      return false;
    }
  };
  const platformName = (id: string) => data?.platforms.find((p) => p.id === id)?.name ?? id;
  /** What Bongsu can do with an account: its platform's formats, plus Trial Reels once the account qualifies. */
  const capabilities = (a: Account) => {
    const p = data?.platforms.find((x) => x.id === a.platform);
    const can = p?.formats.map((f) => f.plural) ?? [];
    if (a.trialReels?.capable) can.push("Trial Reels");
    if (!can.length && p?.features.comments) can.push("Comments on posts made elsewhere");
    return can.join(", ") || "—";
  };
  return (
    <Page title="Accounts" intro="The accounts Bongsu publishes to, and their defaults.">
      {!data ? (
        <Loading error={error} retry={reload} />
      ) : (
        <Card>
          {err && (
            <p className="error" role="alert">
              {err}
            </p>
          )}
          {data.accounts.length === 0 ? (
            <p className="empty">No accounts yet: they appear when you add a connection.</p>
          ) : (
            <div className="table-wrap">
              <table className="stack">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Publishes</th>
                    <th>Connection</th>
                    <th>Trial Reels by default</th>
                    <th>Checks and defaults</th>
                    <th>Status</th>
                    <th className="right">
                      <span className="vh">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.accounts.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <div>{a.name}</div>
                        <div className="muted small">
                          {platformName(a.platform)} · @{a.handle}
                        </div>
                      </td>
                      <td data-label="Publishes" className="small">
                        {capabilities(a)}
                      </td>
                      <td data-label="Connection" className="small">
                        {a.connection ? (
                          <>
                            {a.connection.label ?? a.connection.provider} <Pill status={a.connection.status} />
                          </>
                        ) : (
                          <span className="muted">none</span>
                        )}
                      </td>
                      <td data-label="Trial Reels">
                        {a.trialReels ? (
                          <label className="check">
                            <input
                              type="checkbox"
                              checked={a.trialReels.on}
                              disabled={!a.trialReels.capable}
                              onChange={(e) => update(a.id, { trialReels: e.target.checked })}
                            />
                            {a.trialReels.capable ? (a.trialReels.on ? "On" : "Off") : "Not available yet"}
                          </label>
                        ) : (
                          <span className="muted small">—</span>
                        )}
                      </td>
                      <td data-label="Checks and defaults">
                        {a.captionRules ? (
                          <CaptionRulesCell
                            key={`${a.id}:${a.captionRules.hashtagMax}:${a.captionRules.foldChars}`}
                            rules={a.captionRules}
                            save={(captionRules) => update(a.id, { captionRules })}
                          />
                        ) : a.youtube ? (
                          <YoutubeDefaultsCell
                            key={`${a.id}:${a.youtube.madeForKids}:${a.youtube.category}`}
                            youtube={a.youtube}
                            save={(youtube) => update(a.id, { youtube })}
                          />
                        ) : (
                          <span className="muted small">—</span>
                        )}
                      </td>
                      <td data-label="Status">
                        <Pill status={a.status} />
                      </td>
                      <td className="right">
                        <button
                          type="button"
                          className="link"
                          onClick={() => {
                            const name = window.prompt("Display name", a.name);
                            if (name !== null) update(a.id, { name });
                          }}
                        >
                          Rename
                        </button>
                        {a.status === "active" ? (
                          <button
                            type="button"
                            className="link danger"
                            onClick={() =>
                              confirm({
                                title: `Disable ${a.name}?`,
                                detail: "Nothing is published to it until you enable it again. Its plan stays.",
                                verb: "Disable",
                                run: async () => {
                                  await api(`accounts/${encodeURIComponent(a.id)}`, { status: "disabled" });
                                  toast({ ok: true, text: `${a.name} disabled: nothing is published to it.` });
                                  reload();
                                },
                              })
                            }
                          >
                            Disable
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="link"
                              onClick={() =>
                                update(a.id, { status: "active" }).then(
                                  (ok) => ok && toast({ ok: true, text: `${a.name} enabled.` }),
                                )
                              }
                            >
                              Enable
                            </button>
                            <button
                              type="button"
                              className="link danger"
                              onClick={() =>
                                confirm({
                                  title: `Remove ${a.name}?`,
                                  detail:
                                    "It leaves Bongsu: only possible with nothing left to publish to it. What was published stays in the history.",
                                  verb: "Remove",
                                  run: async () => {
                                    await withFreshCheck(() => api(`accounts/${encodeURIComponent(a.id)}/remove`, {}));
                                    toast({ ok: true, text: `${a.name} removed.` });
                                    reload();
                                  },
                                })
                              }
                            >
                              Remove
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {dialog}
        </Card>
      )}
    </Page>
  );
}
