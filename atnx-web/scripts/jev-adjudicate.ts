// Adjudicates the Jev shadows with a stronger model instead of a labelling
// session: is this title / post about the subject? Reads what the shadows
// stored (vi_samples yt_title_shadow and x_tweet_shadow), plus one fresh
// X page per busy market judged by Jev with full text, and reports how
// each judge did against the adjudicator at every keep threshold.
//
//   npm run jev:adjudicate -- [--titles] [--tweets] [--live=15] [--sample=600] [--out=dir] [--model=anthropic/claude-sonnet-5]
//
// Writes results.json and spotcheck.md (30 random items) to --out.
import { createClient } from '@supabase/supabase-js';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { searchableAliases, type Components } from '../lib/vi/score';
import { xQuery, type Tweet } from '../lib/vi/x';
import { jevTweetVerdicts, subjectLine, type XSubject } from '../lib/vi/relevance-x-jev';

const args = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1']; }));
const doTitles = args.has('titles') || (!args.has('titles') && !args.has('tweets'));
const doTweets = args.has('tweets') || (!args.has('titles') && !args.has('tweets'));
const LIVE = Number(args.get('live') ?? 15);
const SAMPLE = Number(args.get('sample') ?? 600);
const OUT = args.get('out') ?? '.jev-adjudication';
const MODEL = args.get('model') ?? 'anthropic/claude-sonnet-5';
const BATCH = 25;

const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

interface Market { id: string; entity_name: string; entity_type: string | null; category: string | null; aliases: string[] | null; description: string | null; vi_components: unknown }
interface Item {
  kind: 'title' | 'post';
  market: string;
  subject: string;
  text: string;
  jevP: number;
  // Which judge kept it in the shadow: for titles both are known; for
  // stored posts only Jev's verdict exists.
  geminiKeep?: boolean;
  jevKeep: boolean;
  views?: number;
  band: 'dropped' | 'unsure' | 'kept' | 'disagreement';
  about?: boolean;
  why?: string;
}

const verdictSchema = z.object({ verdicts: z.array(z.object({ n: z.number().int(), about: z.boolean(), why: z.string() })) });
const SYSTEM = `You adjudicate whether a piece of content is about a given subject: a person, brand, product, meme, event or work. You will see the subject (name, type, category, other names, and a one-line description when known) and a numbered list of items.

About the subject: the item covers, features, discusses, reacts to, quotes, addresses, tags or is made by the subject; a video on the subject's own channel; a post linking to or replying about the subject.
Not about: the name used as an ordinary word in any language (a goal, a game's meta, a syllable), a genre label or tag on unrelated content, a different thing sharing the name, a stock ticker or hashtag with no connection, a passing mention in a list of many things.
When an item is genuinely unclear, decide by the most likely reading and say so in why. Keep why under 12 words.`;

