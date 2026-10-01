"use client";

import { useEffect, useState } from "react";
import { useAccount, useConnect, useSignMessage } from "wagmi";
import { useAuth } from "@/context/AuthContext";
import { shortAddress } from "@/components/bm/format";

// Sign in with the wallet: connect (if not already), then one signature.
// The hackathon build has no Google or X sign-in; the wallet is the
// identity for trading, opening markets and capturing.
export function LoginModal() {
  const { isLoginModalOpen, closeLoginModal, signInWithWallet } = useAuth();
  const { address, chainId, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { connect, connectors, isPending: connecting, error: connectError } = useConnect();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoginModalOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeLoginModal();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isLoginModalOpen, closeLoginModal]);

  if (!isLoginModalOpen) return null;

  const named = connectors.filter((c) => c.id !== "injected");
  const choices = named.length > 0 ? named : connectors;

  async function sign() {
    if (!address || !chainId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signInWithWallet({ address, chainId, sign: (message) => signMessageAsync({ message }) });
    } catch (err) {
      setError(friendly((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  const buttonClass =
    "w-full py-3 rounded-lg border border-surface bg-surface text-primary font-bold text-sm hover:border-atnx-cyan/60 transition-colors flex items-center justify-center gap-3 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.55)", backdropFilter: "blur(6px)" }}
      onClick={closeLoginModal}
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-modal-title"
    >
      <div className="bg-elevated border border-surface rounded-xl p-6 w-full max-w-sm mx-4 relative" onClick={(e) => e.stopPropagation()}>
        <button onClick={closeLoginModal} aria-label="Close" className="absolute top-4 right-4 text-secondary link-quiet text-lg cursor-pointer">
          {"\u2715"}
        </button>
        <h2 id="login-modal-title" className="font-display text-lg font-bold text-atnx-cyan mb-1">
          Sign in with your wallet
        </h2>
        <p className="text-xs text-secondary mb-5">
          {isConnected
            ? "One signature proves you hold the connected address. No transaction, no gas."
            : "Connect a wallet, then sign one message. No transaction, no gas."}
        </p>

        <div className="flex flex-col gap-3">
          {isConnected && address ? (
            <button onClick={sign} disabled={busy} className={buttonClass}>
              {busy ? "Check your wallet…" : `Sign in as ${shortAddress(address)}`}
            </button>
          ) : (
            choices.map((c) => (
              <button key={c.uid} onClick={() => connect({ connector: c })} disabled={connecting} className={buttonClass}>
                {connecting ? "Connecting…" : c.name}
              </button>
            ))
          )}
          {choices.length === 0 && <p className="text-xs text-tertiary">No wallet extension found in this browser.</p>}
        </div>

        <p className="text-[11px] text-tertiary mt-4 text-center">
          By continuing you agree to the{" "}
          <a href="/terms" target="_blank" rel="noopener" className="underline link-soft">Terms</a> and{" "}
          <a href="/privacy" target="_blank" rel="noopener" className="underline link-soft">Privacy Policy</a>.
        </p>

        {(error || connectError) && (
          <div className="mt-3 text-xs text-atnx-magenta border border-atnx-magenta/40 bg-atnx-magenta/10 rounded px-3 py-2">
            {error ?? friendly(connectError!.message)}
          </div>
        )}
      </div>
    </div>
  );
}

function friendly(msg: string): string {
  const m = msg.split("\n")[0];
  if (/rejected|denied|cancel/i.test(m)) return "The wallet refused. Try again and approve the signature.";
  if (/web3.*disabled|provider.*disabled|unsupported/i.test(m)) return "Wallet sign-in is not enabled on the auth server yet.";
  return m.slice(0, 160);
}
