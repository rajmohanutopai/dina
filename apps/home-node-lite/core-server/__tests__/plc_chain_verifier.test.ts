/**
 * Task 6.8 — PLC signature chain verifier tests.
 */

import {
  verifyPlcChain,
  type CidFn,
  type PlcChainVerifyResult,
  type PlcOperation,
  type VerifyFn,
  type VerifyFnInput,
} from '../src/appview/plc_chain_verifier';

/** Deterministic scripted CID: SHA-style stringification of the op's (prev + sig). */
function scriptedCid(): CidFn {
  let counter = 0;
  return async (op) => {
    counter++;
    return `cid-${counter}-${op.sig.slice(0, 4)}`;
  };
}

/**
 * Scripted verifier — returns true when the signature equals
 * `sig-by-<key>` (simulating "this key produced this sig"). Lets
 * tests express "signed by key X" without real crypto.
 */
function scriptedVerify(): VerifyFn {
  return async (input: VerifyFnInput) => {
    const expected = `sig-by-${input.publicKey}`;
    return input.signature === expected;
  };
}

function op(overrides: Partial<PlcOperation> = {}): PlcOperation {
  return {
    sig: 'sig-by-K1',
    prev: null,
    rotationKeys: ['K1'],
    createdAtMs: 1000,
    ...overrides,
  };
}

