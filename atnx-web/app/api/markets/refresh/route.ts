import { runRefresh } from '@/lib/vi/refresh-job';

// Fast VI refresh (lib/vi/refresh-job.ts). No cron triggers it in this
// fork; it stays callable by hand with the fork's own CRON_SECRET.
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: Request) {
  return runRefresh(request, 'fast');
}
