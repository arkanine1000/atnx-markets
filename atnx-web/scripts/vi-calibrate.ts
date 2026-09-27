// Read-only calibration of the total-attention VI model (lib/vi/score.ts
// CALIBRATION) against the eyeballed anchor values agreed with the user
// on 2026-09-26. Fits the points per decade, the zero point, the video
// exponent and each source's unit equivalence on the live readings, and
// prints the constants, the residuals, a leave-one-out error and what every
// market would score. Predictions go through the production `attention`
// and `levelFromAttention`, so the fit cannot drift from the code.
//
//   npm run vi:calibrate                      # fit, then the full table
//   npm run vi:calibrate -- --apply           # no fit: the table from CALIBRATION as it is
//   npm run vi:calibrate -- --shorts=Forrest Jones,Other   # assume a Shorts-first channel where the meta lacks it
//
// Writes nothing.
import { createClient } from '@supabase/supabase-js';
import {
  CALIBRATION,
  attention,
  compositeMomentum,
  levelFromAttention,
  viTier,
  clamp,
  type Calibration,
  type Components,
  type SourceComponent,
  type SourceName,
} from '../lib/vi/score';

import { ANCHORS, REPORTED } from './vi-anchors';
import { tiktokReading } from '../lib/vi/tiktok';

const FIT_SOURCES: SourceName[] = ['youtube', 'tiktok', 'x', 'trends', 'bluesky', 'wikipedia', 'gdelt', 'hn'];
// Passive-view sources share one exponent q: YouTube views, TikTok videos,
// X impressions. Their prior centre for log k is pinned at a reference
// reading (log10 of it) so a change of q keeps that reading's unit.
const VIDEO_LIKE: Partial<Record<SourceName, number>> = { youtube: 7, tiktok: 6, x: 5 };
// Own-channel factor prior: centred on 0.5, a factor of 2 either way.
const PRIOR_OWN_CHANNEL = [Math.log10(0.5), 0.3];
// theta = [P, log10 A0, q_video, log10 ownChannelFactor, log10 k per FIT_SOURCES]
const PRIOR_SIGMA_LINEAR = 0.3;
const PRIOR_SIGMA_VIDEO = 0.5;
const PRIOR_SIGMA_Q = 0.15;
const PEN = 100; // points of error a one-sigma prior deviation is worth

const apply = process.argv.includes('--apply');
const shortsArg = process.argv.find((a) => a.startsWith('--shorts='));
const assumeShorts = new Set((shortsArg ? shortsArg.slice('--shorts='.length) : '').split(',').map((s) => s.trim()).filter(Boolean));

interface Row {
  name: string;
  category: string | null;
  vi: number;
  raw: number | null;
  components: Components;
}

function toCalibration(theta: number[]): Calibration {
  const [P, z, q, lf, ...lk] = theta;
  const units = { ...CALIBRATION.units } as Record<SourceName, { k: number; q: number } | null>;
  FIT_SOURCES.forEach((s, i) => {
    units[s] = { k: 10 ** lk[i], q: VIDEO_LIKE[s] !== undefined ? q : 1 };
  });
  return { ...CALIBRATION, pointsPerDecade: P, log10ZeroPoint: z, ownChannelFactor: Math.min(1, 10 ** lf), units };
}

function fromCalibration(cal: Calibration): number[] {
  return [cal.pointsPerDecade, cal.log10ZeroPoint, cal.units.youtube!.q, Math.log10(Math.max(0.01, cal.ownChannelFactor)), ...FIT_SOURCES.map((s) => Math.log10(cal.units[s]!.k))];
}

// Prior centre for each log k, given the video exponent: a 10M-view week
// and a 1k-video day keep their calibrated units whatever q is.
function priorCentre(s: SourceName, q: number): number {
  const base = Math.log10(CALIBRATION.units[s]!.k);
  const q0 = CALIBRATION.units[s]!.q;
  const ref = VIDEO_LIKE[s];
  return ref === undefined ? base : base + ref * (q0 - q);
}

