import { createBrowserClient } from '@supabase/ssr';
import type { Database } from './database';
import { crossOriginCookieOptions } from './cookie-options';

// The browser client rewrites the auth cookie on every client-side token
// refresh. Without these options it would use the library default
// (SameSite=Lax) and undo the SameSite=None the server sets, so the Chrome
// extension's cross-origin fetches would start getting 401 about an hour
// after sign-in.
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookieOptions: crossOriginCookieOptions(undefined) }
  );
}
