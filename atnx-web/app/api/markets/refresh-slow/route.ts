import { runRefresh } from '../refresh/route';

// Slow refresh, hourly (vercel.json): GDELT news volume and Wikipedia
// pageviews, both daily-resolution sources that also rate-limit hard.
// GDELT calls are serialised at one per 5 s, so this route needs the
// long budget: 200 markets is ~17 minutes.
export const dynamic = 'force-dynamic';
export const maxDuration = 800;

export async function GET(request: Request) {
  return runRefresh(request, 'slow');
}
