/** One request through the operator's signed-in browser. Credentials never cross this boundary. */
export interface WebCall {
  method: 'GET' | 'POST';
  /** Local path with query already encoded, for example /backend-alt/api/v1/tasks?limit=5. */
  url: string;
  body?: unknown;
  /** Workspace the caller expects the browser session to be on. A mismatch sends nothing. */
  workspace: string;
}
export interface WebReply { status: number; json: unknown; text?: string }
/** One attended UI action: open a page, type into fields, stop. The transport never clicks or submits. */
export interface ActionCall { page: string; fills: { selector: string; value: string }[]; workspace: string }
export interface WebTransport {
  call(call: WebCall): Promise<WebReply>;
  act?(call: ActionCall): Promise<WebReply>;
}

export class WebError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = 'WebError'; }
}
