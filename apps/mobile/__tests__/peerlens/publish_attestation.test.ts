/**
 * Unit tests for the sovereign attestation publish (slices 1–3 of the
 * "real PeerLens publish" build). Verifies the identity gate, the NSID +
 * $type the record is published under, and error propagation — using a
 * fake PDSPublisher so no network/PDS is required.
 */

import { PEERLENS_NSIDS } from '@dina/protocol';

import {
  publishAttestationToPDS,
  AttestationIdentityMismatchError,
} from '../../src/peerlens/publish_attestation';

interface FakePDS {
  authenticate: () => Promise<string>;
  putRecord: (
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
  ) => Promise<{ uri: string; cid: string }>;
}

function makeFakePds(over: Partial<FakePDS> = {}): FakePDS {
  return {
    authenticate: async () => 'did:plc:owner',
    putRecord: async () => ({ uri: 'at://did:plc:owner/c/r', cid: 'bafy' }),
    ...over,
  };
}

const RECORD = {
  subject: { type: 'product', name: 'ErgoFlex Chair' },
  category: 'furniture',
  sentiment: 'positive',
  confidence: 'high',
  text: 'Great lower-back support.',
  createdAt: '2026-06-08T00:00:00.000Z',
};

describe('publishAttestationToPDS', () => {
  it('publishes under the attestation NSID with a $type and returns uri/cid', async () => {
    let seen: { collection: string; rkey: string; record: Record<string, unknown> } | null = null;
    const pds = makeFakePds({
      putRecord: async (collection, rkey, record) => {
        seen = { collection, rkey, record };
        return { uri: 'at://did:plc:owner/x/rk', cid: 'bafyreiabc' };
      },
    });

    const res = await publishAttestationToPDS(
      pds as never,
      'did:plc:owner',
      { ...RECORD },
      'mob-rk-1',
    );

    expect(res).toEqual({ uri: 'at://did:plc:owner/x/rk', cid: 'bafyreiabc' });
    if (seen === null) throw new Error('putRecord was never called');
    expect(seen.collection).toBe(PEERLENS_NSIDS.attestation);
    expect(seen.rkey).toBe('mob-rk-1');
    // The record carries the AppView ingester discriminator + the body.
    expect(seen.record.$type).toBe(PEERLENS_NSIDS.attestation);
    expect(seen.record.category).toBe('furniture');
    expect(seen.record.sentiment).toBe('positive');
  });

  it('refuses to write when the PDS session DID is not this node', async () => {
    let wrote = false;
    const pds = makeFakePds({
      authenticate: async () => 'did:plc:someone-else',
      putRecord: async () => {
        wrote = true;
        return { uri: 'x', cid: 'y' };
      },
    });

    await expect(
      publishAttestationToPDS(pds as never, 'did:plc:owner', { ...RECORD }, 'mob-rk-2'),
    ).rejects.toBeInstanceOf(AttestationIdentityMismatchError);
    expect(wrote).toBe(false); // identity checked BEFORE any write
  });

  it('propagates a PDS putRecord failure to the caller (so it can queue)', async () => {
    const pds = makeFakePds({
      putRecord: async () => {
        throw new Error('HTTP 503');
      },
    });

    await expect(
      publishAttestationToPDS(pds as never, 'did:plc:owner', { ...RECORD }, 'mob-rk-3'),
    ).rejects.toThrow('HTTP 503');
  });
});
