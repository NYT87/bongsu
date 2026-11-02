// The app's service worker: makes it installable, keeps the shell for offline opening, and shows push notifications.
const SHELL = "bongsu-shell-v6";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon-192.png"]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first for the app's own pages and files (fresh after every deploy), the cache only when offline.
// API calls and media links are never cached.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // API calls, media links and the dashboard (its own app, not cached by the PWA) go straight to the network
  if (/^\/(app-api|admin-api|m|v1)\/|^\/dashboard(\/|$)/.test(url.pathname)) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(SHELL).then((c) => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("/"))),
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: "Bongsu", body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || "Bongsu", {
      body: d.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: d.tag || undefined,
      // Buttons (Android shows two): each opens its own url; a tap on the notification opens `url`.
      actions: (d.actions || []).map((a) => ({ action: a.action, title: a.title })),
      data: { url: d.url || "/#/", actions: Object.fromEntries((d.actions || []).map((a) => [a.action, a.url])) },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = new URL((e.action && data.actions?.[e.action]) || data.url || "/#/", location.origin).href;
  if (new URL(url).origin !== location.origin) {
    e.waitUntil(self.clients.openWindow(url));
    return;
  } // Instagram, Studio
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w) {
          w.navigate(url);
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