function level(row: Row, cal: Calibration): number {
  return levelFromAttention(attention(row.components, cal).A, cal);
}

function loss(theta: number[], rows: Row[], anchors: Record<string, number>): number {
  const cal = toCalibration(theta);
  let L = 0;
  for (const r of rows) {
    const t = anchors[r.name];
    if (t === undefined) continue;
    const p = level(r, cal);
    if (t === 0) L += Math.max(0, p) ** 2; // hinge: a floor market only has to read 0
    else L += (p - t) ** 2;
  }
  const q = theta[2];
  L += (((q - 0.5) / PRIOR_SIGMA_Q) * PEN) ** 2;
  const lf = theta[3];
  L += (((lf - PRIOR_OWN_CHANNEL[0]) / PRIOR_OWN_CHANNEL[1]) * PEN) ** 2;
  if (lf > 0) L += ((lf / 0.02) * PEN) ** 2; // never above 1
  FIT_SOURCES.forEach((s, i) => {
    const sigma = VIDEO_LIKE[s] !== undefined ? PRIOR_SIGMA_VIDEO : PRIOR_SIGMA_LINEAR;
    L += (((theta[4 + i] - priorCentre(s, q)) / sigma) * PEN) ** 2;
  });
  if (q > 1) L += (((q - 1) / 0.05) * PEN) ** 2;
  if (q < 0.3) L += (((0.3 - q) / 0.05) * PEN) ** 2;
  return L;
}

function nelderMead(f: (x: number[]) => number, x0: number[], step: number[], iters = 10000): { x: number[]; f: number } {
  const n = x0.length;
  let S = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const x = x0.slice();
    x[i] += step[i];
    S.push(x);
  }
  let V = S.map(f);
  for (let it = 0; it < iters; it++) {
    const idx = V.map((_, i) => i).sort((a, b) => V[a] - V[b]);
    S = idx.map((i) => S[i]);
    V = idx.map((i) => V[i]);
    const best = S[0];
    const worst = S[n];
    const cen = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cen[j] += S[i][j] / n;
    const refl = cen.map((c, j) => 2 * c - worst[j]);
    const fr = f(refl);
    if (fr < V[0]) {
      const e = cen.map((c, j) => 3 * c - 2 * worst[j]);
      const fe = f(e);
      if (fe < fr) {
        S[n] = e;
        V[n] = fe;
      } else {
        S[n] = refl;
        V[n] = fr;
      }
    } else if (fr < V[n - 1]) {
      S[n] = refl;
      V[n] = fr;
    } else {
      const con = cen.map((c, j) => c + 0.5 * (worst[j] - c));
      const fc = f(con);
      if (fc < V[n]) {
        S[n] = con;
        V[n] = fc;
      } else {
        for (let i = 1; i <= n; i++) {
          S[i] = S[i].map((v, j) => best[j] + 0.5 * (v - best[j]));
          V[i] = f(S[i]);
        }
      }
    }
    if (it > 1000 && Math.abs(V[n] - V[0]) < 1e-7) break;
  }
  const i = V.indexOf(Math.min(...V));
  return { x: S[i], f: V[i] };
}

function fit(rows: Row[], anchors: Record<string, number>): number[] {
  const base = fromCalibration(CALIBRATION);
  let best: { x: number[]; f: number } | null = null;
  for (const [P, z, q] of [
    [base[0], base[1], base[2]],
    [270, 5.3, 0.6],
    [200, 5.0, 0.8],
    [350, 5.8, 0.45],
  ]) {
    const start = [P, z, q, PRIOR_OWN_CHANNEL[0], ...FIT_SOURCES.map((s) => priorCentre(s, q))];
    let r = nelderMead((t) => loss(t, rows, anchors), start, [30, 0.2, 0.1, 0.3, ...FIT_SOURCES.map(() => 0.4)]);
    r = nelderMead((t) => loss(t, rows, anchors), r.x, [10, 0.05, 0.03, 0.1, ...FIT_SOURCES.map(() => 0.15)]);
    if (!best || r.f < best.f) best = r;
  }
  return best!.x;
}

