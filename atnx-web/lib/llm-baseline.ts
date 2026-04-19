// Baseline VI derived from the capture's LLM analysis alone. Acts as a floor
// when no external signal (Google Trends, Wikipedia) finds anything. It's
// deterministic and free — no external calls.
//
// We look at three dimensions and take the max:
//   - Numeric metrics the LLM extracted ("views", "likes", "followers", etc.)
//   - How many platforms the content spans
//   - Whether the LLM flagged explicit virality signals in the text

export interface BaselineAnalysis {
  metrics_detected?: Record<string, string | number>;
  platforms_detected?: string[];
  virality_signals?: string;
}

export function llmBaselineScore(analysis: BaselineAnalysis | null | undefined): number {
  if (!analysis) return 0;
  const metrics = metricsScore(analysis.metrics_detected);
  const platforms = platformsScore(analysis.platforms_detected);
  const signals = signalsScore(analysis.virality_signals);
  return Math.max(metrics, platforms, signals);
}

// Parse things like "16,374", "2.3M views", "500K followers", "1.2B plays".
// Returns the largest numeric metric found, or 0.
function largestMetric(
  metrics: Record<string, string | number> | undefined
): number {
  if (!metrics) return 0;
  let best = 0;
  for (const value of Object.values(metrics)) {
    const n = parseMetric(value);
    if (n > best) best = n;
  }
  return best;
}

function parseMetric(raw: string | number): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  if (!raw) return 0;

  const match = String(raw)
    .replace(/,/g, '')
    .match(/(\d+(?:\.\d+)?)\s*([kmb])?/i);
  if (!match) return 0;

  const base = parseFloat(match[1]);
  const suffix = match[2]?.toLowerCase();
  const multiplier =
    suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : suffix === 'b' ? 1_000_000_000 : 1;
  return base * multiplier;
}

function metricsScore(metrics: Record<string, string | number> | undefined): number {
  const max = largestMetric(metrics);
  if (max <= 0) return 0;
  // log10(100)=2 → 150; log10(10k)=4 → 450; log10(1M)=6 → 750; log10(1B)=9 → 1000 (clamped).
  const raw = Math.log10(max + 10) * 150;
  return Math.max(0, Math.min(1000, Math.round(raw)));
}

function platformsScore(platforms: string[] | undefined): number {
  if (!platforms || platforms.length === 0) return 0;
  // Cross-platform content is a weak signal by itself but not nothing.
  // 1 platform → 80, 2 → 160, 3 → 240, capped at 300.
  return Math.min(300, platforms.length * 80);
}

function signalsScore(signals: string | undefined): number {
  if (!signals) return 0;
  const text = signals.toLowerCase();
  // Keyword hits — generous floor when the LLM explicitly flagged virality.
  const strong = [
    'viral',
    'trending',
    'breakout',
    'explosive',
    'massive',
    'huge',
  ];
  const weak = ['rising', 'growing', 'popular', 'notable', 'emerging'];
  if (strong.some((w) => text.includes(w))) return 350;
  if (weak.some((w) => text.includes(w))) return 200;
  // LLM bothered to write a signals string at all — tiny floor.
  return 100;
}
