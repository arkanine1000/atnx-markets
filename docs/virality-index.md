# VI (Virality Index) pipeline

The score is total attention. Each source's raw reading is converted to YouTube-view-equivalents a week (`CALIBRATION` in `lib/vi/score.ts`: a fitted worth per unit, with passive views entering sub-linearly), the terms are summed over the sources that answered, and one log maps the total to the level: about 391 points per tenfold, floor 0, no ceiling. 1000 is where the giants sit (Google, Halloween in season), not the top of the scale. Momentum, each source's current window against the market's own 7–14 day baseline, scales the level from 0.65x at a collapse to 1.35x at a 10x spike. Six tiers label the result (Minimal, Moderate, Trending, Viral, Highly viral, Mega-viral from 851). The written score is smoothed with a two-hour half-life, and the liquidation trigger fires on every write, so a method change lands through the smoothing rather than a ramp (`RAMP_MS` is 0 while the platform is unpublished). Nothing read off a screenshot feeds the score, so resubmitting the same image cannot move it. A source that answers "unknown" is left out of the sum; a known zero counts as an answer; a market whose sources all answer unknown keeps its last value.

| Source | Cadence | Reading |
| --- | --- | --- |
| Google Trends | every 5 min | Ratio to a benchmark keyword (`VI_TRENDS_BENCHMARK`) so terms compare across markets; unofficial scraper, quantises small terms. Asks for the subject's **topic** rather than the words when the Wikipedia reading found its id on Wikidata (the Freebase id for entities known before 2016, the Google Knowledge Graph id for newer ones): Google's own disambiguation, so "Cars" the film reads 0.5x the benchmark instead of 8x for the vehicles. A topic Trends does not know reads nothing and falls back to the words in the same pass, remembered as `topic_dead` |
| Bluesky | every 5 min | Posts a day; needs `BLUESKY_IDENTIFIER` and `BLUESKY_APP_PASSWORD` |
| Wikipedia | hourly | Daily pageviews (14-day median, two-day lag). A section redirect under the market's own name counts on the redirect's own views. Also the guard that lets a one-word alias into the other searches, the reading that says whether the bare name is the subject (a qualified match means it is not), and the source of the Trends topic id. For memes, no article reads as unknown rather than zero, and a one-word meme name it has never heard of is taken as coined ("Nosfercatu"), so Trends and Bluesky count for it where a common word's would be dropped |
| GDELT | hourly | Share of the day's news stories naming the market, from the Global Knowledge Graph on BigQuery (syndicated copies merged); not the `memes` category; needs `GCP_SA_KEY_B64` |
| YouTube | views hourly, search every 1–3 days | Views in the last 7 days on the videos a name search found, after a title relevance filter (Gemini Flash-Lite, `YT_TITLE_FILTER=0` turns it off); or the verified own channel's views with Shorts discounted, whichever is larger. Needs `YOUTUBE_API_KEY`; search.list has its own bucket of 100 calls a day, so discovery is rationed per market |
| Hacker News | hourly | Hits a day (Algolia); tech and crypto only |
| X | every 3 h per market | Impressions a day on posts about the name: one hour of posts, read two hours later once views have matured, the day's median over reads; or the verified own account's posts' impressions times the own-channel factor, whichever is larger. twitterapi.io, paid per tweet, `X_DAILY_TWEET_BUDGET` per UTC day |
| TikTok | every 3 h per market | Views a day gained under the market's hashtag (Apify hashtag stats; the tag is mapped from the name and aliases, taken once it has 100 videos or 100k views, and re-checked weekly), a robust trend with a spike gate so vendor noise does not read as a spike; `TIKTOK_DAILY_HASHTAG_BUDGET`, `APIFY_USD_PER_HASHTAG` for the spend estimate |
| Captured posts | hourly through a market's first day, every 3 h after | Views a day on the posts the market was captured from (TikTok, Instagram video, X; the newest five), from `captures.source_url`: on a post's first read its lifetime views over its age, a measured average since the platforms return the creation time, then the growth between reads; momentum against the rate a day earlier. The one source that sees a meme living as a single viral post rather than a tag or a search term. TikTok and Instagram through Apify, X through twitterapi.io; `POST_DAILY_READ_BUDGET` reads a day |
| DexScreener | hourly | Crypto tokens only; read but not calibrated, so not in the sum |

**Own accounts.** Every source above counts other people talking about a name; a creator's audience is the views on their own uploads, which rarely carry it. `market_handles` holds a market's YouTube channel and X account, resolved automatically and read only once verified; the admin dashboard's Handles tab reviews the rest.

**Scoring state.** A new market is `scoring` (shown as "Scoring…", no trading) until its first full pass over every source, right after the commit or on the next hourly run, at most two hours, then `live`. The go-live write is the reading itself; smoothing starts from there, so nobody sees a number climbing from zero.

