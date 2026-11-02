# Brand guidelines

> v1.4 · 2026-10-28 · Status: draft

Who Bongsu is, how it looks and how it talks, for anything made about it: the README, the docs, release notes, a site,
social posts, slides. The product's own interface has its design systems: the phone app's in
[`packages/web/DESIGN.md`](../packages/web/DESIGN.md), the dashboard's in
[`packages/dashboard/DESIGN.md`](../packages/dashboard/DESIGN.md), and every UI colour in
[`packages/web/src/tokens.css`](../packages/web/src/tokens.css). Those files win for the UI; this one doesn't repeat
them, only points at them.

## Quick reference

| Element | Value |
|---|---|
| Name | **Bongsu** (봉수 / 烽燧). Capital B in prose; `bongsu` only in code, package names and URLs. 봉수 sits next to the name in the lockup |
| Tagline | **Light the signal. Reach every channel.** |
| One line | A self-hosted publishing scheduler for creators: you approve, it posts on time. |
| Mark | A beacon fire on mountain peaks: orange line art (Ember) on Icon Navy (`mark.svg`) |
| Wordmark | "Bongsu" in Plus Jakarta Sans ExtraBold, 봉수 in Noto Sans KR Bold (Ember Glow), outlined in the artwork |
| Brand colours | Icon Navy `#131f2a`, Ember `#f7931e` (gradient `#e85d1c` → `#fdab1a`) |
| Product colour | Go Green `#15803d` / `#22c55e` (UI only: approve, go, here) |
| Type | The system UI font for everything set as text; the fonts above only as outlines in the artwork |
| Voice | Plain, calm, exact. The owner is in charge |

## 1. The idea

In Joseon-era Korea, **bongsu** was the kingdom's signal network: beacon towers (*bongsudae*) on mountain peaks,
burning smoke by day and fire by night. When one peak lit its signal, the next caught it and passed it on, so news
crossed the peninsula in hours instead of days.

Bongsu works the same way for a creator's content: **you light the signal once, and it travels to every channel on
schedule.** The approval is the spark: nothing goes out until the owner approves it with a passkey.

The story maps onto the product, and that mapping is the only place the lore is used as vocabulary:

| In the towers | In Bongsu |
|---|---|
| **Bongsudae**, the beacon towers | Connected accounts: Instagram profiles, YouTube channels |
| **Smoke**, a signal getting ready | Planned items: drafts, waiting for approval, approved and queued |
| **Fire**, the signal lit | Published: the post goes out, its comments follow, the owner is notified |
| **Mangru**, the watchtower | Results after 24 hours, new comments, Stats |

### What Bongsu stands for

1. **The owner decides.** Agents and scripts can plan and draft; only the owner's passkey approves or publishes.
2. **On time, without your computer.** It runs on the owner's own Cloudflare account and posts while they sleep.
3. **Yours.** Self-hosted and MIT-licensed, with the owner's own OAuth apps and tokens. The only third party in the
   path is one the owner chooses (Composio, for that way of posting to Instagram).
4. **Honest state.** It says what will happen, what happened and what's stale, plainly.

## 2. Logo

### Files

All in [`docs/assets/brand/`](assets/brand/); the PWA's own sizes are in `packages/web/public/`. Everything except
the original raster and `mark-small.svg` is generated from `mark.svg` by [`scripts/brand/`](../scripts/brand/README.md).

| File | Use |
|---|---|
| `mark.svg` | The mark alone, transparent: the master for any size; place it on navy, black or pale slate |
| `mark-small.svg` | The mark redrawn for 16–32 px (two peaks, the lit point, two rings): browser tabs and the apps' headers (via `favicon.svg`), never above 32 px |
| `lockup.svg` | Mark + "Bongsu" + 봉수, transparent, light lettering: headers on dark grounds (a site, slides) |
| `banner.svg` / `banner.png` | README header (the SVG) and wide slots: the lockup with the tagline on navy (1600×480; PNG at 2×) |
| `social-card.svg` / `social-card.png` | Link previews (GitHub, Open Graph): 1280×640 (PNG at 2×), safe for 2:1 crops |
| `icon-dark.svg`, `icon-dark-512.png` | The mark on a navy rounded square: app icon, avatar, photo grounds |
| `icon-light.svg`, `icon-light-512.png` | The mark on a pale rounded square: light pages where the navy tile would be too heavy |
| `favicon.ico`, `apple-touch-icon-180.png` | Browser tab and home screen |
| `source/icon-dark-512-original.png` | The original raster the mark is traced from; not for use |
| `packages/web/public/favicon.svg`, `favicon.ico` | Browser tab (the SVG where supported, the ICO elsewhere): the small mark; the ICO's 48 and 64 px use the full one |
| `packages/web/public/icon-*.png`, `icon-maskable-*.png`, `apple-touch-icon.png` | The PWA's icons: rounded tile (any), full-bleed navy with the mark in the safe zone (maskable), full-bleed for iOS |

