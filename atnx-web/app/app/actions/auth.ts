'use server';

import { isAddress } from 'viem';
import { createClient } from '@/lib/supabase/server';
import { ensureUserProfile } from '@/lib/auth/profile';

// After supabase.auth.signInWithWeb3 in the browser: make sure the user
// has a profile row with its wallet address. The address is taken from
// the wallet that signed in, as the session carries it, and only falls
// back to what the browser says when the identity data lacks it.
export async function ensureWalletProfile(claimedAddress: string): Promise<{ ok: boolean; handle?: string; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in' };
  const web3 = user.identities?.find((i) => i.provider === 'web3');
  const fromIdentity = (web3?.identity_data as { address?: string } | undefined)?.address;
  const address = fromIdentity && isAddress(fromIdentity) ? fromIdentity : isAddress(claimedAddress) ? claimedAddress : null;
  await ensureUserProfile(user.id, user.email, ['wallet'], address ? address.toLowerCase() : null);
  const { data: profile } = await supabase.from('user_profiles').select('handle').eq('id', user.id).maybeSingle();
  return { ok: true, handle: profile?.handle ?? undefined };
}
