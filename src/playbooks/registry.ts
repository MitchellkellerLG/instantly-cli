import { allCommands } from '../commands/index.js';
import { campaignIdeas } from './book/ideas.js';
import { lookalike } from './book/lookalike.js';
import { offerProfile } from './book/offer.js';
import { segments } from './book/segments.js';
import { visitors } from './book/visitors.js';
import type { PlaybookDefinition } from './types.js';

/** Ranked as in the plan. Order is stable and part of the public surface. */
export const allPlaybooks: PlaybookDefinition[] = [campaignIdeas, offerProfile, segments, visitors, lookalike];
export { allCommands };
