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

interface DemoContextType {
  positions: Position[];
  balance: number;
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
  const [positions, setPositions] = useState<Position[]>([]);
  const [balance, setBalance] = useState<number>(INITIAL_BALANCE);
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
      setLoading(false);
      return;
    }

    const [{ data: bal }, { data: pos }] = await Promise.all([
      supabase
        .from("sim_balances")
        .select("balance_usd")
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

    if (bal) setBalance(bal.balance_usd);
    setPositions((pos ?? []).map(mapRow));
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
  // Linear VI-based PnL that matches the server's close math.
  const entry = position.entryIndex || 1;
  const ratio = position.currentIndex / entry;
  const directional = position.type === "long" ? ratio - 1 : 1 - ratio;
  const pnlAmount = position.size * directional * position.leverage;
  const pnlPercent = directional * position.leverage * 100;
  const currentValue = position.size + pnlAmount;

  return {
    pnlPercent: pnlPercent.toFixed(2),
    pnlAmount: pnlAmount.toFixed(2),
    currentValue: currentValue.toFixed(2),
    isProfit: pnlAmount >= 0,
  };
}
