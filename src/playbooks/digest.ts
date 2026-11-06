import { visibleTo } from './tiers.js';
import type { OfferProfile, PlaybookDefinition, Tier } from './types.js';

export interface Recommendation {
  slug: string;
  title: string;
  fit: 'recommended' | 'available' | 'not_a_fit';
  why: string;
  command: string;
}
const COMMAND = (slug: string) => `instantly --profile <slug> --workspace <uuid> playbooks run ${slug}`;

/** Pure: rank the tier-visible playbooks for one offer profile. Same input, same output. */
export function recommend(offer: OfferProfile | null, tier: Tier, playbooks: PlaybookDefinition[]): Recommendation[] {
  const rows = playbooks.filter(p => visibleTo(tier, p)).map((p): Recommendation & { rank: number } => {
    const base = { slug: p.slug, title: p.title, command: COMMAND(p.slug) };
    if (!offer) return { ...base, fit: 'available', why: 'No offer profile yet. Run offer_profile first to rank this.', rank: 1 };
    if (p.slug === 'offer_profile') return { ...base, fit: offer.needs_confirmation ? 'recommended' : 'available', rank: offer.needs_confirmation ? 0 : 3,
      why: offer.needs_confirmation ? 'The profile is low confidence or ambiguous. Confirm it before trusting recommendations.' : 'Already detected. Re-run when the workspace changes.' };
    if (offer.needs_confirmation) return { ...base, fit: 'available', why: 'Confirm the offer profile before assessing fit.', rank: 1 };
    const fits = p.offerFit ? p.offerFit(offer) : true;
    return { ...base, fit: fits ? 'recommended' : 'not_a_fit', rank: fits ? 0 : 4,
      why: fits ? `Fits a ${offer.offer_category} workspace with ${offer.motion} motion.` : `Does not match a ${offer.offer_category} workspace with ${offer.motion} motion.` };
  });
  return rows.sort((a, b) => a.rank - b.rank || playbooks.findIndex(p => p.slug === a.slug) - playbooks.findIndex(p => p.slug === b.slug)).map(({ rank: _rank, ...rest }) => rest);
}
export function digestText(offer: OfferProfile | null, recs: Recommendation[]): string {
  const lines = ['Instantly playbooks digest', ''];
  if (offer) lines.push(`Offer: ${offer.offer_category}, angle ${offer.offer_angle ?? 'unknown'}, motion ${offer.motion}, confidence ${offer.confidence}.`, '');
  for (const r of recs) lines.push(`${r.fit === 'recommended' ? '*' : r.fit === 'not_a_fit' ? '-' : 'o'} ${r.title} [${r.slug}]: ${r.why}`, `    ${r.command}`);
  lines.push('', 'Recommendations and aggregates only. No lead data, no email.');
  return lines.join('\n');
}
