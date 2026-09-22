// Next.js 16 renamed `middleware` to `proxy`. Same semantics.
// This file refreshes the Supabase auth cookie on page requests and gates
// access to protected app routes.
//
// It does not run for /api: those handlers check the user themselves when
// they need one (captures POST, portfolio) or take a bearer token (cron),
// and the public feed needs no user at all. Running here too meant every
// dashboard poll cost a round trip to Supabase Auth before it started.
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { crossOriginCookieOptions } from '@/lib/supabase/cookie-options';

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, crossOriginCookieOptions(options))
          );
        },
      },
    }
  );

  const path = request.nextUrl.pathname;
  // Guests can browse the dashboard, market detail, and portfolio (the
  // portfolio page renders its own login prompt). Only explicit user-specific
  // routes need a server-side redirect here — trading server actions and the
  // settings page enforce auth on their own.
  const isProtected =
    path.startsWith('/admin') || path.startsWith('/app/settings');
  const isAuthCallback = path.startsWith('/auth/callback');

  // IMPORTANT: do not put any code between createServerClient and this
  // block — the cookie refresh happens as a side effect of these calls.
  //
  // A protected route asks Supabase Auth who the user is (a network call,
  // the only answer worth gating on). Everywhere else the proxy only has
  // to keep the session cookie fresh, and getSession() does that without
  // a network call unless the token has actually expired. Nothing here
  // reads the session it returns.
  if (isProtected && !isAuthCallback) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      const url = request.nextUrl.clone();
      url.pathname = '/';
      url.searchParams.set('redirect', path);
      return NextResponse.redirect(url);
    }
  } else {
    await supabase.auth.getSession();
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
