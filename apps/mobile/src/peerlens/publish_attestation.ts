/**
 * PeerLens attestation publish — the sovereign path.
 *
 * Publishes a `com.dinakernel.peerlens.attestation` record to the user's
 * own PDS via the authed `PDSPublisher` (the exact mechanism the service
 * profile already uses). The PDS signs the repo commit; AppView's ingester
 * picks the record up from the Jetstream firehose and indexes it. This is
 * the real, decentralised publish — distinct from the dev-only test-inject
 * endpoint (`com.dinakernel.test.injectAttestation`), which writes straight
 * into AppView's DB and 404s in production.
 *
 * Identity is verified before the write (the PDS session DID must equal the
 * node's own DID) so a credential mismatch never lands a review under the
 * wrong identity — mirrors `ServicePublisher.verifyIdentity`.
 */

import { PEERLENS_NSIDS } from '@dina/protocol';

import type { PDSPublisher } from '@dina/brain';

/** Result of a successful attestation publish. */
export interface PublishedAttestation {
  /** Full AT-URI, e.g. `at://did:plc:.../com.dinakernel.peerlens.attestation/<rkey>`. */
  uri: string;
  /** CID of the record body. */
  cid: string;
}

/** Thrown when the PDS session DID doesn't match this node's own DID. */
export class AttestationIdentityMismatchError extends Error {
  constructor(
    readonly expectedDid: string,
    readonly actualDid: string | null,
  ) {
    super(`PDS session DID (${actualDid ?? 'null'}) does not match this node (${expectedDid})`);
    this.name = 'AttestationIdentityMismatchError';
  }
}

/** AppView attestationSchema text cap — mirror of the form's limit. */
const ATTESTATION_TEXT_MAX_LENGTH = 2000;

/**
 * Thrown when a record would fail AppView's lexicon validation, so a
 * `putRecord` would succeed but ingestion silently rejects it. The publish
 * service treats this as PERMANENT — surface it, don't queue for futile
 * retries.
 */
export class AttestationLexiconError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttestationLexiconError';
  }
}

/**
 * Publish a built attestation record to the PDS at `rkey`. `record` is the
 * same body the test-inject path sends; we add the `$type` discriminator
 * AppView's ingester keys on. Each review uses a fresh unique `rkey`, so
 * `putRecord` creates a new record (it would replace in place only on a
 * repeat with the same rkey — used by the edit/republish flow).
 *
 * Returns the AT-URI + CID. Throws on identity mismatch, HTTP, or network
 * failure — the caller decides whether to surface the error or queue the
 * draft to the durable outbox for retry.
 */
export async function publishAttestationToPDS(
  pds: PDSPublisher,
  expectedDid: string,
  record: Record<string, unknown>,
  rkey: string,
): Promise<PublishedAttestation> {
  // Validate the wire body against AppView's lexicon BEFORE writing. A record
  // that passes putRecord but fails ingestion would look "published" yet never
  // become searchable; text length is the cap the mobile form can exceed (other
  // fields are form-validated to match the lexicon).
  const text = record.text;
  if (typeof text === 'string' && text.length > ATTESTATION_TEXT_MAX_LENGTH) {
    throw new AttestationLexiconError(
      `Review text exceeds AppView's ${ATTESTATION_TEXT_MAX_LENGTH}-character limit.`,
    );
  }
  // Pre-write identity check (mirrors ServicePublisher): force a session
  // and confirm the PDS account is THIS node before anything is written.
  const actualDid = await pds.authenticate();
  if (actualDid !== expectedDid) {
    throw new AttestationIdentityMismatchError(expectedDid, actualDid);
  }
  const result = await pds.putRecord(PEERLENS_NSIDS.attestation, rkey, {
    ...record,
    $type: PEERLENS_NSIDS.attestation,
  });
  return { uri: result.uri, cid: result.cid };
}
