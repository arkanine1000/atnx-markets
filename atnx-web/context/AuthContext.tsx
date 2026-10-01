"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { getAddress, type Hex } from "viem";
import { createSiweMessage, generateSiweNonce } from "viem/siwe";
import { ensureWalletProfile } from "@/app/app/actions/auth";

interface AuthContextType {
  user: User | null;
  loading: boolean;
  isLoginModalOpen: boolean;
  openLoginModal: () => void;
  closeLoginModal: () => void;
  // Sign in with Ethereum: one signature over an EIP-4361 message, then a
  // normal Supabase session. The caller signs (wagmi's signMessage).
  signInWithWallet: (p: { address: string; chainId: number; sign: (message: string) => Promise<Hex> }) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isLoginModalOpen, setLoginModalOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      setUser(data.user);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      // Auto-close the login modal once a session is established.
      if (session?.user) setLoginModalOpen(false);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  const openLoginModal = useCallback(() => setLoginModalOpen(true), []);
  const closeLoginModal = useCallback(() => setLoginModalOpen(false), []);

  const signInWithWallet = useCallback(
    async ({ address, chainId, sign }: { address: string; chainId: number; sign: (message: string) => Promise<Hex> }) => {
      const supabase = createClient();
      // The message is built here rather than by supabase-js, whose own
      // builder lowercases the address and omits the nonce; wallets that
      // validate EIP-4361 (Phantom) refuse that as malformed.
      const message = createSiweMessage({
        address: getAddress(address),
        chainId,
        domain: window.location.host,
        // The auth server checks this against the redirect allowlist
        // (https://markets.atnx.app/**), so it has to carry a path.
        uri: window.location.href,
        version: "1",
        nonce: generateSiweNonce(),
        issuedAt: new Date(),
        statement: "Sign in to ATNX markets. Testnet only; tokens have no value.",
      });
      const signature = await sign(message);
      const { data, error } = await supabase.auth.signInWithWeb3({ chain: "ethereum", message, signature });
      if (error) {
        console.error("Wallet sign-in error:", error);
        throw error;
      }
      if (data.user) setUser(data.user);
      const r = await ensureWalletProfile(address);
      if (!r.ok) console.error("Wallet profile:", r.error);
      setLoginModalOpen(false);
      router.refresh();
    },
    [router],
  );

  // Sign out in the browser client, not a server action: the browser client
  // holds the session in memory and only a sign-out through it fires
  // SIGNED_OUT, which clears `user` everywhere without a reload. The refresh
  // then drops server-rendered pages cached for the signed-in user.
  const signOut = useCallback(async () => {
    const supabase = createClient();
    const { error } = await supabase.auth.signOut();
    // A failed revoke (e.g. offline) leaves the local session in place;
    // still end it on this device.
    if (error) await supabase.auth.signOut({ scope: "local" });
    setUser(null);
    router.replace("/");
    router.refresh();
  }, [router]);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isLoginModalOpen,
        openLoginModal,
        closeLoginModal,
        signInWithWallet,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
