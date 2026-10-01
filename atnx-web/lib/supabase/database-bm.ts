// Types for the `bm` schema (supabase/bm/001_schema.sql): the registry of
// bounded VI markets and the keeper's log. Hand-maintained like
// database.ts. Read through createAdminClient().schema('bm') on the server
// and createClient().schema('bm') in the browser; the schema has to be
// exposed in the project's API settings for either to work.

import type { Json } from './database';

export type BmMarketState = 'pending' | 'open' | 'resolving' | 'resolved' | 'failed';
export type BmSide = 'up' | 'down';

export interface BmMarketRow {
  id: string;
  atnx_market_id: string;
  chain: string;
  contract_address: string;
  onchain_market_id: string | null;
  start_vi: number;
  lower_bound: number;
  upper_bound: number;
  seed_usdg: number;
  initial_up_bps: number;
  state: BmMarketState;
  resolved_side: BmSide | null;
  resolved_vi: number | null;
  resolved_at: string | null;
  create_tx: string | null;
  created_block: number | null;
  resolve_tx: string | null;
  keeper_cursor: number;
  streak_side: BmSide | null;
  streak_count: number;
  opened_by: string | null;
  opened_by_wallet: string | null;
  rolled_from: string | null;
  roll: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface BmKeeperLogRow {
  id: number;
  run_id: string;
  bm_market_id: string | null;
  action: string;
  detail: Json | null;
  error: string | null;
  tx_hash: string | null;
  created_at: string;
}

type Optional<T> = { [K in keyof T]?: T[K] };

export type BmSchema = {
  Tables: {
    markets: {
      Row: BmMarketRow;
      Insert: Optional<BmMarketRow> & {
        atnx_market_id: string;
        chain: string;
        contract_address: string;
        start_vi: number;
        lower_bound: number;
        upper_bound: number;
        seed_usdg: number;
      };
      Update: Optional<BmMarketRow>;
      Relationships: [];
    };
    keeper_log: {
      Row: BmKeeperLogRow;
      Insert: Optional<BmKeeperLogRow> & { run_id: string; action: string };
      Update: Optional<BmKeeperLogRow>;
      Relationships: [];
    };
  };
  Views: Record<string, never>;
  Functions: Record<string, never>;
  Enums: Record<string, never>;
  CompositeTypes: Record<string, never>;
};