function fmtCalibration(cal: Calibration): string {
  const u = (s: SourceName) => cal.units[s]!;
  const k = (x: number) => (x >= 1e4 ? x.toExponential(3) : x.toFixed(x >= 100 ? 0 : 2));
  return [
    `export const DEFAULT_CALIBRATION: Calibration = {`,
    `  version: 'sum-v1-${new Date().toISOString().slice(0, 10)}',`,
    `  pointsPerDecade: ${cal.pointsPerDecade.toFixed(1)},`,
    `  log10ZeroPoint: ${cal.log10ZeroPoint.toFixed(3)},`,
    `  shorts: { maxSeconds: ${cal.shorts.maxSeconds}, discount: ${cal.shorts.discount} },`,
    `  xImpressionsPerPostFallback: ${cal.xImpressionsPerPostFallback},`,
    `  ownChannelFactor: ${cal.ownChannelFactor.toFixed(3)},`,
    `  units: {`,
    ...FIT_SOURCES.map((s) => `    ${s}: { k: ${k(u(s).k)}, q: ${u(s).q.toFixed(3)} },`),
    `    dex: null,`,
    `  },`,
    `};`,
  ].join('\n');
}

(async () => {
  const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data, error } = await s
    .from('markets')
    .select('id, entity_name, category, current_vi, vi_components')
    .is('deleted_at', null)
    .eq('vi_state', 'live')
    .order('entity_name');
  if (error) throw error;

  const rows: Row[] = [];
  for (const m of data ?? []) {
    const components = { ...((m.vi_components ?? {}) as Components) };
    if (assumeShorts.has(m.entity_name) && components.youtube?.meta && components.youtube.meta.channel_shorts_share == null) {
      components.youtube = { ...components.youtube, meta: { ...components.youtube.meta, channel_shorts_share: 1 } };
    }
    // A TikTok reading written before the views trend existed: compute it
    // from the stored samples (the view totals were always recorded), so
    // the fit sees real view gains rather than the lifetime-average fallback.
    const tt = components.tiktok;
    if (tt && tt.level !== null && tt.meta && tt.meta.views_per_h == null) {
      const { data: smp } = await s.from('vi_samples').select('sampled_at, value, meta').eq('market_id', m.id).eq('source', 'tiktok').order('sampled_at', { ascending: false }).limit(60);
      const r = tiktokReading(((smp ?? []) as { sampled_at: string; value: number; meta: Record<string, string | number | boolean | null> | null }[]).map((x) => ({ ...x, value: Number(x.value) })), Date.parse(tt.fetchedAt));
      if (r.viewsPerHour !== null) components.tiktok = { ...tt, meta: { ...tt.meta, views_per_h: r.viewsPerHour, views_24h: r.viewsPerHour * 24 } };
    }
    const { data: h } = await s.from('vi_history').select('raw_vi').eq('market_id', m.id).order('recorded_at', { ascending: false }).limit(1).maybeSingle();
    rows.push({ name: m.entity_name, category: m.category, vi: Number(m.current_vi ?? 0), raw: h?.raw_vi === null || h?.raw_vi === undefined ? null : Number(h.raw_vi), components });
  }
  const byName = new Set(rows.map((r) => r.name));
  for (const name of [...Object.keys(ANCHORS), ...Object.keys(REPORTED)]) if (!byName.has(name)) console.error(`anchor market not found: ${name}`);

  let cal: Calibration = CALIBRATION;
  if (!apply) {
    const theta = fit(rows, ANCHORS);
    cal = toCalibration(theta);
    console.log(`Fitted on ${rows.filter((r) => ANCHORS[r.name] !== undefined).length} anchors (${rows.length} live markets):\n`);
    console.log(fmtCalibration(cal));
    // Leave-one-out: refit without each anchor and predict it.
    const errs: { name: string; t: number; p: number }[] = [];
    for (const name of Object.keys(ANCHORS)) {
      if (!byName.has(name)) continue;
      const sub = { ...ANCHORS };
      delete sub[name];
      const c = toCalibration(fit(rows, sub));
      const row = rows.find((r) => r.name === name)!;
      errs.push({ name, t: ANCHORS[name], p: level(row, c) });
    }
    const rmse = Math.sqrt(errs.reduce((a, e) => a + (e.p - e.t) ** 2, 0) / errs.length);
    console.log(`\nLeave-one-out RMSE ${rmse.toFixed(0)} over ${errs.length} anchors`);
    for (const e of errs) console.log(`  ${e.name.padEnd(26)} target ${String(e.t).padStart(4)}  held-out ${String(e.p).padStart(4)}  ${e.p - e.t >= 0 ? '+' : ''}${e.p - e.t}`);
  } else {
    console.log(`Using CALIBRATION ${cal.version} as it is (--apply)`);
  }

  const fitted = rows.filter((r) => ANCHORS[r.name] !== undefined);
  const resid = fitted.map((r) => level(r, cal) - ANCHORS[r.name]);
  console.log(`\nIn-sample RMSE ${Math.sqrt(resid.reduce((a, x) => a + x * x, 0) / resid.length).toFixed(0)}  MAE ${(resid.reduce((a, x) => a + Math.abs(x), 0) / resid.length).toFixed(0)}`);

  console.log('\nmarket                          target  level  score    now    raw   Δnow  tier now → new           top source      answered  A');
  const out = rows
    .map((r) => {
      const at = attention(r.components, cal);
      const lvl = levelFromAttention(at.A, cal);
      const seeing = (Object.values(r.components) as (SourceComponent | undefined)[]).filter((c): c is SourceComponent => !!c && (at.terms[c.source] ?? 0) > 0);
      const m = compositeMomentum(seeing, at.shares);
      const score = clamp(Math.round(lvl * (0.65 + 0.35 * (m / 500))));
      return { r, at, lvl, score };
    })
    .sort((a, b) => b.score - a.score);
  for (const { r, at, lvl, score } of out) {
    const target = ANCHORS[r.name] ?? REPORTED[r.name];
    const tgt = target === undefined ? '' : `${REPORTED[r.name] !== undefined ? '(' : ''}${target}${REPORTED[r.name] !== undefined ? ')' : ''}`;
    const tiers = `${viTier(r.vi).label} → ${viTier(score).label}`;
    const top = at.topSource ? `${at.topSource} ${Math.round(at.topShare * 100)}%` : '-';
    console.log(
      `${r.name.slice(0, 30).padEnd(30)} ${tgt.padStart(7)} ${String(lvl).padStart(6)} ${String(score).padStart(6)} ${String(Math.round(r.vi)).padStart(6)} ${String(r.raw === null ? '-' : Math.round(r.raw)).padStart(6)} ${String(score - Math.round(r.vi)).padStart(6)}  ${tiers.padEnd(24)} ${top.padEnd(15)} ${String(at.answered.length).padStart(8)}  ${at.A > 0 ? at.A.toExponential(2) : '0'}`
    );
  }
  const zero = out.filter((o) => o.score === 0).map((o) => o.r.name);
  console.log(`\n${zero.length} markets at 0: ${zero.join(', ')}`);
  const heavy = out.filter((o) => o.at.topShare > 0.7 && o.at.answered.length >= 3).map((o) => `${o.r.name} (${o.at.topSource} ${Math.round(o.at.topShare * 100)}%)`);
  console.log(`${heavy.length} markets with one source above 70% of the total (3+ sources answering): ${heavy.join('; ')}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
