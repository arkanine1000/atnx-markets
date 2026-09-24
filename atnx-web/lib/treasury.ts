import { createAdminClient } from './supabase/admin';

// The simulated treasury: half of every trading fee (all of it on a market
// with no known creator). One row, kept by open_position() in
// supabase/009. Shown on the admin dashboard's Trading tab.
export interface Treasury {
  balanceUsd: number;
  feeCount: number;
  updatedAt: string | null;
}

export async function getTreasury(): Promise<Treasury> {
  const { data, error } = await createAdminClient()
    .from('sim_treasury')
    .select('balance_usd, fee_count, updated_at')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;
  return {
    balanceUsd: Number(data?.balance_usd ?? 0),
    feeCount: Number(data?.fee_count ?? 0),
    updatedAt: data?.updated_at ?? null,
  };
}
