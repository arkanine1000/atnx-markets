// Next.js 16 renamed `middleware` to `proxy`. Same semantics.
// This file refreshes the Supabase auth cookie on every request and gates
// access to protected app routes.
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

  // IMPORTANT: do not put any code between createServerClient and getUser —
  // the cookie refresh happens as a side effect of this call.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  // Guests can browse the dashboard, market detail, and portfolio (the
  // portfolio page renders its own login prompt). Only explicit user-specific
  // routes need a server-side redirect here — trading server actions and the
  // settings page enforce auth on their own.
  const isProtected =
    path.startsWith('/admin') || path.startsWith('/app/settings');
  const isAuthCallback = path.startsWith('/auth/callback');

  if (isProtected && !user && !isAuthCallback) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.searchParams.set('redirect', path);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
