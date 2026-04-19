"use client";

import { useRouter } from "next/navigation";

export function LaunchAppButton() {
  const router = useRouter();
  return (
    <button
      onClick={() => router.push("/app")}
      className="px-8 py-3 rounded-lg bg-atnx-magenta-dim text-white font-mono font-bold text-center transition-colors hover:bg-atnx-magenta hover:shadow-[0_0_20px_rgba(255,0,229,0.3)] cursor-pointer"
    >
      {"Launch App \u2192"}
    </button>
  );
}
