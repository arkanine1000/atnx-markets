// Jev (TypeSafe AI) through the Vercel AI Gateway: typed decisions with
// probabilities, no generation. Three uses, each behind a flag that is
// off | shadow (recorded beside the current path, not acting) | on, with
// shadow as the code default:
//   - per-post relevance on X (lib/vi/relevance-x-jev.ts, JEV_TWEETS): on
//     in production since 2026-09-29 after an adjudication of the shadow
//     data (scripts/jev-adjudicate.ts)
//   - the admission gate for generic names (lib/admission-jev.ts, JEV_GATE):
//     shadow, too few creations a day to judge
//   - the YouTube title relevance filter (lib/vi/relevance-jev.ts,
//     JEV_TITLES): off in production, Gemini was right on 75 % of their
//     disagreements
// Every call fails open (null) on error or timeout, and the caller keeps
// its own decision.
//
// The gateway exposes only the moving alias `typesafe-ai/jev` (a pinned
// `typesafe-ai/jev-1.13.0` is not found), so the model id each answer came
// from is recorded with it and thresholds are re-checked when it changes.
import { experimental_evaluate as evaluate, type Experimental_EvaluationQuestion as Question } from 'ai';
import { gateway } from '@ai-sdk/gateway';

export type JevMode = 'off' | 'shadow' | 'on';
export const JEV_MODEL = process.env.JEV_MODEL ?? 'typesafe-ai/jev';
const TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS ?? 4000);

export function jevMode(flag: string | undefined): JevMode {
  const v = (flag ?? 'shadow').trim().toLowerCase();
  return v === 'off' || v === 'on' ? v : 'shadow';
}

// On Vercel the gateway authenticates with the deployment's OIDC token
// and no key variable exists (the VLM calls work the same way); locally
// the key is set in .env.local. Either is enough; an unauthenticated call
// fails open with a logged error like any other failure.
export function jevConfigured(): boolean {
  return !!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL);
}

export type JevAnswers<Q extends Record<string, Question>> = Awaited<ReturnType<typeof evaluate<Q>>>['answers'];

export interface JevCall<Q extends Record<string, Question>> {
  answers: JevAnswers<Q>;
  model: string;
  latencyMs: number;
  inputTokens: number | null;
}

// One evaluate call; null on any failure, logged.
export async function jevEvaluate<const Q extends Record<string, Question>>(state: unknown, questions: Q, label: string): Promise<JevCall<Q> | null> {
  if (!jevConfigured()) return null;
  const t0 = Date.now();
  try {
    const r = await evaluate({
      model: gateway.evaluationModel(JEV_MODEL),
      state: state as Parameters<typeof evaluate>[0]['state'],
      questions,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      maxRetries: 0,
    });
    return { answers: r.answers, model: r.response.modelId, latencyMs: Date.now() - t0, inputTokens: r.usage.inputTokens ?? null };
  } catch (err) {
    console.error(`[jev] ${label} failed after ${Date.now() - t0} ms: ${(err as Error).message.slice(0, 200)}`);
    return null;
  }
}

// Rounds a probability map for storage.
export function roundProbs(p: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(p ?? {})) out[k] = Math.round(v * 1000) / 1000;
  return out;
}
