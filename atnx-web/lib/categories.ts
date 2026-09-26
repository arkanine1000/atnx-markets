// The categories a market is filed under. Kept apart from lib/vlm.ts, which
// defines the model's schema with them, so client code (the markets filter)
// can import the list without pulling in the AI SDK.

export const CATEGORIES = [
  'memes',
  'crypto',
  'politics',
  'sports',
  'music',
  'film_tv',
  'gaming',
  'tech',
  'people',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  memes: 'Memes',
  crypto: 'Crypto',
  politics: 'Politics',
  sports: 'Sports',
  music: 'Music',
  film_tv: 'Film & TV',
  gaming: 'Gaming',
  tech: 'Tech',
  people: 'People',
  other: 'Other',
};

export function isCategory(v: string): v is Category {
  return (CATEGORIES as readonly string[]).includes(v);
}
