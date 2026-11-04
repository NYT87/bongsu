---
name: Bongsu app
description: A pocket control room for approving and watching the creator's scheduled Reels, posts and Shorts comments.
colors:
  go-green: "#15803d"
  go-green-dark-mode: "#22c55e"
  on-go-green-dark-mode: "#052e16"
  icon-navy: "#131f2a"
  icon-ember: "#f7931e"
  ok-green-dark-mode: "#4ade80"
  caution-amber: "#b45309"
  caution-amber-dark-mode: "#fbbf24"
  stop-red: "#b91c1c"
  stop-red-dark-mode: "#f87171"
  reel-violet: "#7c3aed"
  reel-violet-dark-mode: "#a78bfa"
  post-cyan: "#0891b2"
  post-cyan-dark-mode: "#22d3ee"
  bongsu-magenta: "#db2777"
  bongsu-magenta-dark-mode: "#f472b6"
  vlogs-blue: "#1d4ed8"
  vlogs-blue-dark-mode: "#60a5fa"
  series-plum: "#86198f"
  series-plum-dark-mode: "#f0abfc"
  series-rust: "#7c2d12"
  series-rust-dark-mode: "#d99a6c"
  series-teal: "#0f766e"
  series-teal-dark-mode: "#5eead4"
  series-olive: "#6b6a0a"
  series-olive-dark-mode: "#bef264"
  series-slate: "#334155"
  series-slate-dark-mode: "#cbd5e1"
  ink: "#0f172a"
  mist: "#f8fafc"
  paper: "#ffffff"
  slate-muted: "#64748b"
  hairline: "#e2e8f0"
  night: "#0f172a"
  night-card: "#1e293b"
  night-line: "#334155"
  night-ink: "#e2e8f0"
  night-muted: "#94a3b8"
  media-black: "#000"
typography:
  display:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "24px"
    fontWeight: 700
  headline:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "18px"
    fontWeight: 700
  bar-title:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "17px"
    fontWeight: 700
  body:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.45
  title:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 700
  label:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
  pill:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
  tab-label:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
rounded:
  xs: "2px"
  sm: "8px"
  md: "10px"
  lg: "12px"
  full: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  button-primary:
    backgroundColor: "{colors.go-green}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "14px"
    width: "100%"
  button-default:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
    height: "44px"
  button-danger:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.stop-red}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
  card:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.lg}"
    padding: "14px"
  list-row:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.lg}"
    padding: "10px 12px"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "12px"
    width: "100%"
  pill:
    textColor: "{colors.slate-muted}"
    typography: "{typography.pill}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  tab:
    textColor: "{colors.slate-muted}"
    typography: "{typography.tab-label}"
    padding: "8px 0 7px"
    width: "76px"
  tab-active:
    textColor: "{colors.go-green}"
  tab-badge:
    backgroundColor: "{colors.caution-amber}"
    textColor: "{colors.paper}"
    rounded: "{rounded.full}"
    height: "18px"
  approve-bar:
    backgroundColor: "{colors.paper}"
    padding: "10px 16px 12px"
  calendar-cell:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.sm}"
    padding: "4px"
---

# Design System: Bongsu app

## Overview

**Creative North Star: "The Pocket Control Room"**

A compact console that lives in one hand. The first screen answers "is today OK, and does anything need me?" before
anything else: a **Needs you** list first when something waits on the owner, and nothing at all when nothing does (no
status card and no "All set" row since 2026-10-21; an offline notice appears only when the data is stale), then today's
items. The room is
quiet by default (slate surfaces, the device's own system font, hairline borders) so that the few signals in it read
instantly: green means approved and safe to go, amber means waiting on the owner, red means failed, stopped or
destructive.

The feel is **crisp and confident**. The app asks the creator to tap "Approve" on something that will be published and
can't be taken back, so every state is stated plainly, the target (channel, account, day and time in the workspace's time zone) is repeated
right above the button, and the button itself says what will happen ("Approve: publish Today 18:00 GMT+9"). Density is
moderate: one 720px column of rows and cards, a sticky top bar, a labelled bottom tab bar sized for the thumb. Light and
dark themes follow the device; neither is the "real" one.

