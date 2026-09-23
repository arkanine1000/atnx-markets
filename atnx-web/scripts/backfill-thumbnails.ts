// Curates images for the highlighted markets now, instead of waiting for
// the hourly slow refresh to work through them a dozen at a time.
//   npm run thumbs:backfill            # up to 100 markets
//   npm run thumbs:backfill -- 20      # cap the pass
// Needs migration 008 and the service role key in .env.local.
import { refreshThumbnails } from '../lib/thumbnails';

const limit = Number(process.argv[2] ?? 100);

(async () => {
  const t0 = Date.now();
  const { log, ...counts } = await refreshThumbnails(limit);
  for (const line of log) console.log(line);
  console.log(`\n${JSON.stringify(counts)}  ${Date.now() - t0} ms`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
