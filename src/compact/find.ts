import { buildCatalog, buildFeatures, defaultContext, type CatalogEntry, type Context, type FeatureEntry } from './catalog.js';
import { containsPhrase, foldedWords, parseQuery, stem, words } from './text.js';

export const MIN_SCORE = 9;
export const MAX_LIMIT = 10;
export type EffectFilter = 'any' | 'read' | 'write';

export interface Hit {
  id: string;
  kind: 'command' | 'feature';
  summary: string;
  group?: string;
  effect: 'read' | 'write' | 'unknown' | 'unavailable';
  availability: 'public' | 'undocumented' | 'virtual' | 'unavailable';
  runnable: boolean;
  score: number;
  matched: string[];
  next: string;
}
export interface FindResult {
  intent: string;
  hits: Hit[];
  indexed: number;
  note?: string;
}

const READ_VERBS = new Set(['show', 'list', 'get', 'view', 'read', 'count', 'find', 'search', 'see', 'display', 'check', 'fetch', 'look', 'report', 'analytic', 'stat', 'status']);
const WRITE_VERBS = new Set(['create', 'add', 'delete', 'remove', 'update', 'change', 'edit', 'pause', 'activate', 'start', 'launch', 'send', 'reply', 'forward',
  'enable', 'disable', 'move', 'mark', 'merge', 'assign', 'resume', 'duplicate', 'import', 'upload', 'connect']);
const ID_BONUS = 8;
const NO_ID_PENALTY = 4;
const EFFECT_MISMATCH = 8;
const SYNONYM_WEIGHT = 0.5;
const DESCRIPTION_WEIGHT = 0.25;

/** Query token weights: direct words count fully, synonym expansions count half. */
const expand = (tokens: string[], synonyms: Record<string, string[]>): Map<string, number> => {
  const out = new Map<string, number>(tokens.map(t => [t, 1]));
  for (const token of tokens) for (const extra of synonyms[token] ?? []) {
    const folded = stem(extra);
    if (!out.has(folded)) out.set(folded, SYNONYM_WEIGHT);
  }
  return out;
};

interface Scored { entry: CatalogEntry | FeatureEntry; score: number; matched: string[] }

export class Finder {
  readonly catalog: CatalogEntry[];
  private features: FeatureEntry[];
  private aliasPhrases: Map<string, string[][]>;
  private groupAliases: Map<string, Set<string>>;
  private idf = new Map<string, number>();
  private synonyms: Record<string, string[]>;
  constructor(readonly context: Context = defaultContext, catalog: CatalogEntry[] = buildCatalog()) {
    this.catalog = catalog;
    this.features = buildFeatures(context);
    this.synonyms = Object.fromEntries(Object.entries(context.synonyms).map(([k, v]) => [foldedWords(k).join(' '), v]));
    this.aliasPhrases = new Map(Object.entries(context.aliases).map(([id, phrases]) => [id, phrases.map(foldedWords)]));
    this.groupAliases = new Map(Object.entries(context.groupAliases).map(([g, a]) => [g, new Set(a.flatMap(foldedWords))]));
    // Rarer words identify a command better than ubiquitous ones such as get or list.
    const df = new Map<string, number>();
    for (const entry of catalog) for (const t of new Set([...entry.groupTokens, ...entry.subTokens, ...entry.idTokens])) df.set(t, (df.get(t) ?? 0) + 1);
    for (const [t, n] of df) this.idf.set(t, Math.log(catalog.length / n) / Math.log(catalog.length));
  }
  private weight(token: string): number { return 2 + 10 * (this.idf.get(token) ?? 1); }
  private scoreCommand(entry: CatalogEntry, tokens: string[], expanded: Map<string, number>, normalized: string, q: ReturnType<typeof parseQuery>, intent: string): Scored {
    const matched = new Set<string>();
    let score = 0;
    // Exact matches compare literal words, never folded ones: activity and activities are different commands.
    if (normalized === words(entry.id).join(' ') || normalized === words(`${entry.group} ${entry.subcommand}`).join(' ')) {
      score += 100; matched.add(entry.id);
    }
    for (const phrase of this.aliasPhrases.get(entry.id) ?? []) {
      if (containsPhrase(tokens, phrase)) { score += 60; matched.add(phrase.join(' ')); break; }
    }
    const groupSet = new Set([...entry.groupTokens, ...(this.groupAliases.get(entry.group) ?? [])]);
    const subSet = new Set(entry.subTokens.filter(t => !entry.groupTokens.includes(t)));
    for (const [t, factor] of expanded) {
      const w = this.weight(t) * factor;
      if (groupSet.has(t)) { score += w; matched.add(t); }
      if (subSet.has(t)) { score += w; matched.add(t); }
      else if (entry.descTokens.includes(t) && !groupSet.has(t)) { score += w * DESCRIPTION_WEIGHT; matched.add(t); }
    }
    if (score > 0) {
      if (entry.needsId) score += q.hasUuid || q.hasEmail ? ID_BONUS : -NO_ID_PENALTY;
      const reads = tokens.some(t => READ_VERBS.has(t));
      const writes = tokens.some(t => WRITE_VERBS.has(t));
      if (reads && !writes && entry.effect.effect !== 'read') score -= EFFECT_MISMATCH;
      if (writes && !reads && entry.effect.effect === 'read') score -= EFFECT_MISMATCH;
    }
    return { entry, score: Math.round(score * 10) / 10, matched: [...matched] };
  }
  private scoreFeature(entry: FeatureEntry, expanded: Map<string, number>): Scored {
    const matched = [...expanded.keys()].filter(t => entry.keywords.includes(t));
    return { entry, score: matched.length * 6, matched };
  }
  find(intent: string, limit = 5, effect: EffectFilter = 'any'): FindResult {
    const q = parseQuery(intent);
    const tokens = q.tokens;
    const expanded = expand(tokens, this.synonyms);
    const normalized = words(intent).join(' ');
    const scored: Scored[] = [];
    for (const entry of this.catalog) {
      if (effect === 'read' && entry.effect.effect !== 'read') continue;
      if (effect === 'write' && entry.effect.effect === 'read') continue;
      const s = this.scoreCommand(entry, tokens, expanded, normalized, q, intent);
      if (s.score >= MIN_SCORE) scored.push(s);
    }
    for (const feature of this.features) {
      const s = this.scoreFeature(feature, expanded);
      if (s.score >= MIN_SCORE) scored.push(s);
    }
    scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
    const hits = scored.slice(0, Math.min(Math.max(limit, 1), MAX_LIMIT)).map(({ entry, score, matched }): Hit => {
      if (entry.kind === 'feature') {
        return { id: entry.id, kind: 'feature', summary: `${entry.title}. ${entry.reason}`, effect: 'unavailable', availability: 'unavailable',
          runnable: false, score, matched, next: 'No supported command. Tell the user this is unavailable; do not guess an endpoint.' };
      }
      return { id: entry.id, kind: 'command', summary: entry.summary, group: entry.group, effect: entry.effect.effect, availability: entry.availability,
        runnable: entry.effect.effect !== 'unknown', score, matched,
        next: entry.effect.effect === 'read' ? `instantly_describe ${entry.id}, then instantly_run mode=read`
          : entry.effect.effect === 'write' ? `instantly_describe ${entry.id}, then instantly_preview` : `instantly_describe ${entry.id}; execution is not permitted (unknown effect)` };
    });
    return { intent, hits, indexed: this.catalog.length,
      ...(hits.length ? {} : { note: 'No command matched with enough confidence. Rephrase with the object and action (for example "list campaigns"), or say the request is unsupported.' }) };
  }
}
