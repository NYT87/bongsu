import { describe, expect, it } from "vitest";
import type { Db, DbStatement } from "../src/db";
import { effectivePrefs, NOTE_GROUPS, receivers, roleDefault, setPref } from "../src/notify-prefs";
import { ROLES } from "../src/roles";

describe("role defaults", () => {
  it("editors don't get needs_you; everyone else gets everything", () => {
    expect(roleDefault("editor", "needs_you")).toBe(false);
    for (const role of ROLES)
      for (const grp of NOTE_GROUPS) {
        if (role === "editor" && grp === "needs_you") continue;
        expect(roleDefault(role, grp), `${role} ${grp}`).toBe(true);
      }
  });
});

// A two-table fake: enough to run the module's four statements, not a SQL engine.
function fakeDb(members: [string, string][], prefs: [string, string, number][]) {
  const rows = prefs.map(([user_id, grp, enabled]) => ({ user_id, grp, enabled }));
  const db: Db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const st: DbStatement = {
        bind(...v) {
          args = v;
          return st;
        },
        async first() {
          return null;
        },
        async all<T>() {
          if (sql.includes("FROM memberships")) {
            return { results: members.map(([user_id, role]) => ({ user_id, role })) as T[] };
          }
          const match = rows.filter((r) =>
            args.length === 2 && sql.includes("user_id = ?2") ? r.user_id === args[1] : r.grp === args[1],
          );
          return { results: match as T[] };
        },
        async run() {
          if (sql.startsWith("DELETE")) {
            const i = rows.findIndex((r) => r.user_id === args[1] && r.grp === args[2]);
            if (i >= 0) rows.splice(i, 1);
          } else {
            const row = rows.find((r) => r.user_id === args[1] && r.grp === args[2]);
            if (row) row.enabled = args[3] as number;
            else rows.push({ user_id: args[1] as string, grp: args[2] as string, enabled: args[3] as number });
          }
          return { results: [] };
        },
      };
      return st;
    },
    async batch() {
      return [];
    },
  };
  return { db, rows };
}

describe("per-person settings", () => {
  it("effectivePrefs lists every group in order, marking what differs from the role", async () => {
    const { db } = fakeDb([], [["u1", "digest", 0]]);
    const p = await effectivePrefs(db, "w", "u1", "editor");
    expect(p.map((x) => x.grp)).toEqual([...NOTE_GROUPS]);
    expect(p.find((x) => x.grp === "needs_you")).toEqual({ grp: "needs_you", enabled: false, isDefault: true });
    expect(p.find((x) => x.grp === "digest")).toEqual({ grp: "digest", enabled: false, isDefault: false });
  });

  it("setPref stores only a difference from the role default", async () => {
    const { db, rows } = fakeDb([], []);
    await setPref(db, "w", "u1", "editor", "digest", false, 10);
    expect(rows).toHaveLength(1);
    await setPref(db, "w", "u1", "editor", "digest", true, 11);
    expect(rows).toHaveLength(0);
    await setPref(db, "w", "u1", "editor", "needs_you", false, 12);
    expect(rows).toHaveLength(0);
  });

  it("receivers are the members whose effective setting is on", async () => {
    const { db } = fakeDb(
      [
        ["a", "admin"],
        ["e", "editor"],
        ["c", "creator"],
      ],
      [
        ["c", "needs_you", 0],
        ["e", "needs_you", 1],
      ],
    );
    expect(await receivers(db, "w", "needs_you")).toEqual(["a", "e"]);
    expect(await receivers(db, "w", "digest")).toEqual(["a", "e", "c"]);
  });
});
