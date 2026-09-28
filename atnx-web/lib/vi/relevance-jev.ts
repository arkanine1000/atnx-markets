// The YouTube title relevance filter as Jev booleans, one per title, run
// in shadow beside the Gemini verdict (lib/vi/relevance.ts). Each read
// records both verdicts and their disagreements so the two can be
// compared on real titles before either replaces the other.
import { jevEvaluate } from '../jev';
import type { RelevanceSubject, RelevanceVideo } from './relevance';

export const JEV_KEEP_AT = 0.5;
const MAX_TITLES = 50;

export interface TitleVerdicts {
  // ids Jev would keep at JEV_KEEP_AT
  keep: string[];
  probabilities: Record<string, number>; // by video id
  model: string;
  latency_ms: number;
  input_tokens: number | null;
}

function subjectLine(s: RelevanceSubject): string {
  const aliases = (s.aliases ?? []).map((a) => a.trim()).filter(Boolean);
  return [s.name, s.entityType ? `(${s.entityType}${s.category ? `, ${s.category}` : ''})` : '', aliases.length ? `also known as ${aliases.join(', ')}` : ''].filter(Boolean).join(' ');
}

export async function jevTitleVerdicts(subject: RelevanceSubject, videos: RelevanceVideo[]): Promise<TitleVerdicts | null> {
  const vids = videos.slice(0, MAX_TITLES);
  if (vids.length === 0) return null;
  const questions: Record<string, { type: 'boolean'; instructions: string }> = {};
  vids.forEach((v, i) => {
    const title = v.title.replace(/\s+/g, ' ').trim().slice(0, 200);
    const by = v.channel ? ` (channel: ${v.channel.replace(/\s+/g, ' ').trim().slice(0, 60)})` : '';
    questions[`t${i}`] = {
      type: 'boolean',
      instructions: `Is video ${i + 1}, titled "${title}"${by}, about the subject: it covers, features, discusses or is made by the subject? Not about: the name used only as a tag, genre label or format for an unrelated video; a different thing that shares the name; a passing mention.`,
    };
  });
  const r = await jevEvaluate({ subject: subjectLine(subject) }, questions, `titles "${subject.name}" x${vids.length}`);
  if (!r) return null;
  const probabilities: Record<string, number> = {};
  const keep: string[] = [];
  vids.forEach((v, i) => {
    const a = r.answers[`t${i}`] as { type: 'boolean'; probability: number } | undefined;
    const p = a ? Math.round(a.probability * 1000) / 1000 : NaN;
    probabilities[v.id] = p;
    if (p >= JEV_KEEP_AT) keep.push(v.id);
  });
  return { keep, probabilities, model: r.model, latency_ms: r.latencyMs, input_tokens: r.inputTokens };
}

// How two keep-sets compare. Pure.
export function compareKeeps(all: string[], a: string[], b: string[]): { agree: number; aOnly: string[]; bOnly: string[] } {
  const A = new Set(a), B = new Set(b);
  let agree = 0;
  const aOnly: string[] = [], bOnly: string[] = [];
  for (const id of all) {
    const inA = A.has(id), inB = B.has(id);
    if (inA === inB) agree++;
    else if (inA) aOnly.push(id);
    else bOnly.push(id);
  }
  return { agree, aOnly, bOnly };
}
