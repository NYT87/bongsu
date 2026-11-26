// A post's or video's results: the 24 h line and the metrics over time.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Item, type MetricPoint, type Metrics, type Results } from "./api";
import { type ChartSeries, LineChart } from "./Chart";
import { cacheGet, cachePut, ErrorNote, friendly, Segmented, Stale, ZONE, zoneLabel } from "./common";
import { dateLocale, t } from "./i18n";

/** One 24 h results line: views (against `vs`), likes, comments, saves, shares, reach. */
export function ResultsLine({ r, vs, label }: { r: Results; vs: string; label?: string }) {
  return (
    <p className="small num results-line">
      <strong>{label ?? t("results.line24h")}</strong> {t("results.lineViews", { n: r.views ?? "–" })}
      {r.median_views && r.views != null ? (
        <span className={r.views >= r.median_views ? " ok-text" : " muted"}>
          {" "}
          ({(r.views / r.median_views).toFixed(1)}× {vs})
        </span>
      ) : null}{" "}
      ·{" "}
      {t("results.lineRest", {
        likes: r.likes ?? 0,
        comments: r.comments ?? 0,
        saves: r.saves ?? 0,
        shares: r.shares ?? 0,
        reach: r.reach ?? "–",
      })}
      {r.follows != null && ` · +${r.follows} ${t("results.followersWord")}`}
      {r.profile_visits != null && ` · ${r.profile_visits} ${t("results.visitsWord")}`}
    </p>
  );
}

type Metric = Exclude<keyof MetricPoint, "at">;

const IG_METRICS: Metric[] = ["views", "reach", "likes", "comments", "saves", "shares", "follows", "profile_visits"];

export const YT_METRICS: Metric[] = ["views", "likes", "comments"];

// with the analytics scope a video also has the subscribers it gained (its "follows")
export const YT_METRICS_SUBS: Metric[] = [...YT_METRICS, "follows"];

type Loaded = { data: Metrics; at: number };

const hasSamples = (d?: Metrics | null) => !!d && (d.samples.length > 0 || (d.trial?.samples.length ?? 0) > 0);

/** A metrics series (`base`: the route with its key) in Total or Daily, on the same day's cache as useLoad: a path
 *  opens on its cached answer, a failed refresh keeps it and says so (`stale`). Each path keeps one answer object
 *  until the data really changes, so the chart's series (memoised on it) don't start over on an identical refresh. */
