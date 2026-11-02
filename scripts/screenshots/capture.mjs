// Runs inside the Playwright image (see index.mjs), never on the host: captures every screen of screens.json, light
// and dark, from the demo instance on localhost. Reads the session tokens and the seed's keys from the environment.
import { readFileSync } from "node:fs";
import { chromium } from "playwright"; // installed beside this script by index.mjs

const ORIGIN = process.env.ORIGIN ?? "http://localhost:8787";
const vars = {
  itemKey: process.env.ITEM_KEY,
  approvedKey: process.env.APPROVED_KEY,
  postedKey: process.env.POSTED_KEY,
  videoId: process.env.VIDEO_ID,
  videoDate: process.env.VIDEO_DATE,
};
const screens = JSON.parse(readFileSync(new URL("./screens.json", import.meta.url), "utf8"));
const COOKIES = {
  pwa: ["bongsu_session", process.env.PWA_TOKEN],
  dashboard: ["bongsu_admin", process.env.DASHBOARD_TOKEN],
};
const VIEWPORTS = { pwa: { width: 390, height: 844, scale: 2 }, dashboard: { width: 1280, height: 800, scale: 1 } };
const LOADING = ["Loading…", "Still loading"];

/** `{itemKey}` in a url becomes the seed's value, URL-encoded the way the app builds its routes. */
const resolve = (url) =>
  url.replace(/\{(\w+)\}/g, (_, k) => {
    if (!vars[k]) throw new Error(`missing ${k} in the environment`);
    return encodeURIComponent(vars[k]);
  });

async function settle(page) {
  await page.waitForLoadState("networkidle");
  await page.waitForFunction((words) => !words.some((w) => document.body.innerText.includes(w)), LOADING, {
    timeout: 20000,
  });
  // every image and video poster on the page decoded, then let the layout and fonts rest
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), null, {
    timeout: 20000,
  });
  // videos: the first frame is decoded (readyState 2), or the browser says it can't play the file
  await page.waitForFunction(
    () => [...document.querySelectorAll("video")].every((v) => v.readyState >= 2 || v.error),
    null,
    {
      timeout: 20000,
    },
  );
  const broken = await page.evaluate(() => [...document.querySelectorAll("video")].filter((v) => v.error).length);
  if (broken) throw new Error("a video failed to load (codec?)");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(600);
}

/** A sign-in page means the cookie did not take or the server is not the demo: never shoot that. */
async function assertSignedIn(page) {
  const signIn = await page.evaluate(
    () =>
      [...document.querySelectorAll("button")].some((b) => /sign in with passkey/i.test(b.textContent ?? "")) ||
      [...document.querySelectorAll("h1")].some((h) => h.textContent?.trim() === "Sign in"),
  );
  if (signIn) throw new Error("the page shows the sign-in screen: the demo session was not accepted");
}

/** A tall viewport instead of a full-page shot, so the fixed tab bar and the sticky approve bar sit at the bottom of
 * the page once, not in the middle of it. */
async function fitToContent(page, vp) {
  const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, innerHeight));
  await page.setViewportSize({ width: vp.width, height });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
}

async function cropToViewport(page, vp) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(400);
}

// hidden scrollbars: the tall viewport would otherwise leave a gutter on the right
const browser = await chromium.launch({ args: ["--hide-scrollbars"] });
try {
  for (const s of screens) {
    const [cookieName, token] = COOKIES[s.app];
    if (!token) throw new Error(`no token for ${s.app}`);
    const vp = VIEWPORTS[s.app];
    for (const theme of ["light", "dark"]) {
      let context;
      try {
        context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          deviceScaleFactor: vp.scale,
          colorScheme: theme,
          locale: "en-US",
        });
        await context.addCookies([
          {
            name: cookieName,
            value: token,
            domain: "localhost",
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
          },
        ]);
        const page = await context.newPage();
        await page.goto(ORIGIN + resolve(s.url), { waitUntil: "load" });
        // the PWA reserves a scrollbar gutter (scrollbar-gutter: stable): it shows as an empty strip in a shot
        await page.addStyleTag({ content: "html { scrollbar-gutter: auto !important; }" });
        await settle(page);
        await assertSignedIn(page);
        const file = `${s.file ?? s.name}-${theme}.png`;
        if (s.app === "pwa") await fitToContent(page, vp);
        await page.screenshot({ path: `/out/app/${file}` });
        if (s.readme) {
          // the README gets the top of the page (header, texts and the approve bar), not a 6000 px scroll
          if (s.crop === "viewport") await cropToViewport(page, vp);
          await page.screenshot({ path: `/out/readme/${file}` });
        }
        console.log(`${s.app}/${file}`);
      } catch (e) {
        throw new Error(`${s.app}/${s.name} (${theme}): ${e.message}`, { cause: e });
      } finally {
        await context?.close();
      }
    }
  }
} finally {
  await browser.close();
}
