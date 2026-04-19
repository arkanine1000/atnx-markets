// Composite VI dispatcher. Runs the available signal sources in parallel and
// returns the strongest score. We MAX rather than weighted-average because
// each source is an independent attention signal — a viral Wikipedia article
// shouldn't be dragged down just because Google Trends is quiet for that term.
import { fetchTrendsData, type TrendsResult } from './trends';
import { fetchWikipediaSignal, type WikipediaResult } from './wikipedia';
import { llmBaselineScore, type BaselineAnalysis } from './llm-baseline';

export interface SignalInput {
  term: string;
  analysis?: BaselineAnalysis | null;
}

export interface SignalResult {
  score: number;
  trends: TrendsResult | null;
  wikipedia: WikipediaResult | null;
  baselineScore: number;
  source: 'trends' | 'wikipedia' | 'baseline' | 'none';
}

export async function composeVi({
  term,
  analysis,
}: SignalInput): Promise<SignalResult> {
  const runTrends = term.length > 1
    ? fetchTrendsData(term).catch(() => null)
    : Promise.resolve(null);
  const runWiki = term.length > 1
    ? fetchWikipediaSignal(term).catch(() => null)
    : Promise.resolve(null);

  const [trends, wikipedia] = await Promise.all([runTrends, runWiki]);
  const baselineScore = llmBaselineScore(analysis ?? null);

  const trendsScore = trends?.viralityScore ?? 0;
  const wikiScore = wikipedia?.score ?? 0;

  const score = Math.max(trendsScore, wikiScore, baselineScore);
  const source: SignalResult['source'] =
    score === 0
      ? 'none'
      : score === trendsScore
        ? 'trends'
        : score === wikiScore
          ? 'wikipedia'
          : 'baseline';

  return { score, trends, wikipedia, baselineScore, source };
}
