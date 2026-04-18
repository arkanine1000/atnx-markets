// Minimal Supabase Database type used to parameterize the JS clients so query
// results aren't typed as `never`. Expand as new tables/columns get touched.

type EmptyRelationships = [];

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: '12';
  };
  public: {
    Tables: {
      markets: {
        Row: {
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
          deleted_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          canonical_entity_id?: string | null;
          entity_name: string;
          entity_name_normalized: string;
          entity_type?: string | null;
          thumbnail_url?: string | null;
          current_vi?: number;
          vi_last_updated?: string | null;
          phase?: number;
          is_graduated?: boolean;
          total_captures?: number;
          total_volume_usd?: number;
          network?: 'simulated' | 'devnet' | 'mainnet';
          on_chain_pda?: string | null;
          trading_mode?: 'sim' | 'live';
          deleted_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          canonical_entity_id?: string | null;
          entity_name?: string;
          entity_name_normalized?: string;
          entity_type?: string | null;
          thumbnail_url?: string | null;
          current_vi?: number;
          vi_last_updated?: string | null;
          phase?: number;
          is_graduated?: boolean;
          total_captures?: number;
          total_volume_usd?: number;
          network?: 'simulated' | 'devnet' | 'mainnet';
          on_chain_pda?: string | null;
          trading_mode?: 'sim' | 'live';
          deleted_at?: string | null;
          created_at?: string;
        };
        Relationships: EmptyRelationships;
      };
      captures: {
        Row: {
          id: string;
          user_id: string | null;
          market_id: string | null;
          image_url: string | null;
          ocr_text: string | null;
          source_url: string | null;
          raw_ai_response: Record<string, unknown> | null;
          embedding_text: number[] | null;
          embedding_image: number[] | null;
          perceptual_hash: number | null;
          confidence_score: number | null;
          resolution_status: 'pending' | 'resolved' | 'review' | 'new_entity';
          deleted_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          market_id?: string | null;
          image_url?: string | null;
          ocr_text?: string | null;
          source_url?: string | null;
          raw_ai_response?: Record<string, unknown> | null;
          embedding_text?: number[] | null;
          embedding_image?: number[] | null;
          perceptual_hash?: number | null;
          confidence_score?: number | null;
          resolution_status?: 'pending' | 'resolved' | 'review' | 'new_entity';
          deleted_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          market_id?: string | null;
          image_url?: string | null;
          ocr_text?: string | null;
          source_url?: string | null;
          raw_ai_response?: Record<string, unknown> | null;
          embedding_text?: number[] | null;
          embedding_image?: number[] | null;
          perceptual_hash?: number | null;
          confidence_score?: number | null;
          resolution_status?: 'pending' | 'resolved' | 'review' | 'new_entity';
          deleted_at?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'captures_market_id_fkey';
            columns: ['market_id'];
            isOneToOne: false;
            referencedRelation: 'markets';
            referencedColumns: ['id'];
          },
        ];
      };
      vi_history: {
        Row: {
          id: number;
          market_id: string;
          vi: number;
          recorded_at: string;
        };
        Insert: {
          id?: number;
          market_id: string;
          vi: number;
          recorded_at?: string;
        };
        Update: {
          id?: number;
          market_id?: string;
          vi?: number;
          recorded_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'vi_history_market_id_fkey';
            columns: ['market_id'];
            isOneToOne: false;
            referencedRelation: 'markets';
            referencedColumns: ['id'];
          },
        ];
      };
      user_profiles: {
        Row: {
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
        Insert: {
          id: string;
          handle: string;
          email?: string | null;
          avatar_url?: string | null;
          wallet_address?: string | null;
          auth_methods?: string[];
          role?: 'user' | 'admin' | 'moderator';
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          handle?: string;
          email?: string | null;
          avatar_url?: string | null;
          wallet_address?: string | null;
          auth_methods?: string[];
          role?: 'user' | 'admin' | 'moderator';
          created_at?: string;
          updated_at?: string;
        };
        Relationships: EmptyRelationships;
      };
      sim_balances: {
        Row: {
          user_id: string;
          balance_usd: number;
          total_pnl_realized: number;
          total_trades: number;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          balance_usd?: number;
          total_pnl_realized?: number;
          total_trades?: number;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          balance_usd?: number;
          total_pnl_realized?: number;
          total_trades?: number;
          updated_at?: string;
        };
        Relationships: EmptyRelationships;
      };
      positions: {
        Row: {
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
          status: 'open' | 'closed';
        };
        Insert: {
          id?: string;
          user_id: string;
          market_id: string;
          direction: 'long' | 'short';
          size_usd: number;
          entry_vi: number;
          entry_price: number;
          leverage?: number;
          network?: 'simulated' | 'devnet' | 'mainnet';
          tx_signature?: string | null;
          opened_at?: string;
          closed_at?: string | null;
          exit_vi?: number | null;
          exit_price?: number | null;
          realized_pnl?: number | null;
          status?: 'open' | 'closed';
        };
        Update: {
          id?: string;
          user_id?: string;
          market_id?: string;
          direction?: 'long' | 'short';
          size_usd?: number;
          entry_vi?: number;
          entry_price?: number;
          leverage?: number;
          network?: 'simulated' | 'devnet' | 'mainnet';
          tx_signature?: string | null;
          opened_at?: string;
          closed_at?: string | null;
          exit_vi?: number | null;
          exit_price?: number | null;
          realized_pnl?: number | null;
          status?: 'open' | 'closed';
        };
        Relationships: EmptyRelationships;
      };
      moderation_log: {
        Row: {
          id: string;
          admin_user_id: string;
          action: string;
          target_type: string;
          target_id: string;
          reason: string | null;
          metadata: Record<string, unknown> | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          admin_user_id: string;
          action: string;
          target_type: string;
          target_id: string;
          reason?: string | null;
          metadata?: Record<string, unknown> | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          admin_user_id?: string;
          action?: string;
          target_type?: string;
          target_id?: string;
          reason?: string | null;
          metadata?: Record<string, unknown> | null;
          created_at?: string;
        };
        Relationships: EmptyRelationships;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
