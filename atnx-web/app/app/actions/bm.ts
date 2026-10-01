'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { openBoundedMarket, type OpenResult } from '@/lib/bm/open';

// "Open UP/DOWN market" on a market page. Needs a signed-in atnx account
// (the wallet is for trading, not for opening); the seed comes from the
// treasury wallet, so opening costs the user nothing on the testnet.
export async function openBoundedMarketAction(atnxMarketId: string, chainKey: string): Promise<OpenResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Sign in to open a market', code: 'chain' };
  if (typeof atnxMarketId !== 'string' || typeof chainKey !== 'string') {
    return { ok: false, error: 'Bad request', code: 'chain' };
  }
  const result = await openBoundedMarket({ atnxMarketId, chainKey, openedBy: user.id });
  if (result.ok) {
    revalidatePath(`/app/markets/${atnxMarketId}`);
    revalidatePath('/app');
  }
  return result;
}
