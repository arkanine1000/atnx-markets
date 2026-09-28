// Per-tweet relevance on X as Jev booleans, one per fetched post, run in
// shadow beside the unfiltered reading (lib/vi/x.ts). A phrase search
// returns every post that contains the phrase, not every post about the
// subject: "meta" is a goal in Portuguese and a game's balance, "hn" is
// yes in romanised Urdu. Nothing filters those today, so they count in
// full, and being steady they flatten the momentum of a real spike.
// Each read records Jev's verdict beside the unfiltered numbers so the
// two can be compared on real posts before the verdict counts
// (JEV_TWEETS=on).
import { jevEvaluate } from '../jev';

export const JEV_TWEET_KEEP_AT = 0.5;
// The read's own cap (TWEET_CAP in x.ts); one call judges a whole read.
const MAX_TWEETS = 60;
const MAX_TEXT = 280;

export interface XSubject {
  name: string;
  aliases?: string[];
  entityType?: string | null;
  category?: string | null;
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
  // ids Jev would keep at JEV_TWEET_KEEP_AT
  keep: string[];
  probabilities: Record<string, number>; // by tweet id
  model: string;
  latency_ms: number;
  input_tokens: number | null;
}

function subjectLine(s: XSubject): string {
  const aliases = (s.aliases ?? []).map((a) => a.trim()).filter(Boolean);
  return [s.name, s.entityType ? `(${s.entityType}${s.category ? `, ${s.category}` : ''})` : '', aliases.length ? `also known as ${aliases.join(', ')}` : ''].filter(Boolean).join(' ');
}

export async function jevTweetVerdicts(subject: XSubject, tweets: TweetForJudging[]): Promise<TweetVerdicts | null> {
  const ts = tweets.slice(0, MAX_TWEETS);
  if (ts.length === 0) return null;
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
  const keep: string[] = [];
  ts.forEach((t, i) => {
    const a = r.answers[`p${i}`] as { type: 'boolean'; probability: number } | undefined;
    const p = a ? Math.round(a.probability * 1000) / 1000 : NaN;
    probabilities[t.id] = p;
    if (p >= JEV_TWEET_KEEP_AT) keep.push(t.id);
  });
  return { keep, probabilities, model: r.model, latency_ms: r.latencyMs, input_tokens: r.inputTokens };
}
