import { createAdminClient } from '@/lib/supabase/admin';

// The profile row behind an auth user: a generated handle, the sign-in
// methods seen so far, and (for wallet sign-in) the address. Shared by
// the OAuth callback and the wallet sign-in action.
export async function ensureUserProfile(
  userId: string,
  email: string | null | undefined,
  methods: string[],
  walletAddress?: string | null,
) {
  const admin = createAdminClient();

  const { data: existing } = await admin
    .from('user_profiles')
    .select('id, auth_methods, wallet_address')
    .eq('id', userId)
    .maybeSingle();

  if (existing) {
    const current = (existing.auth_methods as string[] | null) ?? [];
    const patch: { auth_methods?: string[]; wallet_address?: string } = {};
    if (methods.some((m) => !current.includes(m))) patch.auth_methods = [...new Set([...current, ...methods])];
    if (walletAddress && existing.wallet_address !== walletAddress) patch.wallet_address = walletAddress;
    if (Object.keys(patch).length) {
      await admin.from('user_profiles').update(patch).eq('id', userId);
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
      wallet_address: walletAddress ?? null,
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