describe('verifyPlcChain (task 6.8)', () => {
  describe('construction', () => {
    it('throws without cidFn', async () => {
      await expect(
        verifyPlcChain([op()], {
          cidFn: undefined as unknown as CidFn,
          verifyFn: scriptedVerify(),
        }),
      ).rejects.toThrow(/cidFn/);
    });

    it('throws without verifyFn', async () => {
      await expect(
        verifyPlcChain([op()], {
          cidFn: scriptedCid(),
          verifyFn: undefined as unknown as VerifyFn,
        }),
      ).rejects.toThrow(/verifyFn/);
    });
  });

  describe('genesis only', () => {
    it('valid genesis → ok', async () => {
      const result = (await verifyPlcChain([op()], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      })) as Extract<PlcChainVerifyResult, { ok: true }>;
      expect(result.ok).toBe(true);
      expect(result.opCount).toBe(1);
      expect(result.headCid).toMatch(/^cid-/);
    });

    it('empty chain → empty_chain', async () => {
      const result = await verifyPlcChain([], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('empty_chain');
    });

    it('genesis with prev !== null → genesis_prev_not_null', async () => {
      const genesis = op({ prev: 'cid-fake', rotationKeys: ['K1'] });
      const result = await verifyPlcChain([genesis], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('genesis_prev_not_null');
    });

    it('genesis signed by non-listed key → genesis_sig_invalid', async () => {
      const genesis = op({ sig: 'sig-by-K99', rotationKeys: ['K1'] });
      const result = await verifyPlcChain([genesis], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('genesis_sig_invalid');
    });

    it('genesis signed by any listed key → ok', async () => {
      const genesis = op({
        sig: 'sig-by-K2',
        rotationKeys: ['K1', 'K2', 'K3'],
      });
      const result = await verifyPlcChain([genesis], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('chain walking', () => {
    async function cidOf(n: number, sigPrefix: string): Promise<string> {
      return `cid-${n}-${sigPrefix}`;
    }

    it('valid 3-op chain → ok', async () => {
      const o1 = op({ sig: 'sig-by-K1', rotationKeys: ['K1'], createdAtMs: 1000 });
      // op2 must be signed by one of K1 (rotation keys of op1).
      const o2 = op({
        sig: 'sig-by-K1',
        prev: await cidOf(1, 'sig-'),
        rotationKeys: ['K2'],
        createdAtMs: 2000,
      });
      const o3 = op({
        sig: 'sig-by-K2',
        prev: await cidOf(2, 'sig-'),
        rotationKeys: ['K3'],
        createdAtMs: 3000,
      });
      const result = (await verifyPlcChain([o1, o2, o3], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      })) as Extract<PlcChainVerifyResult, { ok: true }>;
      expect(result.ok).toBe(true);
      expect(result.opCount).toBe(3);
    });

    it('prev mismatch → prev_mismatch at failing index', async () => {
      const o1 = op();
      const o2 = op({
        sig: 'sig-by-K1',
        prev: 'cid-wrong',
        rotationKeys: ['K2'],
        createdAtMs: 2000,
      });
      const result = await verifyPlcChain([o1, o2], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('prev_mismatch');
        expect(result.opIndex).toBe(1);
      }
    });

    it('signer not in previous rotationKeys → signer_not_authorised', async () => {
      const o1 = op({ rotationKeys: ['K1'] });
      const o2 = op({
        sig: 'sig-by-K_ROGUE',
        prev: await cidOf(1, 'sig-'),
        rotationKeys: ['K2'],
        createdAtMs: 2000,
      });
      const result = await verifyPlcChain([o1, o2], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('signer_not_authorised');
        expect(result.opIndex).toBe(1);
      }
    });

    it('timestamp regression → timestamp_regression', async () => {
      const o1 = op({ createdAtMs: 5000 });
      const o2 = op({
        sig: 'sig-by-K1',
        prev: await cidOf(1, 'sig-'),
        rotationKeys: ['K2'],
        createdAtMs: 3000, // before o1
      });
      const result = await verifyPlcChain([o1, o2], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('timestamp_regression');
        expect(result.opIndex).toBe(1);
      }
    });

    it('equal timestamps are allowed', async () => {
      const o1 = op({ createdAtMs: 1000 });
      const o2 = op({
        sig: 'sig-by-K1',
        prev: await cidOf(1, 'sig-'),
        rotationKeys: ['K2'],
        createdAtMs: 1000,
      });
      const result = await verifyPlcChain([o1, o2], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      expect(result.ok).toBe(true);
    });

    it('rotation history: op2 keys != op1 keys, op2 signed by op1\'s old key', async () => {
      // Genesis MUST be signed by one of its OWN rotationKeys.
      const o1 = op({ sig: 'sig-by-K_OLD', rotationKeys: ['K_OLD'] });
      const o2 = op({
        sig: 'sig-by-K_OLD', // signed by op1's rotation key (authorised)
        prev: await cidOf(1, 'sig-'),
        rotationKeys: ['K_NEW'],
        createdAtMs: 2000,
      });
      const o3 = op({
        sig: 'sig-by-K_NEW',
        prev: await cidOf(2, 'sig-'),
        rotationKeys: ['K_NEWER'],
        createdAtMs: 3000,
      });
      const result = await verifyPlcChain([o1, o2, o3], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('shape validation', () => {
    it.each([
      ['empty sig', { sig: '' }],
      ['non-string prev', { prev: 123 as unknown as string }],
      ['empty rotationKeys', { rotationKeys: [] }],
      ['non-string rotationKey entry', { rotationKeys: [123 as unknown as string] }],
      ['negative createdAtMs', { createdAtMs: -1 }],
      ['non-integer createdAtMs', { createdAtMs: 1.5 }],
    ])('rejects %s with malformed_op', async (_label, overrides) => {
      const bad = { ...op(), ...overrides } as PlcOperation;
      const result = await verifyPlcChain([bad], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('malformed_op');
    });

    it('null op in array rejected', async () => {
      const result = await verifyPlcChain(
        [null as unknown as PlcOperation],
        { cidFn: scriptedCid(), verifyFn: scriptedVerify() },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('malformed_op');
    });

    it('reports opIndex on malformed op in the middle of the chain', async () => {
      const good = op();
      const bad = { ...op(), sig: '' } as PlcOperation;
      const result = await verifyPlcChain([good, bad], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('malformed_op');
        expect(result.opIndex).toBe(1);
      }
    });
  });

  describe('validateShape — per-branch detail taxonomy', () => {
    // Each rejection in `validateShape` returns a distinct detail
    // string. Pin them so observability surfacing can rely on the
    // exact wording, AND so a refactor that consolidates branches
    // is caught.
    async function shapeRejectsWith(
      overrides: Partial<PlcOperation> & Record<string, unknown>,
      detailMatcher: RegExp,
    ): Promise<void> {
      const bad = { ...op(), ...overrides } as PlcOperation;
      const result = await verifyPlcChain([bad], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      if (result.ok) throw new Error('expected ok:false');
      expect(result.reason).toBe('malformed_op');
      expect(result.opIndex).toBe(0);
      expect(result.detail).toMatch(detailMatcher);
    }

    it('non-string sig → "non-empty string" detail', async () => {
      await shapeRejectsWith({ sig: 42 as unknown as string }, /sig.*non-empty string/);
    });

    it('null sig → "non-empty string" detail', async () => {
      await shapeRejectsWith({ sig: null as unknown as string }, /sig.*non-empty string/);
    });

    it('empty sig → "non-empty string" detail', async () => {
      await shapeRejectsWith({ sig: '' }, /sig.*non-empty string/);
    });

    it('non-string non-null prev → "null or a non-empty string" detail', async () => {
      await shapeRejectsWith(
        { prev: 42 as unknown as string },
        /prev.*null or a non-empty string/,
      );
    });

    it('empty-string prev → "null or a non-empty string" detail', async () => {
      // Empty string is distinct from null — must reject.
      await shapeRejectsWith(
        { prev: '' as unknown as string },
        /prev.*null or a non-empty string/,
      );
    });

    it('non-array rotationKeys → "non-empty array" detail', async () => {
      await shapeRejectsWith(
        { rotationKeys: 'K1' as unknown as string[] },
        /rotationKeys.*non-empty array/,
      );
    });

    it('null rotationKeys → "non-empty array" detail', async () => {
      await shapeRejectsWith(
        { rotationKeys: null as unknown as string[] },
        /rotationKeys.*non-empty array/,
      );
    });

    it('empty rotationKeys → "non-empty array" detail', async () => {
      await shapeRejectsWith({ rotationKeys: [] }, /rotationKeys.*non-empty array/);
    });

    it('rotationKey entry empty string → "non-empty strings" detail', async () => {
      // Distinct from non-string — empty-string still has type=string.
      await shapeRejectsWith(
        { rotationKeys: [''] },
        /rotationKeys entries.*non-empty strings/,
      );
    });

    it('rotationKey entry null → "non-empty strings" detail', async () => {
      await shapeRejectsWith(
        { rotationKeys: [null as unknown as string] },
        /rotationKeys entries.*non-empty strings/,
      );
    });

    it('rotationKey entry non-string at non-zero index → "non-empty strings" detail', async () => {
      // Iterates all entries, not just first.
      await shapeRejectsWith(
        { rotationKeys: ['K1', 42 as unknown as string] },
        /rotationKeys entries.*non-empty strings/,
      );
    });

    it('non-number createdAtMs → "non-negative integer" detail', async () => {
      await shapeRejectsWith(
        { createdAtMs: 'soon' as unknown as number },
        /createdAtMs.*non-negative integer/,
      );
    });

    it('NaN createdAtMs → "non-negative integer" detail', async () => {
      await shapeRejectsWith(
        { createdAtMs: Number.NaN },
        /createdAtMs.*non-negative integer/,
      );
    });

    it('Infinity createdAtMs → "non-negative integer" detail', async () => {
      await shapeRejectsWith(
        { createdAtMs: Number.POSITIVE_INFINITY },
        /createdAtMs.*non-negative integer/,
      );
    });

    it('-Infinity createdAtMs → "non-negative integer" detail', async () => {
      await shapeRejectsWith(
        { createdAtMs: Number.NEGATIVE_INFINITY },
        /createdAtMs.*non-negative integer/,
      );
    });

    it('zero createdAtMs is allowed (counter-pin: not negative, is integer)', async () => {
      const genesis = op({ createdAtMs: 0 });
      const result = await verifyPlcChain([genesis], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('validateShape — non-object op rejection', () => {
    // The `op === null || typeof op !== 'object' || Array.isArray(op)`
    // branch returns "op must be an object". Existing test only covers
    // null; pin the other variants too.
    it.each([
      ['array', [] as unknown as PlcOperation],
      ['string', 'op-as-string' as unknown as PlcOperation],
      ['number', 42 as unknown as PlcOperation],
      ['boolean', true as unknown as PlcOperation],
      ['undefined', undefined as unknown as PlcOperation],
    ])('rejects %s op with malformed_op + "must be an object" detail', async (_label, badOp) => {
      const result = await verifyPlcChain([badOp], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      if (result.ok) throw new Error('expected ok:false');
      expect(result.reason).toBe('malformed_op');
      expect(result.opIndex).toBe(0);
      expect(result.detail).toMatch(/must be an object/);
    });
  });

  describe('chain walking — opIndex at deeper positions', () => {
    // Pre-existing tests pin opIndex at index 1. Pin deeper indices
    // so an off-by-one in the loop bound is caught.
    async function cidOf(n: number): Promise<string> {
      return `cid-${n}-sig-`;
    }

    it('prev_mismatch at index 3 reports opIndex=3', async () => {
      const o1 = op({ rotationKeys: ['K1'], createdAtMs: 1000 });
      const o2 = op({
        sig: 'sig-by-K1',
        prev: await cidOf(1),
        rotationKeys: ['K2'],
        createdAtMs: 2000,
      });
      const o3 = op({
        sig: 'sig-by-K2',
        prev: await cidOf(2),
        rotationKeys: ['K3'],
        createdAtMs: 3000,
      });
      const o4 = op({
        sig: 'sig-by-K3',
        prev: 'cid-WRONG',
        rotationKeys: ['K4'],
        createdAtMs: 4000,
      });
      const result = await verifyPlcChain([o1, o2, o3, o4], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      if (result.ok) throw new Error('expected ok:false');
      expect(result.reason).toBe('prev_mismatch');
      expect(result.opIndex).toBe(3);
    });

    it('signer_not_authorised at index 2 reports opIndex=2', async () => {
      const o1 = op({ rotationKeys: ['K1'], createdAtMs: 1000 });
      const o2 = op({
        sig: 'sig-by-K1',
        prev: await cidOf(1),
        rotationKeys: ['K2'],
        createdAtMs: 2000,
      });
      const o3 = op({
        // Signed by K_ROGUE which is NOT in op2.rotationKeys (K2 only)
        sig: 'sig-by-K_ROGUE',
        prev: await cidOf(2),
        rotationKeys: ['K3'],
        createdAtMs: 3000,
      });
      const result = await verifyPlcChain([o1, o2, o3], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      if (result.ok) throw new Error('expected ok:false');
      expect(result.reason).toBe('signer_not_authorised');
      expect(result.opIndex).toBe(2);
    });

    it('timestamp_regression at index 4 reports opIndex=4', async () => {
      const o1 = op({ rotationKeys: ['K1'], createdAtMs: 1000 });
      const o2 = op({
        sig: 'sig-by-K1',
        prev: await cidOf(1),
        rotationKeys: ['K1'],
        createdAtMs: 2000,
      });
      const o3 = op({
        sig: 'sig-by-K1',
        prev: await cidOf(2),
        rotationKeys: ['K1'],
        createdAtMs: 3000,
      });
      const o4 = op({
        sig: 'sig-by-K1',
        prev: await cidOf(3),
        rotationKeys: ['K1'],
        createdAtMs: 4000,
      });
      const o5 = op({
        sig: 'sig-by-K1',
        prev: await cidOf(4),
        rotationKeys: ['K1'],
        createdAtMs: 3500, // regresses below o4
      });
      const result = await verifyPlcChain([o1, o2, o3, o4, o5], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      if (result.ok) throw new Error('expected ok:false');
      expect(result.reason).toBe('timestamp_regression');
      expect(result.opIndex).toBe(4);
    });

    it('shape error at the LAST op of a long chain reports correct opIndex', async () => {
      // All ops are validated up-front before crypto walks. Pin that
      // a malformed final op surfaces as opIndex=n-1.
      const good = op({ rotationKeys: ['K1'] });
      const bad = { ...op(), sig: '' } as PlcOperation;
      const result = await verifyPlcChain([good, good, good, good, bad], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      if (result.ok) throw new Error('expected ok:false');
      expect(result.reason).toBe('malformed_op');
      expect(result.opIndex).toBe(4);
    });
  });

  describe('default serialiser — strips ONLY sig field', () => {
    // CRITICAL invariant: the default serialiser strips `sig` so the
    // signed bytes don't include the signature itself (which would
    // make verification circular). Other fields MUST be preserved or
    // signatures over rotationKeys / prev / payload won't verify.
    it('uses default serialiser when serialiseFn omitted', async () => {
      // Capture the messageBytes the verifier sees.
      const captured: Uint8Array[] = [];
      const verifyFn: VerifyFn = async ({ messageBytes, signature, publicKey }) => {
        captured.push(messageBytes);
        return signature === `sig-by-${publicKey}`;
      };
      const genesis = op({
        sig: 'sig-by-K1',
        rotationKeys: ['K1'],
        createdAtMs: 1234,
      });
      const result = await verifyPlcChain([genesis], {
        cidFn: scriptedCid(),
        verifyFn,
      });
      expect(result.ok).toBe(true);
      expect(captured).toHaveLength(1);
      const decoded = JSON.parse(new TextDecoder().decode(captured[0]));
      // sig field MUST be stripped.
      expect(decoded).not.toHaveProperty('sig');
      // All other fields MUST be present.
      expect(decoded).toHaveProperty('prev', null);
      expect(decoded).toHaveProperty('rotationKeys', ['K1']);
      expect(decoded).toHaveProperty('createdAtMs', 1234);
    });

    it('preserves arbitrary extra fields (e.g. verificationMethods, services)', async () => {
      // Real PLC ops carry verificationMethods + services + alsoKnownAs.
      // The default serialiser must keep them in the signed bytes —
      // otherwise the chain would verify even with payload tampering.
      const captured: Uint8Array[] = [];
      const verifyFn: VerifyFn = async ({ messageBytes, signature, publicKey }) => {
        captured.push(messageBytes);
        return signature === `sig-by-${publicKey}`;
      };
      const genesis: PlcOperation = {
        sig: 'sig-by-K1',
        prev: null,
        rotationKeys: ['K1'],
        createdAtMs: 1234,
        verificationMethods: [{ id: '#atproto', type: 'Multikey' }],
        services: { atproto_pds: { endpoint: 'https://bsky.social' } },
        alsoKnownAs: ['at://alice.example'],
      };
      const result = await verifyPlcChain([genesis], { cidFn: scriptedCid(), verifyFn });
      expect(result.ok).toBe(true);
      const decoded = JSON.parse(new TextDecoder().decode(captured[0]));
      expect(decoded).toHaveProperty('verificationMethods');
      expect(decoded).toHaveProperty('services');
      expect(decoded).toHaveProperty('alsoKnownAs', ['at://alice.example']);
    });

    it('decoded bytes are valid JSON (UTF-8 round-trip)', async () => {
      // Counter-pin: bytes are produced via TextEncoder; they must
      // decode cleanly via TextDecoder. Catches a regression where
      // someone uses Buffer.from in a non-UTF-8 mode.
      const captured: Uint8Array[] = [];
      const verifyFn: VerifyFn = async ({ messageBytes, signature, publicKey }) => {
        captured.push(messageBytes);
        return signature === `sig-by-${publicKey}`;
      };
      await verifyPlcChain([op()], { cidFn: scriptedCid(), verifyFn });
      const decoded = new TextDecoder().decode(captured[0]);
      expect(() => JSON.parse(decoded)).not.toThrow();
    });
  });

  describe('outcome shape pinning', () => {
    // Pin exact key sets per outcome variant.
    it('success outcome has exactly {ok, headCid, opCount}', async () => {
      const result = await verifyPlcChain([op()], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      expect(Object.keys(result).sort()).toEqual(['headCid', 'ok', 'opCount']);
    });

    it('malformed_op failure has detail field', async () => {
      const result = await verifyPlcChain(
        [{ ...op(), sig: '' } as PlcOperation],
        { cidFn: scriptedCid(), verifyFn: scriptedVerify() },
      );
      if (result.ok) throw new Error('expected ok:false');
      const { detail } = result;
      if (typeof detail !== 'string') throw new Error('expected detail string');
      expect(detail.length).toBeGreaterThan(0);
    });

    it('genesis_prev_not_null failure has detail with the offending prev value', async () => {
      const result = await verifyPlcChain(
        [op({ prev: 'cid-fake' })],
        { cidFn: scriptedCid(), verifyFn: scriptedVerify() },
      );
      if (result.ok) throw new Error('expected ok:false');
      expect(result.detail).toMatch(/cid-fake/);
    });

    it('prev_mismatch detail includes both expected + actual cid', async () => {
      const o1 = op();
      const o2 = op({
        sig: 'sig-by-K1',
        prev: 'cid-WRONG',
        rotationKeys: ['K2'],
        createdAtMs: 2000,
      });
      const result = await verifyPlcChain([o1, o2], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      if (result.ok) throw new Error('expected ok:false');
      expect(result.detail).toMatch(/cid-WRONG/);
      expect(result.detail).toMatch(/cid-1/); // first scripted CID
    });

    it('timestamp_regression detail includes both timestamps', async () => {
      const o1 = op({ createdAtMs: 5000 });
      const o2 = op({
        sig: 'sig-by-K1',
        prev: 'cid-1-sig-',
        rotationKeys: ['K2'],
        createdAtMs: 3000,
      });
      const result = await verifyPlcChain([o1, o2], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      if (result.ok) throw new Error('expected ok:false');
      expect(result.detail).toMatch(/3000/);
      expect(result.detail).toMatch(/5000/);
    });

    it('empty_chain failure has NO detail (minimal failure form)', async () => {
      const result = await verifyPlcChain([], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
      });
      if (result.ok) throw new Error('expected ok:false');
      // Counter-pin: only ok/reason/opIndex — no extra fields.
      expect(Object.keys(result).sort()).toEqual(['ok', 'opIndex', 'reason']);
    });
  });

  describe('injected serialise + verify', () => {
    it('verify errors on a key do not invalidate other candidates', async () => {
      const verifyFn: VerifyFn = async ({ publicKey, signature }) => {
        if (publicKey === 'K_BROKEN') throw new Error('unsupported algo');
        return signature === `sig-by-${publicKey}`;
      };
      const genesis = op({
        sig: 'sig-by-K_GOOD',
        rotationKeys: ['K_BROKEN', 'K_GOOD'],
      });
      const result = await verifyPlcChain([genesis], {
        cidFn: scriptedCid(),
        verifyFn,
      });
      expect(result.ok).toBe(true);
    });

    it('custom serialiseFn used', async () => {
      let serialiseCalls = 0;
      const result = await verifyPlcChain([op()], {
        cidFn: scriptedCid(),
        verifyFn: scriptedVerify(),
        serialiseFn: (o) => {
          serialiseCalls++;
          return new TextEncoder().encode(JSON.stringify({ stub: o.prev }));
        },
      });
      expect(result.ok).toBe(true);
      expect(serialiseCalls).toBe(1);
    });
  });
});
