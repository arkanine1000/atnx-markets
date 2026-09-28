// Offline backtest of the Jev admission gate (lib/admission-jev.ts) over
// every market this platform created or linked, plus the retired names in
// blocked_terms as known generics. Prints each proposal's verdict and the
// catch and false-reject rates at the gate's thresholds.
//
//   npm run jev:backtest              # every distinct created/linked proposal
//   npm run jev:backtest -- --limit=40
//
// Costs about $0.00003 per proposal. Writes nothing.
import { createClient } from '@supabase/supabase-js';
import { jevAdmission, gateAction } from '../lib/admission-jev';

const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.slice(8)) : 500;
const SYNTHETIC_GENERICS = ['Monday motivation', 'summer vibes', 'breaking news', 'Q4 2026', 'football', 'cats', 'memes', 'good morning', 'the weekend', 'AI'];
const SYNTHETIC_VALID = ['Wednesday', '1984', '2012', '1917', 'Halloween', 'Verity (Minecraft ARG)', 'Ella Freya', 'Whimsy', 'DLSS 5', 'Side Eye Cat'];

(async () => {
  const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: rows } = await s.from('submission_decisions').select('outcome, model_response').in('outcome', ['created', 'created_review', 'linked']).order('created_at', { ascending: false }).limit(2000);
  const seen = new Set<string>();
  const proposals: { name: string; entityType: string; category: string; aliases: string[]; label: 'valid' | 'generic'; text: string | null }[] = [];
  for (const r of rows ?? []) {
    const m = (r.model_response as { new_market?: { name?: string; entity_type?: string; category?: string; aliases?: string[] }; ocr_text?: string; description?: string } | null)?.new_market;
    if (!m?.name || seen.has(m.name.toLowerCase())) continue;
    seen.add(m.name.toLowerCase());
    const mr = r.model_response as { ocr_text?: string; description?: string };
    proposals.push({ name: m.name, entityType: m.entity_type ?? 'other', category: m.category ?? 'other', aliases: m.aliases ?? [], label: 'valid', text: [mr.description, mr.ocr_text].filter(Boolean).join('\n') || null });
  }
  const { data: blocked } = await s.from('blocked_terms').select('term_normalized');
  for (const b of blocked ?? []) if (!seen.has(b.term_normalized)) proposals.push({ name: b.term_normalized, entityType: 'meme', category: 'memes', aliases: [], label: 'generic', text: null });
  for (const g of SYNTHETIC_GENERICS) proposals.push({ name: g, entityType: 'other', category: 'other', aliases: [], label: 'generic', text: null });
  for (const v of SYNTHETIC_VALID) if (!seen.has(v.toLowerCase())) proposals.push({ name: v, entityType: 'other', category: 'other', aliases: [], label: 'valid', text: null });

  const todo = proposals.slice(0, LIMIT);
  console.log(`${todo.length} proposals (${todo.filter((p) => p.label === 'valid').length} valid, ${todo.filter((p) => p.label === 'generic').length} generic)`);
  let caught = 0, generics = 0, valid = 0, failed = 0, tokens = 0;
  const wrong = { reject: 0, review: 0 };
  const ms: number[] = [];
  for (const p of todo) {
    const v = await jevAdmission({ name: p.name, entityType: p.entityType, category: p.category, aliases: p.aliases, captureText: p.text });
    if (!v) { failed++; console.log(`  ${p.name.padEnd(36)} ${p.label.padEnd(8)} FAILED`); continue; }
    tokens += v.input_tokens ?? 0; ms.push(v.latency_ms);
    const action = gateAction(v.pGeneric);
    if (p.label === 'generic') { generics++; if (action === 'reject') caught++; } else { valid++; if (action !== 'allow') wrong[action]++; }
    console.log(`  ${p.name.padEnd(36)} ${p.label.padEnd(8)} ${v.kind.padEnd(26)} pGeneric ${v.pGeneric.toFixed(2)}  ${action.padEnd(6)} ${v.latency_ms} ms`);
  }
  ms.sort((a, b) => a - b);
  console.log(`\ngenerics caught at reject: ${caught}/${generics}; valid wrongly rejected: ${wrong.reject}/${valid}, sent to review: ${wrong.review}/${valid}; failed calls ${failed}; p50 ${ms[Math.floor(ms.length / 2)] ?? '-'} ms, p95 ${ms[Math.floor(ms.length * 0.95)] ?? '-'} ms; tokens ${tokens} (≈ $${((tokens / 1e6) * 0.042).toFixed(4)})`);
})().catch((e) => { console.error(e); process.exit(1); });
