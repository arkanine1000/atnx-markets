"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { positionPnl } from "@/lib/pnl";
import {
  openPosition as serverOpenPosition,
  closePosition as serverClosePosition,
  type OpenPositionInput,
} from "@/app/app/actions/trading";

export interface Position {
  id: string;
  marketId: string;
  type: "long" | "short";
  name: string;
  category: string;
  entryIndex: number;
  currentIndex: number;
  size: number;
  leverage: number;
  openedAt: string;
  captureId: string;
}

// Fee totals from sim_balances: what this account has earned as the
// creator of markets others trade on (already in `balance`) and what it
// has paid on its own opens.
export interface FeeTotals {
  earned: number;
  paid: number;
}

interface DemoContextType {
  positions: Position[];
  balance: number;
  fees: FeeTotals;
  isLiveMode: boolean;
  loading: boolean;
  openPosition: (input: OpenPositionArgs) => Promise<OpenPositionOutcome>;
  closePosition: (id: string) => Promise<Position | null>;
  updateCurrentIndex: (name: string, newIndex: number) => void;
  setLiveMode: (enabled: boolean) => void;
  refresh: () => Promise<void>;
}

export interface OpenPositionArgs {
  marketId: string;
  type: "long" | "short";
  name: string;
  category: string;
  size: number;
  entryIndex: number;
  captureId: string;
  leverage?: number;
}

export type OpenPositionOutcome =
  | { ok: true }
  | { ok: false; error: string };

const INITIAL_BALANCE = 10000;
const NO_FEES: FeeTotals = { earned: 0, paid: 0 };

const DemoContext = createContext<DemoContextType | null>(null);

export function useDemoContext() {
  const ctx = useContext(DemoContext);
  if (!ctx) throw new Error("useDemoContext must be used within DemoProvider");
  return ctx;
}

type PositionRow = {
  id: string;
  market_id: string;
  direction: "long" | "short";
  size_usd: number;
  entry_vi: number;
  leverage: number;
  opened_at: string;
  market: {
    id: string;
    entity_name: string;
    entity_type: string | null;
    current_vi: number;
  } | null;
};

function mapRow(row: PositionRow): Position {
  const currentVi = row.market?.current_vi ?? row.entry_vi;
  return {
    id: row.id,
    marketId: row.market_id,
    type: row.direction,
    name: row.market?.entity_name ?? "Unknown",
    category: row.market?.entity_type ?? "other",
    entryIndex: Math.round(row.entry_vi),
    currentIndex: Math.round(currentVi),
    size: row.size_usd,
    leverage: row.leverage,
    openedAt: row.opened_at,
    captureId: "",
  };
}

export function DemoProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [positions, setPositions] = useState<Position[]>([]);
  const [balance, setBalance] = useState<number>(INITIAL_BALANCE);
  const [fees, setFees] = useState<FeeTotals>(NO_FEES);
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setPositions([]);
      setBalance(INITIAL_BALANCE);
      setFees(NO_FEES);
      setLoading(false);
      return;
    }

    const [{ data: bal }, { data: pos }] = await Promise.all([
      supabase
        .from("sim_balances")
        .select("balance_usd, fees_earned_usd, fees_paid_usd")
        .eq("user_id", user.id)
        .maybeSingle(),
      supabase
        .from("positions")
        .select(
          "id, market_id, direction, size_usd, entry_vi, leverage, opened_at, market:markets(id, entity_name, entity_type, current_vi)"
        )
        .eq("user_id", user.id)
        .eq("status", "open")
        .order("opened_at", { ascending: false })
        .returns<PositionRow[]>(),
    ]);

    if (bal) {
      setBalance(bal.balance_usd);
      setFees({
        earned: Number(bal.fees_earned_usd ?? 0),
        paid: Number(bal.fees_paid_usd ?? 0),
      });
    }
    setPositions((pos ?? []).map(mapRow));
    setLoading(false);
  }, []);

  // Re-run refresh whenever the auth state settles or flips between users.
  useEffect(() => {
    if (authLoading) return;
    refresh();
  }, [user?.id, authLoading, refresh]);

  // Check URL param for demo (live) mode — purely a UI ticker toggle.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("demo") === "true") setIsLiveMode(true);
  }, []);

  const openPosition = useCallback(
    async (input: OpenPositionArgs): Promise<OpenPositionOutcome> => {
      const payload: OpenPositionInput = {
        marketId: input.marketId,
        direction: input.type,
        sizeUsd: input.size,
        leverage: input.leverage,
      };
      const res = await serverOpenPosition(payload);
      if (!res.success) return { ok: false, error: res.error ?? "Unknown error" };
      await refresh();
      return { ok: true };
    },
    [refresh]
  );

  const closePosition = useCallback(
    async (id: string): Promise<Position | null> => {
      // Snapshot the position view model BEFORE the server mutates it so the
      // close modal can show the user the entry/exit numbers immediately.
      const snapshot = positions.find((p) => p.id === id) ?? null;

      const res = await serverClosePosition(id);
      if (!res.success) {
        console.error("closePosition failed:", res.error);
        return null;
      }

      // Overwrite currentIndex with the actual exit VI returned by the server
      // so calculatePnL() lines up with realizedPnl.
      const closed =
        snapshot && res.exitVi !== undefined
          ? { ...snapshot, currentIndex: Math.round(res.exitVi) }
          : snapshot;

      await refresh();
      return closed;
    },
    [positions, refresh]
  );

  // Live mode: in-memory-only shimmer of currentIndex for flair. Does NOT
  // persist — it just drives the sparkline animation.
  const updateCurrentIndex = useCallback(
    (name: string, newIndex: number) => {
      setPositions((prev) =>
        prev.map((p) =>
          p.name === name ? { ...p, currentIndex: newIndex } : p
        )
      );
    },
    []
  );

  const setLiveMode = useCallback((enabled: boolean) => {
    setIsLiveMode(enabled);
  }, []);

  return (
    <DemoContext.Provider
      value={{
        positions,
        balance,
        fees,
        isLiveMode,
        loading,
        openPosition,
        closePosition,
        updateCurrentIndex,
        setLiveMode,
        refresh,
      }}
    >
      {children}
    </DemoContext.Provider>
  );
}

export function calculatePnL(position: Position) {
  // Linear VI-based PnL floored at −size, matching the server's close math
  // (lib/pnl.ts).
  const { pnlUsd, pnlPercent, liquidated } = positionPnl({
    sizeUsd: position.size,
    entryVi: position.entryIndex,
    currentVi: position.currentIndex,
    direction: position.type,
    leverage: position.leverage,
  });
  const currentValue = position.size + pnlUsd;

  return {
    pnlPercent: pnlPercent.toFixed(2),
    pnlAmount: pnlUsd.toFixed(2),
    currentValue: currentValue.toFixed(2),
    isProfit: pnlUsd >= 0,
    liquidated,
  };
}