`mark.svg` is **traced** from the original raster icon, with the lit point redrawn as a true circle: good at every size on
screen, but a placeholder until a hand-drawn vector exists (it goes in the same place, and `scripts/brand/` rebuilds
the rest from it).

### The mark

Three peaks, flames rising from the left, signal rings to the right and a lit point above the highest peak: a beacon
lit on the mountains, sending its signal on. Line art in one weight, Ember gradient (deep orange at the bottom left,
gold at the top right).

### Rules

- **Clear space:** at least the height of the lit point's ring (about ¼ of the mark's height) on every side.
- **Sizes:** the full mark above 32 px; at 32 px and below, `mark-small.svg`, drawn by hand for 16–32 px. The banner
  at 320 px wide at least. The small mark: same Ember gradient, thicker lines, no smoke or inner ridges. Never use the small mark above 32 px.
- **Grounds:** Icon Navy (best), black, or a pale slate (`#f1f5f9` or lighter, the light icon). On photos, use the
  navy tile.
- **Don't:** recolour the mark (no green, no white, no single flat orange), rotate it, stretch it, add shadows or
  glows, outline it, put it on a mid-tone or busy ground, or pair the mark with a different wordmark typeface.
- **Name next to the mark:** use `lockup.svg` (with 봉수) where artwork fits; in live text (the app header, a docs
  site's nav), the mark then "Bongsu" in the system font, bold.

## 3. Colour

### Primary Colors

The brand colours: the mark and brand surfaces.

| Name | Hex | Use |
|---|---|---|
| **Icon Navy** | `#131f2a` | The mark's ground, the banner, the PWA theme colour (`manifest.webmanifest`), brand slides and covers |
| **Ember** | `#f7931e` | The mark; accents on navy (a rule, a highlight, a number) |

### Secondary Colors

| Name | Hex | Use |
|---|---|---|
| **Ember Deep** | `#e85d1c` | The gradient's start (bottom left of the mark) |
| **Ember Glow** | `#fdab1a` | The gradient's end, the lit point |
| **Smoke White** | `#f8fafc` | Text and the wordmark on navy |

### Accessibility

Contrast on Icon Navy: Smoke White 16:1, Ember Glow 8.8:1, Ember 7.3:1, Ember Deep 4.8:1. **Ember is never text on
white or light grounds** (2.3:1); on a light page, orange text would need `#c2410c` (5.2:1), and is better avoided.

### Semantic colors (the product UI)

The interface is a quiet slate world with one green signal; see the design systems for the full set and their rules:

- **Go Green** (`#15803d` light / `#22c55e` dark): approve, go, the current place, links, focus. *The One Signal Rule:*
  it never decorates.
- **Caution Amber** for anything waiting on the owner; **Stop Red** for failed, stopped and destructive.
- **Channel code** (Reel Violet, Post Cyan, Main Magenta, Vlogs Blue): channels and post types only.
- Every colour has a light and a dark value (*The Twin Theme Rule*).

**Ember is not a UI colour.** It belongs to the mark and brand surfaces; inside the app it would read as Caution
Amber. Go Green is not a brand colour: it means "approved", so it stays in the product.

## 4. Typography

### Font Stack

```css
--font-heading: 'system-ui', -apple-system, "Segoe UI", Roboto, sans-serif;
--font-body: 'system-ui', -apple-system, "Segoe UI", Roboto, sans-serif;
--font-mono: 'ui-monospace', SFMono-Regular, Menlo, Consolas, monospace;
```

- **The system UI font**, everywhere. No web fonts, in the product or around it, so nothing loads from third parties
  and everything feels native.
- **Mono** for things to copy: commands, keys, ids, URLs.
- **The wordmark**: "Bongsu" in **Plus Jakarta Sans ExtraBold** (800), tracking −1%, Smoke White on navy; **봉수** next
  to it in **Noto Sans KR Bold** (700) at 42% of the name's size, Ember Glow, on the same baseline; the tagline under
  them in Plus Jakarta Sans SemiBold (600), `#cbd5e1`. Both fonts are free (SIL OFL 1.1).
- These fonts exist **only as outlines in the artwork** (`lockup.svg`, `banner`, `social-card`): never loaded as web
  fonts, in the product or the docs. Anything set as live text uses the system font; next to the mark, that's
  "Bongsu" in bold, as the app header does.
- New artwork with the name starts from `lockup.svg` or `scripts/brand/build_artwork.py`, not from retyping it.
- Hierarchy comes from weight and a few close sizes (the scales are in the design systems), never from a second family.

## 5. Voice

Bongsu asks people to publish things they can't take back, with their passkey. So it talks like a careful colleague:
plain, calm and exact, never hyped.

### Brand Personality

| Trait | We are | We are not |
|---|---|---|
| **Plain** | Short sentences, everyday words | Jargon, marketing filler |
| **Exact** | Says what happens, when, where ("Approve: publish Today 18:00 GMT+9") | Vague ("Your content is on its way!") |
| **Calm** | States the problem and the fix | Alarmed, blaming, apologetic |
| **Deferential** | The owner decides; Bongsu proposes and reports | Pushy, "let AI handle it" |

### By context

| Context | How | Example |
|---|---|---|
| Product UI | Names the action and its outcome | "Approve: publish Today 18:00 GMT+9" · "Revoke key" |
| Success | Brief, factual | "Instagram connected: 1 account." |
| Errors | What happened, then what to do | "Add your Meta app first, then connect." |
| Waiting / stale | Honest, with the time | "Offline: showing data from 09:14" |
| Docs | Direct steps, the why in one line | "Paste the client id and secret, then **Save** (the secret is stored encrypted)." |
| README / announcements | The idea, then the facts | "You light the signal once, and it travels to every channel on schedule." |

### Words

- **Use:** approve, publish, schedule, plan, draft, connect, owner, account, channel, passkey, agent.
- **The lore words** (signal, beacon, spark, light) belong to the README, announcements and the tagline, not to
  buttons, labels or errors. In the product, "Approve", not "Light it".
- No exclamation marks in the product; at most one in an announcement.
- Emoji: only in the README's lore table, never in the product or as icons.

### Prohibited Terms

| Avoid |
|---|
| seamless |
| effortless |
| revolutionary |
| game-changer |
| supercharge |
| unleash |
| magic |
| AI-powered |

They're claims or hype; say what Bongsu does instead. For "AI-powered", say what the agent can do: "agents can plan
and draft; only you approve".

### Messaging

- **Tagline:** Light the signal. Reach every channel.
- **One line:** A self-hosted publishing scheduler for creators: you approve, it posts on time.
- **Three proof points:** your passkey approves every post · it posts without your computer on · agents can plan,
  only you publish.
- **For whom:** creators who plan Instagram Reels, posts and YouTube Shorts ahead, run their own tools and want the
  last word on what goes out.

## 6. Imagery

- **Screenshots** are the main image: the real app in light and dark, phone frames for the PWA, browser frames for
  the dashboard. Use demo accounts (`scripts/dev-seed.sh`), never a real creator's data.
- **Illustration**, when needed, follows the mark: Ember line art in one stroke weight on Icon Navy; mountains,
  beacons, smoke, signal rings. No people, no 3D, no gradients beyond the Ember one.
- **Icons in the product** are inline SVG in one stroke weight (design systems), not emoji.

### Base Prompt Template

New brand images made with an image model (a social card, a cover) start from this prompt:

```
Minimal flat line-art logo style, a single continuous stroke weight, orange-to-gold gradient lines
(#e85d1c to #fdab1a) on a deep navy background (#131f2a). Korean beacon fire on mountain peaks (bongsu):
three triangular peaks, stylised flames rising, concentric signal rings, a small glowing point above the
highest peak. Clean, geometric, generous negative space, no text, no shadows, no 3D, no photo realism.
```

Then check against section 2: same stroke weight, Ember gradient only, navy ground, nothing added to the mark. Text
goes on afterwards as outlined lettering (`scripts/brand/build_artwork.py`), never text rendered by the model.

## 7. Checklist

Before anything about Bongsu goes out:

- [ ] The mark is an original file, unaltered, with clear space, on navy, black or pale slate.
- [ ] Brand colours only on brand surfaces; Go Green only for the product's "approve / go".
- [ ] The name from `lockup.svg` / the generated artwork, or the system font in live text; never retyped in another font.
- [ ] Plain, exact words; lore words only in announcements; none of the avoided words.
- [ ] Screenshots use demo data, both themes where it matters.
- [ ] Text contrast at least 4.5:1 (Ember is never text on light grounds).

## Changelog

| Version | Date | Changes |
|---|---|---|
| 1.4 | 2026-10-28 | The small mark in the apps' headers and above the sign-in cards; the product is named "Bongsu" everywhere (not "Bongsu scheduler") |
| 1.3 | 2026-10-28 | `mark-small.svg`, the mark redrawn for 16–32 px; `favicon.svg` and the ICO's 16/32 px use it |
| 1.2 | 2026-10-28 | Every icon rebuilt from `mark.svg` (PWA, favicons, touch icons, brand tiles); `favicon.svg`, `icon-light.svg`; the README uses `banner.svg`; PNGs at 2× |
| 1.1 | 2026-10-28 | Wordmark fonts chosen (Plus Jakarta Sans, Noto Sans KR); 봉수 in the lockup; traced `mark.svg`, `icon-dark.svg`, `lockup.svg`; new banner and social card; "Yours" names Composio |
| 1.0 | 2026-10-28 | First guidelines, from the README story, the mark, `tokens.css` and the two DESIGN.md files |
