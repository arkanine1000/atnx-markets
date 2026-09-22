"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

interface AuthContextType {
  user: User | null;
  loading: boolean;
  isLoginModalOpen: boolean;
  openLoginModal: () => void;
  closeLoginModal: () => void;
  signInWithGoogle: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

const AFTER_LOGIN_KEY = "atnx:after-login";

function afterLoginPath(): string | null {
  let value: string | null = null;
  try {
    value = window.sessionStorage.getItem(AFTER_LOGIN_KEY);
    if (value) window.sessionStorage.removeItem(AFTER_LOGIN_KEY);
  } catch {
    /* private mode */
  }
  if (!value) value = new URLSearchParams(window.location.search).get("redirect");
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[@\\]/.test(value)) return null;
  return value;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isLoginModalOpen, setLoginModalOpen] = useState(false);

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

  const signInWithGoogle = useCallback(async () => {
    const supabase = createClient();
    // Where to land after the OAuth round-trip: a page that asked to be
    // returned to (the share replay stores it in sessionStorage; links to
    // "/" carry it as ?redirect=), else the app home. The callback only
    // accepts a path on this site.
    const after = afterLoginPath();
    const callback = new URL("/auth/callback", window.location.origin);
    if (after) callback.searchParams.set("redirect", after);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: callback.toString(),
      },
    });
    if (error) {
      console.error("Sign-in error:", error);
      throw error;
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isLoginModalOpen,
        openLoginModal,
        closeLoginModal,
        signInWithGoogle,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
