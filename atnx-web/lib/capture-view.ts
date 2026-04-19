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

// Deterministic mock 24h change derived from a stable id — keeps the number
// stable across renders without needing a backend column for it yet.
export function mock24hChange(id: string, score: number): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const base = ((hash % 600) - 250) / 10;
  const bias = score > 400 ? 5 : score > 200 ? 0 : -3;
  return Math.round((base + bias) * 10) / 10;
}