export function useMetrics(base: string | null) {
  const [mode, setMode] = useState<"total" | "daily">("total");
  const [metric, setMetric] = useState<Metric>("views");
  const [got, setGot] = useState<Record<string, Loaded>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const path = base && `${base}${mode === "daily" ? "&daily=1" : ""}`;
  const fromCache = (p: string | null): Loaded | undefined => {
    const hit = p ? cacheGet<Metrics>(p) : null;
    return hit ? { data: hit.data, at: hit.at } : undefined;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: fromCache only reads storage
  const cached = useMemo(() => fromCache(path), [path]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fromCache only reads storage
  const cachedTotal = useMemo(() => fromCache(base), [base]);
  const reload = useCallback(() => {
    if (!path) return;
    setFailed(({ [path]: _, ...rest }) => rest);
    api<Metrics>(path)
      .then((d) => {
        cachePut(path, d);
        setGot((g) => {
          const was = g[path]?.data ?? cached?.data;
          return { ...g, [path]: { data: was && JSON.stringify(was) === JSON.stringify(d) ? was : d, at: Date.now() } };
        });
      })
      .catch((e: Error) => setFailed((f) => ({ ...f, [path]: friendly(e) })));
  }, [path, cached]);
  useEffect(reload, [reload]);
  const entry = path ? (got[path] ?? cached) : undefined;
  const failure = path ? failed[path] : undefined;
  return {
    mode,
    setMode,
    metric,
    setMetric,
    data: entry?.data ?? null,
    at: entry?.at ?? null,
    error: entry ? null : (failure ?? null),
    stale: entry && failure ? failure : null,
    reload,
    any: hasSamples((base ? (got[base] ?? cachedTotal) : undefined)?.data),
  };
}

/** The chart of a metrics series with its Total | Daily switch and metric picker; the Trial Reel copy is series 2. */
export function MetricsPanel({
  m,
  metrics,
  trialPosted = false,
  names = {},
}: {
  m: ReturnType<typeof useMetrics>;
  metrics: Metric[];
  trialPosted?: boolean;
  /** A metric's name where the platform's word differs (a video's "follows" are subscribers). */
  names?: Partial<Record<Metric, string>>;
}) {
  const { data, metric, mode } = m;
  const series = useMemo((): ChartSeries[] => {
    if (!data) return [];
    const points = (rows: MetricPoint[]) => rows.map((r) => ({ at: r.at, value: r[metric] }));
    const trial = data.trial?.samples ?? [];
    const own = data.samples.length
      ? [
          {
            label: trial.length ? data.item.label : (names[metric] ?? t(`results.${metric}`)),
            hue: 1 as const,
            points: points(data.samples),
          },
        ]
      : [];
    return trial.length ? [...own, { label: t("results.trial"), hue: 2 as const, points: points(trial) }] : own;
  }, [data, metric]);
  // In Total, an answer without samples (or none at all) is the whole panel; Daily keeps its switch to go back.
  if (mode === "total" && m.error) return <ErrorNote msg={m.error} onRetry={m.reload} />;
  if (mode === "total" && !data) return <p className="muted">{t("common.loading")}</p>;
  const stale = m.stale && <Stale msg={m.stale} at={m.at} onRetry={m.reload} />;
  if (mode === "total" && !series.length)
    return (
      <>
        {stale}
        <p className="muted">{t("results.empty")}</p>
      </>
    );
  return (
    <div className="card">
      {stale}
      <Segmented
        label={t("results.range")}
        value={mode}
        options={[
          { value: "total", text: t("results.total") },
          { value: "daily", text: t("results.daily") },
        ]}
        onChange={m.setMode}
      />
      <Segmented
        label={t("results.metric")}
        value={metric}
        options={metrics.map((x) => ({ value: x, text: names[x] ?? t(`results.${x}`) }))}
        onChange={m.setMetric}
        grid={metrics.length > 3}
      />
      {m.error ? (
        <ErrorNote msg={m.error} onRetry={m.reload} />
      ) : !data ? (
        <p className="muted">{t("common.loading")}</p>
      ) : series.length ? (
        <LineChart series={series} mode={mode} tz={ZONE} />
      ) : (
        <p className="muted">{t("results.empty")}</p>
      )}
      {trialPosted && data && !data.trial?.samples.length && <p className="muted small">{t("results.trialEmpty")}</p>}
    </div>
  );
}

const takenAt = (s: number) =>
  `${new Intl.DateTimeFormat(dateLocale(), {
    timeZone: ZONE,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(s * 1000)} ${zoneLabel()}`;

/** A published Instagram item's Results: the 24 h numbers (the Trial Reel copy's too), then the series' chart. */
export function ResultsView({ keyId, item }: { keyId: string; item: Item }) {
  const m = useMetrics(`item/metrics?key=${encodeURIComponent(keyId)}`);
  const r = item.results;
  const tr = item.trial?.results;
  return (
    <>
      {(r || tr) && (
        <div className="card published">
          {r && <ResultsLine r={r} vs={t("results.vsUsual")} />}
          {tr && <ResultsLine r={tr} vs={t("results.vsRegular")} label={t("results.trialNumbers")} />}
          <p className="muted small">{t("results.taken", { when: takenAt((r ?? tr)!.fetched_at) })}</p>
        </div>
      )}
      <MetricsPanel m={m} metrics={IG_METRICS} trialPosted={item.trial?.state === "published"} />
    </>
  );
}
