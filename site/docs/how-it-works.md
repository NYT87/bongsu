# How it works

## Approval

When you approve an item, Bongsu records a hash of its texts and of each media file. Just before publishing it checks
them again: if a text or a file changed, even a file replaced under the same name, the post waits and you approve it
again. Agents can propose and edit, but approving and resuming are only yours, by passkey.

## The schedule

Bongsu checks the plan every few minutes. When an approved item is due, it starts a job for it. A job missed by more
than 6 hours, for example because the instance was down, doesn't go out late: it waits for you to decide.

## A post goes out in steps

A job is a short series of steps: check the approval, hand the media to Instagram, wait until Instagram has processed
it, publish, then post the comments. Each run does a few steps and saves where it got to, so a restart or a platform
limit only delays the post: the next run carries on without publishing twice.

## Drafts and the Drive inbox

A file dropped in `UPLOADS/inbox/<project>/` on Drive becomes a draft, with the text of an optional `<name>.txt` as its
caption. Agents can propose drafts too. Nothing in Drafts is published until you schedule it and approve it. A day
after a post goes out, its media moves to `UPLOADS/_posted/`. Bongsu moves media and never deletes it.

## Notifications

Bongsu tells you when something needs you: a post waiting for approval or past its window, a failed step, a connection
that needs attention. Notifications go to the installed app as pushes and, optionally, to a webhook. A daily digest,
at the hour you choose, lists today's items and their status, what still needs approval in the next 3 days, and what failed.

## Results and comments

After a post goes out, Bongsu samples its numbers (views, reach, likes, comments, saves, shares, and the followers
and profile visits it brought, where Instagram reports them) into a series:
every 6 hours for the first 3 days, then daily until day 30, then weekly until day 90, and then no more (stories
aren't sampled). A day after publishing you get a notification with its 24 h numbers, the sample nearest 24 hours
after it went out, compared with the account's usual views. A sample that fails is tried again one interval later, so
a broken account or a deleted post doesn't hold up the others. The Daily chart shows what a sampled day added since
the previous sample; days without a sample are gaps (in the weekly band, one point a week). Public YouTube uploads are sampled the same way, through YouTube's `videos.list` (views,
likes and comments) and, for a channel connected with the analytics scope, the Analytics API (the subscribers each
video brought). The app's Results view charts the series; see [The phone app](the-app.md#results). Each account's
follower count is sampled once a day too, for the Stats page and each account's page
([Stats and the channel page](the-app.md#stats-and-the-channel-page)). New comments show up in the app's inbox, and
you reply from there.

To run your own instance, see the guides to [deploying on Cloudflare](deploy-cloudflare.md) and
[self-hosting](self-hosting.md).
