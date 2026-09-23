// Regression check for the capture pipeline. Posts every fixture in
// scripts/fixtures/manifest.json through the real /api/captures route and
// reports outcome, latency and whether the expectation held.
//
//   npm run eval:capture                 # full run against EVAL_BASE_URL
//   npm run eval:capture -- --dry-run    # list fixtures, post nothing
//   npm run eval:capture -- --only match-doge-1,text-new-chill-guy
//   npm run eval:capture -- --no-resubmit
//   npm run eval:capture -- --cleanup    # soft-delete what this run created
//
// Needs in .env.local: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY (to seed markets and clean up), EVAL_BASE_URL,
// EVAL_USER_EMAIL, EVAL_USER_PASSWORD (a real account on the target).
//
// Expectations, per fixture `expect`:
//   match   response isNew=false and marketId is the seeded market's id
//   new     response isNew=true
//   reject  response success=false with a reason (4xx), or outcome='rejected'
//
// Then, unless --no-resubmit, every fixture is posted a second time and must
// return the same outcome in under RESUBMIT_MS. That is the dedup check from
// Phase 2; before Phase 2 lands it is expected to fail, and text fixtures
// are expected to come back 400 until Phase 4 accepts `text`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { backfillEmbeddings } from './backfill-embeddings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGES = path.join(HERE, 'fixtures', 'images');
// Dedup answers measure 170-270 ms against the hosted database; a model call
// is never under 1,500 ms. 500 leaves room for network jitter.
const RESUBMIT_MS = 500;

// --- args ------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY = flag('--dry-run');
const RESUBMIT = !flag('--no-resubmit');
const CLEANUP = flag('--cleanup');
const ONLY = opt('--only')?.split(',').map((s) => s.trim());

const BASE = (process.env.EVAL_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'manifest.json'), 'utf8'));
const fixtures = manifest.fixtures.filter((f) => !ONLY || ONLY.includes(f.id));

if (DRY) {
  for (const f of fixtures) console.log(`${f.id.padEnd(28)} ${f.kind.padEnd(6)} expect=${f.expect}`);
  console.log(`\n${fixtures.length} fixtures, ${manifest.seed.length} seed markets, base ${BASE}`);
  process.exit(0);
}

for (const [k, v] of Object.entries({ SUPABASE_URL, ANON_KEY, SERVICE_KEY })) {
  if (!v) {
    console.error(`missing env for ${k}; see .env.local.example`);
    process.exit(2);
  }
}
if (!process.env.EVAL_USER_EMAIL || !process.env.EVAL_USER_PASSWORD) {
  console.error('missing EVAL_USER_EMAIL / EVAL_USER_PASSWORD');
  process.exit(2);
}

// --- seed markets (service role, bypasses RLS) -----------------------------

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const normalize = (s) => s.toLowerCase().trim();

async function seedMarkets() {
  const byName = new Map();
  for (const s of manifest.seed) {
    const norm = normalize(s.name);
    const { data: existing, error: selErr } = await admin
      .from('markets')
      .select('id, entity_name')
      .eq('entity_name_normalized', norm)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    if (selErr) throw selErr;
    if (existing) {
      byName.set(s.name, existing.id);
      continue;
    }
    const { data: created, error: insErr } = await admin
      .from('markets')
      .insert({ entity_name: s.name, entity_name_normalized: norm, entity_type: s.type, category: s.category ?? null })
      .select('id')
      .single();
    if (insErr) throw insErr;
    byName.set(s.name, created.id);
    console.log(`seeded market "${s.name}" ${created.id}`);
  }
  return byName;
}

// --- sign in and build the cookie header the SSR client expects -----------

