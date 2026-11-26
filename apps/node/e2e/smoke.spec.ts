// What the component tests (happy-dom) can't see: the Node build serving the app and the dashboard, their routes
// (the app's hash routes, the dashboard's paths under /dashboard/), the service worker and the static files. A first
// run end to end: set up the instance with a passkey (Chromium's virtual authenticator), create a workspace, walk
// the dashboard, then sign in to the app with the same passkey and walk its tabs.
import { expect, type Page, test } from "@playwright/test";

/** Every request that failed or every script error, besides the API's own answers (a 401 before signing in is
 *  how the pages learn they're signed out). */
function watch(page: Page) {
  const problems: string[] = [];
  page.on("response", (r) => {
    const path = new URL(r.url()).pathname;
    if (r.status() >= 400 && !/^\/(app-api|admin-api)\//.test(path)) problems.push(`${r.status()} ${path}`);
  });
  page.on("requestfailed", (r) => problems.push(`failed ${new URL(r.url()).pathname}`));
  page.on("pageerror", (e) => problems.push(`script error: ${e.message}`));
  return problems;
}

test("a first run: the dashboard and the app load, route and serve their files", async ({ page, context }) => {
  const problems = watch(page);
  // SecretOnce asks before closing an uncopied secret: the recovery codes here are throwaway
  page.on("dialog", (d) => d.accept());
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await test.step("the dashboard's first run", async () => {
    await page.goto("/dashboard/");
    await expect(page.getByRole("heading", { name: "Set up Bongsu" })).toBeVisible();
    await page.getByLabel("Setup token").fill("e2e-setup-token");
    await page.getByLabel("Your name").fill("Demo Owner");
    await page.getByLabel("Email").fill("owner@example.com");
    await page.getByRole("button", { name: "Create my passkey" }).click();
    await expect(page.getByRole("region", { name: "Recovery codes" })).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();

    await expect(page.getByRole("heading", { name: "Create your first workspace" })).toBeVisible();
    await page.getByLabel("Name").fill("Demo travel");
    await page.getByRole("button", { name: "Create the workspace" }).click();
    await expect(page).toHaveURL(/\/dashboard\/start$/);
  });

  await test.step("the dashboard's routes", async () => {
    // the sidebar moves without a reload; Back follows the history
    await page.getByRole("link", { name: "Members" }).click();
    await expect(page).toHaveURL(/\/dashboard\/members$/);
    await expect(page.getByRole("link", { name: "Members" })).toHaveAttribute("aria-current", "page");
    await page.getByRole("link", { name: "Keys & tokens" }).click();
    await expect(page).toHaveURL(/\/dashboard\/keys$/);
    await page.goBack();
    await expect(page.getByRole("link", { name: "Members" })).toHaveAttribute("aria-current", "page");
    // a path opened directly: the server answers with the dashboard's page, which shows that section
    await page.goto("/dashboard/keys");
    await expect(page.getByRole("link", { name: "Keys & tokens" })).toHaveAttribute("aria-current", "page");
  });

  await test.step("the app: sign in with the same passkey, then its tabs", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "Sign in with passkey" }).click();
    const tabs = page.getByRole("navigation", { name: "Sections" });
    await expect(tabs).toBeVisible();
    for (const [href, label] of [
      ["#/calendar", "Calendar"],
      ["#/queue", "Queue"],
      ["#/drafts", "Drafts"],
      ["#/stats", "Stats"],
      ["#/", "Today"],
    ]) {
      await tabs.getByRole("link", { name: label }).click();
      await expect(page).toHaveURL(new RegExp(`${href.replace("/", "\\/")}$`));
      await expect(tabs.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
    }
    // a hash route opened directly
    await page.goto("/#/settings");
    await expect(page.locator('a[href="#/settings"]')).toHaveAttribute("aria-current", "page");
  });

  await test.step("the service worker", async () => {
    const active = () => navigator.serviceWorker.getRegistration().then((r) => r?.active?.scriptURL ?? null);
    await expect.poll(() => page.evaluate(active), { timeout: 10_000 }).toMatch(/\/sw\.js$/);
  });

  await test.step("static files", async () => {
    const manifest = await page.request.get("/manifest.webmanifest");
    expect(manifest.headers()["content-type"]).toBe("application/manifest+json");
    // a missing file is a 404, a path without one is the app's page
    expect((await page.request.get("/assets/missing.js")).status()).toBe(404);
    const deep = await page.request.get("/some/page");
    expect(await deep.text()).toContain('<div id="root">');
  });

  expect(problems).toEqual([]);
});
