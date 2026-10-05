"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";

// Connect a Solana wallet, in the style of components/bm/ConnectButton:
// the wallets the browser announced (Wallet Standard: Phantom, Solflare,
// Backpack) listed by name when there is more than one, and the wallet's
// answer shown when it refuses. Picking one selects it; the provider's
// autoConnect then asks the wallet to connect.
export function SolConnectButton({
  className = "",
  label = "Connect Solana wallet",
  compact = false,
  pill = false,
}: {
  className?: string;
  label?: string;
  compact?: boolean;
  pill?: boolean;
}) {
  const { wallets, select, connect, connecting, connected, wallet } = useWallet();
  // The wallet list exists only in the browser; until hydration the
  // button renders as the server did, with the plain label.
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // A refusal surfaces as an error event on the selected adapter.
  useEffect(() => {
    const adapter = wallet?.adapter;
    if (!adapter) return;
    const onError = (e: Error) => setError(friendly(e.message || e.name));
    adapter.on("error", onError);
    return () => {
      adapter.off("error", onError);
    };
  }, [wallet]);

  const choices = !hydrated ? [] : wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);

  function pick(name: WalletName) {
    setError(null);
    setOpen(false);
    // Picking the wallet that is already selected (connected before, then
    // disconnected or refused) does not re-trigger autoConnect.
    if (wallet?.adapter.name === name) void connect().catch(() => {});
    else select(name);
  }

  return (
    <div className={`relative ${className}`} ref={rootRef}>
      <button
        type="button"
        onClick={() => {
          if (choices.length === 0) return;
          if (choices.length === 1) pick(choices[0].adapter.name);
          else setOpen((v) => !v);
        }}
        disabled={choices.length === 0 || connecting || connected}
        title={choices.length === 0 ? "No Solana wallet found in this browser (Phantom, Solflare, Backpack)" : undefined}
        className={
          pill
            ? "h-8 px-3.5 inline-flex items-center rounded-full btn-magenta text-xs font-bold cursor-pointer whitespace-nowrap disabled:opacity-60"
            : compact
              ? "h-8 px-3 inline-flex items-center gap-1.5 rounded-full border border-surface bg-surface btn-quiet text-xs font-bold text-primary cursor-pointer disabled:opacity-50 whitespace-nowrap"
              : "btn-cyan w-full h-11 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50"
        }
      >
        {!hydrated ? label : connecting ? "Check your wallet…" : choices.length === 0 ? "No Solana wallet found" : label}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-1 min-w-48 bg-elevated border border-surface rounded-md shadow-lg z-50 py-1 text-xs">
          {choices.map((w) => (
            <button
              key={w.adapter.name}
              type="button"
              role="menuitem"
              onClick={() => pick(w.adapter.name)}
              className="w-full text-left px-3 py-2 text-primary hover-lift cursor-pointer inline-flex items-center gap-2"
            >
              {w.adapter.icon && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={w.adapter.icon} alt="" className="h-4 w-4 rounded" />
              )}
              {w.adapter.name}
            </button>
          ))}
        </div>
      )}
      {error && !compact && !pill && <p className="text-[11px] text-atnx-magenta mt-2">{error}</p>}
    </div>
  );
}

function noopSubscribe() {
  return () => {};
}

function friendly(msg: string): string {
  const m = msg.split("\n")[0];
  if (/rejected|denied|cancel/i.test(m)) return "The wallet refused the connection.";
  if (/not ready|not found|not installed/i.test(m)) return "The wallet extension did not answer. Is it installed and unlocked?";
  return m.slice(0, 140);
}
