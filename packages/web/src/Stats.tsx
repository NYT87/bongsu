// The Stats tab: the accounts' overview and a channel's page.

import { useMemo, useState } from "react";
import type { ChannelStats } from "./api";
import { type ChartSeries, LineChart } from "./Chart";
import { ErrorNote, ICON, Segmented, Stale, useLoad, ZONE } from "./common";
import { dateLocale, type Key, t } from "./i18n";

// ---------------------------------------------------------------- stats (the accounts and the last week's posts)

type StatsOverview = {
  days: number;
  accounts: {
    id: string;
    platform: string;
    handle: string;
    title: string;
    followers: number | null;
    change: number | null;
    /** When the sample the change is counted from was taken. */
    since: string | null;
  }[];
  recent: {
    key: string;
    platform: string;
    title: string;
    label: string | null;
    /** A YouTube video's origin: uploaded by Bongsu (counted under its item) or elsewhere. */
    source?: "bongsu" | "elsewhere";
    published_at: string | null;
    views: number | null;
    likes: number | null;
    comments: number | null;
    /** The post's Results or the video's page. */
    href: string;
  }[];
};

const num = (n?: number | null) => (n == null ? "–" : n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** "1 follower", "12.3k views": the plural key picks one/other by the count (a missing count reads "–" and plural). */
const count = (n: number | null | undefined, key: Key) => t(key, { n: n ?? Number.NaN, count: num(n) });

/** The Stats tab: each account with its followers and the change since a day before, opening its page; then the
 *  posts and videos of the last 7 days, most viewed first, each opening its Results or video page. */
export function StatsPage() {
  const { data, error, stale, at, reload } = useLoad<StatsOverview>("stats");
  if (error) return <ErrorNote msg={error} onRetry={reload} />;
  if (!data) return <p className="muted">{t("common.loading")}</p>;
  return (
    <section>
      {stale && <Stale msg={stale} at={at} onRetry={reload} />}
      <h2>{t("stats.audience")}</h2>
      {data.accounts.length ? (
        <ul className="list">
          {data.accounts.map((a) => (
            <li key={a.id}>
              <a className="aud" href={`#/stats/${a.platform}/${encodeURIComponent(a.id)}`}>
                <div className="clip">
                  <strong className="small">{a.title}</strong>
                  <div className="muted small">
                    {a.platform === "youtube"
                      ? t("stats.ytChannel")
                      : `Instagram${a.title !== a.handle ? ` · @${a.handle}` : ""}`}
                  </div>
                </div>
                <div className="small num aud-n">
                  {count(a.followers, a.platform === "youtube" ? "stats.subscribers" : "stats.followers")}
                  {a.change ? (
                    <div className={a.change > 0 ? "ok-text" : "bad-text"}>
                      {a.change > 0 ? "+" : ""}
                      {a.change} {a.since ? t("channel.since", { when: shortDay(a.since) }) : ""}
                    </div>
                  ) : null}
                </div>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t("stats.noAccounts")}</p>
      )}
      <h2>{t("stats.recent", { n: data.days })}</h2>
      {data.recent.length ? (
        <ul className="list">
          {data.recent.map((r) => (
            <li key={r.key}>
              <a href={r.href}>
                <div className="row">
                  <strong className="small clip">{r.title}</strong>
                  <span className="small num">{count(r.views, "stats.views")}</span>
                </div>
                <div className="muted small">
                  {r.label ?? (r.platform === "youtube" ? t("results.video") : t("channel.post"))}
                  {r.published_at ? ` · ${shortDay(r.published_at)}` : ""}
                  {r.source === "bongsu" ? ` · ${t("video.bongsu")}` : ""}
                </div>
                <div className="muted small num">
                  {count(r.likes, "stats.likes")} · {count(r.comments, "stats.comments")}
                </div>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t("stats.recentNone", { n: data.days })}</p>
      )}
    </section>
  );
}

/** An account's page: its follower count and change, the followers chart and views per day over a period, and
 *  the posts and videos that brought followers, each opening its Results or video page. */
export function ChannelPage({ route }: { route: string }) {
  const [, platform, raw] = /^\/stats\/([^/]+)\/(.+)$/.exec(route) ?? [];
  const account = raw ? decodeURIComponent(raw) : "";
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const [mode, setMode] = useState<"total" | "daily">("total");
  const { data, error, stale, at, reload } = useLoad<ChannelStats>(
    account ? `stats/channel?account=${encodeURIComponent(account)}&days=${days}` : null,
    [account, days],
  );
  const yt = platform === "youtube";
  const word = yt ? t("channel.subscribers") : t("channel.followers");
  // memoised: the chart keeps its readout while the parent re-renders
  const followers = useMemo(
    (): ChartSeries[] =>
      data ? [{ label: word, hue: 1, points: mode === "total" ? data.followers.total : data.followers.daily }] : [],
    [data, mode, word],
  );
  const views = useMemo(
    (): ChartSeries[] => (data ? [{ label: t("results.views"), hue: 2, points: data.views }] : []),
    [data],
  );
  const back = (
    <p className="back-row">
      <a className="back" href="#/stats">
        {ICON.back}
        {t("tabs.stats")}
      </a>
    </p>
  );
  if (error)
    return (
      <>
        {back}
        <ErrorNote msg={error} onRetry={reload} />
      </>
    );
  if (!data)
    return (
      <>
        {back}
        <p className="muted">{t("common.loading")}</p>
      </>
    );
  const a = data.account;
  return (
    <section>
      {back}
      {stale && <Stale msg={stale} at={at} onRetry={reload} />}
      <h2>{a.title || `@${a.id}`}</h2>
      <p className="muted small">{yt ? t("stats.ytChannel") : `Instagram · @${a.id}`}</p>
      <div className="card">
        <p className="stat-big num">{a.followers == null ? "–" : a.followers.toLocaleString("en")}</p>
        <p className="small">
          {yt ? t("results.subscribersWord") : t("results.followersWord")}
          {a.change ? (
            <span className={a.change > 0 ? " ok-text" : " bad-text"}>
              {" "}
              · {a.change > 0 ? "+" : ""}
              {a.change} {a.since ? t("channel.since", { when: shortDay(a.since) }) : ""}
            </span>
          ) : null}
        </p>
      </div>
      <Segmented
        label={t("channel.period")}
        value={days}
        options={[
          { value: "7", text: t("channel.days7") },
          { value: "30", text: t("channel.days30") },
          { value: "90", text: t("channel.days90") },
        ]}
        onChange={setDays}
      />
      <div className="card">
        <h3>{word}</h3>
        <Segmented
          label={t("results.range")}
          value={mode}
          options={[
            { value: "total", text: t("results.total") },
            { value: "daily", text: t("results.daily") },
          ]}
          onChange={setMode}
        />
        {followers[0]?.points.length ? (
          <LineChart series={followers} mode={mode} tz={ZONE} />
        ) : (
          <p className="muted">{t("channel.noSamples")}</p>
        )}
      </div>
      <div className="card">
        <h3>{t("channel.viewsPerDay")}</h3>
        {data.views.some((p) => p.value !== null) ? (
          <LineChart series={views} mode="daily" tz={ZONE} />
        ) : (
          <p className="muted">{t("channel.noViews")}</p>
        )}
      </div>
      <h3>{t("channel.brought")}</h3>
      {yt && data.analytics === false ? (
        <p className="muted small">{t("channel.analyticsMissing")}</p>
      ) : data.brought.length ? (
        <ul className="list">
          {data.brought.map((b) => (
            <li key={b.key}>
              <a className="aud" href={b.href}>
                <div className="clip">
                  <strong className="small">{b.title}</strong>
                  {b.source === "bongsu" && <span className="muted small"> · {t("video.bongsu")}</span>}
                </div>
                <div className="small num aud-n">
                  <span className="ok-text">+{b.follows}</span>
                  {b.share != null && <div className="muted">{Math.round(b.share * 100)}%</div>}
                </div>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">{t("channel.broughtNone")}</p>
      )}
      {a.url && (
        <a className="button-link with-icon" href={a.url} target="_blank" rel="noopener">
          {yt ? ICON.youtube : ICON.instagram}
          {t("row.openOn", { where: yt ? "YouTube" : "Instagram" })}
        </a>
      )}
    </section>
  );
}

/** "Oct 31" on the workspace's clock, for a UTC instant. */
const shortDay = (iso: string) =>
  new Intl.DateTimeFormat(dateLocale(), { timeZone: ZONE, month: "short", day: "numeric" }).format(Date.parse(iso));
