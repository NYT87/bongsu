// The app's text. `en` is the source of truth: every other locale is a `Catalogue`, so a key missing from it is a type
// error. Keys are dotted strings grouped by area; a plural is `{ one, other }` and `vars.n` picks the form. The locale
// comes from /app-api/me (the workspace's), set once with setLocale().

export const en = {
  // shared verbs and states
  "common.loading": "Loading…",
  "common.cancel": "Cancel",
  "common.saving": "Saving…",
  "common.changeDate": "Change date",
  "common.saveNewDate": "Save new date",
  "common.openOnYoutube": "Open on YouTube",
  // an example of a plural: no screen uses it yet
  "count.items": { one: "{n} item", other: "{n} items" },

  // the tab bar and the page titles
  "tabs.nav": "Sections",
  "tabs.today": "Today",
  "tabs.calendar": "Calendar",
  "tabs.queue": "Queue",
  "tabs.drafts": "Drafts",
  "tabs.stats": "Stats",
  "tabs.badgeOpen": "{label}, {n} open",
  "tabs.badgeApproval": "{label}, {n} need approval",
  "title.video": "Video",
  "title.review": "Review",
  "title.channel": "Channel",

  // the header
  "header.brandToday": "{name}: Today",
  "header.dryRun": "dry run",
  "header.comments": "Comments",
  "header.commentsNew": "Comments, {n} new",
  "header.settings": "Settings",
  "header.paused": "Publishing is paused.",
  "header.pausedDetail": "Nothing goes out until you resume.",
  "header.resume": "Resume",

  // sign-in and setup of a device
  "sign.signIn": "Sign in with passkey",
  "sign.setupThis": "Set up this device",
  "sign.addThis": "Add this device",
  "sign.codeFilled": "Code from the QR code filled in: create the passkey for this device.",
  "sign.scan": "Scan the QR code from the dashboard (Devices & passkeys → Add a device), or type its code.",
  "sign.codeStays": "The code stays valid if an attempt fails.",
  "sign.codeLabel": "Setup code",
  "sign.create": "Create passkey",
  "sign.deviceError":
    "This device couldn't create the passkey ({detail}: {message}). Your setup code still works: try again. Chrome with Google Password Manager as the passkey provider is the most reliable.",

  // empty lists and the no-account note
  "empty.scheduledBefore": "Nothing scheduled. Posts arrive from the inbox, from a draft, or from an agent: see",
  "empty.scheduledLink": "Drafts",
  "empty.drafts": "No drafts. The inbox and agents put new posts here for you to review.",
  "setup.none": "No account connected yet.",
  "setup.connect": "Connect Instagram or YouTube in the dashboard.",
  "setup.start": "Get started",
  "setup.guides": "guides:",

  // a row's status
  "status.notApproved": "Needs approval",
  "status.reApprove": "Re-approve",
  "status.approved": "Approved",
  "status.posted": "Posted",
  "status.public": "Public",
  "status.scheduled": "Goes public",
  "status.private": "Private",
  "status.unlisted": "Unlisted",
  "status.hold": "On hold",

  // settings
  "settings.publishing": "Publishing",
  "settings.pausedNote": "Paused: nothing is published until you resume.",
  "settings.resumeWithPasskey": "Resume with passkey",
  "settings.resumed": "Resumed: approved items go out at their time again; any overdue ones go out now.",
  "settings.pauseNote": "Stops every Reel, post and Shorts comment until you resume. Approvals are kept.",
  "settings.pauseLabel": "Pause everything",
  "settings.pauseConfirm": "Pause all publishing?",
  "settings.pauseDetail": "Nothing goes out until you resume here.",
  "settings.notifications": "Notifications",
  "settings.pushOn": "On here",
  "settings.pushOff": "Off here",
  "settings.pushNote": "Published, refused and failed items on this device. (ntfy keeps working too.)",
  "settings.pushEnable": "Turn on for this device",
  "settings.pushTest": "Send a test",
  "settings.pushTestSent": "Test sent.",
  "settings.pushEnabled": "Notifications are on for this device.",
  "settings.pushUnsupported": "This browser has no push support.",
  "settings.pushDismissed": "The permission prompt was closed: tap again and choose Allow.",
  "settings.unblockAndroid":
    "Android Settings → Apps → {name} (or the browser that installed it) → Notifications → allow; then reopen the app.",
  "settings.unblockBrowser":
    "In the browser: the icon left of the address → Permissions (Site settings) → Notifications → Allow; then reload.",
  "settings.unblockBrave": 'In Brave also turn on brave://settings/privacy → "Use Google services for push messaging".',
  "settings.unblockHelp":
    "Notifications are blocked for this site on this device. {steps}{brave} Then tap the button again.",
  "settings.thisDevice": "This device",
  "settings.signOut": "Sign out",
  "settings.version": "Version",
  "settings.zone": "Time zone",
  "settings.zoneShown": "Times are shown and entered in",
  "settings.zoneWorkspace": "(the workspace's)",
  "settings.zoneNote": "Plans are kept in UTC: changing this moves nothing.",
  "settings.zoneUse": "Use",
  "settings.zoneDevice": "Use this device's ({zone})",
  "settings.zoneBack": "Back to the workspace's ({zone})",

  // the metrics chart: its summary for screen readers, a missing sample, the table's first column
  "chart.summary": {
    one: "{label}, {n} point, from {from} to {to}, latest {latest}",
    other: "{label}, {n} points, from {from} to {to}, latest {latest}",
  },
  "chart.noData": "no data",
  "chart.when": "When",

  // the Results view of a published item or video
  "results.show": "Show",
  "results.results": "Results",
  "results.post": "Post",
  "results.video": "Video",
  "results.range": "Range",
  "results.total": "Total",
  "results.daily": "Daily",
  "results.metric": "Metric",
  "results.views": "Views",
  "results.reach": "Reach",
  "results.likes": "Likes",
  "results.comments": "Comments",
  "results.saves": "Saves",
  "results.shares": "Shares",
  "results.follows": "Followers",
  "results.subscribers": "Subscribers",
  "results.profile_visits": "Profile visits",
  "results.followersWord": "followers",
  "results.visitsWord": "profile visits",
  "results.analyticsMissing":
    "Subscribers gained: not available until the channel is reconnected with analytics (dashboard → Connections).",
  "results.trial": "Trial Reel",
  "results.trialNumbers": "Trial Reel, 24 h:",
  "results.taken": "Taken {when}.",
  "results.empty": "No results yet: the 24 h numbers arrive a day after publishing.",
  "results.trialEmpty": "Trial Reel: no results yet.",
  "channel.period": "Period",
  "channel.days7": "7 days",
  "channel.days30": "30 days",
  "channel.days90": "90 days",
  "channel.followers": "Followers",
  "channel.subscribers": "Subscribers",
  "channel.viewsPerDay": "Views per day",
  "channel.brought": "What brought followers",
  "channel.broughtNone": "No followers attributed to posts in this period.",
  "channel.noSamples": "No samples in this period yet: the account is sampled once a day.",
  "channel.noViews": "No views recorded for this account's posts in this period.",
  "channel.analyticsMissing":
    "Not available until the channel is reconnected with analytics (dashboard → Connections).",
  "channel.since": "since {when}",
} as const;

export type Key = keyof typeof en;
export type Catalogue = Record<Key, string | { one: string; other: string }>;

const LOCALES: Record<string, Catalogue> = { en };
let current = "en";

/** Switch to a locale the app has a catalogue for (else English); returns the one in use. */
export function setLocale(l: string): string {
  current = l in LOCALES ? l : "en";
  if (typeof document !== "undefined") document.documentElement.lang = current;
  return current;
}

/** The locale for Intl and toLocaleDateString. */
export const dateLocale = (): string => current;

/** The text for a key: `{name}`-style placeholders filled from vars; a plural picks one/other by vars.n. An unknown
 *  key answers itself, so a missing string shows up as its key rather than as nothing. */
export function t(key: Key, vars?: Record<string, string | number>): string {
  const entry = (LOCALES[current] ?? en)[key];
  if (entry === undefined) return key;
  const text = typeof entry === "string" ? entry : vars?.n === 1 ? entry.one : entry.other;
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}
