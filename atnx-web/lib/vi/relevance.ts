// Title relevance for the YouTube name search. A search for a name
// returns videos that carry the phrase in the title, which is not the same
// as videos about the subject: "trollface" titles a genre of compilations,
// "Verity" is also a novel and a surname. Once per discovery, a small text
// model is shown the titles and asked which are about the subject; only
// those are summed. Fails open: any error keeps every video.
//
// YT_TITLE_FILTER=0 turns it off.
import { generateText, Output, type LanguageModel } from 'ai';
import { z } from 'zod';

const MODEL = process.env.VLM_MODEL_TEXT ?? 'google/gemini-3.5-flash-lite';
const TIMEOUT_MS = 15_000;

export interface RelevanceSubject {
  name: string;
  aliases?: string[];
  entityType?: string | null;
  category?: string | null;
  // What the name refers to (markets.description), when known.
  description?: string | null;
}

export interface RelevanceVideo {
  id: string;
  title: string;
  // The uploading channel, when known: a creator's own uploads are about
  // the creator whatever their titles say.
  channel?: string | null;
}

export interface RelevanceResult {
  keep: string[];
  filteredOut: number;
  // 'ok' is a verdict from the model; the others kept every video.
  status: 'ok' | 'failed' | 'off';
  dropped: string[];
}

const schema = z.object({
  // 1-based numbers of the titles that are about the subject.
  about: z.array(z.number().int()),
});

const SYSTEM = `You judge which YouTube videos are about a given subject: a person, brand, product, meme, event or work.

You get the subject (name, type, category, other names) and a numbered list of video titles that matched the name in a search, each with its channel where known. Answer with the numbers of the titles whose video is about the subject: it covers, features, discusses or is made by the subject (a video on the subject's own channel counts).

Not about the subject: the name used as a genre label, tag, format or template for an otherwise unrelated video (a "trollface" compilation of other memes, "sigma edit" on a random clip); a different subject that shares the name (a novel, a surname, a town); a passing mention in a list of many things. When a title is genuinely unclear, include it.`;

export function relevanceFilterOn(): boolean {
  return process.env.YT_TITLE_FILTER !== '0';
}

export function buildRelevancePrompt(subject: RelevanceSubject, videos: RelevanceVideo[]): string {
  const aliases = (subject.aliases ?? []).map((a) => a.trim()).filter(Boolean);
  return [
    `Subject: ${subject.name}`,
    subject.entityType ? `Type: ${subject.entityType}` : null,
    subject.category ? `Category: ${subject.category}` : null,
    aliases.length ? `Also known as: ${aliases.join(', ')}` : null,
    '',
    'Titles:',
    ...videos.map((v, i) => `${i + 1}. ${v.title.replace(/\s+/g, ' ').trim().slice(0, 200)}${v.channel ? ` — by ${v.channel.replace(/\s+/g, ' ').trim().slice(0, 60)}` : ''}`),
  ]
    .filter((l) => l !== null)
    .join('\n');
}

// The ids the verdict keeps, in their original order. A null verdict
// keeps everything; numbers outside 1..n are ignored. Pure.
export function applyVerdict(ids: string[], about: number[] | null): string[] {
  if (about === null) return ids;
  const keep = new Set(about.filter((i) => Number.isInteger(i) && i >= 1 && i <= ids.length).map((i) => ids[i - 1]));
  return ids.filter((id) => keep.has(id));
}

export async function filterRelevantTitles(
  subject: RelevanceSubject,
  videos: RelevanceVideo[],
  { model }: { model?: LanguageModel } = {}
): Promise<RelevanceResult> {
  const all = videos.map((v) => v.id);
  if (!relevanceFilterOn()) return { keep: all, filteredOut: 0, status: 'off', dropped: [] };
  if (videos.length === 0) return { keep: [], filteredOut: 0, status: 'ok', dropped: [] };
  try {
    const result = await generateText({
      model: model ?? MODEL,
      system: SYSTEM,
      prompt: buildRelevancePrompt(subject, videos),
      output: Output.object({ schema }),
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
      temperature: 0,
      maxOutputTokens: 300,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const about = result.output?.about;
    if (!about) throw new Error('no verdict in the output');
    const keep = applyVerdict(all, about);
    const kept = new Set(keep);
    return { keep, filteredOut: all.length - keep.length, status: 'ok', dropped: videos.filter((v) => !kept.has(v.id)).map((v) => v.title) };
  } catch (err) {
    console.error(`[relevance] title filter failed for "${subject.name}": ${(err as Error).message}`);
    return { keep: all, filteredOut: 0, status: 'failed', dropped: [] };
  }
}
