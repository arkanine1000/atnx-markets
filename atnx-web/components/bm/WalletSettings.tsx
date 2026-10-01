"use client";

import { useState } from "react";
import { useAccount, useConfig, useDisconnect, useSwitchChain, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { mockUsdgAbi } from "@/lib/bm/abi";
import { BM_CHAINS, USDG_UNIT, chainById, isDeployed } from "@/lib/bm/chains";
import { ConnectButton } from "./ConnectButton";
import { shortAddress } from "./format";

// The wallet section of Settings: the address, the network, a mint of
// mock USDG (the testnet token mints on request) and disconnect.
export function WalletSettings() {
  const { address, chainId, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const config = useConfig();
  const [minting, setMinting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const chain = chainId ? chainById(chainId) : null;

  async function mint() {
    if (!chain || !isDeployed(chain) || !address) return;
    setMinting(true);
    setNote(null);
    try {
      const hash = await writeContractAsync({
        address: chain.usdg,
        abi: mockUsdgAbi,
        functionName: "mint",
        args: [address, 1_000n * USDG_UNIT],
        chainId: chain.chainId,
      });
      await waitForTransactionReceipt(config, { hash, chainId: chain.chainId });
      setNote("Minted 1,000 mock USDG.");
    } catch (err) {
      setNote((err as Error).message.split("\n")[0].slice(0, 120));
    } finally {
      setMinting(false);
    }
  }

  if (!isConnected || !address) {
    return (
      <div>
        <p className="text-xs text-secondary mb-3">No wallet connected. Trading, opening markets and the portfolio use the wallet.</p>
        <ConnectButton className="max-w-xs" />
      </div>
    );
  }

  const row = "flex items-center justify-between gap-3 py-2.5 border-b border-surface last:border-b-0 text-xs";
  return (
    <div>
      <div className={row}>
        <span className="text-tertiary">Address</span>
        <span className="font-mono text-primary break-all text-right" title={address}>
          {shortAddress(address)}
        </span>
      </div>
      <div className="py-2.5 border-b border-surface">
        <div className="text-xs text-tertiary mb-2">Network</div>
        <div className="flex flex-wrap gap-2">
          {Object.values(BM_CHAINS).map((c) => {
            const active = chain?.key === c.key;
            return (
              <button
                key={c.key}
                type="button"
                disabled={switching || !isDeployed(c) || active}
                onClick={() => switchChain({ chainId: c.chainId })}
                className={`h-8 px-3 rounded-full border text-xs font-bold cursor-pointer transition-colors disabled:cursor-default ${
                  active ? "border-atnx-cyan text-atnx-cyan" : "border-surface text-secondary hover:text-primary disabled:opacity-40"
                }`}
              >
                {c.label}
                {!isDeployed(c) && " (not deployed)"}
              </button>
            );
          })}
          <span className="h-8 px-3 inline-flex items-center rounded-full border border-surface text-xs text-tertiary" title="The Anchor program is live on devnet; wallet support in the web app is next">
            Solana devnet (program live, wallet soon)
          </span>
        </div>
        {!chain && <p className="text-[11px] text-atnx-magenta mt-2">The wallet is on a network this app does not use. Pick one above.</p>}
      </div>
      <div className={row}>
        <div>
          <div className="text-primary">Mock USDG</div>
        </div>
        <button
          type="button"
          disabled={minting || !chain || !isDeployed(chain)}
          onClick={mint}
          className="h-8 px-3 rounded-full btn-cyan text-xs font-bold cursor-pointer disabled:opacity-40 whitespace-nowrap"
        >
          {minting ? "Minting…" : "Mint 1,000"}
        </button>
      </div>
      {note && <p className="text-[11px] text-secondary py-2">{note}</p>}
      <div className={row}>
        <span className="text-tertiary">Wallet</span>
        <button type="button" onClick={() => disconnect()} className="h-8 px-3 rounded-full border border-surface text-xs font-bold text-atnx-magenta hover:bg-surface cursor-pointer">
          Disconnect
        </button>
      </div>
    </div>
  );
}
