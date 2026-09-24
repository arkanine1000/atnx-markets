import { createAdminClient } from './supabase/admin';

// The landing page's waitlist: one email per row, written by the server.
// The form is open to anyone, so the address is checked for shape here
// and the route rate-limits by IP before it reaches this module.

export const MAX_EMAIL_LENGTH = 254;

// One @, something on both sides, a dot in the domain, no whitespace. The
// point is to reject typos and junk, not to validate RFC 5322.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Lowercased and trimmed, or null when the input is not an email address.
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH) return null;
  if (!EMAIL_RE.test(email)) return null;
  return email;
}

export type JoinResult = 'joined' | 'already';

// Inserts the address; an address already on the list answers 'already'
// rather than failing, so a repeat signup reads as a success to the person.
export async function joinWaitlist(email: string, source = 'landing'): Promise<JoinResult> {
  const { error } = await createAdminClient().from('waitlist').insert({ email, source });
  if (!error) return 'joined';
  // 23505: the unique index on the lowercased address.
  if (error.code === '23505') return 'already';
  throw error;
}

// A small per-instance sliding window: the form has no login, and a
// burst of signups from one address is a script, not a launch party.
// Serverless instances each keep their own window, which is fine for the
// bursts this exists to blunt.
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();

export function rateLimited(key: string, now = Date.now()): boolean {
  const since = now - WINDOW_MS;
  const recent = (hits.get(key) ?? []).filter((t) => t > since);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  // Keep the map from growing without bound between bursts.
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.some((t) => t > since)) hits.delete(k);
  }
  return false;
}

// The caller's address as the platform reports it; Vercel sets
// x-forwarded-for, and a missing header collapses everyone into one key.
export function clientKey(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  return fwd?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
}
