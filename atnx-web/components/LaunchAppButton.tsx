"use client";

import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function LaunchAppButton({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    if (busy) return;
    if (signedIn) {
      router.push("/app");
      return;
    }
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) {
      console.error("Sign-in error:", error);
      setBusy(false);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      className="px-8 py-3 rounded-lg bg-atnx-magenta text-black font-mono font-bold text-center transition-colors hover:bg-atnx-magenta-dim hover:shadow-[0_0_20px_rgba(255,0,229,0.3)] disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
    >
      {busy ? "Signing in…" : "Launch App \u2192"}
    </button>
  );
}
