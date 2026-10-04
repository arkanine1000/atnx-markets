# VI sources: what is read today, and what to add next

As of 2026-10-04. Prices are Apify store prices on that day and move; the
account moved from the Free plan ($10 a month, $5.95 used in September) to
the Starter plan on 2026-10-04. The test for any new
source is the one from the September research: absolute counts for an
arbitrary phrase, a window long enough for a baseline, and a price that
scales with markets rather than posts.

## In use

| Aggregator | Access | Role in the pipeline | Cost and limits |
| --- | --- | --- | --- |
| Google Trends | `google-trends-api`, an unofficial scraper | Fast VI source every 5 min: ratio to the "sudoku" benchmark, by Wikidata topic id when the Wikipedia reading found one. Also the second look at rejections. | Free; flaky under rate limits; quantises small terms |
| Bluesky | Public PDS search with an app password | Fast VI source: posts a day naming the phrase. Also the second look. | Free; never returns a busy term's full day |
| Wikipedia and Wikidata | OpenSearch, page query, pageviews REST, summaries, page images, Wikidata properties | Hourly VI source (14-day median pageviews), the generic-term guard, alias vouching, the Trends topic id, X handle resolution, descriptions, thumbnails, the review step's name alternates, the second look | Free |
| GDELT GKG on BigQuery | Service account, sandbox tier | Hourly share of news articles, backfilled 14 days. Not asked for memes. | Free within 1 TiB a month |
| YouTube Data API | API key | Hourly views on a daily name search, creator channel reach with the Shorts discount, channel resolution, the second look | Free; search.list has its own bucket of 100 calls a day |
| Hacker News Algolia | Public | Hourly hits a day; tech and crypto only | Free |
| DexScreener | Public | Hourly token reads, crypto only; read but not calibrated, so not scored | Free |
| twitterapi.io | API key | X talk every 3 h as matured impressions through the Jev post filter, own-account reach, handle lookup, captured-post reads | $0.00015 a tweet; `X_DAILY_TWEET_BUDGET` (10k a day in production) |
| Apify, four actors | Token | `funny_ground/tiktok-hashtag-stats` every 3 h per market and in the second look; `clockworks/tiktok-scraper` for the week's posts naming the phrase, searched every two days per market and re-read every 6 h (`lib/vi/tiktok-search.ts`, since 2026-10-04); `apidojo/tiktok-scraper` and `apify/instagram-post-scraper` for the captured posts themselves (`lib/vi/post.ts`) | $0.0025, $0.0003 and $0.0017 to $0.0027 a result; `TIKTOK_DAILY_HASHTAG_BUDGET`, `POST_DAILY_READ_BUDGET` |
| Apify, `harshmaur/reddit-scraper` | Token | The week's newest Reddit posts naming the phrase (quoted), once a day per market: upvotes plus comments a day as the reading, today's post rate against the week's average as the momentum (`lib/vi/reddit.ts`, since 2026-10-04); memes, tech, gaming, politics | $0.0018 a result plus $0.02 a run; `REDDIT_DAILY_BUDGET` |
| TikTok oEmbed | Public | Link previews, short-link resolution, the review step's link check | Free |
| Know Your Meme | Page fetches | Thumbnails, descriptions, the second look | Free |
| Vercel AI Gateway | OIDC on Vercel, a key locally | Gemini Flash for vision and the YouTube title filter, Flash-Lite for text, Cohere Embed v4 for embeddings, Jev for X post relevance. The model layer, not an aggregator. | Per token |

**Coverage by category.** Memes and people have no name-based Instagram
source; TikTok keyword search (2026-10-04) now sees a meme that lives as
untagged posts nobody captured. Music has no Spotify
or chart signal, gaming no Steam or Twitch, film and TV nothing beyond
the general sources, sports nothing specific. Tech, crypto and politics
are covered by what exists.

## Apify actors worth building on

Ranked by how much VI accuracy each buys per dollar.

