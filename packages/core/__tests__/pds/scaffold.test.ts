/**
 * PDS namespace scaffold smoke test (task 6.1).
 *
 * Verifies:
 *   1. The new `src/pds/` namespace compiles + imports resolve.
 *   2. Interface types are shape-compatible with a plausible
 *      implementation (type-only check — no runtime behaviour).
 *   3. Re-exports from `../trust/pds_publish` still reach the
 *      consumer through the new `pds/` namespace — so external
 *      code can migrate `import … from '.../trust/pds_publish'`
 *      to `import … from '.../pds'` without changing semantics.
 *
 * Actual PDS behaviour is covered by existing tests at the pre-
 * consolidation locations (trust/, identity/). This file exists to
 * catch regressions in the NAMESPACE SHAPE, not the underlying
 * functionality.
 */

import type {
  ListRecordsOptions,
  ListRecordsResult,
  PDSAccountInput,
  PDSClient,
  PDSRecord,
  PDSSession,
  PutRecordInput,
} from '../../src/pds';

import {
  publishToPDS,
  signAttestation,
  validateLexicon,
  verifyAttestation,
  resetPDSFetchFn,
  setPDSFetchFn,
  type AttestationRecord,
  type SignedAttestation,
} from '../../src/pds';

describe('@dina/core/pds namespace scaffold (task 6.1)', () => {
  it('type imports resolve — PDSClient contract is shape-checkable', () => {
    // A TypeScript-compilation-only check: if PDSClient's interface
    // drifts such that this fake implementation no longer conforms,
    // the test file fails `tsc`. Runtime assertion is nominal.
    const fake: PDSClient = {
      async createAccount(_i: PDSAccountInput): Promise<PDSSession> {
        throw new Error('scaffold');
      },
      async createSession(_h: string, _p: string): Promise<PDSSession> {
        throw new Error('scaffold');
      },
      async refreshSession(): Promise<PDSSession> {
        throw new Error('scaffold');
      },
      async deleteSession(): Promise<void> {
        throw new Error('scaffold');
      },
      async createRecord<T>(_i: PutRecordInput<T>): Promise<PDSRecord<T>> {
        throw new Error('scaffold');
      },
      async putRecord<T>(_i: PutRecordInput<T>): Promise<PDSRecord<T>> {
        throw new Error('scaffold');
      },
      async getRecord<T>(_r: string, _c: string, _k: string): Promise<PDSRecord<T> | null> {
        return null;
      },
      async deleteRecord(_r: string, _c: string, _k: string): Promise<void> {
        // no-op
      },
      async listRecords<T>(_o: ListRecordsOptions): Promise<ListRecordsResult<T>> {
        return { records: [] };
      },
    };
    expect(typeof fake.createAccount).toBe('function');
  });

  it('attestation exports reach consumers via @dina/core/pds', () => {
    expect(typeof signAttestation).toBe('function');
    expect(typeof verifyAttestation).toBe('function');
    expect(typeof validateLexicon).toBe('function');
    expect(typeof publishToPDS).toBe('function');
    expect(typeof setPDSFetchFn).toBe('function');
    expect(typeof resetPDSFetchFn).toBe('function');
  });

  it('AttestationRecord + SignedAttestation types are exported', () => {
    const record: AttestationRecord = {
      subject_did: 'did:plc:subject',
      category: 'developer_tool',
      rating: 85,
      verdict: { note: 'scaffold test' },
    };
    const signed: SignedAttestation = {
      record,
      signature_hex: '00'.repeat(64),
      signer_did: 'did:plc:signer',
    };
    expect(signed.signer_did).toBe('did:plc:signer');
    expect(signed.record.rating).toBe(85);
  });

  it('PDSSession type carries the expected shape', () => {
    const session: PDSSession = {
      did: 'did:plc:example',
      handle: 'alice.bsky.social',
      accessJwt: 'eyJhbGci...',
      refreshJwt: 'eyJhbGci...',
      accessExpiresAtMs: 1745318400000,
    };
    expect(session.handle).toBe('alice.bsky.social');
  });
});
