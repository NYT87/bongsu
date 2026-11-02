// A named lock in D1 with an expiry: a slow tick can't overlap the next, and a crashed one frees itself.
import type { Db } from "./db";
export async function acquire(db: Db, name: string, holder: string, nowS: number, ttlS: number): Promise<boolean> {
  await db
    .prepare(
      `INSERT INTO locks (name, holder, expires_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at WHERE locks.expires_at < ?4`,
    )
    .bind(name, holder, nowS + ttlS, nowS)
    .run();
  const row = await db.prepare("SELECT holder FROM locks WHERE name = ?1").bind(name).first<{ holder: string }>();
  return row?.holder === holder;
}

export async function release(db: Db, name: string, holder: string): Promise<void> {
  await db.prepare("DELETE FROM locks WHERE name = ?1 AND holder = ?2").bind(name, holder).run();
}
