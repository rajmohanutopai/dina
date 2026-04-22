/**
 * PDS client namespace.
 *
 * Task 6.1 scaffolds the public surface. Tasks 6.2–6.5 are marked
 * done against implementations currently living at
 * `packages/core/src/identity/*` and
 * `packages/core/src/trust/pds_publish.ts` — a follow-on task
 * migrates them into this directory. This index forwards the
 * pre-consolidation exports that external consumers care about so
 * the `@dina/core/pds` import path works today.
 *
 * See ./README.md for the location table + roadmap.
 */

// ─── Interface types (task 6.1) ────────────────────────────────────────────
// The future home of the PDS client class — declared here so consumers
// can already import typed contracts even before the consolidation.
export type {
  PDSClient,
  PDSSession,
  PDSAccountInput,
  PDSRecord,
  PutRecordInput,
  ListRecordsOptions,
  ListRecordsResult,
} from './types';

// ─── Existing implementations re-exported under this namespace ─────────────
// Attestation publishing (pre-task-6, lives in trust/). Re-export so
// `@dina/core/pds` is a superset of what's callable today.
export {
  publishToPDS,
  signAttestation,
  verifyAttestation,
  validateLexicon,
  setPDSFetchFn,
  resetPDSFetchFn,
} from '../trust/pds_publish';
export type {
  AttestationRecord,
  SignedAttestation,
} from '../trust/pds_publish';
