import tiersJson from './tiers.json';
import { TIERS, type PlaybookDefinition, type Requirement, type Tier } from './types.js';

export interface TierPolicy {
  description: string;
  allowedWrites: string[];
  allowUnknownCost: boolean;
  creditCeiling: number;
  forbiddenRequires: Requirement[];
}
export const TIER_POLICY = tiersJson as Record<Tier, TierPolicy>;

/** Unknown or missing tier is the least privileged one. A typo can never widen access. */
export function resolveTier(...candidates: (string | undefined)[]): Tier {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === '') continue;
    if ((TIERS as readonly string[]).includes(candidate)) return candidate as Tier;
    throw new Error(`UNKNOWN_TIER: '${candidate}'. Use vip, managed or internal.`);
  }
  return 'vip';
}
export function visibleTo(tier: Tier, playbook: Pick<PlaybookDefinition, 'requires'>): boolean {
  return !playbook.requires.some(r => TIER_POLICY[tier].forbiddenRequires.includes(r));
}
/** Effective writes are the intersection of the tier maximum and what the operator enabled on the host. */
export function effectiveWrites(tier: Tier, hostAllowed: readonly string[]): string[] {
  return hostAllowed.filter(command => TIER_POLICY[tier].allowedWrites.includes(command));
}
