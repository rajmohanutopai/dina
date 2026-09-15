/**
 * The phone's repo-proof wiring (§5.C1-mobile): what boot does with the
 * self-check's answer, and what reaches the log. Drives the wiring against a
 * `jest.mock` factory for `@dina/net-expo/repo_proof` so both failure paths —
 * the self-check refusing, the verifier throwing at runtime — run for real.
 */

import { createRepoProofVerifier, selfCheckRepoProofVerifier } from '@dina/net-expo/repo_proof';

import { makeMobileRepoProofVerifier } from '../../src/services/repo_proof_wiring';

jest.mock('@dina/net-expo/repo_proof', () => ({
  createRepoProofVerifier: jest.fn(),
  selfCheckRepoProofVerifier: jest.fn(),
}));

const createMock = createRepoProofVerifier as jest.MockedFunction<typeof createRepoProofVerifier>;
const selfCheckMock = selfCheckRepoProofVerifier as jest.MockedFunction<typeof selfCheckRepoProofVerifier>;

const REQ = { did: 'did:plc:acme0000000000000000000', collection: 'com.dinakernel.plugin.release', rkey: 'abc' };
const SECRETISH = 'resolve did:plc:acme0000000000000000000: https://pds.acme.example/xrpc/…';

let warn: jest.SpyInstance;

beforeEach(() => {
  createMock.mockReset();
  selfCheckMock.mockReset();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe('makeMobileRepoProofVerifier', () => {
  it('a host that fails the self-check gets NO verifier — the door stays closed — and the log carries only the fault', async () => {
    selfCheckMock.mockResolvedValue({ ok: false, fault: 'record_malformed' });
    await expect(makeMobileRepoProofVerifier()).resolves.toBeNull();
    expect(createMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([
      '[plugins] repo-proof verifier self-check failed; install door stays closed',
      'record_malformed',
    ]);
  });

  it('a self-check that THROWS is a failed self-check, logged by class', async () => {
    selfCheckMock.mockRejectedValue(new ReferenceError(`Buffer is not defined ${SECRETISH}`));
    await expect(makeMobileRepoProofVerifier()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toBe('ReferenceError');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('did:plc');
  });

  it('a host that passes gets the verifier, wrapped: a runtime throw becomes a typed transient refusal, class-only in the log', async () => {
    selfCheckMock.mockResolvedValue({ ok: true });
    createMock.mockReturnValue(async () => {
      throw new RangeError(SECRETISH);
    });
    const verifier = await makeMobileRepoProofVerifier();
    if (verifier === null) throw new Error('expected a verifier');
    // The platform fetch is handed in; the chain never reaches for a global.
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ fetch: expect.any(Function) }));

    const result = await verifier(REQ);
    expect(result).toMatchObject({ ok: false, code: 'did_resolution_failed', transient: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual(['[plugins] repo-proof verifier fault', 'RangeError']);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('did:plc');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('https://');
  });

  it('a verifier that answers passes its answer through untouched', async () => {
    selfCheckMock.mockResolvedValue({ ok: true });
    const answer = { ok: true as const, cid: 'bafy…', rev: 'r1', record: { plugin_id: 'com.acme.widget' } };
    createMock.mockReturnValue(async () => answer);
    const verifier = await makeMobileRepoProofVerifier();
    if (verifier === null) throw new Error('expected a verifier');
    await expect(verifier(REQ)).resolves.toBe(answer);
    expect(warn).not.toHaveBeenCalled();
  });
});
