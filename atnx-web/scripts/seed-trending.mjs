// Seeds the app with a set of currently-trending markets so a fresh (or
// stale) database has something worth looking at.
//
//   npm run seed:trending              # writes to Supabase (.env.local)
//   npm run seed:trending -- --dry-run # fetches images, writes nothing
//   npm run seed:trending -- --user <auth uuid>
//
// Each item becomes one market + one capture + a 7-day vi_history series, the
// same three tables a real capture writes (see lib/store.ts addCapture). The
// capture image is the source page's og:image, uploaded to the `captures`
// bucket; when a site blocks the fetch we fall back to a generated card so the
// market still renders. Existing markets with the same name are skipped, so
// re-running is safe. The VI refresh cron takes over the score from here on.
//
// The item list is hand-curated: edit TRENDING below to swap in what's hot.

import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

// --- Trending items -----------------------------------------------------
// Snapshot as of mid-September 2026. `shape` drives the fake 7-day series so
// the dashboard's trend chip (spiking / rising / falling / stable / new)
// comes out the way the item actually feels right now.

// `category` is one of the values markets.category accepts (supabase/002);
// `label` is the free-text line drawn on the placeholder art.
const CATEGORIES = ['memes', 'crypto', 'politics', 'sports', 'music', 'film_tv', 'gaming', 'tech', 'people', 'other'];

