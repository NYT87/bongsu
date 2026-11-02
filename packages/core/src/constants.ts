// Tunable limits of the scheduler. Accounts and connections live in the database (accounts.ts).

/** A job missed by more than this waits for you instead of going out late (e.g. in the middle of the night). */
export const CATCH_UP_S = 6 * 3600;
/** Ticks to wait for Instagram to finish a container (5 min each) before giving up. */
export const MAX_POLLS = 24;
/** Lifetime of the signed media links Instagram fetches. */
export const LINK_TTL_S = 6 * 3600;
/** Jobs advanced per tick (each costs a few subrequests; the free plan allows 50 per invocation). */
export const JOBS_PER_TICK = 4;
/** The cron triggers (wrangler.toml): Instagram every 5 minutes; Shorts comments twice an hour, in their own
 *  invocation, so neither run gets near the free plan's 10 ms CPU limit. */
export const CRON_INSTAGRAM = "*/5 * * * *";
export const CRON_SHORTS = "2,32 * * * *";
/** The Drive inbox scan: every 15 minutes, off the other runs' minutes. */
export const CRON_INBOX = "7,22,37,52 * * * *";
/** The least an agent key may leave between now and a YouTube release it sets: YouTube can take a while to pick up a
 *  new time, and an agent shouldn't be able to publish something at once. The owner has no such limit. */
export const RELEASE_LEAD_S = 3600;
export const AUDIT_KEEP_S = 180 * 86400;

/** Metrics sampling (metrics.ts): the first days matter most, so a post is sampled every 6 h for its first 3 days… */
export const METRICS_DENSE_S = 6 * 3600;
export const METRICS_DENSE_UNTIL_S = 3 * 86400;
/** …then daily until it is 30 days old, enough for a daily chart of how it settles… */
export const METRICS_DAILY_S = 86400;
export const METRICS_DAILY_UNTIL_S = 30 * 86400;
/** …then weekly, since old posts move slowly… */
export const METRICS_WEEKLY_S = 7 * 86400;
/** …and never after 90 days: the numbers have stopped changing and every sample costs an API call. */
export const METRICS_STOP_S = 90 * 86400;
/** Samples taken per cron run (each is a provider call; the free plan allows 50 subrequests per invocation). */
export const METRICS_PER_RUN = 4;
/** Attempts per run, failures included: a failing post doesn't use a METRICS_PER_RUN slot, but each attempt is a
 *  subrequest out of the Workers budget the rest of the inbox run shares, so the failures are bounded too. */
export const METRICS_ATTEMPTS_PER_RUN = METRICS_PER_RUN * 2;
/** Stale YouTube upload lists the sampler refreshes per run, the oldest first (each costs a few subrequests and 3
 *  quota units); the others keep their cached list until a later run. */
export const METRICS_REFRESH_PER_RUN = 2;
/** Points a metrics read answers at most (the newest): more than a phone's chart can show apart. */
export const METRICS_MAX_POINTS = 400;

// The account series (account-metrics.ts): one follower count a day per account, a few accounts per inbox run.
export const ACCOUNT_METRICS_S = 24 * 3600;
export const ACCOUNTS_PER_RUN = 4;
// a broken connection costs a call, so the calls a run makes are bounded too (the Workers subrequest budget)
export const ACCOUNTS_ATTEMPTS_PER_RUN = ACCOUNTS_PER_RUN * 2;
// the snapshot backfill's rows a run at most: a long history comes over a few runs, within the query budget
export const ACCOUNT_BACKFILL_PER_RUN = 200;
