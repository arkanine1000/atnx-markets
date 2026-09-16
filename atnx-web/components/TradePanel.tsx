"use client";

import Link from "next/link";
import { useState } from "react";
import {
  useDemoContext,
  calculatePnL,
  type Position,
} from "@/context/DemoContext";
import { useAuth } from "@/context/AuthContext";
import { Card, Segmented } from "@/components/ui";

const QUICK = [25, 50, 100, 500];
const LEVERAGE = [1, 2, 5, 10] as const;
type Lev = `${(typeof LEVERAGE)[number]}`;
const FEE_RATE = 0.005;

interface Props {
  marketId: string;
  name: string;
  category: string;
  captureId: string;
  score: number;
  openPosition?: Position;
  onOpened: (side: "long" | "short", size: number) => void;
}

// Inline order ticket for the market page: side, size, leverage, submit.
// Replaces the old modal so the chart stays in view while you trade.
export function TradePanel({
  marketId,
  name,
  category,
  captureId,
  score,
  openPosition: openPos,
  onOpened,
}: Props) {
  const { balance, openPosition } = useDemoContext();
  const { user, loading: authLoading, openLoginModal } = useAuth();
  const [side, setSide] = useState<"long" | "short">("long");
  const [amount, setAmount] = useState("100");
  const [lev, setLev] = useState<Lev>("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountNum = parseFloat(amount) || 0;
  const fee = amountNum * FEE_RATE;
  const leverage = Number(lev);
  const isLong = side === "long";
  const overBalance = !!user && amountNum > balance;
  const canSubmit = amountNum > 0 && !busy && !overBalance;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const outcome = await openPosition({
      marketId,
      type: side,
      name,
      category,
      entryIndex: score,
      size: amountNum,
      captureId,
      leverage,
    });
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    onOpened(side, amountNum);
  }

  const pnl = openPos ? calculatePnL(openPos) : null;

  return (
    <Card className="p-4 sm:p-5 space-y-4">
      {/* Side */}
      <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-elevated border border-surface">
        {(["long", "short"] as const).map((s) => {
          const active = side === s;
          const long = s === "long";
          const activeCls = long
            ? "bg-atnx-cyan/15 text-atnx-cyan light:text-atnx-cyan-light border-atnx-cyan/40"
            : "bg-atnx-magenta/15 text-atnx-magenta light:text-atnx-magenta-light border-atnx-magenta/40";
          return (
            <button
              key={s}
              type="button"
              onClick={() => setSide(s)}
              aria-pressed={active}
              className={`py-2.5 rounded-lg border text-sm font-bold transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${
                active
                  ? activeCls
                  : "border-transparent text-secondary hover:text-primary"
              }`}
            >
              <span aria-hidden="true">{long ? "↗" : "↘"}</span>
              {long ? "Long" : "Short"}
            </button>
          );
        })}
      </div>

      {/* Amount */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label
            htmlFor="trade-amount"
            className="text-[11px] uppercase tracking-wider text-tertiary"
          >
            Amount
          </label>
          {user && (
            <button
              type="button"
              onClick={() => setAmount(String(Math.floor(balance)))}
              className="text-[11px] text-secondary hover:text-atnx-cyan cursor-pointer"
            >
              Max ${balance.toFixed(2)}
            </button>
          )}
        </div>
        <div
          className={`flex items-center gap-1 rounded-xl border bg-elevated px-3 py-2 focus-within:border-atnx-cyan/60 transition-colors ${
            overBalance ? "border-atnx-magenta/60" : "border-surface"
          }`}
        >
          <span className="text-2xl font-bold text-tertiary">$</span>
          <input
            id="trade-amount"
            type="number"
            inputMode="decimal"
            min="1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="no-spin flex-1 min-w-0 bg-transparent outline-none text-2xl font-bold text-primary font-mono tabular-nums"
          />
          <span className="text-xs text-tertiary">USDC</span>
        </div>
        <div className="grid grid-cols-4 gap-1.5 mt-2">
          {QUICK.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => setAmount(String(q))}
              className={`py-1.5 rounded-lg border text-xs font-mono transition-colors cursor-pointer ${
                amountNum === q
                  ? "border-atnx-cyan/50 text-primary bg-atnx-cyan/10"
                  : "border-surface bg-surface text-secondary hover:text-primary hover:border-atnx-cyan/40"
              }`}
            >
              ${q}
            </button>
          ))}
        </div>
      </div>

      {/* Leverage */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] uppercase tracking-wider text-tertiary">
          Leverage
        </span>
        <Segmented
          ariaLabel="Leverage"
          value={lev}
          onChange={setLev}
          options={LEVERAGE.map((l) => ({
            value: `${l}` as Lev,
            label: `${l}×`,
          }))}
        />
      </div>

      {/* Summary */}
      <dl className="space-y-1.5 text-xs border-t border-surface pt-3">
        <div className="flex justify-between">
          <dt className="text-tertiary">Entry VI</dt>
          <dd className="font-mono tabular-nums text-atnx-yellow light:text-atnx-yellow-light font-bold">
            {score}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-tertiary">Exposure</dt>
          <dd className="font-mono tabular-nums text-primary">
            ${(amountNum * leverage).toFixed(2)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-tertiary">Fee (0.5%)</dt>
          <dd className="font-mono tabular-nums text-primary">
            ${fee.toFixed(2)}
          </dd>
        </div>
        {user && (
          <div className="flex justify-between">
            <dt className="text-tertiary">Available</dt>
            <dd
              className={`font-mono tabular-nums ${overBalance ? "text-atnx-magenta" : "text-primary"}`}
            >
              ${balance.toFixed(2)}
            </dd>
          </div>
        )}
      </dl>

      {error && (
        <div className="text-xs text-atnx-magenta border border-atnx-magenta/40 bg-atnx-magenta/10 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      {overBalance && !error && (
        <div className="text-xs text-atnx-magenta">
          Amount exceeds your available balance.
        </div>
      )}

      {/* Submit */}
      {user ? (
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className={`w-full py-3 rounded-xl font-bold text-sm cursor-pointer transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
            isLong
              ? "bg-atnx-cyan text-black hover:bg-atnx-cyan-dim hover:shadow-[0_0_24px_rgba(0,212,255,0.3)]"
              : "bg-atnx-magenta text-white hover:bg-atnx-magenta-dim hover:shadow-[0_0_24px_rgba(255,0,229,0.3)]"
          }`}
        >
          {busy
            ? "Opening…"
            : `Open ${isLong ? "Long" : "Short"} · $${amountNum.toFixed(2)}`}
        </button>
      ) : (
        <button
          type="button"
          onClick={openLoginModal}
          disabled={authLoading}
          className="w-full py-3 rounded-xl font-bold text-sm cursor-pointer transition-colors border border-atnx-magenta text-atnx-magenta hover:bg-atnx-magenta hover:text-white disabled:opacity-40"
        >
          Login to trade
        </button>
      )}
      <p className="text-[10px] text-tertiary text-center">
        Simulated USDC. Entry at the current Virality Index.
      </p>

      {/* Open position */}
      {openPos && pnl && (
        <Link
          href="/app/portfolio"
          className="block rounded-xl border border-surface bg-elevated p-3 hover:border-atnx-cyan/40 transition-colors"
        >
          <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-tertiary mb-1">
            <span>Your position</span>
            <span
              className={
                openPos.type === "long"
                  ? "text-atnx-cyan light:text-atnx-cyan-light"
                  : "text-atnx-magenta light:text-atnx-magenta-light"
              }
            >
              {openPos.type} {openPos.leverage}&times;
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="font-mono font-bold tabular-nums text-lg text-primary">
              ${pnl.currentValue}
            </span>
            <span
              className={`font-mono font-bold tabular-nums ${
                pnl.isProfit ? "text-atnx-cyan" : "text-atnx-magenta"
              }`}
            >
              {pnl.isProfit ? "+" : ""}${pnl.pnlAmount}
            </span>
          </div>
          <div className="flex items-baseline justify-between text-xs font-mono tabular-nums">
            <span className="text-secondary">
              ${openPos.size.toFixed(2)} in {"·"} entry {openPos.entryIndex}{" "}
              {"→"} {openPos.currentIndex}
            </span>
            <span
              className={
                pnl.isProfit
                  ? "text-atnx-cyan/80 light:text-atnx-cyan-light"
                  : "text-atnx-magenta/80 light:text-atnx-magenta-light"
              }
            >
              {pnl.isProfit ? "+" : ""}
              {pnl.pnlPercent}%
            </span>
          </div>
        </Link>
      )}
    </Card>
  );
}
