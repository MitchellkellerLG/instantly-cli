import type { InstantlyClient } from '../core/types.js';
import { clone, digest, canonical } from '../safe/canonical.js';
import { assertLocalPath, clientFromRequest, type Request } from '../safe/transport.js';

export interface FixtureContext {
  command: string;
  arguments: Record<string, unknown>;
  workspace: string;
}
export interface Fixture {
  context: FixtureContext;
  position: number;
  request: Request;
  response?: unknown;
  error?: string;
  provenance: 'synthetic' | 'recorded-redacted';
  captured: string;
  schemaVersion: 1;
  responseHash: string;
}
/** No fetch, auth resolver, DNS, or fallback. Every sequence element must match. */
export class FakeTransport {
  readonly events: { request: Request; matched: boolean }[] = [];
  readonly client: InstantlyClient;
  private position = 0;
  constructor(private context: FixtureContext, private fixtures: Fixture[]) {
    this.client = clientFromRequest(async <T>(request: Request): Promise<T> => {
      const { retry: _retry, ...wire } = request;
      request = wire;
      assertLocalPath(request);
      const position = this.position++;
      const matches = fixtures.filter(f => canonical(f.context) === canonical(context) && f.position === position &&
        canonical(f.request) === canonical(request));
      this.events.push({ request: clone(request), matched: matches.length === 1 });
      if (matches.length !== 1) throw new Error('UNMATCHED_FIXTURE');
      const fixture = matches[0];
      if (fixture.responseHash !== digest({ response: fixture.response, error: fixture.error })) throw new Error('FIXTURE_HASH_MISMATCH');
      if (fixture.error) throw new Error(fixture.error);
      return clone(fixture.response ?? null) as T;
    });
  }
  assertComplete(): void {
    const expected = this.fixtures.filter(f => canonical(f.context) === canonical(this.context));
    if (this.position !== expected.length) throw new Error('INCOMPLETE_FIXTURE_SEQUENCE');
  }
}
