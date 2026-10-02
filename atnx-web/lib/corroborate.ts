// The second look at a rejection. The model decides admission in one
// shot from its own knowledge, so a meme it has not seen ("Nosfercatu",
// a sleeping cat captioned as the vampire, 3M likes on the screen) is
// rejected as not cultural content with high confidence. When that
// happens and the model could still name the phrase (tentative_name),
// the phrase is checked against sources the VI pipeline already reads,
// in parallel and under one deadline:
//
//   Know Your Meme   an entry page titled with the name (lib/thumbnails.ts)
//   Wikipedia        an article titled with the name (lib/vi/wikipedia.ts)
//   YouTube          the week's videos naming it, and their views
//   TikTok           the hashtag's videos and views (lib/vi/tiktok.ts)
//   Bluesky          posts naming it in the last day (lib/vi/bluesky.ts)
//   Google Trends    search interest against the benchmark
//
// The content that trips the first look mostly lives on TikTok and
// Instagram; measured on "Nosfercatu" (2026-10-02), only TikTok knew it
// (9 videos, 9.2M views) while the reference and search sources read
// nothing.
//
// Anything found is put to the model a second time, with the image, as
// evidence (lib/vlm.ts buildUserText); nothing found, and the rejection
// stands without a second model call. Both outcomes are recorded on the
// analysis (SubmissionAnalysis.corroboration) and so in the audit row.
// ADMISSION_SECOND_LOOK=off turns it off.
import type { SubmissionAnalysis } from './vlm';
import { isGenericPhrase } from './blocklist';
import { knowYourMemeEntry } from './thumbnails';
import { resolveArticleTitle } from './vi/wikipedia';
import { searchPhrase } from './vi/youtube';
import { countHashtags } from './vi/tiktok';
import { fetchBlueskySignal } from './vi/bluesky';
import { fetchTrendsSignal } from './vi/trends';

// Every source is given this long; a slow one reads as nothing.
const LOOKUP_TIMEOUT_MS = Number(process.env.SECOND_LOOK_TIMEOUT_MS ?? 8_000);
// Fewer YouTube views than this over the week is not circulation.
const YOUTUBE_MIN_VIEWS = 10_000;
// A TikTok hashtag with fewer views than this is not circulation either.
const TIKTOK_MIN_VIEWS = 100_000;
// Posts naming the phrase on Bluesky in the last day.
const BLUESKY_MIN_POSTS = 5;

export type EvidenceSource = 'knowyourmeme' | 'wikipedia' | 'youtube' | 'tiktok' | 'bluesky' | 'trends';

export interface Evidence {
  source: EvidenceSource;
  // One line, as the model sees it.
  line: string;
}

export interface Corroboration {
  term: string;
  evidence: Evidence[];
  // Sources that did not answer in time or failed.
  timed_out: EvidenceSource[];
  latency_ms: number;
  // Whether the second model call admitted what the first rejected.
  // False when nothing was found and no second call was made.
  flipped: boolean;
  first_pass: { reject_reason: string | null; confidence: string; tentative_name: string | null };
}

export function secondLookEnabled(): boolean {
  return (process.env.ADMISSION_SECOND_LOOK ?? 'on').toLowerCase() !== 'off';
}

// The phrase worth checking, or null: only a not_cultural_content reject
// (a policy reject is final, an unreadable one has nothing to check), and
// only a tentative name that is not a calendar phrase. A common word
// ("cats") passes here; the prompt keeps the generic-phrase rule on the
// second call and the proposal guard applies after it. Pure.
export function corroborationTerm(s: Pick<SubmissionAnalysis, 'admit' | 'reject_reason' | 'tentative_name'>): string | null {
  if (s.admit || s.reject_reason !== 'not_cultural_content') return null;
  const term = (s.tentative_name ?? '').replace(/^#/, '').replace(/[!?.]+$/, '').trim();
  if (term.length < 3 || term.length > 80) return null;
  if (isGenericPhrase(term)) return null;
  return term;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve('timeout');
      }
    );
  });
}

