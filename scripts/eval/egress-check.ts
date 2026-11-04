import { FakeTransport } from '../../src/eval/offline.js';
let fetchCalls = 0;
const original = globalThis.fetch;
globalThis.fetch = (() => { fetchCalls++; throw new Error('OFFLINE_EGRESS_DENIED'); }) as typeof fetch;
try {
  const transport = new FakeTransport({ command: 'unmatched', arguments: {}, workspace: 'synthetic' }, []);
  const errors: string[] = [];
  for (const path of ['/deliberately-unmatched', 'https://example.com/forbidden', '//example.com/forbidden']) {
    try { await transport.client.get(path); throw new Error('EGRESS_GATE_BYPASSED'); }
    catch (error) {
      const message = (error as Error).message;
      if (!['UNMATCHED_FIXTURE', 'EXTERNAL_ROUTE_DENIED'].includes(message)) throw error;
      errors.push(message);
    }
  }
  if (fetchCalls !== 0 || errors.length !== 3) throw new Error('EGRESS_CHECK_FAILED');
  console.log(JSON.stringify({ errors, fetchCalls, networkEgress: 0 }));
} finally { globalThis.fetch = original; }
