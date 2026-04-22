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
