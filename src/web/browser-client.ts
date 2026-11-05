import type { InstantlyClient } from '../core/types.js';
import { WEB_BROWSER_ENV, createCdpTransport } from './cdp.js';
import { createWebClient } from './client.js';
import type { WebTransport } from './transport.js';
import { WebError } from './transport.js';

const failing = (error: unknown): WebTransport => ({ call: async () => { throw error; }, act: async () => { throw error; } });

/**
 * Client for web commands, bound to one workspace. The browser is the operator's own, already running and
 * signed in; this never launches one. With no endpoint configured, any web call fails before touching a network.
 * A malformed endpoint must not break public API commands, so it fails only when a web command runs.
 */
export function webClientFor(workspace: string, browserUrl: string | undefined = process.env[WEB_BROWSER_ENV]): InstantlyClient {
  if (!browserUrl) {
    return createWebClient(failing(new WebError('WEB_BROWSER_UNAVAILABLE', `set ${WEB_BROWSER_ENV} to the loopback debugging URL of the signed-in browser`)), workspace);
  }
  try {
    return createWebClient(createCdpTransport({ browserUrl }), workspace);
  } catch (error) {
    return createWebClient(failing(error), workspace);
  }
}
