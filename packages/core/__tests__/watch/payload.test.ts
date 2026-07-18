/**
 * PSVC-0 — poll-mode watch payload parse/serialize (round-trip + rejection).
 */

import {
  MIN_POLL_INTERVAL_SEC,
  parseWatchPollPayload,
  serializeWatchPollPayload,
  type WatchPollPayload,
} from '../../src/watch/payload';

const base: WatchPollPayload = {
  type: 'watch_poll',
  subscription_id: 'sub-1',
  persona: 'general',
  service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
  provider_did: 'did:plc:prov',
  capability: 'flight_status',
  query: { flight: 'BA117' },
  poll_interval_sec: 300,
  condition: 'delay > 30m',
};

describe('watch payload', () => {
  it('round-trips through serialize → parse', () => {
    const out = parseWatchPollPayload(serializeWatchPollPayload(base));
    expect(out).toEqual(base);
  });

  it('defaults query to {} and omits an absent condition', () => {
    const { condition: _c, query: _q, ...rest } = base;
    const out = parseWatchPollPayload(JSON.stringify(rest));
    expect(out?.query).toEqual({});
    expect(out?.condition).toBeUndefined();
  });

  it.each([
    ['not json', 'not-json'],
    ['empty', ''],
    ['wrong type discriminator', JSON.stringify({ ...base, type: 'service_query' })],
    ['missing subscription_id', JSON.stringify({ ...base, subscription_id: '' })],
    ['missing provider_did', JSON.stringify({ ...base, provider_did: undefined })],
    ['non-positive interval', JSON.stringify({ ...base, poll_interval_sec: 0 })],
    ['NaN interval', JSON.stringify({ ...base, poll_interval_sec: 'soon' })],
  ])('rejects %s → null', (_label, raw) => {
    expect(parseWatchPollPayload(raw)).toBeNull();
  });

  it('exports a sane poll-interval floor', () => {
    expect(MIN_POLL_INTERVAL_SEC).toBeGreaterThanOrEqual(30);
  });
});