async function adjudicate(subject: string, items: Item[]): Promise<void> {
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const list = batch.map((it, k) => `${k + 1}. [${it.kind}] ${it.text.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
    try {
      const r = await generateText({
        model: MODEL,
        system: SYSTEM,
        prompt: `Subject: ${subject}\n\nItems:\n${list}\n\nAnswer for every item 1 to ${batch.length}.`,
        output: Output.object({ schema: verdictSchema }),
        temperature: 0,
        maxOutputTokens: 2500,
        abortSignal: AbortSignal.timeout(60_000),
      });
      for (const v of r.output?.verdicts ?? []) {
        const it = batch[v.n - 1];
        if (it) { it.about = v.about; it.why = v.why; }
      }
    } catch (err) {
      console.error(`[adjudicate] "${subject.slice(0, 30)}" batch failed: ${(err as Error).message.slice(0, 160)}`);
    }
  }
}

function subjectOf(m: Market): string {
  const aliases = searchableAliases(m.aliases ?? [], (m.vi_components as Components | null)?.wikipedia?.meta);
  const sub: XSubject = { name: m.entity_name, entityType: m.entity_type, category: m.category, aliases, description: m.description };
  return subjectLine(sub);
}

function parseList(v: unknown): { id: string; p: number; text: string; lang?: string }[] {
  return String(v ?? '').split(' ;; ').filter(Boolean).map((line) => {
    const parts = line.split('|');
    // titles: id|p|title ; posts: id|p|lang|text
    if (parts.length >= 4) return { id: parts[0], p: Number(parts[1]), lang: parts[2], text: parts.slice(3).join('|') };
    return { id: parts[0], p: Number(parts[1]), text: parts.slice(2).join('|') };
  });
}

// Deterministic sample.
function pick<T>(arr: T[], n: number, seed = 7): T[] {
  const a = [...arr]; let x = seed;
  for (let i = a.length - 1; i > 0; i--) { x = (x * 1103515245 + 12345) & 0x7fffffff; const j = x % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

function pct(n: number, d: number): string { return d ? `${Math.round((100 * n) / d)}%` : '-'; }

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { data: mrows } = await s.from('markets').select('id, entity_name, entity_type, category, aliases, description, vi_components').is('deleted_at', null);
  const markets = new Map((mrows ?? []).map((m) => [m.id, m as Market]));
  const all: Item[] = [];
  const report: string[] = [`# Jev adjudication ${new Date().toISOString()} (adjudicator ${MODEL})`, ''];

  if (doTitles) {
    const { data: rows } = await s.from('vi_samples').select('market_id, meta').eq('source', 'yt_title_shadow');
    const byMarket = new Map<string, Item[]>();
    for (const r of rows ?? []) {
      const m = markets.get(r.market_id); if (!m) continue;
      const meta = (r.meta ?? {}) as Record<string, unknown>;
      const items = byMarket.get(m.id) ?? [];
      for (const t of parseList(meta.gemini_only)) items.push({ kind: 'title', market: m.entity_name, subject: subjectOf(m), text: t.text, jevP: t.p, geminiKeep: true, jevKeep: false, band: 'disagreement' });
      for (const t of parseList(meta.jev_only)) items.push({ kind: 'title', market: m.entity_name, subject: subjectOf(m), text: t.text, jevP: t.p, geminiKeep: false, jevKeep: true, band: 'disagreement' });
      byMarket.set(m.id, items);
    }
    for (const [, items] of byMarket) { await adjudicate(items[0].subject, items); all.push(...items); }
    const judged = all.filter((i) => i.kind === 'title' && i.about !== undefined);
    const gRight = judged.filter((i) => i.geminiKeep === i.about).length;
    const jRight = judged.filter((i) => i.jevKeep === i.about).length;
    report.push(`## YouTube titles: ${judged.length} disagreements adjudicated (${all.filter((i) => i.kind === 'title').length} total)`, '',
      `- Gemini right: ${gRight} (${pct(gRight, judged.length)}); Jev right: ${jRight} (${pct(jRight, judged.length)})`,
      `- Where Gemini kept and Jev dropped (${judged.filter((i) => i.geminiKeep).length}): about per adjudicator ${pct(judged.filter((i) => i.geminiKeep && i.about).length, judged.filter((i) => i.geminiKeep).length)}`,
      `- Where Jev kept and Gemini dropped (${judged.filter((i) => i.jevKeep).length}): about per adjudicator ${pct(judged.filter((i) => i.jevKeep && i.about).length, judged.filter((i) => i.jevKeep).length)}`, '');
    report.push('| Jev p band | items | about (adjudicator) |', '|---|---|---|');
    for (const [lo, hi] of [[0, 0.2], [0.2, 0.35], [0.35, 0.5], [0.5, 0.65], [0.65, 0.8], [0.8, 1.01]]) {
      const b = judged.filter((i) => i.jevP >= lo && i.jevP < hi);
      report.push(`| ${lo}–${hi === 1.01 ? 1 : hi} | ${b.length} | ${pct(b.filter((i) => i.about).length, b.length)} |`);
    }
    report.push('');
  }

  if (doTweets) {
    // Stored: the dropped and kept-but-unsure lines (80 chars of text).
    const { data: rows } = await s.from('vi_samples').select('market_id, meta, sampled_at').eq('source', 'x_tweet_shadow');
    const stored: Item[] = [];
    for (const r of rows ?? []) {
      const m = markets.get(r.market_id); if (!m) continue;
      const meta = (r.meta ?? {}) as Record<string, unknown>;
      for (const t of parseList(meta.dropped)) if (t.text.trim()) stored.push({ kind: 'post', market: m.entity_name, subject: subjectOf(m), text: `(${t.lang}) ${t.text}`, jevP: t.p, jevKeep: false, band: 'dropped' });
      for (const t of parseList(meta.unsure)) if (t.text.trim()) stored.push({ kind: 'post', market: m.entity_name, subject: subjectOf(m), text: `(${t.lang}) ${t.text}`, jevP: t.p, jevKeep: true, band: 'unsure' });
    }
    const sample = [...pick(stored.filter((i) => i.band === 'dropped'), Math.round(SAMPLE * 0.6)), ...pick(stored.filter((i) => i.band === 'unsure'), Math.round(SAMPLE * 0.4))];
    const bySubject = new Map<string, Item[]>();
    for (const it of sample) bySubject.set(it.subject, [...(bySubject.get(it.subject) ?? []), it]);
    for (const [subject, items] of bySubject) await adjudicate(subject, items);
    all.push(...sample);
    const sj = sample.filter((i) => i.about !== undefined);
    const d = sj.filter((i) => i.band === 'dropped'), u = sj.filter((i) => i.band === 'unsure');
    report.push(`## X posts, stored shadow (80-char text): ${sj.length} adjudicated of ${stored.length} (${stored.filter((i) => i.band === 'dropped').length} dropped, ${stored.filter((i) => i.band === 'unsure').length} unsure)`, '',
      `- Dropped (p < 0.5): not about per adjudicator ${pct(d.filter((i) => !i.about).length, d.length)} of ${d.length} → drop precision`,
      `- Kept-unsure (0.5–0.7): about per adjudicator ${pct(u.filter((i) => i.about).length, u.length)} of ${u.length}`, '');
    report.push('| Jev p band | items | about (adjudicator) |', '|---|---|---|');
    for (const [lo, hi] of [[0, 0.1], [0.1, 0.25], [0.25, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7]]) {
      const b = sj.filter((i) => i.jevP >= lo && i.jevP < hi);
      report.push(`| ${lo}–${hi} | ${b.length} | ${pct(b.filter((i) => i.about).length, b.length)} |`);
    }
    report.push('');

    // Live: one fresh page per busy market, full text, every band.
    const counts = new Map<string, number>();
    for (const r of rows ?? []) counts.set(r.market_id, (counts.get(r.market_id) ?? 0) + Number(((r.meta ?? {}) as Record<string, unknown>).tweets ?? 0));
    const busy = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, LIVE).map(([id]) => markets.get(id)).filter((m): m is Market => !!m);
    const live: Item[] = [];
    let credits = 0;
    for (const m of busy) {
      const aliases = searchableAliases(m.aliases ?? [], (m.vi_components as Components | null)?.wikipedia?.meta);
      const params = new URLSearchParams({ query: xQuery(m.entity_name, aliases), queryType: 'Latest', cursor: '' });
      const res = await fetch(`https://api.twitterapi.io/twitter/tweet/advanced_search?${params}`, { headers: { 'X-API-Key': process.env.TWITTERAPI_IO_KEY ?? '', Accept: 'application/json' } });
      if (!res.ok) { console.error(`[live] ${m.entity_name}: ${res.status}`); continue; }
      const tweets = ((((await res.json()) as { tweets?: Tweet[] }).tweets ?? []).filter((t) => !t.retweeted_tweet));
      credits += tweets.length;
      const jv = await jevTweetVerdicts({ name: m.entity_name, aliases, entityType: m.entity_type, category: m.category, description: m.description }, tweets.map((t) => ({ id: t.id, text: t.text ?? '', lang: t.lang, author: t.author?.userName, isReply: t.isReply })));
      if (!jv) { console.error(`[live] ${m.entity_name}: jev failed`); continue; }
      const items: Item[] = tweets.filter((t) => !jv.unjudged.includes(t.id)).map((t) => ({ kind: 'post', market: m.entity_name, subject: subjectOf(m), text: `(${t.lang ?? '-'}) ${t.text ?? ''}`, jevP: jv.probabilities[t.id], jevKeep: jv.keep.includes(t.id), views: t.viewCount ?? 0, band: jv.probabilities[t.id] < 0.5 ? 'dropped' : jv.probabilities[t.id] < 0.7 ? 'unsure' : 'kept' }));
      await adjudicate(subjectOf(m), items);
      live.push(...items);
    }
    all.push(...live);
    const lj = live.filter((i) => i.about !== undefined);
    const aboutN = lj.filter((i) => i.about).length, aboutV = lj.filter((i) => i.about).reduce((a, i) => a + (i.views ?? 0), 0);
    report.push(`## X posts, live pages: ${lj.length} posts over ${busy.length} markets (${credits} tweets fetched), full text, all bands`, '',
      `- About per adjudicator: ${aboutN} (${pct(aboutN, lj.length)}) carrying ${aboutV} of ${lj.reduce((a, i) => a + (i.views ?? 0), 0)} views`, '',
      '| keep at p ≥ | posts kept | drop precision (not-about among dropped) | about-posts wrongly dropped | views of about-posts lost | not-about views still counted |', '|---|---|---|---|---|---|');
    for (const t of [0.3, 0.4, 0.5, 0.6, 0.7]) {
      const kept = lj.filter((i) => i.jevP >= t), dropped = lj.filter((i) => i.jevP < t);
      const wrongDrop = dropped.filter((i) => i.about);
      report.push(`| ${t} | ${kept.length} | ${pct(dropped.filter((i) => !i.about).length, dropped.length)} | ${wrongDrop.length} of ${aboutN} (${pct(wrongDrop.length, aboutN)}) | ${pct(wrongDrop.reduce((a, i) => a + (i.views ?? 0), 0), aboutV)} | ${kept.filter((i) => !i.about).reduce((a, i) => a + (i.views ?? 0), 0)} |`);
    }
    report.push('', '### Per market, live page (keep at 0.5)', '', '| market | posts | about | Jev kept | wrong drops (views) | wrong keeps |', '|---|---|---|---|---|---|');
    for (const m of busy) {
      const it = lj.filter((i) => i.market === m.entity_name); if (!it.length) continue;
      const wd = it.filter((i) => i.about && !i.jevKeep), wk = it.filter((i) => !i.about && i.jevKeep);
      report.push(`| ${m.entity_name} | ${it.length} | ${it.filter((i) => i.about).length} | ${it.filter((i) => i.jevKeep).length} | ${wd.length} (${wd.reduce((a, i) => a + (i.views ?? 0), 0)}) | ${wk.length} |`);
    }
    report.push('');
  }

  writeFileSync(join(OUT, 'results.json'), JSON.stringify(all, null, 1));
  const spot = pick(all.filter((i) => i.about !== undefined), 30, 11);
  const md = ['# Spot check: 30 adjudicated items', '', 'Verdict is the adjudicator\'s; check whether you agree.', ''];
  for (const it of spot) md.push(`- **${it.market}** [${it.kind}, Jev ${it.jevP}${it.geminiKeep !== undefined ? `, Gemini ${it.geminiKeep ? 'keep' : 'drop'}` : ''}] "${it.text.replace(/\s+/g, ' ').slice(0, 160)}" → **${it.about ? 'ABOUT' : 'not about'}**: ${it.why}`);
  writeFileSync(join(OUT, 'spotcheck.md'), md.join('\n') + '\n');
  writeFileSync(join(OUT, 'report.md'), report.join('\n') + '\n');
  console.log(report.join('\n'));
  console.log(`\nwrote ${OUT}/report.md, results.json, spotcheck.md`);
}
main().catch((e) => { console.error(e); process.exit(1); });
