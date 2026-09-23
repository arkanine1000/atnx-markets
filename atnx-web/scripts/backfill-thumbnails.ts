// Curates images for the highlighted markets now, instead of waiting for
// the hourly slow refresh to work through them a dozen at a time.
//   npm run thumbs:backfill                 # fill up to 100 empty slots
//   npm run thumbs:backfill -- 20           # cap the pass
//   npm run thumbs:backfill -- --redo       # also replace images the job
//                                           # chose earlier (never manual)
// Needs migration 008 and the service role key in .env.local.
import { refreshThumbnails } from '../lib/thumbnails';

const args = process.argv.slice(2);
const redo = args.includes('--redo');
const limit = Number(args.find((a) => /^\d+$/.test(a)) ?? 100);

(async () => {
  const t0 = Date.now();
  const { log, ...counts } = await refreshThumbnails({ limit, redo });
  for (const line of log) console.log(line);
  console.log(`\n${JSON.stringify(counts)}  ${Date.now() - t0} ms`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
