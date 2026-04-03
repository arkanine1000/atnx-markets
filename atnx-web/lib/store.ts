import type { TrendsResult } from './trends';

export interface Capture {
  id: string;
  timestamp: string;
  pageUrl: string;
  pageTitle: string;
  screenshot: string; // base64
  analysis: {
    type?: string;
    name?: string;
    description?: string;
    category?: string;
    platforms_detected?: string[];
    metrics_detected?: Record<string, string | number>;
    sentiment?: string;
    virality_signals?: string;
    raw_text?: string;
    error?: string;
    raw_response?: string;
    parse_error?: boolean;
  };
  trends: TrendsResult | null;
  viralityScore: number;
}

// In-memory store for MVP
const captures: Capture[] = [];

export function addCapture(capture: Capture) {
  captures.push(capture);
  // Sort by virality score descending
  captures.sort((a, b) => b.viralityScore - a.viralityScore);
}

export function getCaptures(): Capture[] {
  return captures;
}