const TRENDING = [
  {
    name: 'Superman Tornado Squirrel',
    type: 'meme',
    category: 'memes',
    label: 'reaction meme',
    description:
      'A squirrel calmly waving goodbye before a tornado sweeps it away, edited into the Man of Steel Jonathan Kent scene. The go-to "it\'s over, I\'m cooked" reaction of late summer 2026.',
    platforms: ['X', 'TikTok', 'Reddit'],
    sentiment: 'mixed',
    signals: 'Reaction GIF spreading across every platform; new edits daily',
    source:
      'https://knowyourmeme.com/memes/squirrel-waving-bye-in-tornado-superman-tornado-squirrel',
    vi: 905,
    shape: 'spiking',
  },
  {
    name: 'iPhone Duo',
    type: 'brand',
    category: 'tech',
    label: 'tech launch',
    description:
      "Apple's first foldable iPhone, announced September 9. The internet's reaction is a flood of \"Apple invented folding\" jokes, with Samsung and Duolingo heckling from the sidelines.",
    platforms: ['X', 'YouTube', 'Reddit', 'TikTok'],
    sentiment: 'mixed',
    signals: 'Launch-week meme wave, brand accounts piling on, price discourse',
    source:
      'https://www.boredpanda.com/apple-turns-into-a-mockery-after-launching-foldable-iphone-duo/',
    vi: 860,
    shape: 'spiking',
  },
  {
    name: 'Zip It, Movie Lady',
    type: 'event',
    category: 'film_tv',
    label: 'awards show moment',
    description:
      "Emmys 2026 host Mariska Hargitay recreated Nicole Kidman's AMC monologue, Kidman shut it down, and Hargitay fired back \"zip it, movie lady, it's TV's turn tonight.\" The clip of the night.",
    platforms: ['X', 'TikTok', 'Instagram'],
    sentiment: 'positive',
    signals: 'Clipped and quoted everywhere the morning after the ceremony',
    source: 'https://www.bustle.com/entertainment/2026-emmys-best-memes-viral-moments',
    vi: 780,
    shape: 'new',
  },
  {
    name: 'My American Girl Doll',
    type: 'trend',
    category: 'memes',
    label: 'TikTok audio',
    description:
      'A 2009 clip of a kid screaming "MY AMERICAN GIRL DOLL MIA" recycled as the reveal for whatever ordinary thing you are currently obsessed with. Childhood excitement, adult purchase.',
    platforms: ['TikTok', 'Instagram', 'YouTube'],
    sentiment: 'positive',
    signals: 'Top trending sound of the month; brand accounts joining in',
    source: 'https://socialtrendingnow.substack.com/p/latest-trend-report-my-american-girl',
    vi: 640,
    shape: 'rising',
  },
  {
    name: 'Kinda Chic',
    type: 'trend',
    category: 'memes',
    label: 'caption format',
    description:
      'Posts that open every line with "kinda chic to..." followed by something unglamorous and healthy: going to bed early, reading, taking care of your mental health. Started on Instagram in April, everywhere by September.',
    platforms: ['Instagram', 'TikTok'],
    sentiment: 'positive',
    signals: 'Steady cross-platform format, still spawning new variants',
    source: 'https://knowyourmeme.com/memes/kinda-chic-trend',
    vi: 590,
    shape: 'rising',
  },
  {
    name: 'How Could This Day Get Any Better',
    type: 'trend',
    category: 'memes',
    label: 'TikTok format',
    description:
      'One mundane object, then the upgraded version of it revealed on a bass drop. Format-first comedy: a repeatable premise with a hard punchline.',
    platforms: ['TikTok', 'Instagram'],
    sentiment: 'positive',
    signals: 'High remix rate, works for brands and creators alike',
    source: 'https://newengen.com/insights/september-tiktok-trends/',
    vi: 560,
    shape: 'rising',
  },
  {
    name: 'Allison Janney Shocked Reaction',
    type: 'meme',
    category: 'film_tv',
    label: 'reaction image',
    description:
      'Janney\'s open-mouthed, hands-up face when she won Supporting Actress at the 2026 Emmys after giving herself a 2% chance. A brand-new "I did not expect that" template.',
    platforms: ['X', 'Instagram', 'Reddit'],
    sentiment: 'positive',
    signals: 'Fresh reaction GIF minted live on air',
    source:
      'https://www.eonline.com/news/1436075/emmys-2026-see-allison-janneys-shocked-reaction-to-win',
    vi: 520,
    shape: 'new',
  },
  {
    name: 'Down Goes the Whiskey',
    type: 'trend',
    category: 'music',
    label: 'comment roast',
    description:
      'Luke Bryan\'s single getting roasted in the comments with "blank goes the blank" rhyme parodies. Brands like Southwest have joined the pile-on.',
    platforms: ['TikTok', 'X'],
    sentiment: 'mixed',
    signals: 'Comment-section format; brand participation extends the tail',
    source: 'https://www.socialpilot.co/blog/tiktok-trends',
    vi: 470,
    shape: 'stable',
  },
  {
    name: '2026 Is the New 2016',
    type: 'trend',
    category: 'memes',
    label: 'nostalgia',
    description:
      'The idea that this year is a rerun of 2016: the fashion, the music, the memes. Started late 2025, peaked in the spring, now settling into a slow-burn nostalgia format.',
    platforms: ['TikTok', 'YouTube', 'X'],
    sentiment: 'neutral',
    signals: 'Past its peak but still a reliable format',
    source: 'https://en.wikipedia.org/wiki/2026_is_the_new_2016',
    vi: 410,
    shape: 'falling',
  },
  {
    name: 'The Ancestor Photo Prank',
    type: 'trend',
    category: 'memes',
    label: 'prank format',
    description:
      'Send your parents a fake vintage photo of a celebrity and claim it is a family ancestor from the 1800s. The reaction texts are the content.',
    platforms: ['TikTok', 'Instagram'],
    sentiment: 'positive',
    signals: 'Low effort, high share rate; screenshots of the replies travel',
    source: 'https://www.ramd.am/blog/trends-tiktok',
    vi: 350,
    shape: 'rising',
  },
];

// --- CLI ------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const USER_ID = flag('--user') ?? process.env.SEED_USER_ID ?? null;
const OUT_DIR = flag('--out') ?? path.join(process.cwd(), '.seed-preview');

const STORAGE_BUCKET = 'captures';
const UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36';

// --- Images ---------------------------------------------------------------

async function fetchBytes(url, accept) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(10_000),
    headers: { 'user-agent': UA, accept, 'accept-language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType, finalUrl: res.url };
}

function ogImage(html) {
  for (const m of html.matchAll(/<meta\s+([^>]+?)\/?>/gi)) {
    const attrs = m[1];
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.toLowerCase();
    if (!key) continue;
    if (['og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'].includes(key)) {
      const content = /content\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
      if (content) return content.replace(/&amp;/g, '&');
    }
  }
  return null;
}

