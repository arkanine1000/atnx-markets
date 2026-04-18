import googleTrends from 'google-trends-api';
import { getCached, setCache } from './trends-cache';

interface TrendsDataPoint {
  date: string;
  value: number;
}

export interface TrendsResult {
  term: string;
  dataPoints: TrendsDataPoint[];
  viralityScore: number;
  peakValue: number;
  currentValue: number;
  trend: 'rising' | 'falling' | 'stable' | 'spiking' | 'new';
  fetchedAt: string;
}

export async function fetchTrendsData(searchTerm: string): Promise<TrendsResult> {
  // Check cache first
  const cached = getCached(searchTerm);
  if (cached) return cached as TrendsResult;

  try {
    const results = await googleTrends.interestOverTime({
      keyword: searchTerm,
      startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      endTime: new Date(),
      granularTimeResolution: true,
    });

    const parsed = JSON.parse(results);
    const timelineData = parsed.default?.timelineData || [];

    const dataPoints: TrendsDataPoint[] = timelineData.map((point: any) => ({
      date: new Date(parseInt(point.time) * 1000).toISOString(),
      value: point.value?.[0] ?? 0,
    }));

    const viralityScore = calculateViralityScore(dataPoints);
    const values = dataPoints.map(d => d.value);
    const currentValue = values.length > 0 ? values[values.length - 1] : 0;
    const peakValue = values.length > 0 ? Math.max(...values) : 0;
    const trend = determineTrend(dataPoints);

    const result: TrendsResult = {
      term: searchTerm,
      dataPoints,
      viralityScore,
      peakValue,
      currentValue,
      trend,
      fetchedAt: new Date().toISOString(),
    };

    setCache(searchTerm, result);
    return result;
  } catch (error) {
    console.error(`Google Trends query failed for "${searchTerm}":`, error);

    return {
      term: searchTerm,
      dataPoints: [],
      viralityScore: 0,
      peakValue: 0,
      currentValue: 0,
      trend: 'new',
      fetchedAt: new Date().toISOString(),
    };
  }
}

function calculateViralityScore(dataPoints: TrendsDataPoint[]): number {
  if (dataPoints.length === 0) return 0;

  const values = dataPoints.map(d => d.value);
  const len = values.length;

  // Component 1: Current Interest (0-100)
  const currentValue = values[len - 1] || 0;

  // Component 2: Momentum (0-100)
  const midpoint = Math.floor(len / 2);
  const olderHalf = values.slice(0, midpoint);
  const recentHalf = values.slice(midpoint);

  const olderAvg = olderHalf.length > 0
    ? olderHalf.reduce((a, b) => a + b, 0) / olderHalf.length
    : 0;
  const recentAvg = recentHalf.length > 0
    ? recentHalf.reduce((a, b) => a + b, 0) / recentHalf.length
    : 0;

  let momentum = 50;
  if (olderAvg > 0) {
    const changeRatio = (recentAvg - olderAvg) / olderAvg;
    momentum = Math.max(0, Math.min(100, 50 + (changeRatio * 100)));
  } else if (recentAvg > 0) {
    momentum = 100;
  }

  // Component 3: Spike Detection (0-100)
  const recentPoints = values.slice(-6);
  const priorPoints = values.slice(-12, -6);

  const recentMax = recentPoints.length > 0 ? Math.max(...recentPoints) : 0;
  const priorMax = priorPoints.length > 0 ? Math.max(...priorPoints) : 0;

  let spike = 0;
  if (priorMax > 0) {
    spike = Math.min(100, ((recentMax - priorMax) / priorMax) * 100);
  } else if (recentMax > 20) {
    spike = 80;
  }
  spike = Math.max(0, spike);

  // Component 4: Consistency (0-100)
  const peak = Math.max(...values, 1);
  const threshold = peak * 0.1;
  const aboveThreshold = values.filter(v => v >= threshold).length;
  const consistency = Math.min(100, (aboveThreshold / len) * 100);

  // Composite Score (0-1000)
  const composite = (
    currentValue * 0.35 +
    momentum * 0.30 +
    spike * 0.20 +
    consistency * 0.15
  );

  return Math.round(composite * 10);
}

function determineTrend(dataPoints: TrendsDataPoint[]): 'rising' | 'falling' | 'stable' | 'spiking' | 'new' {
  if (dataPoints.length < 3) return 'new';

  const values = dataPoints.map(d => d.value);
  const recent = values.slice(-6);
  const prior = values.slice(-12, -6);

  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const priorAvg = prior.length > 0
    ? prior.reduce((a, b) => a + b, 0) / prior.length
    : 0;

  if (priorAvg === 0 && recentAvg > 0) return 'new';

  const changePercent = priorAvg > 0 ? ((recentAvg - priorAvg) / priorAvg) * 100 : 0;

  if (changePercent > 100) return 'spiking';
  if (changePercent > 15) return 'rising';
  if (changePercent < -15) return 'falling';
  return 'stable';
}

export function normalizeSearchTerm(analysis: any): string {
  let term = analysis?.name || '';

  // Remove quotes
  term = term.replace(/["""'']/g, '');

  // If name is too long, shorten to first 3 meaningful words
  if (term.split(' ').length > 4) {
    const stopWords = ['the', 'a', 'an', 'of', 'and', 'in', 'on', 'at', 'for', 'to', 'is', 'was'];
    const words = term.split(' ').filter((w: string) => !stopWords.includes(w.toLowerCase()));
    term = words.slice(0, 3).join(' ');
  }

  return term.trim();
}
