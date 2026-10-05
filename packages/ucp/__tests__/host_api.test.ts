/** The profile host's HTTP contract (UCP plan §3.5): endpoints and the answers both sides parse. */
import { hostEndpoints, parseHostAnswer, parsePublicState } from '../src/host_api';
import { labelFromBytes } from '../src/publication';

const LABEL = labelFromBytes(new Uint8Array(16).fill(0x42));
const STATE = {
  revision: 2,
  epoch: 1,
  instance: '11111111-1111-4111-8111-111111111111',
  highest_generation: 0,
  keys: [{ thumbprint: 'T'.repeat(43), generation: 0, phase: 'active' }],
  retired: [],
  serving: true,
};

describe('host endpoints', () => {
  it('names the profile, retire and state URLs for a label, on production or a test host', () => {
    expect(hostEndpoints(LABEL)).toEqual({
      profile: `https://ucp.dinakernel.com/v1/profiles/${LABEL}`,
      retire: `https://ucp.dinakernel.com/v1/profiles/${LABEL}/retire`,
      state: `https://ucp.dinakernel.com/v1/profiles/${LABEL}/state`,
    });
    expect(hostEndpoints(LABEL, 'ucp.test.dinakernel.com').state).toBe(
      `https://ucp.test.dinakernel.com/v1/profiles/${LABEL}/state`,
    );
    expect(() => hostEndpoints('Not-A-Label')).toThrow();
  });
});

describe('answers', () => {
  it('reads applied and replay answers with their state', () => {
    expect(parseHostAnswer({ status: 'applied', state: STATE })).toEqual({
      status: 'applied',
      state: STATE,
    });
    expect(parseHostAnswer({ status: 'replay', state: STATE })).toMatchObject({ status: 'replay' });
  });
  it('reads a refusal with or without a state', () => {
    expect(
      parseHostAnswer({ status: 'refused', reason: 'stale_revision', state: STATE }),
    ).toMatchObject({
      status: 'refused',
      reason: 'stale_revision',
      state: STATE,
    });
    expect(parseHostAnswer({ status: 'refused', reason: 'not_bound', state: null })).toEqual({
      status: 'refused',
      reason: 'not_bound',
      state: null,
    });
  });
  it.each([
    ['an unknown status', { status: 'ok', state: STATE }],
    ['an unknown reason', { status: 'refused', reason: 'nope', state: null }],
    ['a malformed state', { status: 'applied', state: { ...STATE, revision: -1 } }],
    [
      'a refusal with a malformed state',
      { status: 'refused', reason: 'stale_revision', state: { revision: 'x' } },
    ],
  ])('refuses %s', (_n, value) => {
    expect(parseHostAnswer(value)).toBeNull();
  });
  it('reads a never-published state (highest generation -1) and refuses a bad key phase', () => {
    expect(parsePublicState({ ...STATE, highest_generation: -1, keys: [] })).toMatchObject({
      highest_generation: -1,
    });
    expect(
      parsePublicState({ ...STATE, keys: [{ thumbprint: 'x', generation: 0, phase: 'gone' }] }),
    ).toBeNull();
  });
});
