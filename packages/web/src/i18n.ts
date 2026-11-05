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

  // the workspace picker (the name under the header's title) and push links into another workspace
  "workspace.switch": "Switch workspace",
  "workspace.gone": "You're no longer in that workspace.",
  "workspace.toQueue": "Open the queue",

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

  // signed in, in no workspace (removed, or not invited yet)
  "noWorkspace.title": "You're not in a workspace yet",
  "noWorkspace.detail": "An admin of a workspace invites you to it: ask them for an invite link, then open it here.",

  // joining a workspace from an invite link (#/invite/<token>)
  "invite.title": "Join {workspace}",
  "invite.asRole": "You're invited as a {role}: the plan, the texts and approving.",
  "invite.gone": "This invite doesn't work",
  "invite.goneDetail":
    "It was used already, revoked, or is older than 7 days. Ask the person who invited you for a new link.",
  "invite.new": "New to Bongsu",
  "invite.name": "Your name",
  "invite.passkey": "Your passkey (this device's fingerprint, face or PIN) signs you in from now on; no password.",
  "invite.create": "Create my passkey and join",
  "invite.existing": "Already have a Bongsu account?",
  "invite.existingDetail": "Sign in with its passkey: the account must have the email this invite was sent to.",
  "invite.signIn": "Sign in with my passkey and join",
  "invite.waiting": "Waiting for the passkey…",

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
  "settings.pausedNote": "Paused: nothing in this workspace is published until you resume.",
  "settings.resumeWithPasskey": "Resume with passkey",
  "settings.resumed": "Resumed: approved items go out at their time again; any overdue ones go out now.",
  "settings.pauseNote":
    "Stops this workspace's Reels, posts and Shorts comments until you resume. Approvals are kept; other workspaces keep publishing.",
  "settings.pauseLabel": "Pause this workspace",
  "settings.pauseConfirm": "Pause publishing in this workspace?",
  "settings.pauseDetail": "Nothing goes out until you resume here.",
  "settings.notifications": "Notifications",
  "settings.pushOn": "On here",
  "settings.pushOff": "Off here",
  "settings.pushNote":
    "Notifications from your workspaces on this device; choose which below. (ntfy keeps working too.)",
  // the five notification groups (core/notify-prefs.ts), for the signed-in person in this workspace
  "settings.groups": "What {name} sends you",
  "settings.groupDefault": "Default for your role",
  "settings.groupsOther": "For another workspace, switch to it first.",
  "notify.needs_you": "Needs you",
  "notify.needs_youNote": "Posts held past their time, and Shorts comments waiting for a working connection.",
  "notify.problems": "Problems",
  "notify.problemsNote": "Failed, refused or stuck posts, and accounts that need reconnecting.",
  "notify.published": "Published and results",
  "notify.publishedNote": "What went out, Trial Reels and comments included, and each post's 24 h results.",
  "notify.inbox": "New drafts and comments",
  "notify.inboxNote": "Drafts from the inbox, others' comments on your posts, and moved release dates.",
  "notify.digest": "Daily digest",
  "notify.digestNote": "One summary a day, at the workspace's digest hour.",
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
  "settings.media": "Media stores",
  "settings.mediaNone": "None yet: set one up in the dashboard (Media) before approving anything with media.",
  "settings.mediaDefault": "default",
  "settings.mediaBroken": "needs attention",
  "settings.mediaNote": "Where the Reels and photos are read from. They're set up in the dashboard (Media).",
  "settings.accounts": "Accounts",
  "settings.accountsNote": "Connect the Instagram and YouTube accounts this workspace publishes to.",
  "settings.connect": "Connect {label}",
  "settings.reconnect": "Reconnect",
  "settings.connectNoApp": "{label}: the instance admin has to add its OAuth app in the dashboard first.",
  "settings.connectBroken": "needs reconnecting",
  "settings.connected": { one: "Connected {label}: {n} account.", other: "Connected {label}: {n} accounts." },
  "settings.connectFailed": "Not connected: {error}",
  "settings.connectBrowserHint":
    "If you connected from the app on your home screen, open Bongsu in the phone's browser (Safari on iPhone) and connect from there.",
  "settings.connectNone": "Nothing connected yet.",
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

  // errors shown in place of a page or an action
  "error.offline": "Couldn't reach the scheduler: check the connection.",
  "error.signedOut": "You're signed out: reopen the app and sign in.",
  "error.server": "The scheduler had a problem. Try again in a minute.",

  // relative days and dates
  "day.today": "Today",
  "day.tomorrow": "Tomorrow",
  "day.yesterday": "Yesterday",
  "day.noDate": "No date set",

  // a platform's post when the platform list has no name for it
  "channel.post": "Post",

  // a row's link to the real post or video
  "row.openTitleOn": "Open “{title}” on {where}",
  "row.openOn": "Open on {where}",
  "day.none": "No date",

  // the queue's filters
  "queue.all": "All",
  "queue.channel": "Channel",
  "queue.allChannels": "All channels",
  "queue.project": "Project",
  "queue.allProjects": "All projects",
  "queue.nextDays": "The next {n} days, {zone}.",
  "queue.noneNeeds": "Nothing needs approval. All set.",

  // a page showing its cached copy, and retrying
  "stale.saved": "Showing what was saved.",
  "stale.savedAt": "Showing what was saved at {time}.",
  "common.tryAgain": "Try again",

  // the Today page
  "today.offline": "Offline: couldn't reach the scheduler.",
  "today.next3": "Next 3 days",
  "today.activity": "Recent activity",
  "today.activityNone": "None yet.",
  "today.held": "{n} on hold",
  "today.heldDetail": { one: ": won't go out until you release it.", other: ": won't go out until you release them." },
  "today.needsYou": "Needs you",
  "today.overdue": "{n} overdue",
  "today.overdueDetail": ": its time passed and it hasn't gone out.",
  "today.drafts": { one: "{n} open draft to schedule or refuse", other: "{n} open drafts to schedule or refuse" },
  "today.nothing": "Nothing planned for today.",

  // the calendar and a day's events
  "calendar.nothingThatDay": "Nothing that day.",
  "calendar.posted": "Posted {when}",
  "calendar.noTime": "Time not set",
  "calendar.prevMonth": "Previous month",
  "calendar.nextMonth": "Next month",
  "calendar.pickDay": "{month}: pick a day",
  "calendar.mon": "Mon",
  "calendar.tue": "Tue",
  "calendar.wed": "Wed",
  "calendar.thu": "Thu",
  "calendar.fri": "Fri",
  "calendar.sat": "Sat",
  "calendar.sun": "Sun",
  "calendar.todaySuffix": ", today",
  "calendar.nothing": "nothing",
  "calendar.cellWaiting": { one: "; {n} needs approval", other: "; {n} need approval" },
  "calendar.checkYoutube": "Check YouTube now",
  "calendar.youtubeHourly": "YouTube updates on its own every hour.",

  // the item page
  "item.heldMsg": "On hold: it won't go out until you release it. The approval is kept.",
  "item.releasedMsg": "Released: it goes out at its time again.",
  "item.whenScheduled": "when scheduled",
  "item.story": "Story",
  "item.published": "Published",
  "results.vsUsual": "usual",
  "item.trialShown": "{when}: shown to non-followers first",
  "item.trialNotPosted": "not posted",
  "item.trialNotPostedError": "not posted: {error}",
  "item.trialPosting": "posting the trial copy…",
  "results.vsRegular": "the regular Reel",
  "item.openTrial": "Open the trial",
  "item.storyNote": "A Story: no caption or comments; it disappears from the profile after 24 h.",
  "item.caption": "Caption",
  "item.missing": "(missing)",
  "item.captionCheck": "Caption check",
  "item.captionCheckNote": "(worth a look, doesn't block):",
  "item.selfComment": "Self-comment",
  "item.none": "(none)",
  "item.secondComment": "Second comment",
  "item.altTexts": "Alt texts",
  "item.saveTexts": "Save texts",
  "item.editTexts": "Edit texts",
  "item.editNeedsApproval": "Saving changes needs a new approval.",
  "item.media": "Media",
  "item.mediaCount": "Media ({n})",
  "item.videoN": "{label} video {n}",
  "item.imageN": "Image {n}",
  "item.mediaPosted":
    "The media isn't shown here after publishing (it moves to the store's _posted folder): open it on Instagram.",
  "item.mediaMissing": "No media in the store yet: it can't be approved until the file is there.",
  "item.failed": "Failed.",
  "item.failedWith": "Failed: {error}.",
  "item.failedAgain": "Approve it again to start over.",
  "item.failedMayBeLive":
    "{platform} was asked to publish it, so it may be live: check the account (post it by hand if it isn't there), then record it with record_posted.",
  "item.approvedAt": "Approved {when}, exactly as shown.",
  "item.commentsChanged":
    "Only the comments changed since it was approved: approve them (the post itself stays as approved).",
  "item.changed": "Approved before, but something changed since: approve again.",
  "item.fixFirst": "Fix before approving:",
  "item.stopOne": "Stop just this one",
  "item.heldNote": "It won't go out until you release it.",
  "item.heldKept": "The approval is kept: once released it goes out at its time.",
  "item.release": "Release hold",
  "item.releaseConfirm": "Release this item?",
  "item.goesOut": "It goes out {when}.",
  "item.stillNeeds": "It still needs approval before it can go out.",
  "item.holdNote": "Keeps the approval; nothing else is affected.",
  "item.hold": "Hold this item",
  "item.holdConfirm": "Hold this item?",
  "item.holdDetail": "It won't go out until you release it here.",
  "item.key": "Item key",
  "item.approvedDone": "Approved.",
  "item.goesOutResumed": "Goes out when you resume publishing (scheduled {when}).",
  "item.goesOutOn": "Goes out {when} on @{account}.",
  "common.done": "Done",
  "item.holdInstead": "Hold it instead…",
  "item.pausedNote": "Publishing is paused: approving now keeps it waiting until you resume.",
  "common.waitingPasskey": "Waiting for passkey…",
  "item.checking": "Checking for changes…",
  "item.fixN": { one: "Fix {n} problem first", other: "Fix {n} problems first" },
  "item.approveComments": "Approve comments",
  "item.approvePaused": "Approve (held while paused)",
  "item.approve": "Approve: publish {slot}",

  // an item's display name
  "name.rename": "Rename",
  "name.name": "Name",
  "name.note": "Only what the app shows. The file name ({file}) and the approval stay the same.",
  "name.useFile": "Use the file name",
  "name.save": "Save name",

  // a video's cover frame
  "cover.reset": "Cover back to the default (0.5 s).",
  "cover.set": "Cover set to {s} s.",
  "cover.title": "Cover frame",
  "cover.default": "The frame at 0.5 s (default).",
  "cover.frameAt": "The frame at",
  "cover.seconds": "{s} s",
  "cover.video": "Video to pick the cover from",
  "common.useDefault": "Use the default",
  "cover.use": "Use this frame",

  // an Instagram location tag
  "location.title": "Location",
  "location.tagged": "Tagged:",
  "location.place": "place {id}",
  "location.none": "No location.",
  "location.label": "Instagram location link or place number",
  "location.help":
    "On Instagram, search the place, open it and share or copy its link. Older places can have a different number in the link than the one the API wants; if Instagram refuses it, the post still goes out without the location.",
  "location.save": "Save location",
  "common.remove": "Remove",
  "common.change": "Change",
  "location.add": "Add location",

  // a Reel's Trial Reel switch
  "trial.also": "Also post it as a Trial Reel",
  "trial.note":
    "Right after the Reel: the same video, shown to non-followers first. It reaches your followers too if it does well.",
  "trial.set": "Set for this Reel.",
  "trial.defaultIs": "'s default is {state}.",
  "trial.on": "on",
  "trial.off": "off",
  "trial.following": "Following",
  "trial.followingEnd": "'s default.",

  // moving an item's time
  "reschedule.moved": "Moved to {when}.",
  "reschedule.reapprove": "It needs approving again for the new time.",
  "reschedule.title": "Release date",
  "reschedule.goesOut": "Goes out",
  "reschedule.notYet": "Not scheduled yet.",
  "common.dateIn": "Date ({zone})",
  "common.time": "Time",
  "reschedule.needsApproval": "Moving it needs a new approval for the new time.",

  // where an item's texts came from
  "texts.copied": "Texts copied from the repo.",
  "texts.copiedAt": "Texts copied from the repo on {at}.",
  "texts.notCopied": "Not copied yet: add the texts in the app or with",
  "texts.byHere": "here",
  "texts.byAgent": "by an agent ({id})",
  "texts.edited": "Texts edited {who}",
  "texts.on": " on {at}",
  "texts.filesOlder": "; the repo files are older (",
  "texts.filesOlderEnd": " with those files brings the scheduler in step)",

  // a 24 h results line
  "results.line24h": "24 h:",
  "results.lineViews": "{n} views",
  "results.lineRest": "{likes} likes · {comments} comments · {saves} saves · {shares} shares · reach {reach}",

  // approving with a passkey, and a Short's comment
  "approve.cancelled": "The passkey prompt was closed or timed out. Nothing was approved: tap Approve to try again.",
  "comment.commented": "Commented",
  "comment.changed": "Changed since approval",
  "comment.waiting": "Waiting for your approval",
  "comment.title": "Comment",
  "comment.goesOutAs": "It goes out as {account} once the video is public.",
  "comment.fixFirst": "Fix the problem first",
  "comment.approve": "Approve the comment",
  "comment.approved": "Approved: it's posted once the video is public.",

  // a YouTube video's release date and page
  "release.cancelled": "The passkey prompt was closed or timed out. Nothing was moved: tap Save new date to try again.",
  "video.unknown": "Unknown video link.",
  "video.gone": "This video isn't in the calendar for {month} any more.",
  "video.note":
    "YouTube videos are published by YouTube itself; the scheduler only adds the pinned-comment text to Shorts, once you approve it.",

  // others' comments and replying
  "comments.none": "No comments on the last two weeks' posts yet. New ones show up here (checked every 15 minutes).",
  "comments.ytShort": "YouTube Short",
  "comments.igPost": "Instagram post",
  "comments.replied": "↳ You replied: {text}",
  "comments.reply": "Reply",
  "comments.replyTo": "Reply to {author}",
  "comments.sending": "Sending…",
  "comments.send": "Send reply",

  // the texts form
  "texts.storyNone": "A Story has no caption or comments.",
  "texts.commentHint": "(empty: the caption's question line)",
  "texts.comment2Hint": "(optional: posted right after the first)",
  "texts.altHint": "(one line per image, in order)",

  // scheduling a draft
  "schedule.freeTimes": "Free times",
  "schedule.free": "Free:",
  "schedule.story": "Schedule Story",
  "schedule.schedule": "Schedule",
  "schedule.publishAs": "Publish as",
  "schedule.reel": "Reel",
  "schedule.account": "Account",
  "common.timeIn": "Time ({zone})",
  "schedule.itemKey": "(item key: {key})",

  // uploading a new draft's files to a media store
  "upload.unreadable":
    "this device couldn't read {file} ({error}): pick it again from the file browser (Videos or DCIM/Camera)",
  "upload.failed": "upload of {file} failed ({status})",
  "upload.network": "upload of {file}: network error at {percent}%",

  // a new draft from this device
  "draft.choose": "Choose files",
  "draft.pickHelp":
    "1 video for a Reel, or up to 10 images/videos for a carousel, in the order picked (on the phone: Videos, Images or DCIM/Camera in the file browser).",
  "draft.carouselOf": "Carousel of {n}",
  "draft.photo": "Photo",
  "draft.size": "{mb} MB: {files}",
  "draft.altHint": "(one line per image)",
  "draft.uploading": "Uploading… {percent}%",
  "draft.store": "Upload to",
  "draft.uploadingShort": "Uploading…",
  "draft.upload": "Upload and create draft",
  "draft.uploadNote":
    "The files go straight from this device to the media store ({folder}/_uploads); the texts can still be edited when scheduling.",

  // the Drafts page
  "drafts.refused": "Draft refused.",
  "drafts.carousel": "Carousel",
  "drafts.shortsComment": "Shorts comment",
  "drafts.new": "New draft",
  "drafts.about": "About drafts",
  "drafts.aboutBefore": "Files dropped in a media store's",
  "drafts.aboutAfter": "and proposals from agents. Schedule one, then approve it on its page.",
  "drafts.video": "Video: {name}",
  "drafts.selfComment": "Self-comment: {text}",
  "drafts.secondComment": "Second comment: {text}",
  "drafts.driveInbox": "Inbox",
  "store.drive": "Google Drive",
  "store.s3": "Bucket (S3)",
  "store.local": "This server",
  "drafts.refuse": "Refuse",
  "drafts.refuseConfirm": "Refuse this draft?",
  "drafts.refuseDetail": "It can't be brought back.",
  "drafts.schedule": "Schedule…",

  // the Stats tab
  "stats.followers": { one: "{count} follower", other: "{count} followers" },
  "stats.subscribers": { one: "{count} subscriber", other: "{count} subscribers" },
  "stats.views": { one: "{count} view", other: "{count} views" },
  "stats.likes": { one: "{count} like", other: "{count} likes" },
  "stats.comments": { one: "{count} comment", other: "{count} comments" },
  "stats.audience": "Audience",
  "stats.ytChannel": "YouTube channel",
  "stats.noAccounts": "No accounts yet.",
  "stats.recent": "Last {n} days, most viewed",
  "stats.recentNone": "Nothing published in the last {n} days has numbers yet.",

  // an account's page
  "results.subscribersWord": "subscribers",

  // the app's version
  "settings.app": "App",
  "settings.built": ", built {built}.",
  "settings.upToDate": "Up to date.",
  "settings.newer": "A newer version is deployed (",
  "settings.newerEnd": ", {built}).",
  "settings.update": "Update now",
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
