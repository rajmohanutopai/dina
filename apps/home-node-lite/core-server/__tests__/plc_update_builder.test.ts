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
      // Object-wrapper for closure capture: TS narrows `let seen | null = null`
      // back to `null` after a closure-via-await reassignment, which makes
      // a subsequent `if (!seen) throw` narrow to `never`. Wrapping in an
      // object dodges the limitation since property reads aren't tracked.
      const box: {
        captured: { messageBytes: Uint8Array; publicKey: string } | null;
      } = { captured: null };
      const signFn: SignerFn = async (input) => {
        box.captured = input;
        return 'ok-sig';
      };
      await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: { rotationKeys: ['K3'], signerPublicKey: 'K2' },
        signFn,
      });
      const seen = box.captured;
      if (!seen) throw new Error('signer not called');
      expect(seen.publicKey).toBe('K2');
      expect(seen.messageBytes).toBeInstanceOf(Uint8Array);
      const text = new TextDecoder().decode(seen.messageBytes);
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

  describe('construction — validateOptions exhaustive', () => {
    // The pre-existing 3 throw tests cover signFn / prev / signerPublicKey.
    // Pin the remaining branches in `validateOptions`.
    it('throws when opts is undefined', async () => {
      await expect(
        buildPlcUpdateOp(
          undefined as unknown as Parameters<typeof buildPlcUpdateOp>[0],
        ),
      ).rejects.toThrow(/options required/);
    });

    it('throws when opts is null', async () => {
      await expect(
        buildPlcUpdateOp(
          null as unknown as Parameters<typeof buildPlcUpdateOp>[0],
        ),
      ).rejects.toThrow(/options required/);
    });

    it('throws when prev.rotationKeys is not an array', async () => {
      await expect(
        buildPlcUpdateOp({
          prevCid: PREV_CID,
          prev: {
            ...PREV,
            rotationKeys: 'K1' as unknown as string[],
          },
          update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
          signFn: stubSigner(),
        }),
      ).rejects.toThrow(/prev.rotationKeys is malformed/);
    });

    it('throws when update is missing entirely', async () => {
      await expect(
        buildPlcUpdateOp({
          prevCid: PREV_CID,
          prev: PREV,
          update: undefined as unknown as Parameters<
            typeof buildPlcUpdateOp
          >[0]['update'],
          signFn: stubSigner(),
        }),
      ).rejects.toThrow(/update is required/);
    });

    it('throws when update is null', async () => {
      await expect(
        buildPlcUpdateOp({
          prevCid: PREV_CID,
          prev: PREV,
          update: null as unknown as Parameters<
            typeof buildPlcUpdateOp
          >[0]['update'],
          signFn: stubSigner(),
        }),
      ).rejects.toThrow(/update is required/);
    });

    it('throws when signerPublicKey is empty string', async () => {
      // Distinct from "missing" — empty-string still type-narrows to string.
      await expect(
        buildPlcUpdateOp({
          prevCid: PREV_CID,
          prev: PREV,
          update: { rotationKeys: ['K3'], signerPublicKey: '' },
          signFn: stubSigner(),
        }),
      ).rejects.toThrow(/signerPublicKey/);
    });

    it('throws when signerPublicKey is non-string', async () => {
      await expect(
        buildPlcUpdateOp({
          prevCid: PREV_CID,
          prev: PREV,
          update: {
            rotationKeys: ['K3'],
            signerPublicKey: 42 as unknown as string,
          },
          signFn: stubSigner(),
        }),
      ).rejects.toThrow(/signerPublicKey/);
    });
  });

  describe('signer return-type strictness', () => {
    // signer must return a non-empty STRING. Pin the full taxonomy:
    // empty + non-string types → signer_failed.
    it.each([
      ['number', 42],
      ['null', null],
      ['undefined', undefined],
      ['object', { sig: 'x' }],
      ['boolean', true],
      ['array', ['signed']],
    ])('signer returns %s → signer_failed', async (_label, returnValue) => {
      const out = await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
        signFn: (async () => returnValue) as unknown as SignerFn,
      });
      if (out.ok) throw new Error('expected ok:false');
      expect(out.reason).toBe('signer_failed');
      expect(out.detail).toMatch(/empty signature/);
    });

    it('signer returning a single-char string is accepted', async () => {
      // Counter-pin: any non-empty string passes the check. The
      // builder doesn't validate the signature format — that's the
      // signer's contract.
      const out = await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
        signFn: async () => 'x',
      });
      if (!out.ok) throw new Error('expected ok:true');
      expect(out.op.sig).toBe('x');
    });
  });

  describe('rotationKey entry type taxonomy', () => {
    // Pre-existing test covers empty-string entry. Pin all
    // non-string variants — each must trigger empty_rotation_keys
    // with the entries-specific detail message.
    it.each([
      ['null', null],
      ['number', 42],
      ['undefined', undefined],
      ['object', { id: 'K' }],
      ['boolean', false],
      ['array', ['K']],
    ])('non-string %s entry → empty_rotation_keys', async (_label, badEntry) => {
      const out = await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: {
          rotationKeys: ['K3', badEntry as unknown as string],
          signerPublicKey: 'K1',
        },
        signFn: stubSigner(),
      });
      if (out.ok) throw new Error('expected ok:false');
      expect(out.reason).toBe('empty_rotation_keys');
      expect(out.detail).toMatch(/entries must be non-empty strings/);
    });

    it('rotationKeys is a non-array → empty_rotation_keys (length check fails)', async () => {
      // Pin: passing a string instead of array hits the
      // `!Array.isArray` branch, distinct from empty-array.
      const out = await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: {
          rotationKeys: 'K3' as unknown as string[],
          signerPublicKey: 'K1',
        },
        signFn: stubSigner(),
      });
      if (out.ok) throw new Error('expected ok:false');
      expect(out.reason).toBe('empty_rotation_keys');
      expect(out.detail).toMatch(/must be non-empty/);
    });
  });

  describe('field inheritance — edge cases', () => {
    // The inheritance rule: `update.X !== undefined` overrides;
    // otherwise inherit from prev. Pin the boundary cases that look
    // ambiguous (empty array, null, both-missing).
    it('update.verificationMethods = [] OVERRIDES (does not inherit)', async () => {
      // Empty array is `!== undefined`, so it must replace prev's
      // value. This is the same rule JSON-Patch / merge-patch use.
      const richPrev: PlcOperation = {
        ...PREV,
        verificationMethod: [{ id: 'old' }],
      };
      const out = (await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: richPrev,
        update: {
          rotationKeys: ['K3'],
          signerPublicKey: 'K1',
          verificationMethods: [],
        },
        signFn: stubSigner(),
      })) as Extract<BuildUpdateOutcome, { ok: true }>;
      const opRecord = out.op as Record<string, unknown>;
      expect(opRecord.verificationMethod).toEqual([]);
    });

    it('update.handles = [] OVERRIDES (does not inherit)', async () => {
      const richPrev: PlcOperation = {
        ...PREV,
        alsoKnownAs: ['at://old.example'],
      };
      const out = (await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: richPrev,
        update: {
          rotationKeys: ['K3'],
          signerPublicKey: 'K1',
          handles: [],
        },
        signFn: stubSigner(),
      })) as Extract<BuildUpdateOutcome, { ok: true }>;
      const opRecord = out.op as Record<string, unknown>;
      expect(opRecord.alsoKnownAs).toEqual([]);
    });

    it('neither update nor prev has verificationMethods → field absent from output', async () => {
      const out = (await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV, // no verificationMethod
        update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
        signFn: stubSigner(),
      })) as Extract<BuildUpdateOutcome, { ok: true }>;
      // Counter-pin: the field is NOT present (not undefined, not null).
      expect(Object.keys(out.op)).not.toContain('verificationMethod');
    });

    it('neither update nor prev has services → field absent from output', async () => {
      const out = (await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
        signFn: stubSigner(),
      })) as Extract<BuildUpdateOutcome, { ok: true }>;
      expect(Object.keys(out.op)).not.toContain('services');
    });

    it('neither update nor prev has handles → alsoKnownAs absent from output', async () => {
      const out = (await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
        signFn: stubSigner(),
      })) as Extract<BuildUpdateOutcome, { ok: true }>;
      expect(Object.keys(out.op)).not.toContain('alsoKnownAs');
    });

    it('rotationKeys is defensive-copied (input mutation does not leak)', async () => {
      // Pin: the produced op's rotationKeys is a fresh array, so a
      // caller mutating their input later doesn't retroactively
      // change the signed op.
      const inputKeys = ['K3', 'K4'];
      const out = (await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: { rotationKeys: inputKeys, signerPublicKey: 'K1' },
        signFn: stubSigner(),
      })) as Extract<BuildUpdateOutcome, { ok: true }>;
      // Mutate the input array AFTER the build.
      inputKeys.push('K_MALICIOUS');
      // The output op's rotationKeys must not have been affected.
      expect(out.op.rotationKeys).toEqual(['K3', 'K4']);
      expect(out.op.rotationKeys).not.toContain('K_MALICIOUS');
    });

    it('rotationKeys output is a different array reference from input', async () => {
      // Counter-pin to the previous test: the defensive copy must
      // produce a NEW array, not the same reference.
      const inputKeys = ['K3'];
      const out = (await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: { rotationKeys: inputKeys, signerPublicKey: 'K1' },
        signFn: stubSigner(),
      })) as Extract<BuildUpdateOutcome, { ok: true }>;
      expect(out.op.rotationKeys).not.toBe(inputKeys);
    });
  });

  describe('createdAtMs — edge cases', () => {
    it('nowMsFn === prev.createdAtMs (equal) → equal', async () => {
      // Math.max with two equal values returns either; pin that
      // result is exactly prev's time (no off-by-one).
      const out = (await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: { ...PREV, createdAtMs: 5000 },
        update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
        signFn: stubSigner(),
        nowMsFn: () => 5000,
      })) as Extract<BuildUpdateOutcome, { ok: true }>;
      expect(out.op.createdAtMs).toBe(5000);
    });

    it('nowMsFn returns NaN → produces NaN createdAtMs (caller responsibility)', async () => {
      // Math.max(NaN, n) is NaN. The builder doesn't validate the
      // clock — that's the caller's job. Pin actual behavior so a
      // future "guard against NaN" change is intentional.
      // The chain verifier rejects NaN createdAtMs separately
      // (validateShape in plc_chain_verifier).
      const out = (await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: { ...PREV, createdAtMs: 1000 },
        update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
        signFn: stubSigner(),
        nowMsFn: () => Number.NaN,
      })) as Extract<BuildUpdateOutcome, { ok: true }>;
      expect(out.op.createdAtMs).toBeNaN();
    });

    it('default clock used when nowMsFn omitted', async () => {
      // Pin: omitted nowMsFn falls back to Date.now(). The result
      // must be >= prev (which is 1000), close to the real now.
      const beforeMs = Date.now();
      const out = (await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
        signFn: stubSigner(),
      })) as Extract<BuildUpdateOutcome, { ok: true }>;
      const afterMs = Date.now();
      expect(out.op.createdAtMs).toBeGreaterThanOrEqual(beforeMs);
      expect(out.op.createdAtMs).toBeLessThanOrEqual(afterMs);
    });
  });

  describe('output op — exact key set + integrity', () => {
    it('minimal output op has exactly: prev, rotationKeys, createdAtMs, sig', async () => {
      // No verificationMethods / services / handles → no extra keys.
      const out = (await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
        signFn: stubSigner(),
      })) as Extract<BuildUpdateOutcome, { ok: true }>;
      expect(Object.keys(out.op).sort()).toEqual([
        'createdAtMs',
        'prev',
        'rotationKeys',
        'sig',
      ]);
    });

    it('full output op has rotation + verificationMethod + services + alsoKnownAs', async () => {
      const richPrev: PlcOperation = {
        ...PREV,
        verificationMethod: [{ id: 'vm1' }],
        services: [{ id: 'svc1' }],
        alsoKnownAs: ['at://alice.example'],
      };
      const out = (await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: richPrev,
        update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
        signFn: stubSigner(),
      })) as Extract<BuildUpdateOutcome, { ok: true }>;
      expect(Object.keys(out.op).sort()).toEqual([
        'alsoKnownAs',
        'createdAtMs',
        'prev',
        'rotationKeys',
        'services',
        'sig',
        'verificationMethod',
      ]);
    });

    it('signed bytes do NOT contain "sig" field (signer signs body without sig)', async () => {
      // Pre-existing test pins this for K2; expand the assertion to
      // verify EXACT key set in the signed bytes (no leakage).
      let seenBytes: Uint8Array | null = null;
      const signFn: SignerFn = async ({ messageBytes }) => {
        seenBytes = messageBytes;
        return 'signed!';
      };
      await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
        signFn,
      });
      if (!seenBytes) throw new Error('signer not called');
      const decoded = JSON.parse(new TextDecoder().decode(seenBytes));
      expect(Object.keys(decoded).sort()).toEqual([
        'createdAtMs',
        'prev',
        'rotationKeys',
      ]);
      expect(decoded).not.toHaveProperty('sig');
    });

    it('counter-pin: produced op.sig matches signer return value byte-for-byte', async () => {
      const exoticSig = 'z3aB+/=PadCharsHere==';
      const out = (await buildPlcUpdateOp({
        prevCid: PREV_CID,
        prev: PREV,
        update: { rotationKeys: ['K3'], signerPublicKey: 'K1' },
        signFn: stubSigner(exoticSig),
      })) as Extract<BuildUpdateOutcome, { ok: true }>;
      expect(out.op.sig).toBe(exoticSig);
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
