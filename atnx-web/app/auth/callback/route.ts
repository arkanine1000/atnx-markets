import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { ensureUserProfile } from '@/lib/auth/profile';

// Exchanges the OAuth `code` for a Supabase session and, defensively, ensures
// a user_profiles + sim_balances row exists for the newly-authed user. The DB
// should have triggers that do this automatically; this is a safety net.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const redirect = safeRedirect(searchParams.get('redirect'));

  if (!code) {
    return NextResponse.redirect(`${origin}/?error=missing_code`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/?error=auth_failed`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    // Every provider linked to this user. Supabase links an X login to an
    // existing Google user with the same verified email, so this can grow.
    const methods = (user.app_metadata.providers as string[] | undefined) ?? [
      user.app_metadata.provider ?? 'google',
    ];
    await ensureUserProfile(user.id, user.email, methods);
  }

  return NextResponse.redirect(`${origin}${redirect}`);
}

// Only a path on this site. `//evil.com`, `@evil.com` and backslash
// variants would otherwise turn `${origin}${redirect}` into an open
// redirect after a successful login.
function safeRedirect(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/app';
  if (/[@\\]/.test(value)) return '/app';
  return value;
}
