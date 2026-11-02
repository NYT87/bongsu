# Dashboard design

The dashboard (`/dashboard`) is where an instance is set up and managed: sign-up, connections, accounts, devices,
agent keys, the audit log. It's used rarely, on a laptop, with care; the PWA is used daily, on a phone, quickly. Both
are one product, so the dashboard **inherits the PWA's design system** (`packages/web/DESIGN.md`): the same tokens
(`packages/web/src/tokens.css`), the same named rules, the same type. This file only adds what a desktop admin app
needs.

Brand (name, mark, Ember and Icon Navy, voice) is in [`docs/brand-guidelines.md`](../../docs/brand-guidelines.md).

Direction (from the ui-ux-pro-max design pass, 2026-10-28): *Minimalism & Swiss style*, the fit for admin tools and
dashboards: clean, functional, grid-based, high contrast, essential; subtle motion; standard-dense spacing. Its
palette (slate primary, one green accent, slate neutrals) is the PWA's already, so no new colours. Its suggestions
not taken: slate primary buttons (the PWA's primary is Go Green), a dark-mode default (the PWA follows the system, so does the dashboard) and web fonts (system fonts:
nothing loaded from third parties, as the PWA).

## Rules carried over from the PWA

- **The One Signal Rule.** Go Green is the primary action and "connected / done / here", as in the PWA (primary
  buttons, the current section, links, the focus ring); it never decorates.
- **The Waiting Is Amber Rule.** Expiring connections, a pending setup step, dry-run mode: Caution Amber.
- Red only for broken, failed, revoked and destructive actions.
- **The Twin Theme Rule**: every colour from `tokens.css`, light and dark.
- **The Channel Code Rule**: platform dots and names come from `/app-api/platforms`, as in the PWA.

## Layout

- **Sidebar + content**, desktop first. A 232px sidebar with the instance name, the sections and, at the bottom, the
  signed-in user (name and email, cut short with an ellipsis) with a sign-out icon button on its right; the content column is at most 960px wide, 32px from the sidebar. Under 900px the sidebar becomes a top bar with a
  menu button (no horizontal scroll at 375px).
- Sections, in this order: **Overview** · **Connections** · **OAuth apps** · **Accounts** · **Videos** · **Devices & passkeys** · **Keys & tokens** ·
  **Audit** · **Settings**. One level only; deep links for each (`/dashboard/connections`, …).
- A **dry-run banner** (amber, full width above the content) while `DRY_RUN` is on: "Dry run: nothing is published".
- Signed-out pages (bootstrap, sign-in, add-a-phone landing) are a single centred card, 440px wide, with a
  full-width primary button and the secondary link centred under it.

## Spacing and type

- Spacing scale 4 · 8 · 12 · 16 · 24 · 32 · 48 (standard density: tables 12px row padding, cards 24px).
- Type as the PWA (system UI, 16px body, line height 1.45): page title 24/700, section title 18/700, table header
  13/600 Slate Muted, body 15–16.
- **Mono** (`ui-monospace, SFMono-Regular, Menlo, monospace`, 14px) for things to copy or compare: agent keys, setup
  codes, recovery codes, ids, redirect URLs, scopes.

## Components

- **Card**: Paper, Hairline border, 12px radius, 24px padding; a title row (title left, actions right).
- **Table**: for lists (connections, accounts, passkeys, keys, audit); under 640px each row stacks into label: value
  lines. Header row Slate Muted 13px; rows separated by
  Hairline; the first column is the name (bold); status in a pill; row actions as text buttons on the right, never
  icon-only; a destructive one (Remove, Revoke) is Slate Muted and turns red on hover or focus, and its confirmation
  dialog carries the red.
- **Status pill**: a capitalised word: "Connected" green text on a faint green ground, "Expiring" amber, "Broken" /
  "Revoked" red, "Disabled" Slate Muted. Always a word, never colour alone.
- **Buttons**: primary Go Green (one per view), secondary Paper with Hairline border, danger red text (filled red only
  inside a confirmation). 40px tall (44px on touch screens and phones), 8px radius; disabled at 50% opacity with
  `aria-disabled`; a disabled action still answers a click with the reason.
- **Forms**: a visible label above every field, helper text below it, the error below the field in red and wired with
  `aria-describedby` (never only a summary at the top); no placeholder-only fields.
- **Stepper** (setup wizard): "Step 2 of 6 · Media store" plus the step names as a list on the left; steps can be
  skipped and revisited; finished steps show a check and a short summary.
- **Secret shown once** (agent keys, recovery codes; general practice, no database match in the design pass): a
  bordered panel with the value in mono, a **Copy** button that changes to "Copied" (announced with `aria-live`), the
  line "This won't be shown again", and **Done** to close; closing without copying asks to confirm.
- **Confirmation dialog** for anything destructive or irreversible, naming the object: "Revoke the key
  'claude-laptop'? Agents using it stop working." The confirm button repeats the verb ("Revoke key").
- **QR panel** (add a phone): the QR code on a white tile (`--qr-tile`), the one-time code in mono under it, the time
  left, and "Waiting for the phone…" until it's used.
- **Empty states** say what to do next and link to it ("No connections yet. Connect Instagram").

## Sign-in and passkeys

- Passkey first. Sign-in asks for the email (`autocomplete="username webauthn"`, paste allowed) and then the passkey;
  no passwords, no one-time codes to retype.
- Bootstrap: the setup token (paste allowed, mono), then name and email, then the passkey, then the recovery codes
  (download or copy, then "I've saved them").
- Actions that change who can do what (connect, create a key, add a phone or passkey, remove anything) ask for a
  fresh passkey check if the last one is older than 10 minutes.

## Motion and accessibility

- Motion is subtle: 150–200ms fades and colour changes; no slides or parallax; everything respects
  `prefers-reduced-motion`.
- Contrast 4.5:1 for text in both themes; visible focus rings (2px Go Green outline, 2px offset, as the PWA); every action reachable by
  keyboard in reading order; dialogs trap focus and return it; icon buttons have labels.
- Checked before delivery: 375 / 768 / 1024 / 1440px, light and dark, keyboard only, reduced motion.
