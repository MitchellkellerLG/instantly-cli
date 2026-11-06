import type { InstantlyClient } from '../core/types.js';

export type Request = Parameters<InstantlyClient['request']>[0];
export function clientFromRequest(request: InstantlyClient['request']): InstantlyClient {
  return {
    request,
    get: (path, query) => request({ method: 'GET', path, query }),
    post: (path, body, query) => request({ method: 'POST', path, body, query }),
    patch: (path, body) => request({ method: 'PATCH', path, body }),
    delete: (path, query) => request({ method: 'DELETE', path, query }),
  };
}
export function assertLocalPath(request: Request): void {
  if (!/^\/(?!\/)[^?#\\]*$/.test(request.path) || request.path.includes('://') || /[\r\n]/.test(request.path)) {
    throw new Error('EXTERNAL_ROUTE_DENIED');
  }
}
