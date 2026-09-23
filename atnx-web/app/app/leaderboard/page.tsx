import { getLeaderboard } from "@/lib/leaderboard";
import { getTreasury } from "@/lib/treasury";
import { LeaderboardView } from "./LeaderboardView";

// Marked to the live VI on every request; the view re-fetches while open.
export const dynamic = "force-dynamic";

export default async function LeaderboardPage() {
  const [rows, treasury] = await Promise.all([getLeaderboard(), getTreasury()]);
  return <LeaderboardView rows={rows} treasury={treasury} />;
}