**Key Characteristics:**
- One accent, Go Green, reserved for "approved / go / you are here".
- Three status colours (ok / caution / stop) and a four-hue channel code that never borrows a status hue.
- Flat surfaces with hairline borders; no shadows.
- Soft, thumb-sized controls: 44px minimum height, 10–12px corners, full-width primary actions.
- What needs the owner comes first, and is counted on the tabs.
- Honest state: offline or stale data says so, with the time it was saved.

## Colors

A quiet slate world with one green signal, three status colours, a separate channel code and five chart hues.

### Primary
- **Go Green** (light #15803d with white text; dark #22c55e with #052e16 text): the "safe to publish" signal. The
  primary button (Approve, Schedule, Save, Resume), the active tab, today's calendar cell
  border, the selected day's tint (18% mixed into the card colour), links and the focus ring.
- **Icon Navy** (#131f2a) and **Icon Ember** (#f7931e): the mark only (`public/icon-*.png`: header logo, favicon,
  app icons) and the PWA theme colour. The mark is a beacon fire on mountain peaks (Bongsu, 봉수: Korea's beacon-tower
  network), orange line art on navy. Brand originals and the README banner live in `docs/assets/brand/`.

### Status
- **OK Green** (light #15803d, dark #4ade80): approved, posted, done.
- **Caution Amber** (light #b45309, dark #fbbf24): waiting on the owner. "Needs approval" and "Re-approve" pills, the
  Needs you heading, the tab count badges, the ring on a calendar dot, offline/stale notices.
- **Stop Red** (light #b91c1c, dark #f87171): failed, error, paused and destructive buttons (Pause this workspace, Refuse).
  The paused banner is white text on the light value (#b91c1c) in both themes, so it keeps 4.5:1 in dark mode too.

### Channel code
The same four hues mark a channel or post type wherever one appears: rows on Today, Queue and the calendar's day list,
the item page, calendar dots and the legend. None of them is green, amber or red, so a dot never reads as a status.
Each also has a shape, so colour is never the only cue: **circle** for videos (Reels), **rounded square** for other posts,
**triangle** for YouTube. The names next to them come from the server's platform list (`/app-api/platforms`: "Instagram
Reel", "YouTube Short"…); a platform without its own hue yet gets Slate Muted with the same shapes
(`.dot.p-<platform>` in `styles.css`).
- **Reel Violet** (light #7c3aed, dark #a78bfa): Instagram Reels.
- **Post Cyan** (light #0891b2, dark #22d3ee): Instagram photo and carousel posts.
- **Main Magenta** (light #db2777, dark #f472b6): YouTube, Main channel.
- **Vlogs Blue** (light #1d4ed8, dark #60a5fa): YouTube, Demo Vlogs.

### Chart series
Five hues for the lines of a chart (`--series-1` … `--series-5`), in this order. They are none of the channel or status
hues, so a line never reads as a channel or a state, and each keeps 3:1 or more against the card in its theme (light
5.4–10:1, dark 6–11:1). A series always has its label in the legend and its own marker shape (see Charts).
- **Series Plum** (light #86198f, dark #f0abfc): the first series, the item itself.
- **Series Rust** (light #7c2d12, dark #d99a6c): the second, a Trial Reel copy.
- **Series Teal** (light #0f766e, dark #5eead4).
- **Series Olive** (light #6b6a0a, dark #bef264).
- **Series Slate** (light #334155, dark #cbd5e1).

### Neutral
- **Ink** (#0f172a) / **Night Ink** (#e2e8f0): body text, light / dark.
- **Mist** (#f8fafc) / **Night** (#0f172a): page background and the sticky header.
- **Paper** (#ffffff) / **Night Card** (#1e293b): rows, cards, buttons, inputs, the tab bar and the approve bar.
- **Slate Muted** (#64748b) / **Night Muted** (#94a3b8): secondary text, inactive tabs, neutral pills.
- **Hairline** (#e2e8f0) / **Night Line** (#334155): every border and divider.
- **Media Black** (#000): behind videos and photos so they letterbox cleanly.

### Named Rules
**The One Signal Rule.** Go Green means "approved / go / here" and nothing else. It never decorates, and it is never used
for a status that isn't positive.

**The Waiting Is Amber Rule.** Anything waiting on the owner (not approved, re-approve, open drafts, stale data) is Caution
Amber. Red is only for failed, stopped and destructive.

**The Channel Code Rule.** Reel Violet, Post Cyan, Main Magenta and Vlogs Blue identify channels and post types only,
always the same way, always next to a text label or the legend; colour is never the only cue.

**The Series Rule.** Chart lines use the series hues only, never a channel or status colour, and never colour alone:
each series has its legend label and its marker shape.

**The Twin Theme Rule.** Every colour has a light and a dark value, defined as a custom property on `:root`; add both or
neither.

## Typography

**Display Font:** system-ui (with -apple-system, "Segoe UI", Roboto, sans-serif)
**Body Font:** the same system stack

**Character:** the phone's own type, so the app feels native and loads instantly. Hierarchy comes from weight and from a
few close sizes, never from a second family.

### Hierarchy
- **Display** (700, 24px): sign-in title.
- **Headline** (700, 18px): section headings (`h2`): Needs you, Today, Caption, card titles in Settings.
- **Bar title** (700, 17px): the sticky top bar's title (the page, or the item's readable name).
- **Body** (400, 16px, line-height 1.45): everything else, including captions shown verbatim (`pre-wrap`).
- **Title** (700, 15px): day headings in Queue, sub-section headings (`h3`), form labels, the item's target line.
- **Label** (400, 13px): row meta lines (the time in them is 600 and in the text colour), help text, timestamps.
- **Pill** (400, 13px): status pills ("Needs approval" is decision text, so it stays at the 13px floor).
- **Tab label** (400, 12px): tab labels and tab count badges (700); navigation, not decision text.
- Numbers that line up (times, counts, stats) use tabular numerals.

### Named Rules
**The Native Type Rule.** No web fonts. Inputs use 16px so phones don't zoom; nothing the owner must read to decide is
smaller than 13px.

## Layout

A single centred column, max 720px wide, 16px side gutters, 12px top padding, and enough bottom padding to clear the tab
bar (96px plus the safe area; 210px when the approve bar is showing).

- **Top bar:** sticky, three columns (the 32px logo left, linking to Today; title centred and clipped; on the right
  the comments icon, with an amber unread-count badge like the tabs', and the settings icon), each a 44px target.
- **Comments page** (the header's speech-bubble icon): others' comments on the last two weeks' posts and Shorts,
  grouped per post (its name links to the item, the platform icon opens it), newest first; comments new since the last
  visit carry the amber row border. Reply opens a field in place ("Send reply" is the inline primary). Opening the
  page marks them seen once it has loaded.
- **Phase 12 on the item page:** a **Cover frame** card for a video (its player, "Use this frame", "Use the default") and
  a **Location** card (the tagged place as a link, "Add location" / "Change" with a field for an Instagram location link,
  "Remove"). A Story shows a neutral **Story** pill in the target line and no caption or comment sections. After a clash,
  the reschedule and schedule forms show the free hours as **chips** (44px, Go Green outline). The Schedule form for a
  single image or video starts with a two-way segmented control: **Reel**/**Post** or **Story**.
- **Item page extras:** a published item's card adds the **24 h** line (views, ×usual, likes, comments, saves,
  shares, reach, then `+12 followers · 85 profile visits` when Instagram reported them); an unpublished one shows the **Caption check** warnings as an amber notice that doesn't block
  (a failing check is listed with the problems and does block).
- **Paused banner:** full-width Stop Red strip under the top bar on every screen while publishing is paused, with a
  Resume link. Top bar and banner stick together as one block.
- **Bottom tab bar:** fixed; five tabs in order of use (Today, Calendar, Queue, Drafts, Stats), each a 24px icon over a
  12px label, about 76px wide. Queue and Drafts carry an amber count badge (items needing approval, open drafts).
- **Approve bar:** on an item that can be approved, a card-coloured bar fixed to the bottom repeats the target and holds
  the full-width Approve button, in the thumb zone. While it shows, the tab bar is hidden so no tab sits next to Approve.
- **Rhythm:** a 4/8/12/16px scale. Rows stack with 8px gaps; more space above a heading (18–22px) than below (8px).
- **Queue:** a two-way segmented control (All / Needs approval, with counts), two filter selects side by side, then
  rows grouped under day headings ("Today · Wed, Oct 21", "Tomorrow", "Fri, Oct 23").
- **Calendar:** month bar with 44px arrow buttons, legend, a 7-column grid with 4px gaps and square cells.
- **Media:** full width, at most 70% of the viewport height; carousels scroll
  sideways with snap points, each slide 85% wide so the next one peeks in.

## Elevation & Depth

Flat. There are no shadows: depth comes from a card-coloured surface on the page colour plus a hairline border, and from
the sticky top bar, paused banner, approve bar and tab bar sitting over the scrolling column. The only rings are state
markers: the amber outline on a calendar dot that needs approval, the 2px green border on today's cell, and the focus
ring.

### Named Rules
**The Flat Room Rule.** Surfaces separate by tone and hairline, never by shadow. If something needs to stand out, give it
a state colour, not a lift.

## Shapes

Soft corners scaled to the size of the thing: 2px on the post-square channel marker, 8px on small elements (calendar cells, the focus ring), 10px on controls
(buttons, inputs, selects, notices, quoted caption text), 12px on containers (rows, cards, details, media), fully rounded
on pills, badges, dots and the check disc. Borders are 1px hairlines (2px only for today's cell). The QR code sits on a
white 10px tile in both themes so it stays scannable.

## Components

### Rows (signature)
One row look for every list of items: Today, Needs you, Next 3 days, Queue and the calendar's day list.
- **Line 1:** the readable title (`short5_lisbon_food` → "Lisbon food"), clipped to one line. No status pill (user,
  2026-10-21): **the row's border is the status**, 1.5px: OK Green for approved, posted and public; Caution Amber for
  needs approval, re-approve and on hold; Stop Red for failed; the hairline for neutral states (goes public, private).
  The status word stays in the row for screen readers (visually hidden) and as its tooltip.
- **Line 2:** the time in the text colour and semibold ("Today · 18:00 GMT+9", or just "18:00 GMT+9" under a day heading; the zone is the workspace's),
  then the channel dot + channel label, @account and the project ("Lisbon (Aug)") in muted text.
- The whole row opens the item in the app (a YouTube row opens its video page); a pressed row darkens 5%. A posted or
  public row also carries a 44px platform icon (Instagram or YouTube, outline style, 26px glyph), vertically centred on
  the row's right; the title and meta stop 56px short of it, so a long title clips before the icon. It opens the
  real post or video: only the
  icon leaves the app, never the row.

### Buttons
Soft, thumb-sized and decisive; 44px minimum height everywhere.
- **Primary:** Go Green fill, bold text (white in light, #052e16 in dark), full width, 14px padding. One per screen:
  the action the screen exists for. Its label names the outcome ("Approve: publish Today 18:00 GMT+9", "Schedule").
- **Default:** card-coloured with a hairline border and body text, for secondary actions.
- **Danger:** card-coloured, Stop Red border and text. **Always asks once, in place** before acting: an inline red-edged
  box ("Pause publishing in this workspace? Nothing goes out until you resume here.") with Cancel and the action.
- **Icon button:** 44px square (calendar month arrows).
- **Disabled:** 50% opacity; a blocked Approve says why ("Fix 2 problems first").

### Pills and badges
- **Pill:** 12px text, 2px × 8px, fully rounded, hairline border, muted text; ok / warn / bad pills take the status colour
  for text and border. Words, capitalised: Approved, Needs approval, Re-approve, On hold, Posted.
- **Tab badge:** amber disc with a 12px bold count, top-right of the tab icon; "9+" above nine.

### Notices
Inline messages in a 10px-cornered box: the status colour for text and border over an 8% tint of it. Used for offline /
stale data ("Offline: showing what was saved at 08:07 GMT+9"), load errors (what failed and what to do), problems that
block approval, and confirmations next to the control that caused them. Offline and load-error notices carry a
**Try again** button. Secondary text on a tinted surface uses the text colour, not muted grey, to keep 4.5:1 contrast.

### Needs you (signature)
The first block on Today. When something waits: an amber "Needs you" heading, overdue items first (their time has
passed, today included) with a one-line explanation, then items to approve or re-approve in the next 7 days, a link to
open drafts, and a line for items on hold ("1 on hold: won't go out until you release it"). When nothing waits, the
block isn't shown at all (the owner's choice: a green "all set" row added nothing); items on hold alone still show it,
with just their line. "On hold" is an amber pill everywhere.

### Cards / Containers
- **Corner Style:** 12px; **Background:** Paper / Night Card; **Border:** 1px hairline; **Padding:** 14px.
- Recent activity on Today is a collapsed disclosure, not a card.

### Inputs / Fields
- Full width, 12px padding (textareas and selects 10px × 12px), 10px corners, hairline border, 16px text. Fields inside
  forms sit on the page colour so they read as wells. Labels are 15px; hints in parentheses are 13px muted.

### Navigation
- **Bottom tab bar:** icon over label; inactive Slate Muted, active Go Green with a bold label, `aria-current="page"`.
  Settings is the gear in the top bar.
- **Back link:** on the item page, a green chevron link named after where you came from ("‹ Today", "‹ Calendar").

### Calendar (signature)
A month grid of square cells. Each cell shows the day number and up to six 7px channel-code dots; a dot that needs
approval gets an amber outline. Today has a 2px Go Green border; the selected day is tinted 18% Go Green. Each cell's
accessible name gives the date, the item count and how many need approval. A legend of dots and short labels (Reel,
Post, Main, Vlogs, Needs approval) sits above the grid.

### Charts
`LineChart` (`src/Chart.tsx`): a time series drawn as inline SVG, no library, on a card.
- **Axes:** dates on the workspace's clock along the bottom ("Oct 30"), one tick per day boundary, at most six and
  fewer on a narrow screen; three or four round values up the side, tabular, compact from 10,000 ("12K"). Gridlines
  are hairlines, axis text is 12px Slate Muted.
- **Lines:** 2px, one series hue each; a missing sample breaks the line (a gap, never a zero). Daily shows what a
  sampled day added since the previous sample; days without a sample are gaps (in the weekly band one point a week). Every point carries
  the series' marker, **circle, square, diamond, triangle, cross** for series 1 to 5, so colour is never the only cue;
  when points sit closer than 7px only the chosen and the last point keep theirs.
- **Legend:** under the chart, each label after its line-and-marker swatch, in 13px muted text.
- **Readout:** a line under the legend for the chosen point ("Oct 30 · Views 1,234 · Trial Reel 980"), the latest one
  until the owner taps, drags or, with the chart focused, uses the arrow keys (Home and End too); a dashed muted guide
  marks it in the plot. Hovering a mouse doesn't move it. A new metric or Total | Daily starts again from the latest.
  Every series is read at the chosen time: in Total, its last sample at or before it (series sampled in different
  runs still read together; "no data" only before a series' first sample), and the chosen markers sit on those
  samples; in Daily, its value for the same day on the workspace's clock. The hidden table reads the same way.
- **Screen readers:** the plot is an image whose name sums each series up ("Views, 12 points, from Oct 20 to Oct 30,
  latest 1,234"); the visually hidden table of every value is what they read. A tap, the end of a drag or a key press
  also announces the chosen point in a polite live region; a drag in progress and hovering never do, so a mouse
  doesn't set off a stream of announcements.
- **Motion:** a line eases to its new shape when the data changes; with reduced motion it just changes.
- The Total | Daily switch and the metric picker are the Queue's segmented control, owned by the page, not the chart.

### Channel page

`#/stats/<platform>/<account>`: the back link, the account's name, the big count (`stat-big`) with its change, then a
period control (**7 days | 30 days | 90 days**, the `segmented` pattern), a card with the followers chart (Total |
Daily) and a card with views per day, both the Charts component (series 1 and 2), then **What brought followers** as
rows (`aud`: the title, `+12` in the ok colour and the share of the period's gain under it), then the **Open on**
button. A YouTube channel without the analytics scope says so in a muted line instead of the rows.

### Item page and approve bar (signature)
**Words first.** The item's name (its display name, editable with the pencil: only what the app, calendar and daily
summary show; the file name, key and approval don't change; "Use the file name" clears it), the target line (channel
dot, channel, @account, **day · time (zone)**), then the caption, self-comment (and the second comment when there is one) and
alt texts verbatim, then the media exactly as it will be published (videos show their first frame); the raw item key sits
in a collapsed "Item key" disclosure at the end. On an item that can be approved, the approve bar repeats the target
above a full-width primary button; errors from approving appear inside the bar, next to the button.
- **Approve only what was seen:** the page may open on a saved copy, so the button reads "Checking for changes…" and stays
  disabled until the server's current version has loaded. Approving sends that version's fingerprint; if the item changed
  in between, the server refuses, the page reloads the new version and says so.
- **After approving**, the bar itself turns into the confirmation (green check disc, "Approved. Goes out … on @…") with
  Done and "Hold it instead…", so the answer appears where the thumb is.
- **Paused:** the bar carries an amber note ("Publishing is paused: approving now keeps it waiting until you resume"),
  the button reads "Approve (held while paused)", and the confirmation says it goes out when you resume. Wording never
  promises a publish time that won't happen.
- **Release date:** an item that hasn't gone out has a "Release date" card: Change date opens date and time fields in
  place; saving says the new time and, for an approved item, that it needs approving again (the approve bar returns).
  A time in an hour the account already uses is refused with the item that holds it.
- **Published:** a card with the Published pill and time, and an "Open on Instagram" button (a default button with
  the external-link icon). Approval problems aren't shown for a published item.
- **Results | Post:** a published Instagram item has a two-way segmented control under the target line. The link
  carries the view (`#/item/<key>/results`, `#/item/<key>/post`; switching replaces it, so Back still leaves the item);
  a bare `#/item/<key>` opens Results when there are 24 h numbers, else Post. **Results** is a card with the 24 h line
  (and the Trial Reel copy's, "×the regular Reel") and the time it was taken, then a card holding the Total | Daily
  switch, the metric picker (six choices, three to a row) and the chart (see **Charts**): the Reel as series 1, its
  Trial Reel copy as series 2 ("Trial Reel: no results yet." while the copy has no sample). Before any sample, one
  muted line: "No results yet: the 24 h numbers arrive a day after publishing." **Post** is the page as it was.
  A YouTube video's page has **Results | Video** the same way once its series has samples (views, likes, comments).
- **Stop just this one:** an approved or held item that hasn't gone out has a card to **Hold this item** (danger, asks
  in place; the approval is kept) or **Release hold** (asks in place, says when it will go out).

### YouTube rows
Rows for YouTube are the videos themselves, read from YouTube: the title without the "Short ·" prefix, "Short" or
"Video" in the meta line, and the video's state as the pill ("Goes public", "Public"). They need no approval here.
The row opens a small video page (channel, Short/Video, day and time, state) with an "Open on YouTube" button. A
scheduled video's page also has a **Release date** card: "Goes public <when>" and **Change date**, which opens a date
and a time in the viewer's zone and **Save new date**. Saving asks for the passkey, then says "Moved to <when>.".

## Do's and Don'ts

### Do:
- **Do** put what needs the owner first (Today's Needs you block, tab badges), and show nothing when nothing does.
- **Do** keep Go Green for approve, the active tab, links, focus and "today" only.
- **Do** give every new colour a light and a dark value, defined as a custom property on `:root`.
- **Do** repeat channel, account, day and time (with the zone) right above any Approve button, and name the outcome on it.
- **Do** use one row component for every list of items, with the channel dot and its label.
- **Do** make every destructive action ask once, in place, next to the button.
- **Do** offer "Hold this item" before reaching for "Pause this workspace".
- **Do** say when data is offline or stale, with the time it was saved.
- **Do** keep tap targets at least 44px high and inputs at 16px text.
- **Do** put new UI text in `src/i18n.ts` and render it through `t()`; the rest of `App.tsx` moves in #144.

### Don't:
- **Don't** add shadows; separate surfaces with tone and a 1px hairline.
- **Don't** add web fonts or a second type family.
- **Don't** use red for waiting, or green, amber or red as a channel colour.
- **Don't** rely on colour alone for a status or channel; pair it with a word, pill or legend. The one exception is
  the row border (the owner's choice): its word is still there for screen readers, and the item page shows it as a pill.
- **Don't** show raw keys, folder names or URLs as titles; show readable names and keep the key as small muted text.
- **Don't** put more than one primary button on a screen.
- **Don't** use emoji as icons or data labels; icons are inline SVG in one stroke weight.
- **Don't** promise a publish time while publishing is paused.
- **Don't** let Approve or Resume act without the passkey, or Approve act on a version the page hasn't shown.
