# Captions and checks

Every Instagram post carries up to four texts. Bongsu shows them exactly as they will be published, checks the caption
before you approve, and includes all of them in the approval, so a changed word needs your approval again.

## The texts

| Text | What it is |
|---|---|
| **Caption** | The post's caption. Required: without one the item can't be approved. |
| **Self-comment** | A comment your account posts on the post. If you leave it empty, Bongsu uses the caption's first line that ends with a question mark, and posts no comment if there is none. |
| **Second comment** | Optional, posted right after the first. Empty means none. |
| **Alt texts** | One line per image, in order, for photos and carousels. Blank lines are dropped, and a leading slide number and tab ("01" then a tab) is removed. More lines than images blocks approval. |

You write them in the app, when you schedule a draft or press **Edit texts** on an item. Agents can set them too. A
Story has no caption or comments. A Shorts comment is one text, approved on the Short's page (see
[YouTube](youtube.md)).

Only the caption is checked, and only for Instagram. The comments and alt texts are published as written.

## What the caption check does

The check runs each time an item is loaded, which includes the moment you approve. It gives each caption a list of results. A **FAIL**
blocks approval: it appears under **Fix before approving:**, the approve button reads **Fix 1 problem first**, and
the CLI's `bongsu approve` refuses too. A **WARN** is advice: it appears in a **Caption check** notice that says it
doesn't block. Everything else passes silently.

The checks, in the order they run:

| Check | Looks at | Result |
|---|---|---|
| LENGTH | The whole caption against Instagram's limit of 2200 characters | FAIL when over |
| FIRST LINE | The text before the first line break | FAIL when blank, or when it starts with `#` or `@`. WARN when longer than the fold, because Instagram cuts it mid-thought |
| CONCRETE HOOK | The first 125 characters (the fold) | WARN when there is no number and no capitalised name. Korean has no capitals, so check it by eye |
| HASHTAGS | Every `#tag` | FAIL when there are more than 5. WARN when any is generic: viral, fyp, explore, explorepage, foryou, foryoupage, trending, instagood, love, follow, like4like, reels, reelsinstagram, viralreels, instadaily |
| TAG PLACEMENT | Whether a hashtag sits before the fold | WARN: the visible lines are better spent on a sentence than a label |
| MENTIONS | Every `@name` | FAIL above 20 |
| LINKS | Web addresses | WARN: links in captions aren't clickable, use the bio |
| ONE ASK | Calls to action: comment, DM, save, share, follow or subscribe, link in bio, or a question | WARN when there are none or more than one. Words in English, Spanish and Korean are recognised |
| EMOJI | Emoji per 100 characters | WARN above 4 |
| INVISIBLE | Zero-width and other invisible format characters | FAIL: strip them |

The messages say what was found, such as "7 tags, over Instagram's cap of 5" or "no number or name before the fold".
The fold is where the feed cuts the caption to "… more", 125 characters by default.

Counts are in characters, not bytes, so an emoji counts as one and Korean and Spanish tags are read as tags.

## An example

This caption, made up for the example:

```
#viral Sunrise run along the river, 12 km before work, and the light was unreal. Which route should I try next? Save this for your weekend. Follow for more #running #fyp
```

gets these results (the app lists only the FAIL and the WARNs):

| Check | Result | Message |
|---|---|---|
| LENGTH | pass | 169 / 2200 characters |
| FIRST LINE | **FAIL** | opens on a hashtag/mention |
| CONCRETE HOOK | pass | 5 numbers or names before the fold |
| HASHTAGS | WARN | 3 tags, generic: #viral #fyp |
| TAG PLACEMENT | WARN | a hashtag sits before the fold |
| ONE ASK | WARN | 3 asks (save, follow/subscribe, question) |

The FAIL stops the approval until the caption starts with a sentence. The warnings are yours to weigh: you may well
keep a generic tag, but three asks in one caption is usually two too many.

## Other things that block approval

The caption check isn't the only gate. The same **Fix before approving:** list also names a missing caption, media that
isn't in the store yet or hasn't finished processing, more alt lines than images, an item with no valid date, and a post
that has already been published.

## Rules for one account

The defaults suit most accounts. In the dashboard, **Accounts** has a **Caption checks** column for each Instagram
account:

- **Hashtags max**: the cap for HASHTAGS (0 to 30). Empty uses 5.
- **First line chars**: the fold (50 to 500). Empty uses 125. FIRST LINE, CONCRETE HOOK and TAG PLACEMENT all use it.
- **Language checks**: turn off for an account whose captions don't suit the guesses behind CONCRETE HOOK and ONE ASK.
  Both are then skipped.

Each field saves when you leave it, and an empty field goes back to the default. A new rule applies from the next time an
item is loaded.

LENGTH, MENTIONS and INVISIBLE don't change: they are Instagram's own limits or plain mistakes.