async function signIn() {
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await anon.auth.signInWithPassword({
    email: process.env.EVAL_USER_EMAIL,
    password: process.env.EVAL_USER_PASSWORD,
  });
  if (error) throw new Error(`sign-in failed: ${error.message}`);

  // Let @supabase/ssr serialise the session the same way the browser does
  // (name, chunking, encoding) by capturing what its setAll() emits.
  const jar = new Map();
  const ssr = createServerClient(SUPABASE_URL, ANON_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  await ssr.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
  if (jar.size === 0) throw new Error('ssr client produced no cookies');
  return { userId: data.user.id, cookie: [...jar].map(([n, v]) => `${n}=${v}`).join('; ') };
}

// --- one submission ----------------------------------------------------------

async function submit(fx, cookie) {
  const form = new FormData();
  if (fx.kind === 'image') {
    const file = path.join(IMAGES, `${fx.id}.png`);
    form.set('image', new Blob([fs.readFileSync(file)], { type: 'image/png' }), `${fx.id}.png`);
  } else {
    form.set('text', fx.text);
  }
  if (fx.sourceUrl) form.set('sourceUrl', fx.sourceUrl);
  if (fx.pageTitle) form.set('pageTitle', fx.pageTitle);

  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/captures`, {
    method: 'POST',
    headers: { cookie },
    body: form,
  });
  const ms = Math.round(performance.now() - t0);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = { success: false, error: `non-JSON ${res.status}` };
  }
  return { status: res.status, body, ms };
}

// Map a response to one of: match | new | reject | error | unsupported.
function outcomeOf({ status, body }) {
  if (status === 400 && /image field is required/i.test(body?.error ?? '')) return 'unsupported';
  if (body?.outcome === 'rejected') return 'reject';
  if (!body?.success) return status >= 500 ? 'error' : 'reject';
  return body.isNew ? 'new' : 'match';
}

function check(fx, r, seeded) {
  const got = outcomeOf(r);
  if (got !== fx.expect) return { got, ok: false, why: `expected ${fx.expect}` };
  if (fx.expect === 'match' && r.body.marketId !== seeded.get(fx.market)) {
    return { got, ok: false, why: `linked to ${r.body.marketId}, not seeded "${fx.market}"` };
  }
  return { got, ok: true };
}

// --- run ---------------------------------------------------------------------

const startedAt = new Date().toISOString();
const seeded = await seedMarkets();
// Seeded and pre-existing markets need a vector or cosine retrieval skips them.
await backfillEmbeddings({ admin });
const { userId, cookie } = await signIn();
console.log(`signed in as ${process.env.EVAL_USER_EMAIL} -> ${BASE}\n`);

const rows = [];
const createdMarkets = new Set();
let pass = 0;
let fail = 0;

for (const fx of fixtures) {
  let r;
  try {
    r = await submit(fx, cookie);
  } catch (e) {
    r = { status: 0, body: { success: false, error: e.message }, ms: 0 };
  }
  const c = check(fx, r, seeded);
  if (c.got === 'new' && r.body.marketId) createdMarkets.add(r.body.marketId);
  if (c.ok) pass++;
  else fail++;
  const detail = c.ok ? '' : `  ${c.why}${r.body?.error ? `: ${r.body.error}` : ''}`;
  console.log(`${c.ok ? 'PASS' : 'FAIL'} ${fx.id.padEnd(28)} ${c.got.padEnd(11)} ${String(r.ms).padStart(6)} ms${detail}`);
  rows.push({ fx, first: r, firstCheck: c });
}

if (RESUBMIT) {
  console.log('\nresubmitting (dedup check)');
  for (const row of rows) {
    if (row.firstCheck.got === 'unsupported' || row.firstCheck.got === 'error') continue;
    let r;
    try {
      r = await submit(row.fx, cookie);
    } catch (e) {
      r = { status: 0, body: { success: false, error: e.message }, ms: 0 };
    }
    // A dedup answer reports isNew=false; compare on the market, not on the label.
    const got = r.body?.outcome === 'dedup' ? row.firstCheck.got : outcomeOf(r);
    const same = got === row.firstCheck.got && (r.body?.marketId ?? null) === (row.first.body?.marketId ?? null);
    const fast = r.ms < RESUBMIT_MS;
    const ok = same && fast;
    if (ok) pass++;
    else fail++;
    if (outcomeOf(r) === 'new' && r.body.marketId) createdMarkets.add(r.body.marketId);
    const why = ok ? '' : `  ${!same ? 'different outcome' : `slower than ${RESUBMIT_MS} ms (model was called)`}`;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${row.fx.id.padEnd(28)} ${got.padEnd(11)} ${String(r.ms).padStart(6)} ms${why}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);

if (CLEANUP) {
  const now = new Date().toISOString();
  const { error: capErr, count } = await admin
    .from('captures')
    .update({ deleted_at: now }, { count: 'exact' })
    .eq('user_id', userId)
    .gte('created_at', startedAt)
    .is('deleted_at', null);
  if (capErr) console.error('cleanup captures failed', capErr.message);
  else console.log(`cleanup: soft-deleted ${count} captures`);
  // Audit rows for this run, so rejection dedup does not answer the next run.
  const { error: dErr, count: dCount } = await admin
    .from('submission_decisions')
    .delete({ count: 'exact' })
    .eq('user_id', userId)
    .gte('created_at', startedAt);
  if (dErr) console.error('cleanup decisions failed', dErr.message);
  else console.log(`cleanup: deleted ${dCount} audit rows`);
  if (createdMarkets.size) {
    const { error: mErr } = await admin
      .from('markets')
      .update({ deleted_at: now })
      .in('id', [...createdMarkets])
      .is('deleted_at', null);
    if (mErr) console.error('cleanup markets failed', mErr.message);
    else console.log(`cleanup: soft-deleted ${createdMarkets.size} markets created by this run`);
  }
}

process.exit(fail ? 1 : 0);
