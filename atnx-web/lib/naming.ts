// The name a market goes live under decides what every source searches
// for, and the model sometimes titles a subject instead of naming it:
// "Chemtrails Weather Control Conspiracy" for the chemtrails conspiracy
// (2026-10-02), a phrase nobody writes, which read 0 on every search
// source while "chemtrails" alone read Trends at 173 and Bluesky at 32
// posts a day. The one-word alias that is the real name cannot be
// searched on its own (lib/vi/score.ts searchableAliases: a single word
// counts only once Wikipedia vouches for it against the market's own
// article, and an invented title has none).
//
// So when Wikipedia knows nothing under the model's name but knows a
// one-word alias as a redirect to a longer article that carries the word
// ("Chemtrails" -> "Chemtrail conspiracy theory"), the review step offers
// that word and the article's title among the names the reviewer may
// pick (lib/review.ts buildReview). Only a redirect to a longer title
// counts (lib/vi/wikipedia.ts redirectNamesTerm): an exact article under
// the word ("Cat") or a one-word target is a common noun, a
// disambiguation page means several things, a section redirect is a part
// of something else. Nothing here is free text: the reviewer chooses.
import { lookupPages, resolvePageviewArticle, redirectNamesTerm, type PageInfo } from './vi/wikipedia';
import { isVerifiableAlias } from './vi/score';

// At most this many aliases are looked up, two names each.
const MAX_ALIASES = 3;

// The names to offer beside the model's: the alias as people write it,
// then the article's title. Pure.
export function nameAlternatesFrom(name: string, aliases: string[], nameKnown: boolean, pages: Map<string, PageInfo>): string[] {
  if (nameKnown) return [];
  const out: string[] = [];
  const seen = new Set<string>([name.trim().toLowerCase()]);
  const push = (n: string) => {
    const k = n.trim().toLowerCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(n.trim());
  };
  for (const alias of aliases) {
    const info = pages.get(alias);
    if (!info || !isVerifiableAlias(alias)) continue;
    if (info.missing || info.disambiguation || !info.redirected || info.fragment) continue;
    if (!redirectNamesTerm(alias, info.title)) continue;
    // Title case for the word as a name: "chemtrails" -> "Chemtrails".
    push(alias.trim().charAt(0).toUpperCase() + alias.trim().slice(1));
    push(info.title);
  }
  return out;
}

// Looks the name and its one-word aliases up. Never throws: a failed
// lookup offers nothing.
export async function wikipediaNameAlternates(name: string, aliases: string[]): Promise<string[]> {
  try {
    const candidates = aliases.filter((a) => isVerifiableAlias(a) && a.trim().toLowerCase() !== name.trim().toLowerCase()).slice(0, MAX_ALIASES);
    if (candidates.length === 0) return [];
    const [known, pages] = await Promise.all([resolvePageviewArticle(name), lookupPages(candidates)]);
    return nameAlternatesFrom(name, candidates, !!known.title || known.namedRedirect, pages);
  } catch (err) {
    console.warn('[naming] alternates lookup failed', (err as Error).message);
    return [];
  }
}