// og:image of the source page, or null when the site won't give us one.
async function fetchSourceImage(source) {
  const page = await fetchBytes(source, 'text/html,image/*;q=0.9,*/*;q=0.1');
  if (page.contentType.startsWith('image/')) return page;
  const img = ogImage(page.buffer.toString('utf8'));
  if (!img) throw new Error('no og:image');
  const abs = new URL(img, page.finalUrl).toString();
  const res = await fetchBytes(abs, 'image/*');
  if (!res.contentType.startsWith('image/')) throw new Error(`og:image is ${res.contentType}`);
  if (res.buffer.byteLength > 5_000_000) throw new Error('og:image over 5MB');
  return res;
}

const PALETTE = [
  ['#00D4FF', '#0066FF'],
  ['#FF00E5', '#7A00B8'],
  ['#FFE500', '#FF7A00'],
  ['#00D4FF', '#FF00E5'],
];

// Fallback card in the ATNX palette; the market still needs a thumbnail.
function fallbackCard(item, i) {
  const [a, b] = PALETTE[i % PALETTE.length];
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const words = item.name.split(' ');
  const lines = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && (last + ' ' + w).length <= 18) lines[lines.length - 1] = last + ' ' + w;
    else lines.push(w);
  }
  const text = lines
    .map((l, j) => `<tspan x="60" dy="${j === 0 ? 0 : 64}">${esc(l)}</tspan>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
  <rect width="1200" height="630" fill="#0f0f0f"/>
  <rect x="24" y="24" width="1152" height="582" rx="28" fill="url(#g)" opacity="0.92"/>
  <text x="60" y="110" font-family="ui-monospace,monospace" font-size="26" letter-spacing="6" fill="rgba(10,10,10,0.7)">${esc(item.label.toUpperCase())}</text>
  <text x="60" y="${330 - (lines.length - 1) * 32}" font-family="ui-monospace,monospace" font-size="60" font-weight="700" fill="#0a0a0a">${text}</text>
  <text x="60" y="560" font-family="ui-monospace,monospace" font-size="24" fill="rgba(10,10,10,0.7)">${esc(item.platforms.join(' · '))}</text>
</svg>`;
  return { buffer: Buffer.from(svg), contentType: 'image/svg+xml' };
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };

// --- Fake history -----------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 42 points over the last 7 days (every 4h), ending at `vi`. The dashboard
// buckets trend from the last 6 points vs the 6 before, so each shape is
// built around that window (see buildTrendsView in lib/store.ts).
function fakeSeries(item, seed) {
  const rand = mulberry32(seed);
  const n = 42;
  const now = Date.now();
  const step = (7 * 86_400_000) / (n - 1);
  const noise = () => 1 + (rand() - 0.5) * 0.08;
  return Array.from({ length: n }, (_, i) => {
    const tail = Math.max(0, (i - (n - 7)) / 6); // 0 until the last 6 points, then 0..1
    const ramp = Math.max(0, (i - (n - 12)) / 11); // 0 until the last 12 points, then 0..1
    let v;
    switch (item.shape) {
      case 'spiking':
        v = item.vi * (0.28 + 0.72 * tail * tail);
        break;
      case 'rising':
        // flat, then the last two days climb ~25% into the current VI
        v = item.vi * (0.68 + 0.32 * ramp);
        break;
      case 'falling':
        // peaked, then the last two days give back ~22%
        v = item.vi * (1.6 - 0.6 * ramp);
        break;
      case 'new':
        v = i < n - 6 ? 0 : item.vi * (0.5 + 0.5 * tail);
        break;
      default:
        v = item.vi;
    }
    const last = i === n - 1;
    const value = last ? item.vi : Math.max(0, Math.round(v * (v === 0 ? 1 : noise())));
    return { vi: value, recorded_at: new Date(now - (n - 1 - i) * step).toISOString() };
  });
}

// --- Main -------------------------------------------------------------------

for (const item of TRENDING) {
  if (!CATEGORIES.includes(item.category)) {
    throw new Error(`${item.name}: category "${item.category}" is not one of ${CATEGORIES.join(', ')}`);
  }
}

