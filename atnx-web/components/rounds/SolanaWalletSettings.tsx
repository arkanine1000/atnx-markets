"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { fmtUsdg, shortAddress } from "@/components/bm/format";
import { USDG_UNIT, solAddressUrl } from "@/lib/bm/chains";
import { USDG_MINT } from "@/lib/bm/sol-shared";
import { SolConnectButton } from "./SolConnectButton";
import { MOCK_HINT, friendlySolError, usdgBalance, useSendRounds, useSolWallet } from "./useRounds";

// The Solana block of Settings: the address, its mock USDG balance, a
// faucet of 1,000 (creating the USDG account if needed) and disconnect.
export function SolanaWalletSettings() {
  const wallet = useSolWallet();
  const { connection } = useConnection();
  const { send } = useSendRounds();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const holder = wallet.publicKey?.toBase58() ?? null;

  const balance = useQuery({
    queryKey: ["rounds", "usdg", connection.rpcEndpoint, holder],
    enabled: !!holder && !!USDG_MINT,
    refetchInterval: 15_000,
    queryFn: () => usdgBalance(connection, wallet.publicKey!),
  });

  async function faucet() {
    if (!USDG_MINT) return;
    const mint = USDG_MINT;
    setBusy(true);
    setNote(null);
    try {
      await send(async (b, holderPk) => {
        const ata = getAssociatedTokenAddressSync(mint, holderPk);
        return [createAssociatedTokenAccountIdempotentInstruction(holderPk, ata, holderPk, mint), await b.faucet({ to: ata, amount: 1_000n * USDG_UNIT })];
      });
      void balance.refetch();
      setNote("Got 1,000 mock USDG.");
    } catch (err) {
      setNote(friendlySolError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!wallet.connected || !wallet.publicKey) {
    return (
      <div>
        <p className="text-xs text-secondary mb-3">No Solana wallet connected. The rounds trade on Solana devnet with Phantom, Solflare or Backpack.</p>
        <SolConnectButton className="max-w-xs" />
      </div>
    );
  }

  const row = "flex items-center justify-between gap-3 py-2.5 border-b border-surface last:border-b-0 text-xs";
  const address = wallet.publicKey.toBase58();
  return (
    <div>
      <div className={row}>
        <span className="text-tertiary">Address{wallet.walletName ? ` (${wallet.walletName})` : ""}</span>
        <a href={solAddressUrl(address)} target="_blank" rel="noreferrer" className="font-mono text-primary link-quiet" title={address}>
          {shortAddress(address)} ↗
        </a>
      </div>
      <div className={row}>
        <div>
          <div className="text-primary">Mock USDG</div>
          <div className="text-tertiary mt-0.5 tabular-nums">
            {!USDG_MINT ? "not deployed yet" : balance.data ? `${fmtUsdg(balance.data.usdg)} in the wallet` : "reading…"}
          </div>
        </div>
        <button
          type="button"
          disabled={busy || !USDG_MINT || wallet.mock}
          onClick={faucet}
          className="h-8 px-3 rounded-full btn-cyan text-xs font-bold cursor-pointer disabled:opacity-40 whitespace-nowrap"
        >
          {busy ? "Getting…" : "Faucet 1,000"}
        </button>
      </div>
      {note && <p className="text-[11px] text-secondary py-2 break-words">{note}</p>}
      {wallet.mock && <p className="text-[11px] text-tertiary py-2">{MOCK_HINT}</p>}
      <div className={row}>
        <span className="text-tertiary">Wallet</span>
        <button
          type="button"
          onClick={() => void wallet.disconnect()}
          disabled={wallet.mock}
          className="h-8 px-3 rounded-full border border-surface text-xs font-bold text-atnx-magenta hover-lift cursor-pointer disabled:opacity-40"
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}
