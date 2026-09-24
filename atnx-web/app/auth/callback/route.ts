import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { NextResponse } from 'next/server';

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

async function ensureUserProfile(
  userId: string,
  email: string | null | undefined,
  methods: string[],
) {
  const admin = createAdminClient();

  const { data: existing } = await admin
    .from('user_profiles')
    .select('id, auth_methods')
    .eq('id', userId)
    .maybeSingle();

  if (existing) {
    const current = (existing.auth_methods as string[] | null) ?? [];
    if (methods.some((m) => !current.includes(m))) {
      await admin
        .from('user_profiles')
        .update({ auth_methods: [...new Set([...current, ...methods])] })
        .eq('id', userId);
    }
    return;
  }

  // Generate a default handle in the Attn_seeker#XXXX pattern. Collisions are
  // unlikely at our scale; if the unique constraint rejects, retry with a new
  // suffix a few times before giving up (the user can edit in settings).
  for (let i = 0; i < 5; i++) {
    const handle = `Attn_seeker#${Math.floor(1000 + Math.random() * 9000)}`;
    const { error: insertErr } = await admin.from('user_profiles').insert({
      id: userId,
      handle,
      email: email ?? null,
      auth_methods: methods,
    });
    if (!insertErr) break;
    if (insertErr.code !== '23505') throw insertErr;
  }

  await admin
    .from('sim_balances')
    .insert({ user_id: userId })
    .select()
    .maybeSingle();
}
