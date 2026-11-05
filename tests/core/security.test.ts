import { describe, it, expect, vi, afterEach } from 'vitest';
import { InstantlyClient } from '../../src/core/client.js';
import { formatError, InstantlyError } from '../../src/core/errors.js';
import { redactText, redactValue, REDACTED } from '../../src/core/redact.js';
import { safeOAuthUrl, openOAuthUrl, openCommandFor } from '../../src/core/open-url.js';

afterEach(() => vi.unstubAllGlobals());

describe('F1 OAuth URL launch', () => {
  it('only accepts https URLs on known OAuth hosts', () => {
    expect(safeOAuthUrl('https://accounts.google.com/o/oauth2/v2/auth?x=1')).toBeTruthy();
    expect(safeOAuthUrl('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')).toBeTruthy();
    for (const bad of ['http://accounts.google.com/', 'https://example.com/$(touch x)', 'file:///etc/passwd', 'javascript:alert(1)',
      'https://accounts.google.com.evil.example/', 'https://user:pw@accounts.google.com/', '--flag', 42, undefined]) {
      expect(safeOAuthUrl(bad as unknown), String(bad)).toBeUndefined();
    }
  });
  it('passes the URL as a single argv element and never through a shell', () => {
    const calls: [string, string[]][] = [];
    expect(openOAuthUrl('https://accounts.google.com/a?b=$(id)&c=`id`', (c, a) => calls.push([c, a]), 'linux')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('xdg-open');
    expect(calls[0][1]).toHaveLength(1);
    expect(openCommandFor('https://accounts.google.com/', 'win32')[0]).toBe('rundll32');
    expect(openCommandFor('https://accounts.google.com/', 'darwin')[0]).toBe('open');
  });
  it('refuses to launch a malicious URL', () => {
    const spawner = vi.fn();
    expect(openOAuthUrl('https://example.com/$(touch pwned)', spawner)).toBe(false);
    expect(spawner).not.toHaveBeenCalled();
  });
});

describe('F7 write retries', () => {
  const run = async (method: 'get' | 'post' | 'patch' | 'delete') => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => (++calls === 1 ? Response.json({ message: 'boom' }, { status: 500 }) : Response.json({ ok: true })));
    const client = new InstantlyClient({ apiKey: 'synthetic-key-1234', maxRetries: 1 });
    const result = await client[method]('/x').catch((e: Error) => e);
    return { calls, result };
  };
  it('does not retry any write after a 5xx', async () => {
    for (const m of ['post', 'patch', 'delete'] as const) {
      const { calls, result } = await run(m);
      expect(calls, m).toBe(1);
      expect(result).toBeInstanceOf(InstantlyError);
    }
  });
  it('still retries reads', async () => {
    vi.useFakeTimers();
    const p = run('get');
    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();
    expect((await p).calls).toBe(2);
  });
});

describe('F8 redaction', () => {
  const key = 'synthetic-audit-key-0001';
  it('removes a reflected API key from client errors, in plain, URL and base64 form', async () => {
    for (const reflected of [key, encodeURIComponent(key + ' x'), Buffer.from(key).toString('base64')]) {
      vi.stubGlobal('fetch', async () => Response.json({ message: `upstream reflected ${reflected}` }, { status: 400 }));
      const client = new InstantlyClient({ apiKey: key, maxRetries: 0 });
      const err = await client.get('/campaigns').catch((e: Error) => e);
      expect((err as Error).message).not.toContain(reflected);
      expect((err as Error).message).toContain(REDACTED);
    }
  });
  it('masks bearer tokens in formatted errors', () => {
    expect(formatError(new Error('failed with Authorization: Bearer abcdefghijklmnop')).message).not.toContain('abcdefghijklmnop');
  });
  it('masks credential-named fields and known secrets deeply, leaving ordinary data', () => {
    const out = redactValue({ items: [{ email: 'a@example.com', password: 'p1', imap_pass: 'p2', nested: { api_key: 'k', note: `has ${key}` } }], bypass: 'ok', passed: 3 }, [key]) as any;
    expect(out.items[0].password).toBe(REDACTED);
    expect(out.items[0].imap_pass).toBe(REDACTED);
    expect(out.items[0].nested.api_key).toBe(REDACTED);
    expect(out.items[0].nested.note).toBe(`has ${REDACTED}`);
    expect(out.items[0].email).toBe('a@example.com');
    expect(out.bypass).toBe('ok');
    expect(out.passed).toBe(3);
    expect(redactText('nothing here')).toBe('nothing here');
  });
});
