// The sparkline view model. The series behind it is vi_history (built in
// lib/store.ts), not a live Trends call; the name is historical. The
// source itself lives in lib/vi/trends.ts.
export { normalizeSearchTerm } from './vi/trends';

export interface TrendsResult {
  term: string;
  dataPoints: { date: string; value: number }[];
  viralityScore: number;
  peakValue: number;
  currentValue: number;
  trend: 'rising' | 'falling' | 'stable' | 'spiking' | 'new';
  fetchedAt: string;
}
