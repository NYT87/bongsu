import type { Ctx } from "./ctx";

const cell = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** Columns padded to their widest cell, under a header row; the last column isn't padded, so no trailing spaces. */
export function table(rows: Record<string, unknown>[], columns: string[]): string {
  const cells = [columns, ...rows.map((r) => columns.map((c) => cell(r[c])))];
  const widths = columns.map((_, i) => Math.max(...cells.map((row) => row[i].length)));
  const line = (row: string[]) =>
    row
      .map((v, i) => (i === row.length - 1 ? v : v.padEnd(widths[i])))
      .join("  ")
      .trimEnd();
  return `${cells.map(line).join("\n")}\n`;
}

/** RFC 4180: CRLF line ends, a field quoted when it holds a comma, a quote or a line break. */
export function csv(rows: Record<string, unknown>[], columns: string[]): string {
  const field = (v: unknown) => {
    const s = cell(v);
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [columns, ...rows.map((r) => columns.map((c) => r[c]))]
    .map((row) => `${row.map(field).join(",")}\r\n`)
    .join("");
}

/** `--json` prints the API's answer as it came (plus a line end), for scripts; otherwise the text for people. */
export const emit = (ctx: Ctx, data: unknown, text: () => string) =>
  ctx.io.out(ctx.json ? `${JSON.stringify(data, null, 2)}\n` : text());
