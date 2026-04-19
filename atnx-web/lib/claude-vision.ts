import Anthropic from '@anthropic-ai/sdk';

export type VisionAnalysis = {
  type: 'meme' | 'trend' | 'person' | 'brand' | 'event' | 'other';
  name: string;
  description: string;
  category: string;
  platforms_detected: string[];
  metrics_detected: Record<string, string | number>;
  sentiment: 'positive' | 'negative' | 'neutral' | 'mixed';
  virality_signals: string;
  raw_text: string;
};

export type VisionMediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif';

const client = new Anthropic();

function buildPrompt(
  sourceUrl: string | undefined,
  pageTitle: string | undefined,
  pageContext: string | undefined
): string {
  // Keep the base instructions byte-identical to atnx-extension/background.js
  // so composeVi's downstream parsing stays stable. pageContext is appended
  // only when the caller (e.g. Android share target) has extra text to pass.
  const base = `Analyze this screenshot captured from ${sourceUrl ?? 'unknown'} (${pageTitle ?? 'unknown'}).

Identify the main subject/content and extract the following information. Respond ONLY in valid JSON with these fields:
{
  "type": "meme" | "trend" | "person" | "brand" | "event" | "other",
  "name": "...",
  "description": "...",
  "category": "...",
  "platforms_detected": [...],
  "metrics_detected": {...},
  "sentiment": "positive" | "negative" | "neutral" | "mixed",
  "virality_signals": "...",
  "raw_text": "..."
}`;
  return pageContext
    ? `${base}\n\nAdditional context from the user: ${pageContext}`
    : base;
}

export async function analyzeScreenshot(opts: {
  imageBase64: string;
  mediaType: VisionMediaType;
  sourceUrl?: string;
  pageTitle?: string;
  pageContext?: string;
}): Promise<VisionAnalysis> {
  const prompt = buildPrompt(opts.sourceUrl, opts.pageTitle, opts.pageContext);

  const res = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: opts.mediaType,
              data: opts.imageBase64,
            },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  const textBlock = res.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text block');
  }

  // Claude sometimes wraps JSON in ```json fences despite the instruction.
  const cleaned = textBlock.text.trim().replace(/^```json\s*|\s*```$/g, '');
  try {
    return JSON.parse(cleaned) as VisionAnalysis;
  } catch (err) {
    throw new Error(
      `Failed to parse Claude JSON response: ${(err as Error).message}\nRaw: ${textBlock.text.slice(0, 500)}`
    );
  }
}
