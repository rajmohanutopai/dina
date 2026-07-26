import { getPublicKey } from '../../src/crypto/ed25519';
import { deriveDIDKey } from '../../src/identity/did';
import { deriveLocalServiceIdentity } from '../../src/identity/local_service_identity';

describe('deriveLocalServiceIdentity', () => {
  const ownerSeed = new Uint8Array(32).fill(7);

  it('is stable and distinct from the owner identity', () => {
    const first = deriveLocalServiceIdentity(ownerSeed, 'internal-brain');
    const second = deriveLocalServiceIdentity(ownerSeed, 'internal-brain');
    const ownerDid = deriveDIDKey(getPublicKey(ownerSeed));

    expect(first.did).toBe(second.did);
    expect(first.keypair.privateKey).toEqual(second.keypair.privateKey);
    expect(first.did).toMatch(/^did:key:z6Mk/);
    expect(first.did).not.toBe(ownerDid);
  });

  it('domain-separates service names and owner seeds', () => {
    const otherOwner = new Uint8Array(32).fill(8);
    expect(deriveLocalServiceIdentity(ownerSeed, 'internal-brain').did).not.toBe(
      deriveLocalServiceIdentity(ownerSeed, 'plugin-runner').did,
    );
    expect(deriveLocalServiceIdentity(ownerSeed, 'internal-brain').did).not.toBe(
      deriveLocalServiceIdentity(otherOwner, 'internal-brain').did,
    );
  });

  it('rejects malformed seed and service names', () => {
    expect(() => deriveLocalServiceIdentity(new Uint8Array(31), 'internal-brain')).toThrow(
      '32-byte',
    );
    for (const name of ['', 'Internal Brain', '-brain', 'brain-', 'brain/worker']) {
      expect(() => deriveLocalServiceIdentity(ownerSeed, name)).toThrow('canonical service name');
    }
  });
});
