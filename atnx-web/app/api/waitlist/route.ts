import { clientKey, joinWaitlist, normalizeEmail, rateLimited } from '@/lib/waitlist';

// The landing page's Join Waitlist form. JSON body: { email }, and an
// optional `company` field that no person sees (a honeypot): when it is
// filled the request is answered as a success and nothing is stored.
// Answers { success: true, status: 'joined' | 'already' }.
export async function POST(request: Request) {
  let body: { email?: unknown; company?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Expected JSON' }, { status: 400 });
  }

  const email = normalizeEmail(body.email);
  if (!email) {
    return Response.json(
      { success: false, error: 'That does not look like an email address' },
      { status: 400 }
    );
  }
  if (typeof body.company === 'string' && body.company.trim()) {
    return Response.json({ success: true, status: 'joined' });
  }
  if (rateLimited(clientKey(request))) {
    return Response.json(
      { success: false, error: 'Too many signups from here; try again in a few minutes' },
      { status: 429 }
    );
  }

  try {
    const status = await joinWaitlist(email);
    return Response.json({ success: true, status });
  } catch (err) {
    console.error('[waitlist POST] insert failed', err);
    return Response.json(
      { success: false, error: 'Could not save that right now; try again shortly' },
      { status: 500 }
    );
  }
}
