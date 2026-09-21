// Composite VI dispatcher. Runs the available signal sources in parallel and
// returns the strongest score. We MAX rather than weighted-average because
// each source is an independent attention signal — a viral Wikipedia article
// shouldn't be dragged down just because Google Trends is quiet for that term.
import { fetchTrendsData, type TrendsResult } from './trends';
import { fetchWikipediaSignal, type WikipediaResult } from './wikipedia';

export interface SignalInput {
  term: string;
}

export interface SignalResult {
  score: number;
  trends: TrendsResult | null;
  wikipedia: WikipediaResult | null;
  source: 'trends' | 'wikipedia' | 'none';
}

// The third source, a score read off the screenshot by the vision model
// (view counts, platform list, a free-text "virality" judgement), was
// removed: it let the same screenshot move the price on every resubmit and
// had no external referent. Only measured attention counts now.
export async function composeVi({ term }: SignalInput): Promise<SignalResult> {
  const runTrends = term.length > 1
    ? fetchTrendsData(term).catch(() => null)
    : Promise.resolve(null);
  const runWiki = term.length > 1
    ? fetchWikipediaSignal(term).catch(() => null)
    : Promise.resolve(null);

  const [trends, wikipedia] = await Promise.all([runTrends, runWiki]);

  const trendsScore = trends?.viralityScore ?? 0;
  const wikiScore = wikipedia?.score ?? 0;

  const score = Math.max(trendsScore, wikiScore);
  const source: SignalResult['source'] =
    score === 0 ? 'none' : score === trendsScore ? 'trends' : 'wikipedia';

  return { score, trends, wikipedia, source };
}
