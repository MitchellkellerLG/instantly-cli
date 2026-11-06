const STOPWORDS = new Set(('a an and any are as at be by can do does for from has have how i if in into is it its me my of on or our ' +
  'please should so some that the their them then there these this those to up us want we what when where which who will with without would you your ' +
  'all each every first last next only just also not no new existing current my').split(/\s+/));

/** Plural and simple inflection folding. Returned command IDs are never altered. */
export function stem(word: string): string {
  const base = (): string => {
    if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
    if (word.length > 4 && /(ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
    if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3).replace(/(.)\1$/, '$1');
    if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2).replace(/(.)\1$/, '$1');
    if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
    return word;
  };
  // Dropping a final e makes enable, enabled and enabling fold to the same word.
  const folded = base();
  return folded.length > 3 && folded.endsWith('e') && !folded.endsWith('ee') ? folded.slice(0, -1) : folded;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL = /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/g;

export interface Query {
  /** Folded tokens in order, stopwords and identifiers removed. */
  tokens: string[];
  hasUuid: boolean;
  hasEmail: boolean;
}

export function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}
export function foldedWords(text: string): string[] {
  return words(text).filter(w => !/^\d+$/.test(w)).map(stem);
}
/** A clause the user excludes ("without marking anything read", "do not reply") must not drive the choice. */
const NEGATED = /\b(?:without|do not|don't|dont|never|must not|should not)\b[^.,;:!?]*/gi;

export function parseQuery(intent: string): Query {
  const hasUuid = new RegExp(UUID.source, 'i').test(intent);
  const hasEmail = new RegExp(EMAIL.source).test(intent);
  const text = intent.replace(UUID, ' ').replace(EMAIL, ' ').replace(NEGATED, ' ');
  const tokens = foldedWords(text).filter(w => !STOPWORDS.has(w));
  return { tokens, hasUuid, hasEmail };
}
/** Phrase containment over folded tokens, contiguous and order preserving. */
export function containsPhrase(tokens: string[], phrase: string[]): boolean {
  if (!phrase.length || phrase.length > tokens.length) return false;
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    if (phrase.every((w, j) => tokens[i + j] === w)) return true;
  }
  return false;
}
