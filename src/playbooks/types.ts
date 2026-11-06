import type { z } from 'zod';

/** Privilege order: vip < managed < internal. A tier is a policy label, never an entitlement claim. */
export type Tier = 'vip' | 'managed' | 'internal';
export const TIERS: readonly Tier[] = ['vip', 'managed', 'internal'];
export type Requirement = 'api_read' | 'api_write' | 'spend' | 'browser_read' | 'browser_write' | 'model';

export const OFFER_ANGLES = ['make_money', 'save_time', 'save_money', 'mitigate_risk'] as const;
export type OfferAngle = typeof OFFER_ANGLES[number];
export const OFFER_CATEGORIES = ['service', 'saas', 'local_service', 'agency', 'recruiting', 'creator_partnership', 'investment', 'unknown'] as const;
export type OfferCategory = typeof OFFER_CATEGORIES[number];

export interface Evidence { field: string; source: string; signal: string }
export interface OfferProfile {
  offer_angle: OfferAngle | null;
  offer_category: OfferCategory;
  motion: 'outbound' | 'demand_gen' | 'unknown';
  entitlements: { outreach: boolean; credits_available: number | null; crm: boolean; website_visitors: boolean; inbox_placement: boolean };
  scale: { campaigns: number; sampled_leads: number; sales_agents: number };
  confidence: 'high' | 'medium' | 'low';
  needs_confirmation: boolean;
  evidence: Evidence[];
}

/** A read the runner executes through SafeDispatcher.read. Anything outside the frozen allowlist fails closed. */
export interface ReadStep {
  id: string;
  command: string;
  /** Static arguments, or a pure function of earlier read results (reads never follow a write). */
  args: Record<string, unknown> | ((earlier: ReadResults) => Record<string, unknown> | null);
  optional?: boolean;
  /** Follow next_starting_after for at most this many pages. Items are concatenated into one result. */
  pages?: number;
  requireComplete?: boolean;
}
export type ReadResult = { ok: true; value: unknown } | { ok: false; code: string };
export type ReadResults = Record<string, ReadResult>;

/**
 * A dependent field: the only thing allowed to vary at run time. The value is read from an earlier
 * step's response at a fixed path, must be a UUID, and is placed in one top-level argument.
 */
export interface Fill { into: string; from: string; path: string; asArray?: boolean }
/**
 * One registered single-request command. `args` is the fixed template. `fills` name the only fields that
 * depend on earlier results; everything else, including the command, is hashed into the plan.
 */
export interface WriteStep {
  id: string;
  stage: number;
  command: string;
  summary: string;
  args: Record<string, unknown>;
  fills?: Fill[];
  /** Attach this step's (small, non-PII) response to its receipt, e.g. a background job id. */
  exposeResponse?: boolean;
  /** Maximum credits this step may spend. Zero for organisational writes. */
  credits: number;
  /** Read-only lookup a host can run after an unknown execution status to see whether this step landed. */
  reconcile?: ReadStep;
}
/** Browser steps are never executed by the playbook layer. They are an attended checklist. */
export interface BrowserStep {
  id: string;
  page: string;
  action: 'observe' | 'fill' | 'attended-submit' | 'external';
  instruction: string;
  fields?: string[];
}
export type RefusalCode = 'NOT_ENTITLED' | 'WRITE_POLICY_DENIED' | 'BROWSER_REQUIRED' | 'SPEND_CEILING' | 'COST_POLICY_DENIED' | 'NEEDS_CONFIRMATION' | 'INSUFFICIENT_DATA';
export interface Refusal { code: RefusalCode; message: string; route?: string }
export interface Computed {
  artifact: unknown;
  writes: WriteStep[];
  browser: BrowserStep[];
  refusals: Refusal[];
  cost: { credits: 'none' | 'metered' | 'unknown'; max_credits: number; notes: string };
}
export interface ComputeContext { now: string }

export interface PlaybookDefinition {
  slug: string;
  title: string;
  description: string;
  requires: Requirement[];
  examples: string[];
  inputSchema: z.ZodObject<any>;
  /** Free offer-fit predicate used to rank and filter recommendations. */
  offerFit?: (offer: OfferProfile) => boolean;
  reads(input: Record<string, any>): ReadStep[];
  /** Pure and offline-testable. No account effect. */
  compute(input: Record<string, any>, reads: ReadResults, ctx: ComputeContext): Computed;
}