| Rank | Actor | What it adds | Price | Categories |
| --- | --- | --- | --- | --- |
| 1, built 2026-10-04 | `clockworks/tiktok-scraper` with `searchQueries`, the video section and the past-week filter (`lib/vi/tiktok-search.ts`) | TikTok keyword search: posts naming the phrase, their plays and timestamps. Views a day for a phrase rather than a tag, which is what Nosfercatu and Chemtrails needed. | $0.0037 a result, or $0.0003 | memes, people, music, film_tv, gaming |
| 2 | `apify/instagram-hashtag-scraper`, `apify/instagram-hashtag-analytics-scraper` | Instagram's first name-based reading: recent posts under a tag with plays and timestamps, possibly the tag's post count directly. Probe the count's refresh rate for a day before building, as was done for TikTok. | $0.0026 and $0.0023 a result | memes, people, music |
| 3, built 2026-10-04 | `harshmaur/reddit-scraper` (half the price of trudax, rows name their search term, 8 s a run against 60) | Reddit search sorted new over a time window, with upvotes. The first undone item of the 2026-09-26 brainstorm, now in the same price band as the ScrapeCreators plan and in the actor pattern already run. | $0.004 or $0.002 a result | memes, tech, gaming, politics |
| 4 | `clockworks/tiktok-profile-scraper` | TikTok profile mode for creators, the half of channel mode deferred on budget: plays on their own uploads, keyed on the resolved handle | $0.003 a result | people |
| 5 | `apify/instagram-profile-scraper` | Creator reach on Instagram | $0.0026 a profile | people, music |
| 6 | `apidojo/youtube-scraper` | The agreed fallback when the 100 daily YouTube searches run out | $0.0005 a video | all |
| 7 | `logical_scrapers/threads-post-scraper` | Threads posts, if Meta's free keyword search is not approved | $0.0025 a result | memes, people |

**Not from Apify, because a free official API is better:** Steam's Web API
gives exact concurrent players for nothing (`jungle_synthesizer/
steam-charts-player-count-topsellers-scraper` at $0.0005 a record is the
fallback); Twitch Helix gives live viewers with a free client id; the
Spotify Web API gives artist popularity and followers with client
credentials (`beatanalytics/spotify-play-count-scraper` at $0.004 a URL
only matters for song-level plays). These are the only way the gaming and
music categories ever read anything beyond YouTube.

**One to be careful with:** `apify/google-trends-scraper` at $0.003 a
result is the maintained replacement if the unofficial scraper dies, but
at the five-minute cadence it would cost about $60 a day across 70
markets. A slow-path fallback only.

## Cost and order

Rough monthly spend at 70 markets, using the YouTube pattern (one
discovery a day, cheap re-reads after), restricted to the categories each
source covers:

| Addition | Cadence | About |
| --- | --- | --- |
| TikTok keyword search, ~45 eligible markets | daily search, 3-hourly post re-reads via `apidojo/tiktok-scraper` | $35 to $50 |
| Instagram hashtag reads, ~45 markets | daily | $100 at 20 results, $35 at 7 |
| Reddit search, ~55 markets | once a day, 10 posts a phrase, quoted | about $1 a day at the cap, less for quiet phrases |
| TikTok and Instagram profiles, creators only | every 6 h | under $10 |

None of it fits the free ceiling; the Starter plan (2026-10-04, Bronze
tier prices) opened it. TikTok keyword search went first, since it closes
the gap behind both of the day's zero-score cases and reuses the post-read
code; Reddit next, cheap and four categories; Instagram hashtags third,
after the refresh-rate probe. Steam, Twitch and Spotify are free whenever someone
has an afternoon.

Dead ends already researched (2026-09-24), not worth repeating: the
TikTok Research API, Instagram Graph hashtag search, Reddit's self-service
API without approval, Tenor, Giphy, and the enterprise listeners
(Exploding Topics, Glimpse, EnsembleData, Brandwatch, Meltwater).
