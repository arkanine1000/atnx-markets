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

// claude-sonnet-4-20250514 was retired on 2026-06-15 and now returns
// not_found_error. claude-sonnet-5 is its drop-in replacement.
const VISION_MODEL = 'claude-sonnet-5';

function buildPrompt(
  sourceUrl: string | undefined,
  pageTitle: string | undefined,
  pageContext: string | undefined
): string {
  // The response shape feeds composeVi's downstream parsing, so keep the
  // field list stable. pageContext is appended only when the caller (e.g.
  // Android share target) has extra text to pass.
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
    model: VISION_MODEL,
    // Sonnet 5 thinks by default and max_tokens caps thinking + answer
    // together, so the old 1024 would truncate the JSON. This is a scoped
    // extraction task, so low effort keeps latency and cost down.
    max_tokens: 8192,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
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

  if (res.stop_reason === 'refusal') {
    throw new Error(
      `Claude declined to analyze this image${
        res.stop_details?.explanation ? `: ${res.stop_details.explanation}` : ''
      }`
    );
  }
  if (res.stop_reason === 'max_tokens') {
    throw new Error('Claude response was truncated (max_tokens)');
  }

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
