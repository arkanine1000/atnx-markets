"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useDisconnect, useSwitchChain, useWriteContract, useConfig } from "wagmi";
import { ConnectButton } from "./ConnectButton";
import { waitForTransactionReceipt } from "wagmi/actions";
import { mockUsdgAbi } from "@/lib/bm/abi";
import { BM_CHAINS, USDG_UNIT, chainById, isDeployed } from "@/lib/bm/chains";
import { shortAddress } from "./format";

// Connect, the short address, the chain, a disconnect, and a "Mint 1,000
// mock USDG" since the testnet token mints on request. Sits beside the
// account menu in the header.
export function WalletButton({ compact = false }: { compact?: boolean }) {
  const { address, chainId, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const config = useConfig();
  const [open, setOpen] = useState(false);
  const [minting, setMinting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const chain = chainId ? chainById(chainId) : null;

  if (!isConnected || !address) {
    return <ConnectButton compact label={compact ? "Wallet" : "Connect"} />;
  }

  async function mint() {
    if (!chain || !isDeployed(chain)) return;
    setMinting(true);
    setNote(null);
    try {
      const hash = await writeContractAsync({
        address: chain.usdg,
        abi: mockUsdgAbi,
        functionName: "mint",
        args: [address!, 1_000n * USDG_UNIT],
        chainId: chain.chainId,
      });
      await waitForTransactionReceipt(config, { hash, chainId: chain.chainId });
      setNote("Minted 1,000 USDG");
    } catch (err) {
      setNote((err as Error).message.split("\n")[0].slice(0, 80));
    } finally {
      setMinting(false);
    }
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`h-8 px-3 inline-flex items-center gap-1.5 rounded-full border bg-surface text-xs font-bold cursor-pointer transition-colors whitespace-nowrap ${
          chain ? "border-surface hover:border-atnx-cyan/50 text-primary" : "border-atnx-magenta/60 text-atnx-magenta"
        }`}
        title={chain ? `${shortAddress(address)} on ${chain.label}` : "Unsupported network"}
      >
        <WalletIcon />
        {!compact && <span className="font-mono">{shortAddress(address)}</span>}
        {!chain && !compact && <span>· switch</span>}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 w-60 bg-elevated border border-surface rounded-md shadow-lg z-50 py-1 text-xs"
        >
          <div className="px-3 py-2 border-b border-surface font-mono text-secondary break-all">{address}</div>
          <div className="px-3 pt-2 pb-1 text-[10px] font-mono uppercase tracking-wider text-tertiary">Network</div>
          {Object.values(BM_CHAINS).map((c) => (
            <button
              key={c.key}
              type="button"
              role="menuitem"
              disabled={switching || !isDeployed(c)}
              onClick={() => switchChain({ chainId: c.chainId })}
              className={`w-full text-left px-3 py-1.5 hover:bg-surface transition-colors cursor-pointer disabled:opacity-40 ${
                chain?.key === c.key ? "text-atnx-cyan" : "text-primary"
              }`}
            >
              {chain?.key === c.key ? "● " : "○ "}
              {c.label}
              {!isDeployed(c) && <span className="text-tertiary"> (not deployed)</span>}
            </button>
          ))}
          <div className="px-3 py-1.5 text-tertiary" title="Program live on devnet; wallet support in the web app is next">
            ○ Solana devnet <span className="text-tertiary">(program live, wallet soon)</span>
          </div>
          <div className="border-t border-surface mt-1 pt-1">
            <button
              type="button"
              role="menuitem"
              disabled={minting || !chain || !isDeployed(chain)}
              onClick={mint}
              className="w-full text-left px-3 py-1.5 text-primary hover:bg-surface transition-colors cursor-pointer disabled:opacity-40"
            >
              {minting ? "Minting…" : "Mint 1,000 mock USDG"}
            </button>
            {note && <div className="px-3 py-1 text-[11px] text-secondary">{note}</div>}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
              className="w-full text-left px-3 py-1.5 text-secondary hover:bg-surface transition-colors cursor-pointer"
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function WalletIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="1.5" y="3.5" width="13" height="9" rx="2" />
      <path d="M10 8h4.5" />
      <circle cx="10.5" cy="8" r="0.6" fill="currentColor" />
    </svg>
  );
}
