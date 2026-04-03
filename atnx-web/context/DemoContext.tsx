"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";

export interface Position {
  id: string;
  type: "long" | "short";
  name: string;
  category: string;
  entryIndex: number;
  currentIndex: number;
  size: number;
  openedAt: string;
  captureId: string;
}

interface DemoState {
  positions: Position[];
  balance: number;
  isLiveMode: boolean;
}

interface DemoContextType extends DemoState {
  openPosition: (pos: Omit<Position, "id">) => void;
  closePosition: (id: string) => Position | null;
  updateCurrentIndex: (name: string, newIndex: number) => void;
  setLiveMode: (enabled: boolean) => void;
}

const DEMO_POSITIONS: Position[] = [
  {
    id: "demo-1",
    type: "long",
    name: "Chainsaw Man",
    category: "entertainment",
    entryIndex: 310,
    currentIndex: 426,
    size: 500,
    openedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    captureId: "",
  },
  {
    id: "demo-2",
    type: "short",
    name: "Say Wallahi",
    category: "entertainment",
    entryIndex: 460,
    currentIndex: 424,
    size: 200,
    openedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    captureId: "",
  },
  {
    id: "demo-3",
    type: "long",
    name: "Leon Kennedy One Liners",
    category: "entertainment",
    entryIndex: 590,
    currentIndex: 585,
    size: 100,
    openedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    captureId: "",
  },
];

const INITIAL_BALANCE = 10000;
const STORAGE_KEY = "atnx-demo-state";

const DemoContext = createContext<DemoContextType | null>(null);

export function useDemoContext() {
  const ctx = useContext(DemoContext);
  if (!ctx) throw new Error("useDemoContext must be used within DemoProvider");
  return ctx;
}

function loadState(): DemoState {
  if (typeof window === "undefined") {
    return {
      positions: DEMO_POSITIONS,
      balance: INITIAL_BALANCE,
      isLiveMode: false,
    };
  }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return {
    positions: DEMO_POSITIONS,
    balance: INITIAL_BALANCE,
    isLiveMode: false,
  };
}

function saveState(state: DemoState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

export function DemoProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DemoState>(loadState);

  useEffect(() => {
    saveState(state);
  }, [state]);

  // Check URL param for demo mode
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("demo") === "true") {
      setState((s) => ({ ...s, isLiveMode: true }));
    }
  }, []);

  const openPosition = useCallback(
    (pos: Omit<Position, "id">) => {
      const newPos: Position = { ...pos, id: `pos-${Date.now()}` };
      setState((s) => ({
        ...s,
        positions: [...s.positions, newPos],
        balance: s.balance - pos.size,
      }));
    },
    []
  );

  const closePosition = useCallback((id: string): Position | null => {
    let closed: Position | null = null;
    setState((s) => {
      const pos = s.positions.find((p) => p.id === id);
      if (!pos) return s;
      closed = pos;
      const pnl = calculatePnL(pos);
      return {
        ...s,
        positions: s.positions.filter((p) => p.id !== id),
        balance: s.balance + parseFloat(pnl.currentValue),
      };
    });
    return closed;
  }, []);

  const updateCurrentIndex = useCallback(
    (name: string, newIndex: number) => {
      setState((s) => ({
        ...s,
        positions: s.positions.map((p) =>
          p.name === name ? { ...p, currentIndex: newIndex } : p
        ),
      }));
    },
    []
  );

  const setLiveMode = useCallback((enabled: boolean) => {
    setState((s) => ({ ...s, isLiveMode: enabled }));
  }, []);

  return (
    <DemoContext.Provider
      value={{
        ...state,
        openPosition,
        closePosition,
        updateCurrentIndex,
        setLiveMode,
      }}
    >
      {children}
    </DemoContext.Provider>
  );
}

export function calculatePnL(position: Position) {
  const indexChange = position.currentIndex - position.entryIndex;
  const changePercent = (indexChange / position.entryIndex) * 100;
  const direction = position.type === "long" ? 1 : -1;
  const pnlPercent = changePercent * direction;
  const pnlAmount = position.size * (pnlPercent / 100);
  const currentValue = position.size + pnlAmount;

  return {
    pnlPercent: pnlPercent.toFixed(2),
    pnlAmount: pnlAmount.toFixed(2),
    currentValue: currentValue.toFixed(2),
    isProfit: pnlAmount >= 0,
  };
}
