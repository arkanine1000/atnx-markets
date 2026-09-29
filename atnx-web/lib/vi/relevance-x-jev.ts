// Per-tweet relevance on X as Jev booleans, one per fetched post
// (lib/vi/x.ts). A phrase search returns every post that contains the
// phrase, not every post about the subject: "meta" is a goal in
// Portuguese and a game's balance, "hn" is yes in romanised Urdu. Unfiltered
// they counted in full, and being steady they flattened the momentum of a
// real spike. Each read records Jev's verdict beside the unfiltered
// numbers; with JEV_TWEETS=on (production since 2026-09-29) the kept
// posts are the ones that count.
import { jevEvaluate } from '../jev';

// Keep a post at this probability or above. Adjudicated 2026-09-29 on 294
// live posts: at 0.4 no post about the subject was dropped and drop
// precision was 100 %; at 0.5 two were (3 % of the views on posts about
// the subject) for slightly fewer noise views kept. Set by JEV_TWEET_KEEP_AT.
export const JEV_TWEET_KEEP_AT = (() => { const n = Number(process.env.JEV_TWEET_KEEP_AT); return Number.isFinite(n) && n > 0 && n < 1 ? n : 0.4; })();
// The read's own cap (TWEET_CAP in x.ts); one call judges a whole read.
const MAX_TWEETS = 60;
const MAX_TEXT = 280;

export interface XSubject {
  name: string;
  aliases?: string[];
  entityType?: string | null;
  category?: string | null;
  // What the name refers to (markets.description), when known. Without
  // it a post about the Resident Evil film's record read 0.42 for the
  // market "Zach Cregger Resident Evil" and dropped 26k of 34k views.
  description?: string | null;
}

export interface TweetForJudging {
  id: string;
  text: string;
  lang?: string | null;
  // The posting account's handle, when known.
  author?: string | null;
  isReply?: boolean;
}

export interface TweetVerdicts {
  // ids Jev would keep at JEV_TWEET_KEEP_AT, plus the unjudged ones
  keep: string[];
  probabilities: Record<string, number>; // by tweet id, judged ones only
  // Posts with no words to judge (a bare media link): kept, never asked.
  unjudged: string[];
  model: string;
  latency_ms: number;
  input_tokens: number | null;
}

// The words of a post once links and handles are gone. A post that is
// only a media link (X tags it lang "zxx") is a screenshot or a clip, and
// the judge cannot see it: on a game market those were 40 % of a page's
// views and read 0.41, a coin flip. Such a post is unjudgeable and stays
// in, as an unknown rather than a no. Pure.
export function judgeableText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(^|\s)@\w+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function subjectLine(s: XSubject): string {
  const aliases = (s.aliases ?? []).map((a) => a.trim()).filter(Boolean);
  const about = (s.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return [s.name, s.entityType ? `(${s.entityType}${s.category ? `, ${s.category}` : ''})` : '', aliases.length ? `also known as ${aliases.join(', ')}` : '', about ? `: ${about}` : ''].filter(Boolean).join(' ');
}

export async function jevTweetVerdicts(subject: XSubject, tweets: TweetForJudging[]): Promise<TweetVerdicts | null> {
  const all = tweets.slice(0, MAX_TWEETS);
  if (all.length === 0) return null;
  const unjudged = all.filter((t) => judgeableText(t.text) === '').map((t) => t.id);
  const ts = all.filter((t) => judgeableText(t.text) !== '');
  if (ts.length === 0) return { keep: unjudged, probabilities: {}, unjudged, model: 'none', latency_ms: 0, input_tokens: null };
  const questions: Record<string, { type: 'boolean'; instructions: string }> = {};
  ts.forEach((t, i) => {
    const text = t.text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    const facts = [t.lang ? `language ${t.lang}` : '', t.author ? `by @${t.author}` : '', t.isReply ? 'a reply' : ''].filter(Boolean).join(', ');
    questions[`p${i}`] = {
      type: 'boolean',
      instructions: `Is post ${i + 1}${facts ? ` (${facts})` : ''}, reading "${text}", about the subject: it discusses, reacts to, quotes, addresses, tags or is written by the subject? Not about: the name used as an ordinary word in any language (a goal, a game's meta, a syllable, an abbreviation of something else); a different person, place or thing that shares the name; a stock ticker or tag with no connection to the subject.`,
    };
  });
  const r = await jevEvaluate({ subject: subjectLine(subject) }, questions, `tweets "${subject.name}" x${ts.length}`);
  if (!r) return null;
  const probabilities: Record<string, number> = {};
  const keep: string[] = [...unjudged];
  ts.forEach((t, i) => {
    const a = r.answers[`p${i}`] as { type: 'boolean'; probability: number } | undefined;
    const p = a ? Math.round(a.probability * 1000) / 1000 : NaN;
    probabilities[t.id] = p;
    if (p >= JEV_TWEET_KEEP_AT) keep.push(t.id);
  });
  return { keep, probabilities, unjudged, model: r.model, latency_ms: r.latencyMs, input_tokens: r.inputTokens };
}
