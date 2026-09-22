// CORS for endpoints the Chrome extension calls with `credentials: 'include'`.
// Credentialed CORS requires echoing the caller's Origin (never `*`) so the
// browser attaches the Supabase auth cookie on the cross-origin request.
//
// Only origins on the allowlist are echoed. Echoing every Origin, as this
// used to, let any web page read a signed-in visitor's /api/portfolio and
// post captures as them. The list is the app's own hosts plus whatever
// CORS_ALLOWED_ORIGINS names (comma-separated), which is where the
// extension's `chrome-extension://<id>` origin goes.

const OWN_ORIGINS = ['https://www.atnx.app', 'https://atnx.app'];

function allowedOrigins(): Set<string> {
  const extra = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const dev = process.env.NODE_ENV !== 'production' ? ['http://localhost:3000'] : [];
  return new Set([...OWN_ORIGINS, ...extra, ...dev]);
}

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins().has(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

export function corsPreflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
