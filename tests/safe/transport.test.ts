import { it, expect, vi } from 'vitest';
import { InstantlyClient } from '../../src/core/client.js';

it('safe mutation transport never retries 429 or server errors', async () => {
  for (const status of [429, 500, 503]) {
    const fetch = vi.fn().mockResolvedValue(new Response('{"message":"synthetic failure"}', { status }));
    vi.stubGlobal('fetch', fetch);
    try {
      const client = new InstantlyClient({ apiKey: 'synthetic-not-a-credential', maxRetries: 3 });
      await expect(client.request({ method: 'POST', path: '/campaigns', body: {}, retry: 'never' })).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  }
});
