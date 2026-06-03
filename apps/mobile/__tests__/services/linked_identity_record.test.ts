/**
 * Linked external AT Protocol identity store — round-trip + guards.
 */

import { resetKeychainMock } from '../../__mocks__/react-native-keychain';
import {
  loadLinkedAtprotoIdentity,
  saveLinkedAtprotoIdentity,
  clearLinkedAtprotoIdentity,
} from '../../src/services/linked_identity_record';

beforeEach(() => {
  resetKeychainMock();
});

describe('linked_identity_record', () => {
  it('returns null when nothing is linked', async () => {
    expect(await loadLinkedAtprotoIdentity()).toBeNull();
  });

  it('round-trips a verified (OAuth) linked identity', async () => {
    const rec = {
      did: 'did:plc:linkedbsky',
      handle: 'alice.bsky.social',
      pdsUrl: 'https://bsky.social',
      linkedAt: '2026-06-03T00:00:00.000Z',
      verified: true,
    };
    await saveLinkedAtprotoIdentity(rec);
    expect(await loadLinkedAtprotoIdentity()).toEqual(rec);
  });

  it('round-trips an unverified (resolve-only) link and tolerates a null handle', async () => {
    const rec = {
      did: 'did:plc:onlydid',
      handle: null,
      pdsUrl: 'https://pds.example',
      linkedAt: '2026-06-03T01:00:00.000Z',
      verified: false,
    };
    await saveLinkedAtprotoIdentity(rec);
    expect(await loadLinkedAtprotoIdentity()).toEqual(rec);
  });

  it('rejects a non-did identifier', async () => {
    await expect(
      saveLinkedAtprotoIdentity({
        did: 'alice.bsky.social',
        handle: 'alice.bsky.social',
        pdsUrl: 'https://bsky.social',
        linkedAt: '2026-06-03T00:00:00.000Z',
        verified: false,
      }),
    ).rejects.toThrow(/did must be a non-empty/);
  });

  it('clears the linked identity', async () => {
    await saveLinkedAtprotoIdentity({
      did: 'did:plc:linkedbsky',
      handle: 'alice.bsky.social',
      pdsUrl: 'https://bsky.social',
      linkedAt: '2026-06-03T00:00:00.000Z',
      verified: true,
    });
    await clearLinkedAtprotoIdentity();
    expect(await loadLinkedAtprotoIdentity()).toBeNull();
  });
});
