/**
 * REAL_LIFE_FIXES §9 — providers this node saw go quiet rank lower, but at
 * most half of the set is demoted and a lone candidate never is.
 */

import { rankCandidates } from '../../src/service/candidate_ranker';

import type { ServiceProfile } from '../../src/appview_client/http';

const p = (did: string): ServiceProfile => ({ did, name: did, capabilities: ['eta_query'], isDiscoverable: true });

describe('ranking around quiet providers', () => {
  it('a quiet provider sorts after the rest', () => {
    const out = rankCandidates('eta_query', [p('did:plc:a'), p('did:plc:b')], { ejected: new Set(['did:plc:a']) });
    expect(out.map((c) => c.profile.did)).toEqual(['did:plc:b', 'did:plc:a']);
  });

  it('a lone candidate is never demoted', () => {
    const out = rankCandidates('eta_query', [p('did:plc:a')], { ejected: new Set(['did:plc:a']) });
    expect(out[0]?.demoted).toBeUndefined();
  });

  it('at most half of the set is demoted, taken in index order', () => {
    const all = ['a', 'b', 'c', 'd'].map((x) => p(`did:plc:${x}`));
    const out = rankCandidates('eta_query', all, { ejected: new Set(['did:plc:a', 'did:plc:b', 'did:plc:c']) });
    expect(out.map((c) => c.profile.did)).toEqual(['did:plc:c', 'did:plc:d', 'did:plc:a', 'did:plc:b']);
  });
});
