import { getLeaderboard } from "@/lib/leaderboard";
import { LeaderboardView } from "./LeaderboardView";

// Marked to the live VI on every request; the view re-fetches while open.
export const dynamic = "force-dynamic";

export default async function LeaderboardPage() {
  const rows = await getLeaderboard();
  return <LeaderboardView rows={rows} />;
}