**A new market's first day.** The level is a log of the summed attention, so a source that has not answered yet understates the level by its eventual share, and a source without a momentum yet is left out of the momentum average rather than counted as flat.

| After the commit | What lands |
| --- | --- |
| 15–30 s | Wikipedia first, on its own, so the search phrases and the Trends topic are settled before anything else reads; then the first full pass, and the market goes live at that reading. Trends, Bluesky and Wikipedia arrive with level and momentum (their APIs return history); YouTube with its 7-day search views; X with one hour of posts through the Jev filter; GDELT with today's news count; Hacker News for tech and crypto. TikTok gets its hashtag mapped, from the aliases when the bare name is an everyday word, no level yet. The captured post itself is read, so its lifetime average is in the go-live total. The description is written in the same pass, and the YouTube channel resolver runs for people and brands. |
| next hourly run | GDELT backfills 14 days, so its momentum works. A verified own channel is read for the first time. The X account resolver runs a few markets per hour. |
| ~1 h | TikTok's level, from its second read of the hashtag: a young market's mapped tag is read again by whichever pass runs first once an hour has passed, instead of waiting for the three-hour slot. |
| ~4 h | YouTube momentum (three prior hourly deltas). |
| ~12 h | X momentum (four prior three-hourly reads). |
| ~36 h | TikTok momentum: four reads in the last 12 h against four in the same 12 h a day earlier. |

For a person or brand the go-live level is usually within a few points of where it settles. For a meme, TikTok can be half the total, so the level sits about a hundred points low for the first hour. The gap that can matter is a creator whose name nobody writes: the market reads near zero until the own channel or account is verified, automatically when the capture evidence and Wikidata agree, otherwise after the admin decides on the Handles tab.

**Measured, 2026-10-02** (22 markets created since 2026-09-27 with hourly
snapshots, 9 of them at least a day old; medians, hours after creation):

| What | When |
| --- | --- |
| Every source that will ever answer has answered | 3.3 h over the nine day-old markets; 1.4 to 2.5 h for markets created after the early TikTok read and the captured-post source shipped (TikTok's second read at ~1.4 h, the post pair at ~2.5 h) |
| YouTube momentum | 4 h |
| X momentum | 12.5 h (four three-hourly reads) |
| TikTok momentum | 33 h (twelve hours against the same hours a day earlier) |
| Raw score within 10 % of its day-one value, and staying there | 17 h |

The go-live score sat a median 44 points under the day-one score, lower
on six of the nine markets and higher on one: the sources that land later
add attention, and the level is a log of the sum. The three outliers
where X answered 15 to 25 hours in all fall at 16:00 to 17:00 UTC on
2026-10-02, when the twitterapi.io credit was topped up after running
out, not a property of the pipeline. Re-measure with `vi_component_history`
once a week of post-source markets exists.

**Records.** `vi_history` keeps the smoothed and raw score per write, `vi_samples` the per-source raw series the momentum needs (YouTube view totals, X and TikTok reads, own-account reads, the Jev shadow rows), `vi_component_history` a snapshot of each market's breakdown per hourly pass for sixty days, so a calibration can be refitted on any past hour.

**Jev.** TypeSafe AI's Jev answers typed yes/no questions on the gateway with a probability. Since 2026-09-29 it filters X posts for the score (`JEV_TWEETS=on`): only posts it keeps at `JEV_TWEET_KEEP_AT` (default 0.4) count toward the rate and views, a capped read's rate scales by the kept share, and a filtered read compares itself only with filtered samples for the day's median and the momentum baseline. Media-only posts are not judged and stay in; a failed call keeps every post. The threshold came from an adjudication of the shadow data by a stronger model (`npm run jev:adjudicate`): at 0.4 no post about the subject was dropped on 294 live posts. On YouTube titles Jev lost to Gemini (right on 25 % of their disagreements), so `JEV_TITLES` is off in production and Gemini stays the title judge. The admission gate (`JEV_GATE`) stays in shadow: too few creations a day to judge. Each flag is `off | shadow | on`.

**Sources in use and to add.** Every aggregator the VI reads, what each is used for and what it costs, and the Apify actors and free APIs worth adding next, by category: [vi-sources.md](vi-sources.md).

**Tuning.** `VI_CALIBRATION_JSON` overrides any calibration constant without a deploy. `npm run vi:calibrate` fits the constants against the hand anchors in `scripts/vi-anchors.ts` or a saved snapshot; `vi:compare` measures a change against the hour before it; `vi:report`, `vi:audit` and `vi:jumps` are the read-only checks (see the app README). `npm run test:vi` runs the pure-math tests.
