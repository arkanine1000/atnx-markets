import type { CookieOptions } from '@supabase/ssr';

// The Chrome extension POSTs to /api/captures from a `chrome-extension://<id>`
// origin with `credentials: 'include'`. For Chrome to actually attach the
// Supabase auth cookie on that cross-site request, the cookie must be set
// with `SameSite=None; Secure`. The default @supabase/ssr behaviour is
// `SameSite=Lax`, which silently drops the cookie and yields a 401 even when
// the user is signed in on atnx.app.
//
// `Secure` is required whenever `SameSite=None` is used. Modern browsers
// treat `http://localhost` as a secure context for cookie purposes, so local
// dev keeps working without special-casing.
export function crossOriginCookieOptions(
  options: CookieOptions | undefined
): CookieOptions {
  return {
    ...(options ?? {}),
    sameSite: 'none',
    secure: true,
  };
}
