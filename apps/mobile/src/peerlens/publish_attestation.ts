/**
 * Mobile compatibility surface for the shared PeerLens PDS adapter.
 *
 * The implementation lives in `@dina/brain` so Home Node Lite and mobile use
 * identical lexicon validation, identity verification, and record writes.
 */

import { attestationLexiconErrors } from '@dina/brain';

export {
  AttestationIdentityMismatchError,
  AttestationLexiconError,
  publishAttestationToPDS,
} from '@dina/brain';

export type PublishedAttestation = { uri: string; cid: string };

/** Existing form-validation seam: return one useful error, or null. */
export function lexiconErrorFor(record: Record<string, unknown>): string | null {
  const errors = attestationLexiconErrors(record);
  return errors.length === 0 ? null : errors.join('; ');
}
