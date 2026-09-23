export type Market = {
  id: string;
  canonical_entity_id: string | null;
  entity_name: string;
  entity_name_normalized: string;
  entity_type: string | null;
  thumbnail_url: string | null;
  current_vi: number;
  vi_last_updated: string | null;
  phase: number;
  is_graduated: boolean;
  total_captures: number;
  total_volume_usd: number;
  network: 'simulated' | 'devnet' | 'mainnet';
  on_chain_pda: string | null;
  trading_mode: 'sim' | 'live';
  created_by: string | null;
  deleted_at: string | null;
  created_at: string;
};

export type Capture = {
  id: string;
  user_id: string | null;
  market_id: string | null;
  image_url: string | null;
  ocr_text: string | null;
  source_url: string | null;
  raw_ai_response: Record<string, unknown> | null;
  confidence_score: number | null;
  resolution_status: 'pending' | 'resolved' | 'review' | 'new_entity';
  deleted_at: string | null;
  created_at: string;
};

export type Position = {
  id: string;
  user_id: string;
  market_id: string;
  direction: 'long' | 'short';
  size_usd: number;
  entry_vi: number;
  entry_price: number;
  leverage: number;
  network: 'simulated' | 'devnet' | 'mainnet';
  tx_signature: string | null;
  opened_at: string;
  closed_at: string | null;
  exit_vi: number | null;
  exit_price: number | null;
  realized_pnl: number | null;
  fee_usd: number;
  liquidated: boolean;
  status: 'open' | 'closed';
};

export type SimBalance = {
  user_id: string;
  balance_usd: number;
  total_pnl_realized: number;
  total_trades: number;
  fees_earned_usd: number;
  fees_paid_usd: number;
  updated_at: string;
};

export type SimTreasury = {
  id: number;
  balance_usd: number;
  fee_count: number;
  updated_at: string;
};

export type UserProfile = {
  id: string;
  handle: string;
  email: string | null;
  avatar_url: string | null;
  wallet_address: string | null;
  auth_methods: string[];
  role: 'user' | 'admin' | 'moderator';
  created_at: string;
  updated_at: string;
};

export type ViHistoryPoint = {
  id: number;
  market_id: string;
  vi: number;
  recorded_at: string;
};