function analysisFor(item) {
  return {
    type: item.type,
    name: item.name,
    description: item.description,
    category: item.category,
    platforms_detected: item.platforms,
    metrics_detected: {},
    sentiment: item.sentiment,
    virality_signals: item.signals,
    raw_text: '',
    _meta: { page_title: item.name, captured_at: null, seeded: true },
  };
}

async function main() {
  let supabase = null;
  if (!DRY_RUN) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      console.error(
        'Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Run via `npm run seed:trending` so .env.local is loaded, or pass --dry-run.'
      );
      process.exit(1);
    }
    supabase = createClient(url, key, { auth: { persistSession: false } });
  } else {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    console.log(`dry run: images and rows go to ${OUT_DIR}\n`);
  }

  let created = 0;
  let skipped = 0;
  for (const [i, item] of TRENDING.entries()) {
    const slug = item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const normalized = item.name.toLowerCase().trim();

    if (supabase) {
      const { data: matches, error } = await supabase.rpc('find_similar_market', {
        query_name: normalized,
        threshold: 0.85,
      });
      if (error) throw error;
      if (matches?.[0]) {
        console.log(`skip    ${item.name}  (exists as "${matches[0].entity_name}")`);
        skipped++;
        continue;
      }
    }

    let image;
    let imageNote = 'og:image';
    try {
      image = await fetchSourceImage(item.source);
    } catch (e) {
      image = fallbackCard(item, i);
      imageNote = `fallback card (${e.message})`;
    }
    const ext = EXT[image.contentType] ?? 'png';

    // Spread captures across the last day so the feed isn't one timestamp.
    const capturedAt = new Date(Date.now() - (i * 97 + 13) * 60_000).toISOString();
    const series = fakeSeries(item, i + 1);
    const analysis = analysisFor(item);
    analysis._meta.captured_at = capturedAt;

    if (!supabase) {
      fs.writeFileSync(path.join(OUT_DIR, `${slug}.${ext}`), image.buffer);
      fs.writeFileSync(
        path.join(OUT_DIR, `${slug}.json`),
        JSON.stringify({ market: { entity_name: item.name, entity_type: item.type, current_vi: item.vi }, analysis, series }, null, 2)
      );
      console.log(`preview ${item.name.padEnd(36)} VI ${String(item.vi).padStart(3)}  ${item.shape.padEnd(8)} ${imageNote}`);
      created++;
      continue;
    }

    const filePath = `${USER_ID ?? 'seed'}/${slug}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(filePath, image.buffer, { contentType: image.contentType, upsert: true });
    if (upErr) throw new Error(`upload ${item.name}: ${upErr.message}`);
    const imageUrl = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(filePath).data.publicUrl;

    const { data: market, error: mErr } = await supabase
      .from('markets')
      .insert({
        entity_name: item.name,
        entity_name_normalized: normalized,
        entity_type: item.type,
        category: item.category,
        thumbnail_url: imageUrl,
        current_vi: item.vi,
        vi_last_updated: new Date().toISOString(),
        total_captures: 1,
      })
      .select('id')
      .single();
    if (mErr) throw new Error(`market ${item.name}: ${mErr.message}`);

    const { error: cErr } = await supabase.from('captures').insert({
      user_id: USER_ID,
      market_id: market.id,
      image_url: imageUrl,
      source_url: item.source,
      ocr_text: null,
      raw_ai_response: analysis,
      confidence_score: null,
      resolution_status: 'resolved',
      created_at: capturedAt,
    });
    if (cErr) throw new Error(`capture ${item.name}: ${cErr.message}`);

    const { error: hErr } = await supabase
      .from('vi_history')
      .insert(series.map((p) => ({ market_id: market.id, ...p })));
    if (hErr) throw new Error(`vi_history ${item.name}: ${hErr.message}`);

    console.log(`created ${item.name.padEnd(36)} VI ${String(item.vi).padStart(3)}  ${item.shape.padEnd(8)} ${imageNote}`);
    created++;
  }

  console.log(`\n${DRY_RUN ? 'previewed' : 'created'} ${created}, skipped ${skipped}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
