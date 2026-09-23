export function timeAgo(timestamp: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(timestamp).getTime()) / 1000
  );
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function sentimentColor(sentiment?: string): string {
  switch (sentiment) {
    case "positive":
      return "text-atnx-cyan";
    case "negative":
      return "text-atnx-magenta";
    case "mixed":
      return "text-atnx-yellow";
    default:
      return "text-secondary";
  }
}

const DAY_MS = 86_400_000;

// Percent change of the Virality Index over the last day, from the market's
// VI history (oldest first) and its current score. The baseline is the
// reading nearest to 24h before the newest point; the newest point's own
// time is the clock, not Date.now(), so the server and the client agree.
// The newest point is never its own baseline. Null when there is nothing to
// compare against (fewer than two readings, or a baseline of zero), which
// the DeltaChip renders as a neutral dash.
export function viChange24h(
  points: { date: string; value: number }[],
  current: number,
): number | null {
  if (points.length < 2) return null;
  const target = new Date(points[points.length - 1].date).getTime() - DAY_MS;
  let baseline = points[0];
  let best = Infinity;
  for (const p of points.slice(0, -1)) {
    const gap = Math.abs(new Date(p.date).getTime() - target);
    if (gap < best) {
      best = gap;
      baseline = p;
    }
  }
  if (!(baseline.value > 0)) return null;
  return Math.round(((current - baseline.value) / baseline.value) * 1000) / 10;
}
