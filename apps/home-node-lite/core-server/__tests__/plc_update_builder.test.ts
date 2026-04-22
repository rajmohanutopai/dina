/**
 * Task 6.7 — PLC update builder tests.
 */

import {
  buildPlcUpdateOp,
  type BuildUpdateOutcome,
  type SignerFn,
} from '../src/appview/plc_update_builder';
import type { PlcOperation } from '../src/appview/plc_chain_verifier';

const PREV: PlcOperation = {
  sig: 'prev-sig',
  prev: null,
  rotationKeys: ['K1', 'K2'],
  createdAtMs: 1000,
};
const PREV_CID = 'cid-prev';

function stubSigner(sig = 'signed!'): SignerFn {
  return async () => sig;
}

describe('buildPlcUpdateOp (task 6.7)', () => {
  describe('construction', () => {
    it('throws without signFn', async () => {
      await expect(
        buildPlcUpdateOp({
          prevCid: PREV_CID,
          prev: PREV,
          update: {
            rotationKeys: ['K3'],
            signerPublicKey: 'K1',
          },
          signFn: undefined as unknown as SignerFn,
        }),
      ).rejects.toThrow(/signFn/);
    });

    it('throws without prev', async () => {
      await expect(
        buildPlcUpdateOp({
          prevCid: PREV_CID,
          prev: null as unknown as PlcOperation,
          update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
          signFn: stubSigner(),
        }),
      ).rejects.toThrow(/prev/);
    });

    it('throws without signerPublicKey', async () => {
      await expect(
        buildPlcUpdateOp({
          prevCid: PREV_CID,
          prev: PREV,
          update: { rotationKeys: ['K3'] } as unknown as {
            rotationKeys: string[];
            signerPublicKey: string;
          },
          signFn: stubSigner(),
        }),
      ).rejects.toThrow(/signerPublicKey/);
    });
  });

  describe('happy path', () => {
    it('builds a valid signed op', async () => {
      const out = (await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: {
          rotationKeys: ['K3', 'K4'],
          signerPublicKey: 'K1',
        },
        signFn: stubSigner('new-sig'),
      })) as Extract<BuildUpdateOutcome, { ok: true }>;
      expect(out.ok).toBe(true);
      expect(out.op.prev).toBe(PREV_CID);
      expect(out.op.rotationKeys).toEqual(['K3', 'K4']);
      expect(out.op.sig).toBe('new-sig');
      expect(out.op.createdAtMs).toBeGreaterThanOrEqual(PREV.createdAtMs);
    });

    it('inherits verificationMethod + services + alsoKnownAs from prev', async () => {
      const richPrev: PlcOperation = {
        ...PREV,
        // Extra fields live on PlcOperation via the index signature.
        verificationMethod: [{ id: 'vm1' }],
        services: [{ id: 'svc1' }],
        alsoKnownAs: ['at://alice.social'],
      };
      const out = (await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: richPrev,
        update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
        signFn: stubSigner(),
      })) as Extract<BuildUpdateOutcome, { ok: true }>;
      const opRecord = out.op as Record<string, unknown>;
      expect(opRecord.verificationMethod).toEqual([{ id: 'vm1' }]);
      expect(opRecord.services).toEqual([{ id: 'svc1' }]);
      expect(opRecord.alsoKnownAs).toEqual(['at://alice.social']);
    });

    it('explicit overrides replace inherited fields', async () => {
      const richPrev: PlcOperation = {
        ...PREV,
        verificationMethod: [{ id: 'old-vm' }],
      };
      const out = (await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: richPrev,
        update: {
          rotationKeys: ['K3'],
          signerPublicKey: 'K1',
          verificationMethods: [{ id: 'new-vm' }],
        },
        signFn: stubSigner(),
      })) as Extract<BuildUpdateOutcome, { ok: true }>;
      const opRecord = out.op as Record<string, unknown>;
      expect(opRecord.verificationMethod).toEqual([{ id: 'new-vm' }]);
    });

    it('createdAtMs is clamped to prev.createdAtMs when clock is behind', async () => {
      const out = (await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: { ...PREV, createdAtMs: 5000 },
        update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
        signFn: stubSigner(),
        nowMsFn: () => 100, // clock skewed backwards
      })) as Extract<BuildUpdateOutcome, { ok: true }>;
      expect(out.op.createdAtMs).toBe(5000);
    });

    it('createdAtMs uses now when now > prev.createdAtMs', async () => {
      const out = (await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
        signFn: stubSigner(),
        nowMsFn: () => 9000,
      })) as Extract<BuildUpdateOutcome, { ok: true }>;
      expect(out.op.createdAtMs).toBe(9000);
    });

    it('signer receives canonical bytes + publicKey', async () => {
      let seen: { messageBytes: Uint8Array; publicKey: string } | null = null;
      const signFn: SignerFn = async (input) => {
        seen = input;
        return 'ok-sig';
      };
      await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: { rotationKeys: ['K3'], signerPublicKey: 'K2' },
        signFn,
      });
      expect(seen!.publicKey).toBe('K2');
      expect(seen!.messageBytes).toBeInstanceOf(Uint8Array);
      const text = new TextDecoder().decode(seen!.messageBytes);
      expect(text).toContain(PREV_CID);
      expect(text).toContain('K3');
      // Signer-input bytes MUST NOT include the sig field (nothing to sign yet).
      expect(text).not.toContain('"sig"');
    });

    it('custom serialiseFn used for the signed bytes', async () => {
      let seenBody: unknown = null;
      const serialiseFn = (body: Record<string, unknown>): Uint8Array => {
        seenBody = body;
        return new Uint8Array([1, 2, 3]);
      };
      const out = await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
        signFn: stubSigner(),
        serialiseFn: serialiseFn as Parameters<typeof buildPlcUpdateOp>[0]['serialiseFn'],
      });
      expect(out.ok).toBe(true);
      expect((seenBody as { prev: string }).prev).toBe(PREV_CID);
    });

    it('handles update supplied explicitly', async () => {
      const out = (await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: { ...PREV, alsoKnownAs: ['at://old'] },
        update: {
          rotationKeys: ['K3'],
          signerPublicKey: 'K1',
          handles: ['at://new'],
        },
        signFn: stubSigner(),
      })) as Extract<BuildUpdateOutcome, { ok: true }>;
      expect((out.op as unknown as { alsoKnownAs: string[] }).alsoKnownAs).toEqual(['at://new']);
    });
  });

  describe('rejections', () => {
    it('empty prevCid → invalid_prev_cid', async () => {
      const out = await buildPlcUpdateOp({
        prevCid: '',
        prev: PREV,
        update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
        signFn: stubSigner(),
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('invalid_prev_cid');
    });

    it('empty rotationKeys → empty_rotation_keys', async () => {
      const out = await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: { rotationKeys: [], signerPublicKey: 'K1' },
        signFn: stubSigner(),
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('empty_rotation_keys');
    });

    it('empty-string key in rotationKeys → empty_rotation_keys', async () => {
      const out = await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: { rotationKeys: ['K3', ''], signerPublicKey: 'K1' },
        signFn: stubSigner(),
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('empty_rotation_keys');
    });

    it('signer not in prev.rotationKeys → signer_not_authorised', async () => {
      const out = await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: { rotationKeys: ['K3'], signerPublicKey: 'K_ROGUE' },
        signFn: stubSigner(),
      });
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'signer_not_authorised') {
        expect(out.detail).toMatch(/K_ROGUE/);
      }
    });

    it('signer returns empty string → signer_failed', async () => {
      const out = await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
        signFn: async () => '',
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('signer_failed');
    });

    it('signer throws → signer_failed', async () => {
      const out = await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
        signFn: async () => {
          throw new Error('key unlocked');
        },
      });
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'signer_failed') {
        expect(out.detail).toMatch(/key unlocked/);
      }
    });
  });
});