// Pure: the evidence lines from each source's answer, or null when the
// answer says nothing.
export function knowYourMemeLine(term: string, found: { description?: string | null } | null): Evidence | null {
  if (!found) return null;
  const desc = found.description?.trim();
  return { source: 'knowyourmeme', line: `Know Your Meme has an entry for "${term}"${desc ? `: ${desc}` : '.'}` };
}

export function wikipediaLine(term: string, title: string | null): Evidence | null {
  return title ? { source: 'wikipedia', line: `Wikipedia has an article titled "${title}".` } : null;
}

export function youtubeLine(term: string, found: { videos: number; views: number; titles: string[] } | null): Evidence | null {
  if (!found || found.videos === 0 || found.views < YOUTUBE_MIN_VIEWS) return null;
  const titles = found.titles.filter(Boolean).map((t) => `"${t.slice(0, 80)}"`).join(', ');
  return {
    source: 'youtube',
    line: `YouTube has ${found.videos} videos from the last week naming "${term}" with ${found.views.toLocaleString('en-US')} views between them${titles ? `, such as ${titles}` : ''}.`,
  };
}

export function tiktokLine(term: string, found: { hashtag: string; video_count: number; view_count: number | null } | null): Evidence | null {
  if (!found || (found.view_count ?? 0) < TIKTOK_MIN_VIEWS) return null;
  return {
    source: 'tiktok',
    line: `TikTok's #${found.hashtag} has ${found.video_count.toLocaleString('en-US')} videos with ${(found.view_count ?? 0).toLocaleString('en-US')} views.`,
  };
}

export function blueskyLine(term: string, signal: { level: number | null; meta?: Record<string, unknown> } | null): Evidence | null {
  const posts = Number(signal?.meta?.posts_24h ?? 0);
  if (!signal || signal.level === null || posts < BLUESKY_MIN_POSTS) return null;
  return { source: 'bluesky', line: `Bluesky has ${posts.toLocaleString('en-US')} posts naming "${term}" in the last day.` };
}

export function trendsLine(term: string, signal: { level: number | null; meta?: Record<string, unknown> } | null): Evidence | null {
  if (!signal || signal.level === null) return null;
  const ratio = Number(signal.meta?.ratio_to_benchmark ?? 0);
  const bench = String(signal.meta?.benchmark ?? 'the benchmark');
  return {
    source: 'trends',
    line: `Google Trends shows searches for "${term}" over the last week at ${Math.round(ratio * 100)}% of searches for "${bench}".`,
  };
}

// The sources, asked together. Never throws.
export async function gatherEvidence(term: string): Promise<{ evidence: Evidence[]; timed_out: EvidenceSource[] }> {
  const lookups: { source: EvidenceSource; run: () => Promise<Evidence | null> }[] = [
    {
      source: 'knowyourmeme',
      run: async () => knowYourMemeLine(term, await knowYourMemeEntry({ id: '', entity_name: term, entity_type: null, vi_components: null, sourceUrls: [] })),
    },
    { source: 'wikipedia', run: async () => wikipediaLine(term, await resolveArticleTitle(term)) },
    { source: 'youtube', run: async () => youtubeLine(term, await searchPhrase(term)) },
    { source: 'tiktok', run: async () => tiktokLine(term, await countHashtags(term)) },
    { source: 'bluesky', run: async () => blueskyLine(term, await fetchBlueskySignal(term)) },
    { source: 'trends', run: async () => trendsLine(term, await fetchTrendsSignal(term)) },
  ];
  const answers = await Promise.all(lookups.map((l) => withTimeout(l.run(), LOOKUP_TIMEOUT_MS)));
  const evidence: Evidence[] = [];
  const timed_out: EvidenceSource[] = [];
  answers.forEach((a, i) => {
    if (a === 'timeout') timed_out.push(lookups[i].source);
    else if (a) evidence.push(a);
  });
  return { evidence, timed_out };
}
