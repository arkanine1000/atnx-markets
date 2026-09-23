// Exercises the review step end to end against a running app:
// propose → recrop → commit on an image, a text proposal with a subject
// nudge, and the sweep of an expired draft. Attaches captures to existing
// markets only (the default choices), so it leaves no new market behind.
//
//   npx tsx --env-file=.env.local scripts/review-probe.ts
//
// Needs the same env as the eval script: EVAL_BASE_URL, EVAL_USER_EMAIL,
// EVAL_USER_PASSWORD, the Supabase URL/keys.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { sweepExpiredDrafts } from '../lib/review';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.EVAL_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function signIn() {
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await anon.auth.signInWithPassword({
    email: process.env.EVAL_USER_EMAIL!,
    password: process.env.EVAL_USER_PASSWORD!,
  });
  if (error || !data.session) throw new Error(`sign-in failed: ${error?.message}`);
  const jar = new Map<string, string>();
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
  return { userId: data.user.id, cookie: [...jar].map(([n, v]) => `${n}=${v}`).join('; ') };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = Record<string, any>;

async function post(pathname: string, cookie: string, body: FormData | object): Promise<{ status: number; body: Any; ms: number }> {
  const t0 = performance.now();
  const init: RequestInit =
    body instanceof FormData
      ? { method: 'POST', headers: { cookie }, body }
      : { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(`${BASE}${pathname}`, init);
  const ms = Math.round(performance.now() - t0);
  const json = (await res.json().catch(() => ({ error: 'non-JSON' }))) as Any;
  return { status: res.status, body: json, ms };
}

function summary(b: Any): string {
  if (!b.success) return `FAIL ${b.code ?? b.outcome ?? ''} ${b.error}`;
  if (b.final) return `final outcome=${b.outcome} market=${b.entityName} (${b.marketId})`;
  const d = b.draft;
  const n = d.nudge;
  return [
    `draft ${d.draftId.slice(0, 8)} tier=${n.tier}`,
    `name="${d.analysis.name}" type=${d.analysis.entityType} names=${JSON.stringify(d.choices.names)}`,
    `candidates=${n.candidates.map((c: Any) => `${c.name}${c.similarity !== null ? ` ${Math.round(c.similarity * 100)}%` : ''}`).join(' | ') || '-'}`,
    `subject=${n.subject ? n.subject.name : '-'} parent=${d.choices.parentMarketId ? 'yes' : 'no'} createSubject=${d.choices.createSubject ? d.choices.createSubject.name : '-'}`,
    `default=${JSON.stringify(n.defaultChoice)} recropsLeft=${d.recropsLeft} image=${d.image ? `${d.image.width}x${d.image.height}` : '-'}`,
  ].join('\n    ');
}

async function main() {
  const { userId, cookie } = await signIn();
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  console.log(`signed in as ${userId} against ${BASE}\n`);

  // 1. Image: a match fixture with one extra row of pixels so its hash is new.
  const doge = await sharp(path.join(HERE, 'fixtures', 'images', 'match-doge-1.png'))
    .extend({ bottom: 1, background: '#000' })
    .png()
    .toBuffer();
  let form = new FormData();
  form.set('image', new Blob([new Uint8Array(doge)], { type: 'image/png' }), 'doge.png');
  let r = await post('/api/captures/propose', cookie, form);
  console.log(`1. propose image  ${r.status} ${r.ms} ms\n    ${summary(r.body)}`);
  if (!r.body.success || r.body.final) return;
  const d1 = r.body.draft;

  // 2. Recrop to the central 80 %.
  const { width, height } = d1.image;
  const crop = {
    x: Math.round(width * 0.1),
    y: Math.round(height * 0.1),
    width: Math.round(width * 0.8),
    height: Math.round(height * 0.8),
  };
  r = await post('/api/captures/recrop', cookie, { draftId: d1.draftId, crop });
  console.log(`2. recrop         ${r.status} ${r.ms} ms\n    ${summary(r.body)}`);
  // A bad rectangle must be refused.
  const bad = await post('/api/captures/recrop', cookie, { draftId: d1.draftId, crop: { x: 0, y: 0, width: 4000, height: 10 } });
  console.log(`   bad crop       ${bad.status} ${bad.body.error}`);
  const draft2 = r.body.success && !r.body.final ? r.body.draft : d1;

  // 3. A choice the draft did not offer must be refused; then commit the default.
  const forged = await post('/api/captures/commit', cookie, {
    draftId: draft2.draftId,
    choice: { kind: 'attach', marketId: '00000000-0000-0000-0000-000000000000' },
  });
  console.log(`   forged attach  ${forged.status} ${forged.body.error}`);
  r = await post('/api/captures/commit', cookie, { draftId: draft2.draftId, choice: draft2.nudge.defaultChoice });
  console.log(`3. commit         ${r.status} ${r.ms} ms\n    ${summary(r.body)}`);
  const again = await post('/api/captures/commit', cookie, { draftId: draft2.draftId, choice: draft2.nudge.defaultChoice });
  console.log(`   commit again   ${again.status} ${again.body.error}`);

  // 4. Text with a subject: the meme is about a person who has a market.
  form = new FormData();
  form.set('text', `Elon Musk crying meme after the Tesla earnings call, everyone is posting the sad Elon edit ${Date.now() % 1000}`);
  r = await post('/api/captures/propose', cookie, form);
  console.log(`4. propose text   ${r.status} ${r.ms} ms\n    ${summary(r.body)}`);
  if (r.body.success && !r.body.final) {
    const d = r.body.draft;
    if (d.nudge.subject) {
      const c = await post('/api/captures/commit', cookie, { draftId: d.draftId, choice: { kind: 'attach', marketId: d.nudge.subject.id } });
      console.log(`   attach subject ${c.status} ${c.ms} ms\n    ${summary(c.body)}`);
    } else {
      console.log('   (no subject offered; leaving the draft to expire)');
    }
  }

  // 5. Sweep: a second image draft, backdated, then swept.
  const doge2 = await sharp(path.join(HERE, 'fixtures', 'images', 'match-doge-1.png'))
    .extend({ bottom: 2, background: '#000' })
    .png()
    .toBuffer();
  form = new FormData();
  form.set('image', new Blob([new Uint8Array(doge2)], { type: 'image/png' }), 'doge2.png');
  r = await post('/api/captures/propose', cookie, form);
  console.log(`5. propose image  ${r.status} ${r.ms} ms\n    ${summary(r.body)}`);
  if (r.body.success && !r.body.final) {
    const id = r.body.draft.draftId;
    // The web review page renders for the owner.
    const page = await fetch(`${BASE}/app/submit/review/${id}`, { headers: { cookie }, redirect: 'manual' });
    const html = await page.text();
    console.log(`   review page    ${page.status} headline=${/This looks like|This is about|could be one of these|Nothing like this yet/.exec(html)?.[0] ?? 'not found'} commit-button=${html.includes('Add to ') || html.includes('Create ')}`);
    await admin.from('submission_drafts').update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', id);
    const gone = await post('/api/captures/commit', cookie, { draftId: id, choice: r.body.draft.nudge.defaultChoice });
    console.log(`   expired commit ${gone.status} ${gone.body.code} ${gone.body.error}`);
    const swept = await sweepExpiredDrafts();
    const { data: row } = await admin.from('submission_drafts').select('status, image_path').eq('id', id).single();
    const { data: objects } = await admin.storage.from('captures').list(`${userId}/pending`);
    console.log(`   sweep          expired=${swept.expired} row=${JSON.stringify(row)} pending objects left=${objects?.length ?? 'n/a'}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
