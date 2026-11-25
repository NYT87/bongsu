// The scheduler publishes exactly what was approved: texts, media files, and which files a folder post holds, checked
// again at the last step before the post goes live.
import { env } from "cloudflare:workers";
import { tick } from "@bongsu/core/tick";
import { beforeEach, describe, expect, it } from "vitest";
import { approve, clearPlan, copyText, igHappyPath, MD5, planItem, seedReel, testEnv, World } from "./world";

const AT = new Date("2026-10-20T09:32:00Z"); // 18:32 KST
const later = (min: number) => new Date(AT.getTime() + min * 60_000);

interface Job {
  state: string;
  last_error: string | null;
}
const jobs = async () => (await env.DB.prepare("SELECT * FROM jobs ORDER BY id").all<Job>()).results;

let w: World;
beforeEach(async () => {
  await env.DB.batch(["DELETE FROM jobs", "DELETE FROM audit", "DELETE FROM locks"].map((s) => env.DB.prepare(s)));
  await clearPlan();
  w = new World();
});

const published = () => w.calls.filter((c) => c.slug === "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH");

describe("approval is checked again at every step that publishes", () => {
  it("a caption edited while the container was processing is not published", async () => {
    const { folder, base } = await seedReel(w);
    igHappyPath(w, ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"]);
    const e = await testEnv(env);
    await tick(e, { fetch: w.fetch, now: AT });
    expect((await jobs())[0].state).toBe("container_created");
    await copyText(`channels/${folder}/shorts/instagram/${base}.txt`, "Edited while processing\n");
    for (let i = 1; i <= 4; i++) await tick(e, { fetch: w.fetch, now: later(5 * i) });
    expect(published()).toEqual([]);
    expect(await jobs().then((j) => [j[0].state, j[0].last_error])).toEqual([
      "refused",
      "the caption changed after approval",
    ]);
  });
});

describe("a folder post's files are compared with the approved selection", () => {
  const folder = "main/CONTENT/20260101_TRIP";
  const name = "posts/carousel2_bridges";
  const dir = `UPLOADS/${folder}/${name}`;
  async function seedFolder() {
    const key = await planItem({ kind: "post", folder, name, time: "18:30" });
    await copyText(`channels/${folder}/${name}/caption.txt`, "Bridges");
    const a = w.drivePut(`${dir}/01.jpg`, { md5: MD5, mimeType: "image/jpeg" });
    const b = w.drivePut(`${dir}/02.jpg`, { md5: MD5, mimeType: "image/jpeg" });
    await approve(key, {
      due: "2026-10-20 18:30",
      caption: "Bridges",
      comment: null,
      media: [a, b].map((driveId) => ({ driveId, md5: MD5 })),
    });
    igHappyPath(w);
    return { a, b };
  }

  it("goes out when the folder is as approved", async () => {
    await seedFolder();
    await tick(await testEnv(env), { fetch: w.fetch, now: AT });
    expect((await jobs())[0].state).toBe("container_created");
  });

  it("is refused when a file was added after approval", async () => {
    await seedFolder();
    w.drivePut(`${dir}/03.jpg`, { md5: MD5, mimeType: "image/jpeg" });
    await tick(await testEnv(env), { fetch: w.fetch, now: AT });
    expect((await jobs())[0]).toMatchObject({ state: "refused" });
    expect((await jobs())[0].last_error).toMatch(/media selection changed after approval/);
    expect(w.calls.filter((c) => c.slug === "INSTAGRAM_POST_IG_USER_MEDIA")).toEqual([]);
  });

  it("is refused when a file was removed after approval", async () => {
    const { b } = await seedFolder();
    w.drive.delete(b);
    await tick(await testEnv(env), { fetch: w.fetch, now: AT });
    expect((await jobs())[0].state).toBe("refused");
  });
});
