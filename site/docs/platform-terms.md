# Platform terms

Bongsu posts to your accounts, so it has to behave the way Instagram and YouTube allow. This page says how it does,
and what stays with you.

## Official APIs only

- **Instagram:** Bongsu uses the Instagram API with Instagram Login, with content publishing. This is the default:
  the tokens stay in your instance and every call goes from it to Instagram. You can instead reach Instagram through
  [Composio](instagram-composio.md), the one optional third party and your choice. Then the Instagram connection and
  its tokens live in your Composio account, and the publishing calls go through Composio's service.
- **YouTube:** Bongsu uses the YouTube Data API, to comment on your Shorts and reply to comments. It doesn't upload
  videos. It also reads a video's privacy and release date and can move the release date (a workspace's admins,
  editors and creators in the app, with their passkey, or an agent key only with the `reschedule` scope); that costs
  51 quota units.
- **Your own apps and tokens:** you register the Meta and Google apps and generate the tokens yourself
  ([Instagram](instagram-graph.md), [YouTube](youtube.md)). Nothing goes through a shared account. With the direct
  Instagram route, the tokens stay in your own instance.

## Rate limits

- **Instagram** allows 100 published posts per account per 24 hours through the API; Stories and carousels count as
  one each. Bongsu stays well under it for normal planning.
- **YouTube** gives a Google project 10,000 quota units a day. A comment or a reply costs 50, reading a video's
  comments 1, checking up to 50 videos' privacy 1 and moving a release date 51. See [YouTube](youtube.md#quota).
- **Bongsu's own caps** are lower: each run advances at most `JOBS_PER_TICK` jobs (4 on Cloudflare, 20 on Node) and
  posts at most two Shorts comments. The [configuration](configuration.md#how-many-go-out-at-once) page explains them
  and what you can tune.

## No scraping

Bongsu never automates a browser, calls unofficial endpoints or collects data about other people's accounts. It reads
only what the official APIs return for your own accounts: comments on your own posts, and your own results.

## Your responsibility

You decide what is posted, and you approve each item. You are responsible for the content and for following each
platform's terms:

- [Meta Platform Terms](https://developers.facebook.com/terms/)
- [YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service)
- [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)

The platforms can change their terms and limits. Their pages are the ones that count.
