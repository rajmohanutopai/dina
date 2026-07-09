/**
 * Pending-preflight store (CONTACT review #1/#2) — request_id correlation,
 * take-once, confused-deputy binding, TTL.
 *
 * Pins the contract the boot relies on: a stashed first-run intent is returned
 * exactly once and ONLY for the matching (request_id, contactDID) pair — so an
 * unrelated/proactive offer, or an offer from a different contact echoing a
 * request_id, can never replay it — and expires so a stale intent never fires.
 */

import {
  PENDING_PREFLIGHT_TTL_SECONDS,
  resetPendingPreflights,
  stashPendingPreflight,
  takePendingPreflight,
} from '../../src/services/pending_preflight';

const REQ = 'req-abc123';
const PEER = 'did:plc:sancho';

beforeEach(() => resetPendingPreflights());

describe('pending_preflight', () => {
  it('returns the stashed intent once for the matching request_id + contact', () => {
    stashPendingPreflight(REQ, PEER, 'find a time next week');
    expect(takePendingPreflight(REQ, PEER)).toEqual({ intent: 'find a time next week' });
    // A second offer echoing the same request_id must NOT replay again.
    expect(takePendingPreflight(REQ, PEER)).toBeNull();
  });

  it('does not match a different request_id', () => {
    stashPendingPreflight(REQ, PEER, 'x');
    expect(takePendingPreflight('req-other', PEER)).toBeNull();
    // original still intact
    expect(takePendingPreflight(REQ, PEER)).toEqual({ intent: 'x' });
  });

  it('confused-deputy guard: a foreign contact echoing the request_id is declined AND cannot evict the stash', () => {
    stashPendingPreflight(REQ, PEER, 'secret intent');
    // Wrong sender — declined (returns null)…
    expect(takePendingPreflight(REQ, 'did:plc:attacker')).toBeNull();
    // …but the stash is PRESERVED: a foreign offer must NOT consume it, so the
    // LEGITIMATE contact's later offer still replays exactly once. (Regression
    // guard for the delete-before-verify bug: the delete now happens only on
    // expiry or a matching consume.)
    expect(takePendingPreflight(REQ, PEER)).toEqual({ intent: 'secret intent' });
    expect(takePendingPreflight(REQ, PEER)).toBeNull();
  });

  it('the latest stash wins for the same request_id', () => {
    stashPendingPreflight(REQ, PEER, 'first');
    stashPendingPreflight(REQ, PEER, 'second');
    expect(takePendingPreflight(REQ, PEER)).toEqual({ intent: 'second' });
  });

  it('drops an expired stash (no replay long after the ask)', () => {
    stashPendingPreflight(REQ, PEER, 'stale', -1); // already expired
    expect(takePendingPreflight(REQ, PEER)).toBeNull();
  });

  it('ignores a degenerate key', () => {
    stashPendingPreflight('', PEER, 'x');
    stashPendingPreflight(REQ, '', 'x');
    expect(takePendingPreflight('', PEER)).toBeNull();
    expect(takePendingPreflight(REQ, PEER)).toBeNull();
  });

  it('exposes a sane default TTL', () => {
    expect(PENDING_PREFLIGHT_TTL_SECONDS).toBeGreaterThanOrEqual(30);
  });
});
