// A line chart for the metrics series: inline SVG, no library. Times are unix seconds, shown on the workspace's clock.
import { type KeyboardEvent, type PointerEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { dateLocale, t } from "./i18n";

export type Hue = 1 | 2 | 3 | 4 | 5;
export type ChartPoint = { at: number; value: number | null };
export type ChartSeries = { label: string; hue: Hue; points: ChartPoint[] };

const PAD = { top: 10, right: 12, bottom: 24, left: 44 };
const MARK = 3.5; // marker radius
const MIN_GAP = 7; // px between points below which only the chosen and the last point keep their marker

/** The UTC offset of `tz` at `at`, in seconds (wall clock minus UTC). */
function offsetOf(at: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(new Date(at * 1000))
      .map((x) => [x.type, Number(x.value)]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - at;
}

/** The instant the day holding `at` started on `tz`'s clock (twice, so a day that changes offset lands right). */
export function dayStart(at: number, tz: string): number {
  const wall = at + offsetOf(at, tz);
  const midnight = wall - (((wall % 86400) + 86400) % 86400);
  const first = midnight - offsetOf(midnight, tz);
  return midnight - offsetOf(first, tz);
}

/** Day boundaries on `tz` inside [from, to], thinned to at most `max`. */
export function dayTicks(from: number, to: number, tz: string, max = 6): number[] {
  const days: number[] = [];
  let d = dayStart(from, tz);
  if (d < from) d = dayStart(d + 30 * 3600, tz);
  while (d <= to && days.length < 1000) {
    days.push(d);
    d = dayStart(d + 30 * 3600, tz); // 30 h always lands in the next day, whatever the offset change
  }
  const every = Math.ceil(days.length / max);
  return days.filter((_, i) => i % every === 0);
}

/** A step of 1, 2 or 5 × 10ⁿ (at least 1: these are counts) that splits [min, max] into about three parts, and the
 *  ticks it gives, from zero or below. */
export function valueTicks(min: number, max: number): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(max, lo + 1);
  const rough = (hi - lo) / 3;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(1, ([1, 2, 5, 10].find((m) => m * pow >= rough) ?? 10) * pow);
  const first = Math.floor(lo / step);
  return Array.from({ length: Math.ceil(hi / step) - first + 1 }, (_, i) => (first + i) * step);
}

/** An axis number: grouped below 10,000, compact ("12k") above. */
export function axisNumber(v: number): string {
  return Math.abs(v) >= 10000
    ? new Intl.NumberFormat(dateLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(v)
    : new Intl.NumberFormat(dateLocale()).format(v);
}

/** The runs of non-null points: a null breaks the line. */
export function runs(points: ChartPoint[]): { at: number; value: number }[][] {
  const out: { at: number; value: number }[][] = [];
  let run: { at: number; value: number }[] = [];
  for (const p of points) {
    if (p.value === null) {
      if (run.length) out.push(run);
      run = [];
    } else run.push({ at: p.at, value: p.value });
  }
  if (run.length) out.push(run);
  return out;
}

const SHAPES = ["circle", "square", "diamond", "triangle", "cross"] as const;

/** The series' marker: its shape is the cue that doesn't depend on colour. */
function Marker({ hue, x, y, r = MARK }: { hue: Hue; x: number; y: number; r?: number }) {
  switch (SHAPES[hue - 1]) {
    case "circle":
      return <circle cx={x} cy={y} r={r} />;
    case "square":
      return <rect x={x - r * 0.9} y={y - r * 0.9} width={r * 1.8} height={r * 1.8} />;
    case "diamond":
      return <polygon points={`${x},${y - r * 1.25} ${x + r * 1.25},${y} ${x},${y + r * 1.25} ${x - r * 1.25},${y}`} />;
    case "triangle":
      return <polygon points={`${x},${y - r * 1.2} ${x + r * 1.2},${y + r} ${x - r * 1.2},${y + r}`} />;
    default:
      return (
        <path className="chart-cross" d={`M${x - r},${y - r}L${x + r},${y + r}M${x - r},${y + r}L${x + r},${y - r}`} />
      );
  }
}

/** The index of the last of ascending `points` at or before `at`; -1 when none is. */
function lastAtOrBefore(points: ChartPoint[], at: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].at <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** The point a series (ascending) shows at `at`. Total: its last sample with a value at or before `at` (lifetime
 *  counts hold between samples, and a series sampled in another run still has a count then). Daily: its point of
 *  the same day on `tz`'s clock, since a daily point carries the instant of its day's last sample and two series'
 *  instants differ within a day. Undefined when there is none. */
export function pointAtOrBefore(
  points: ChartPoint[],
  at: number,
  mode: "total" | "daily",
  tz: string,
): ChartPoint | undefined {
  if (mode === "daily") {
    const day = dayStart(at, tz);
    const p = points[lastAtOrBefore(points, dayStart(day + 30 * 3600, tz) - 1)];
    return p && p.at >= day && p.value !== null ? p : undefined;
  }
  for (let i = lastAtOrBefore(points, at); i >= 0; i--) if (points[i].value !== null) return points[i];
  return undefined;
}

/** A series' value at `at` (see pointAtOrBefore); null when it has none. */
export const valueAt = (points: ChartPoint[], at: number, mode: "total" | "daily", tz: string): number | null =>
  pointAtOrBefore(points, at, mode, tz)?.value ?? null;

/** The index of the time nearest `at` in ascending `times` (a binary search: it runs on every pointer move). */
export function nearest(times: number[], at: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < at) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && at - times[lo - 1] <= times[lo] - at ? lo - 1 : lo;
}

/** How an x label sits on its tick: centred, unless it would spill past the left or right edge of the chart. */
export function labelAnchor(x: number, width: number, half = 24): "start" | "middle" | "end" {
  return x - half < 0 ? "start" : x + half > width ? "end" : "middle";
}

const fmt = (tz: string, o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(dateLocale(), { timeZone: tz, ...o });

export function LineChart({
  series,
  mode,
  tz,
  height = 180,
}: {
  series: ChartSeries[];
  mode: "total" | "daily";
  tz: string;
  height?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(340);
  const [chosen, setChosen] = useState<number | null>(null); // index into `times`; null = the latest
  const [spoken, setSpoken] = useState<number | null>(null); // the pick last chosen by key or tap: what is announced
  // A new series (another metric, Total or Daily) starts again from the latest point.
  const [shown, setShown] = useState(series);
  if (shown !== series) {
    setShown(series);
    setChosen(null);
    setSpoken(null);
  }

  const empty = !series.some((s) => s.points.length);
  // The viewBox follows the box's real width, so text and markers keep their pixel size on any screen. Measured
  // before the first paint, so the lines don't animate from a guessed width.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || empty) return;
    const measure = (w: number) => setWidth(Math.max(200, Math.round(w)));
    measure(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => measure(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [empty]);

  // Everything that depends on the data alone, once per series.
  const data = useMemo(() => {
    const times = [...new Set(series.flatMap((s) => s.points.map((p) => p.at)))].sort((a, b) => a - b);
    const values = series.flatMap((s) => s.points.flatMap((p) => (p.value === null ? [] : [p.value])));
    const x0 = times[0] ?? 0;
    const x1 = times.length > 1 ? times[times.length - 1] : x0 + 86400;
    const yt = valueTicks(values.length ? Math.min(...values) : 0, values.length ? Math.max(...values) : 0);
    return { times, x0, x1, yt, runs: series.map((s) => runs(s.points)) };
  }, [series]);
  const { times, x0, x1, yt } = data;
  const [y0, y1] = [yt[0], yt[yt.length - 1]];
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const sx = (at: number) => PAD.left + ((at - x0) / (x1 - x0)) * plotW;
  const sy = (v: number) => PAD.top + plotH - ((v - y0) / (y1 - y0)) * plotH;
  const dense = plotW / Math.max(1, times.length - 1) < MIN_GAP;

  const day = useMemo(() => fmt(tz, { month: "short", day: "numeric" }), [tz]);
  const when = useMemo(() => {
    const key = fmt(tz, { year: "numeric", month: "2-digit", day: "2-digit" });
    const sharedDay = times.some((at, i) => i > 0 && key.format(at * 1000) === key.format(times[i - 1] * 1000));
    return mode === "total" && sharedDay
      ? fmt(tz, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      : day;
  }, [times, mode, tz, day]);
  const valueText = (v: number | null | undefined) =>
    v === null || v === undefined ? t("chart.noData") : new Intl.NumberFormat(dateLocale()).format(v);

  // The lines and their markers, redrawn only when the data or the size changes, not while the pick moves. When
  // points are dense, the chosen point's markers are drawn separately below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sx and sy are derived from data, width and height
  const lines = useMemo(
    () =>
      series.map((s, k) => (
        <g key={s.label} className={`chart-series s${s.hue}`}>
          {data.runs[k].map((run) => (
            <path
              key={run[0].at}
              className="chart-line"
              d={run.map((p, i) => `${i ? "L" : "M"}${sx(p.at).toFixed(1)},${sy(p.value).toFixed(1)}`).join("")}
            />
          ))}
          {data.runs[k].flatMap((run) =>
            run
              .filter((_, i) => !dense || run.length === 1 || i === run.length - 1)
              .map((p) => <Marker key={p.at} hue={s.hue} x={sx(p.at)} y={sy(p.value)} />),
          )}
        </g>
      )),
    [series, data, width, height, dense],
  );

  // The values for screen readers, rebuilt only with the data.
  // biome-ignore lint/correctness/useExhaustiveDependencies: valueText only reads the locale
  const table = useMemo(
    () => (
      <table>
        <caption>{series.map((s) => s.label).join(", ")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("chart.when")}</th>
            {series.map((s) => (
              <th key={s.label} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {times.map((at) => (
            <tr key={at}>
              <th scope="row">{when.format(at * 1000)}</th>
              {series.map((s) => (
                <td key={s.label}>{valueText(valueAt(s.points, at, mode, tz))}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    ),
    [series, times, mode, tz, when],
  );

  if (!times.length) return null;

  const xt = dayTicks(x0, x1, tz, Math.max(2, Math.min(6, Math.floor(plotW / 72)))); // a label is about 50px wide
  const xLabels = xt.length ? xt : [x0];
  const pick = chosen === null ? times.length - 1 : Math.min(chosen, times.length - 1);
  const pickAt = times[pick];

  const latest = (s: ChartSeries) => [...s.points].reverse().find((p) => p.value !== null)?.value;
  const summary = series
    .map((s) =>
      t("chart.summary", {
        label: s.label,
        n: s.points.length,
        from: day.format((s.points[0]?.at ?? x0) * 1000),
        to: day.format((s.points[s.points.length - 1]?.at ?? x0) * 1000),
        latest: valueText(latest(s)),
      }),
    )
    .join("; ");
  const readoutAt = (at: number) =>
    [when.format(at * 1000), ...series.map((s) => `${s.label} ${valueText(valueAt(s.points, at, mode, tz))}`)].join(
      " · ",
    );

  const pointAt = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return nearest(times, x0 + (((e.clientX - r.left) * (width / r.width) - PAD.left) / plotW) * (x1 - x0));
  };
  // A tap, a click or the end of a drag moves the pick and announces it.
  const press = (e: PointerEvent<HTMLDivElement>) => {
    const i = pointAt(e);
    setChosen(i);
    setSpoken(i);
  };
  // A drag (or a held mouse button) moves the pick on screen only; hovering doesn't move it at all.
  const drag = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.buttons === 0) return;
    setChosen(pointAt(e));
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const next =
      e.key === "ArrowLeft"
        ? pick - 1
        : e.key === "ArrowRight"
          ? pick + 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? times.length - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    const i = Math.max(0, Math.min(times.length - 1, next));
    setChosen(i);
    setSpoken(i);
  };

  return (
    <figure className="chart">
      <div
        ref={box}
        className="chart-plot"
        role="img"
        aria-label={summary}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focus lets left/right move the readout for keyboard users
        tabIndex={0}
        onPointerDown={press}
        onPointerMove={drag}
        onPointerUp={press}
        onKeyDown={keys}
      >
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} aria-hidden="true">
          <g className="chart-axis">
            {yt.map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={width - PAD.right} y1={sy(v)} y2={sy(v)} />
                <text x={PAD.left - 6} y={sy(v)} dy="0.35em" textAnchor="end">
                  {axisNumber(v)}
                </text>
              </g>
            ))}
            {xLabels.map((at) => (
              <text key={at} x={sx(at)} y={height - 6} textAnchor={labelAnchor(sx(at), width)}>
                {day.format(at * 1000)}
              </text>
            ))}
          </g>
          <line className="chart-guide" x1={sx(pickAt)} x2={sx(pickAt)} y1={PAD.top} y2={PAD.top + plotH} />
          {lines}
          {dense &&
            series.map((s) => {
              const p = pointAtOrBefore(s.points, pickAt, mode, tz);
              return p?.value == null ? null : (
                <g key={s.label} className={`chart-series s${s.hue}`}>
                  <Marker hue={s.hue} x={sx(p.at)} y={sy(p.value)} />
                </g>
              );
            })}
        </svg>
      </div>
      <ul className="legend small chart-legend" aria-hidden="true">
        {series.map((s) => (
          <li key={s.label} className={`s${s.hue}`}>
            <svg viewBox="0 0 14 14" width="14" height="14" className="chart-series" aria-hidden="true">
              <line className="chart-line" x1="0" x2="14" y1="7" y2="7" />
              <Marker hue={s.hue} x={7} y={7} r={4} />
            </svg>
            {s.label}
          </li>
        ))}
      </ul>
      <p className="chart-readout small">{readoutAt(pickAt)}</p>
      <p className="vh" aria-live="polite">
        {spoken === null ? "" : readoutAt(times[Math.min(spoken, times.length - 1)])}
      </p>
      <div className="vh">{table}</div>
    </figure>
  );
}
