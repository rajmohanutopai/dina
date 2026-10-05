import { readUcpAgentProfile, readWebhookDelivery, WEBHOOK_MAX_BYTES } from '../src/webhook';

const enc = (v: unknown) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));

const HEADERS = {
  'ucp-agent': 'profile="https://shop.example/.well-known/ucp"',
  'webhook-id': 'evt_1',
  'webhook-timestamp': '1790000000',
  signature: 'sig1=:AAAA:',
  'signature-input': 'sig1=("@method");keyid="k"',
  'content-digest': 'sha-256=:AAAA:',
  'content-type': 'application/json',
};
const BODY = { id: 'ord_1', checkout_id: 'co_1', line_items: [] };

describe('UCP-Agent', () => {
  it.each([
    ['profile="https://m.example/.well-known/ucp"', 'https://m.example/.well-known/ucp'],
    ['profile="http://m.example/.well-known/ucp"', null],
    ['profile=?1', null],
    ['other="https://m.example/"', null],
    ['profile="unterminated', null],
  ])('%s', (header, want) => {
    expect(readUcpAgentProfile(header)).toBe(want);
  });
});

describe('an order webhook delivery', () => {
  it('reads the origin, ids and timestamp', () => {
    expect(readWebhookDelivery(HEADERS, enc(BODY))).toEqual({
      ok: true,
      delivery: {
        origin: 'https://shop.example',
        profileUrl: 'https://shop.example/.well-known/ucp',
        webhookId: 'evt_1',
        timestampMs: 1790000000000,
        orderId: 'ord_1',
        checkoutId: 'co_1',
        body: BODY,
      },
    });
  });

  it.each<[string, Record<string, string | undefined>, unknown, string]>([
    ['no Webhook-Id', { 'webhook-id': undefined }, BODY, 'header_missing'],
    ['an empty Webhook-Id', { 'webhook-id': '' }, BODY, 'header_missing'],
    ['an oversized Webhook-Id', { 'webhook-id': 'x'.repeat(257) }, BODY, 'header_missing'],
    ['no signature', { signature: undefined }, BODY, 'header_missing'],
    ['no Content-Digest', { 'content-digest': undefined }, BODY, 'header_missing'],
    ['no UCP-Agent', { 'ucp-agent': undefined }, BODY, 'header_missing'],
    [
      'a UCP-Agent that is not https',
      { 'ucp-agent': 'profile="http://x.example/.well-known/ucp"' },
      BODY,
      'agent_invalid',
    ],
    [
      'a version leaf, not the root profile',
      { 'ucp-agent': 'profile="https://shop.example/ucp/v2026-08-25.json"' },
      BODY,
      'not_root_profile',
    ],
    [
      'a root profile with a query',
      { 'ucp-agent': 'profile="https://shop.example/.well-known/ucp?x=1"' },
      BODY,
      'not_root_profile',
    ],
    [
      'a timestamp in ISO form',
      { 'webhook-timestamp': '2026-10-05T10:00:00Z' },
      BODY,
      'timestamp_invalid',
    ],
    ['a body that is not JSON', {}, 'not json', 'body_invalid'],
    ['a body with no checkout_id', {}, { id: 'ord_1' }, 'body_invalid'],
    ['a body with an empty id', {}, { id: '', checkout_id: 'co' }, 'body_invalid'],
    ['a body that is an array', {}, [BODY], 'body_invalid'],
    ['a body with a duplicate member', {}, '{"id":"a","id":"b","checkout_id":"c"}', 'body_invalid'],
  ])('refuses %s', (_n, over, body, reason) => {
    // Each header as overridden; one overridden to undefined is left out.
    const headers = Object.fromEntries(
      Object.entries({ ...HEADERS, ...over }).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    );
    expect(readWebhookDelivery(headers, enc(body))).toEqual({ ok: false, reason });
  });

  it('refuses a body that is not UTF-8, and one over the cap before reading it', () => {
    expect(readWebhookDelivery(HEADERS, new Uint8Array([0x7b, 0xff, 0x7d]))).toEqual({
      ok: false,
      reason: 'body_invalid',
    });
    expect(readWebhookDelivery(HEADERS, new Uint8Array(WEBHOOK_MAX_BYTES + 1))).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });
});
