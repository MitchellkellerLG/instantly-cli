import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/program.js';

describe('official CLI capabilities through the public program', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('{"id":"mock-result"}'));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('INSTANTLY_PROFILE', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  async function run(args: string[]) {
    await createProgram().exitOverride().parseAsync(['--api-key', 'mock-only', ...args], { from: 'user' });
  }

  function body() {
    return JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
  }

  it.each([
    ['warmup-enable', 'one, two'],
    ['warmup-disable', '["one","two"]'],
  ])('accepts array flags before schema validation: %s', async (command, ids) => {
    await run(['accounts', command, '--account-ids', ids]);
    expect(body()).toEqual({ account_ids: ['one', 'two'] });
  });

  it('accepts user arrays for bulk assignment', async () => {
    await run(['leads', 'bulk-assign', '--user-ids', '["one","two"]', '--ids', 'lead-1,lead-2']);
    expect(body()).toEqual({ organization_user_ids: ['one', 'two'], ids: ['lead-1', 'lead-2'] });
  });

  it('moves selected leads with the API ids and campaign fields', async () => {
    await run(['leads', 'move', '--lead-ids', 'one, two', '--from-campaign-id', 'source', '--to-campaign-id', 'target']);
    expect(body()).toEqual({ ids: ['one', 'two'], campaign: 'source', to_campaign_id: 'target' });
  });

  it('maps the campaign filter to the lead-list API field', async () => {
    await run(['leads', 'list', '--campaign-id', 'source']);
    expect(body()).toEqual({ campaign: 'source', limit: 10 });
  });

  it('accepts a string AI prompt template ID', async () => {
    await run(['enrichment', 'ai', '--resource-id', 'resource', '--output-column', 'result',
      '--resource-type', '1', '--model-version', 'mock-model', '--template-id', 'template-example']);
    expect(body().template_id).toBe('template-example');
  });

  it('accepts arrays when moving leads to a subsequence', async () => {
    await run(['leads', 'subsequence-move', '--lead-ids', '["one","two"]', '--subsequence-id', 'sub']);
    expect(body()).toMatchObject({ lead_ids: ['one', 'two'] });
  });

  it('creates an account with warmup and sending settings', async () => {
    await run(['accounts', 'create', '--email', 'sender@example.com',
      '--smtp-host', 'smtp.example.com', '--smtp-port', '587', '--smtp-username', 'mock', '--smtp-password', 'mock',
      '--imap-host', 'imap.example.com', '--imap-port', '993', '--imap-username', 'mock', '--imap-password', 'mock',
      '--reply-to', 'reply@example.com', '--tracking-domain-name', 'track.example.com', '--skip-cname-check',
      '--warmup', '{"limit":30,"increment":"disabled"}', '--warmup-custom-ftag', 'example', '--enable-slow-ramp',
      '--inbox-placement-test-limit', '10', '--sending-gap', '5', '--provider-code', '1']);
    expect(body()).toMatchObject({ reply_to: 'reply@example.com', tracking_domain_name: 'track.example.com',
      skip_cname_check: true, warmup: { limit: 30, increment: 'disabled' }, warmup_custom_ftag: 'example',
      enable_slow_ramp: true, inbox_placement_test_limit: 10, sending_gap: 5, provider_code: 1 });
  });

  it('rejects invalid array elements before HTTP', async () => {
    await run(['accounts', 'warmup-enable', '--account-ids', '[1,2]']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('rejects invalid warmup JSON before HTTP', async () => {
    await run(['accounts', 'create', '--email', 'sender@example.com',
      '--smtp-host', 'smtp.example.com', '--smtp-port', '587', '--smtp-username', 'mock', '--smtp-password', 'mock',
      '--imap-host', 'imap.example.com', '--imap-port', '993', '--imap-username', 'mock', '--imap-password', 'mock',
      '--warmup', '[]']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('creates a custom-label webhook with structured delivery headers', async () => {
    await run(['webhooks', 'create', '--url', 'https://example.com/hook', '--custom-interest-value', '3', '--headers', '{"X-Example":"value"}']);
    expect(body()).toEqual({ target_hook_url: 'https://example.com/hook', custom_interest_value: 3, headers: { 'X-Example': 'value' } });
  });

  it('updates webhook headers without leaking the path ID into the body', async () => {
    await run(['webhooks', 'update', 'hook/id', '--headers', '{"X-Example":"value"}']);
    expect(fetchMock.mock.calls[0][0].toString()).toContain('/webhooks/hook%2Fid');
    expect(body()).toEqual({ headers: { 'X-Example': 'value' } });
  });

  it.each(['not-json', '[]', '{"X-Example":4}'])('rejects invalid webhook headers before HTTP: %s', async (headers) => {
    await run(['webhooks', 'create', '--url', 'https://example.com/hook', '--headers', headers]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('passes false and pagination options to workspace-member queries', async () => {
    await run(['workspace-members', 'list', '--accepted', 'false', '--limit', '20', '--starting-after', 'cursor']);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({ accepted: 'false', limit: '20', starting_after: 'cursor' });
  });

  it('passes reply reminder and assignment while validating the recipient', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"from_address_email":"lead@example.com"}'));
    await run(['email', 'reply', '--reply-to-uuid', 'thread', '--to', 'lead@example.com', '--eaccount', 'sender@example.com',
      '--subject', 'Re: Hello', '--body-text', 'Hello', '--reminder-ts', '2026-11-01T10:00:00Z',
      '--assigned-to', '11111111-1111-4111-8111-111111111111']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body()).toMatchObject({ reminder_ts: '2026-11-01T10:00:00Z', assigned_to: '11111111-1111-4111-8111-111111111111', body: { text: 'Hello' } });
    expect(body()).not.toHaveProperty('to');
  });
});
