import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from 'ai';
import { z } from 'zod';
import { CATEGORIES } from './categories';

// Provider-neutral analysis of one submission (image, text, or both) through
// the Vercel AI Gateway. Replaces lib/claude-vision.ts. The output is
// validated against a hard schema, so callers never see malformed JSON: if
// the model cannot produce a valid object the submission is rejected as
// `unreadable`.
//
// Model ids are gateway strings ("provider/model"). Override per environment
// with VLM_MODEL_IMAGE / VLM_MODEL_TEXT; the defaults were the newest Flash
// tiers listed by the gateway on 2026-09-20.

const IMAGE_MODEL = process.env.VLM_MODEL_IMAGE ?? 'google/gemini-3.8-flash';
const TEXT_MODEL = process.env.VLM_MODEL_TEXT ?? 'google/gemini-3.5-flash-lite';

export { CATEGORIES, type Category } from './categories';

export const ENTITY_TYPES = ['meme', 'trend', 'person', 'brand', 'event', 'other'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const REJECT_REASONS = ['not_cultural_content', 'policy', 'unreadable'] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

// Entity types a subject may have: the person, brand or event a meme,
// trend or edit is about. The review step offers that subject's market as
// the place to attach the capture (see lib/review.ts).
export const SUBJECT_TYPES = ['person', 'brand', 'event'] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export type VisionMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

// A market the retrieval stage (Phase 2) found close to this submission. The
// model may only link to ids in this list; anything else is treated as null.
export interface CandidateMarket {
  id: string;
  name: string;
  entityType: string | null;
  category?: string | null;
  aliases?: string[];
}

const newMarketSchema = z.object({
  name: z.string().min(1).max(120),
  entity_type: z.enum(ENTITY_TYPES),
  category: z.enum(CATEGORIES),
  aliases: z.array(z.string().min(1).max(80)).max(8),
});

function buildSchema(candidateIds: string[]) {
  // The candidate enum is rebuilt per request. When there are no candidates
  // a nullable string keeps the JSON schema simple; the value is discarded
  // below because there is nothing valid to link to.
  const candidateId = () =>
    candidateIds.length > 0
      ? z.enum(candidateIds as [string, ...string[]]).nullable()
      : z.string().nullable();

  return z.object({
    admit: z.boolean(),
    reject_reason: z.enum(REJECT_REASONS).nullable(),
    matched_market_id: candidateId(),
    new_market: newMarketSchema.nullable(),
    // Other canonical names the market could go by; the reviewer picks one.
    name_alternates: z.array(z.string().min(1).max(120)).max(2),
    // The subject a meme/trend/event is about, when it is a person, brand
    // or event with its own identity: a candidate id if it was shown, else
    // a name and type the server resolves against existing markets.
    subject_market_id: candidateId(),
    subject_name: z.string().max(120).nullable(),
    subject_entity_type: z.enum(SUBJECT_TYPES).nullable(),
    description: z.string().max(400),
    ocr_text: z.string().max(4000),
    platforms_detected: z.array(z.string()).max(8),
    sentiment: z.enum(['positive', 'negative', 'neutral', 'mixed']),
    confidence: z.enum(CONFIDENCE_LEVELS),
  });
}

export type SubmissionAnalysis = z.infer<ReturnType<typeof buildSchema>> & {
  model: string;
  latencyMs: number;
};

export interface AnalyzeSubmissionInput {
  imageBase64?: string;
  mediaType?: VisionMediaType;
  text?: string;
  sourceUrl?: string;
  pageTitle?: string;
  candidates: CandidateMarket[];
  // Test seam: pass a mock model instead of the gateway string.
  model?: LanguageModel;
}

const SYSTEM_PROMPT = `You classify content that people submit to ATNX, a platform where internet culture is tracked as markets. A submission is a screenshot, a link, or a line of text.

Decide three things.

1. admit. Admit the submission when its main subject is a piece of internet culture with a public identity: a meme, a viral trend or format, a public figure, a brand or product in the public conversation, a public event, a song, show, film, game, or crypto token that people are talking about. Reject (admit=false) with a reject_reason when:
   - not_cultural_content: a blank, private, or purely functional screen (settings, spreadsheets, documents, chats between private individuals, receipts, code), or content with no identifiable public subject.
   - policy: sexual content involving minors, or content whose main subject is a private individual being harassed or doxxed.
   - unreadable: the input is too small, corrupted, or garbled to read.
   When admit is false, set matched_market_id and new_market to null.

2. matched_market_id. A list of candidate markets may be supplied with their ids. If the submission's subject IS one of those candidates (the same meme, person, product, or event, even under a different spelling or alias), set matched_market_id to that candidate's id and new_market to null. Never invent an id. If no candidate fits, set matched_market_id to null.

3. new_market. When admitted and unmatched, describe the subject as a market: the canonical name people use for it (short, no hashtags, no trailing punctuation), its entity_type, one category, and up to eight aliases (alternative spellings, hashtags without the #, nicknames). Names must be specific: "Distracted Boyfriend" not "meme about a boyfriend". In name_alternates give up to two other names the same market could reasonably carry (a longer or shorter form, the name a different community uses); leave it empty when the name is settled.

4. subject. When the content is a meme, trend, edit, image or event ABOUT a specific person, brand, product or public event that has its own identity beyond this content (a mugshot meme is about the person in it; a "graphics setting off / on" meme is about that product; a fan edit is about the show), name that subject. If the subject is one of the candidate markets, set subject_market_id to its id; otherwise set subject_name (canonical name) and subject_entity_type (person, brand or event). The subject is what the content is about, never the platform it appears on and never the meme format itself. Leave all three null when the market IS the subject (a person's own post, a brand's own product page, a public figure's photo with no meme on top) or when there is no single subject.

Also fill in: description (one sentence, what the content is and why it is circulating), ocr_text (all readable text in the image, verbatim, or the submitted text; empty string if none), platforms_detected (platform names visible or implied, such as X, TikTok, Instagram, Reddit, YouTube), sentiment, and confidence in your admit/match/new decision (high, medium, low). Use low when the subject is ambiguous or you are unsure whether it is a known thing.`;

function buildUserText(input: AnalyzeSubmissionInput): string {
  const lines: string[] = [];
  if (input.sourceUrl) lines.push(`Source URL: ${input.sourceUrl}`);
  if (input.pageTitle) lines.push(`Page title: ${input.pageTitle}`);
  if (input.text) lines.push(`Submitted text:\n${input.text}`);
  if (input.candidates.length > 0) {
    lines.push('Candidate markets (link only to one of these ids, or none):');
    for (const c of input.candidates) {
      const extra = [
        c.entityType ? `type=${c.entityType}` : null,
        c.category ? `category=${c.category}` : null,
        c.aliases?.length ? `aliases=${c.aliases.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('; ');
      lines.push(`- id=${c.id} name="${c.name}"${extra ? ` (${extra})` : ''}`);
    }
  } else {
    lines.push('Candidate markets: none.');
  }
  lines.push(
    input.imageBase64
      ? 'Analyze the attached image together with the context above.'
      : 'Analyze the submitted text together with the context above.'
  );
  return lines.join('\n');
}

function unreadable(model: string, latencyMs: number, text = ''): SubmissionAnalysis {
  return {
    admit: false,
    reject_reason: 'unreadable',
    matched_market_id: null,
    new_market: null,
    name_alternates: [],
    subject_market_id: null,
    subject_name: null,
    subject_entity_type: null,
    description: '',
    ocr_text: text,
    platforms_detected: [],
    sentiment: 'neutral',
    confidence: 'low',
    model,
    latencyMs,
  };
}

export async function analyzeSubmission(
  input: AnalyzeSubmissionInput
): Promise<SubmissionAnalysis> {
  if (!input.imageBase64 && !input.text?.trim()) {
    throw new Error('analyzeSubmission needs an image or text');
  }

  const modelId = input.imageBase64 ? IMAGE_MODEL : TEXT_MODEL;
  const model = input.model ?? modelId;
  const candidateIds = input.candidates.map((c) => c.id);
  const schema = buildSchema(candidateIds);

  const content: Array<
    { type: 'text'; text: string } | { type: 'file'; mediaType: string; data: string }
  > = [];
  if (input.imageBase64) {
    content.push({
      type: 'file',
      mediaType: input.mediaType ?? 'image/png',
      data: input.imageBase64,
    });
  }
  content.push({ type: 'text', text: buildUserText(input) });

  const started = performance.now();
  let output: z.infer<typeof schema> | undefined;
  // One retry on a malformed object. Measured 2026-09-20: with thinking off
  // the output is well formed; the retry covers a transient truncation.
  for (let attempt = 0; attempt < 2 && output === undefined; attempt++) {
    try {
      const result = await generateText({
        model,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
        output: Output.object({ schema }),
        // The portable `reasoning: 'none'` is ignored for Gemini 3.x through
        // the gateway (measured: 18 s and truncated JSON). The provider
        // option is honoured (2.6 s). providerOptions take precedence, so
        // no top-level reasoning setting is passed.
        providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
        temperature: 0,
        maxOutputTokens: 1500,
      });
      output = result.output;
    } catch (err) {
      if (!NoObjectGeneratedError.isInstance(err)) throw err;
      console.warn(`[vlm] malformed object (attempt ${attempt + 1})`, {
        model: modelId,
        cause: (err.cause as Error | undefined)?.message?.split('\n')[0],
        text: err.text?.slice(0, 200),
      });
    }
  }
  const latencyMs = Math.round(performance.now() - started);
  if (output === undefined) return unreadable(modelId, latencyMs);

  // The route may only link to ids the model was shown.
  const matched =
    output.matched_market_id && candidateIds.includes(output.matched_market_id)
      ? output.matched_market_id
      : null;
  const subjectId =
    output.subject_market_id && candidateIds.includes(output.subject_market_id)
      ? output.subject_market_id
      : null;
  // A subject that is the proposal itself under another spelling is no
  // subject; and a name without a type (or the reverse) is unusable.
  const proposedName = output.new_market?.name.trim().toLowerCase();
  const subjectName =
    output.subject_name?.trim() &&
    output.subject_entity_type &&
    output.subject_name.trim().toLowerCase() !== proposedName
      ? output.subject_name.trim()
      : null;
  const subject = {
    subject_market_id: subjectId,
    subject_name: subjectId ? null : subjectName,
    subject_entity_type: subjectId || !subjectName ? null : output.subject_entity_type,
    name_alternates: [
      ...new Set(
        output.name_alternates
          .map((n) => n.trim())
          .filter((n) => n && n.toLowerCase() !== proposedName)
      ),
    ].slice(0, 2),
  };

  // Keep the three-way outcome consistent regardless of how the model filled
  // the optional fields.
  if (!output.admit) {
    return {
      ...output,
      reject_reason: output.reject_reason ?? 'not_cultural_content',
      matched_market_id: null,
      new_market: null,
      model: modelId,
      latencyMs,
    };
  }
  if (matched) {
    return {
      ...output,
      ...subject,
      reject_reason: null,
      matched_market_id: matched,
      new_market: null,
      model: modelId,
      latencyMs,
    };
  }
  if (!output.new_market) {
    // Admitted, unmatched, but nothing to create: treat as unreadable so the
    // caller has one code path for "the model gave us nothing usable".
    return unreadable(modelId, latencyMs, output.ocr_text);
  }
  return { ...output, ...subject, reject_reason: null, matched_market_id: null, model: modelId, latencyMs };
}
