"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect } from "wagmi";

// Connect, with the wallets found in the browser listed by name when
// there is more than one (Brave Wallet and MetaMask side by side is the
// usual case), and the wallet's answer shown when it refuses. Brave's own
// "which extension" prompt, once dismissed, makes a silent connect look
// like a dead button; a visible error and a named choice avoid that.
export function ConnectButton({ className = "", label = "Connect wallet", compact = false, pill = false }: { className?: string; label?: string; compact?: boolean; pill?: boolean }) {
  const { connect, connectors, isPending, error, reset } = useConnect();
  const { status } = useAccount();
  // The page is still re-establishing last time's connection.
  const reconnecting = status === "reconnecting" || status === "connecting";
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // wagmi lists one generic "Injected" entry plus one per wallet it
  // discovered (EIP-6963); the named ones are the useful choices.
  const named = connectors.filter((c) => c.id !== "injected");
  const choices = named.length > 0 ? named : connectors;

  function pick(id: string) {
    reset();
    const c = choices.find((x) => x.uid === id || x.id === id);
    if (c) connect({ connector: c });
    setOpen(false);
  }

  const message = error ? friendly(error.message) : null;

  return (
    <div className={`relative ${className}`} ref={rootRef}>
      <button
        type="button"
        onClick={() => {
          if (choices.length === 0) return;
          if (choices.length === 1) pick(choices[0].uid);
          else setOpen((v) => !v);
        }}
        disabled={choices.length === 0 || isPending || reconnecting}
        title={choices.length === 0 ? "No wallet extension found in this browser" : undefined}
        className={
          pill
            ? "h-8 px-3.5 inline-flex items-center rounded-full btn-magenta text-xs font-bold cursor-pointer whitespace-nowrap disabled:opacity-60"
            : compact
              ? "h-8 px-3 inline-flex items-center gap-1.5 rounded-full border border-surface bg-surface hover:border-atnx-cyan/50 text-xs font-bold text-primary cursor-pointer transition-colors disabled:opacity-50 whitespace-nowrap"
              : "btn-cyan w-full h-11 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50"
        }
      >
        {reconnecting ? "Reconnecting…" : isPending ? "Check your wallet…" : choices.length === 0 ? "No wallet found" : label}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-1 min-w-48 bg-elevated border border-surface rounded-md shadow-lg z-50 py-1 text-xs">
          {choices.map((c) => (
            <button
              key={c.uid}
              type="button"
              role="menuitem"
              onClick={() => pick(c.uid)}
              className="w-full text-left px-3 py-2 text-primary hover:bg-surface transition-colors cursor-pointer"
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
      {message && !compact && !pill && <p className="text-[11px] text-atnx-magenta mt-2">{message}</p>}
    </div>
  );
}

function friendly(msg: string): string {
  const m = msg.split("\n")[0];
  if (/rejected|denied|cancel/i.test(m)) return "The wallet refused the connection. In Brave: Settings → Web3 → Default Ethereum wallet, pick one, reload.";
  if (/provider not found|no provider/i.test(m)) return "No wallet extension answered. Is one installed and enabled for this site?";
  return m.slice(0, 140);
}
