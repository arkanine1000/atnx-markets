"use client";

import { useRouter } from "next/navigation";

export function LaunchAppButton() {
  const router = useRouter();
  return (
    <button
      onClick={() => router.push("/app")}
      className="px-8 py-3 rounded-lg btn-magenta font-bold text-center cursor-pointer"
    >
      {"Launch App \u2192"}
    </button>
  );
}
