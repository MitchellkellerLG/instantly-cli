/** Secrets that must never reach logs, errors, fixtures or tool output. */
const JWT = /eyJ[\w-]{2,}\.[\w-]{2,}\.[\w-]{2,}/g;
const BEARER = /\bBearer\s+[\w.~+/=-]{12,}/gi;
const HEADER = /\b(x-org-auth|authorization|cookie|set-cookie)\s*[:=]\s*[^\s,;]+/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function redactText(text: string): string {
  return text.replace(JWT, '<jwt>').replace(BEARER, 'Bearer <token>').replace(HEADER, '$1: <redacted>')
    .replace(EMAIL, '<email>').replace(UUID, '<uuid>');
}
/** Fixture leak check: true when the text still contains secret-shaped material. */
export function leaks(text: string): boolean {
  return redactText(text) !== text;
}
