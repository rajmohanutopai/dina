/**
 * Shared PeerLens PDS adapter.
 *
 * Both mobile and Home Node Lite publish through this module. It validates the
 * complete AppView lexicon, verifies that PDS credentials authenticate as the
 * expected owner DID, and classifies failures for Core's durable queue.
 */

import { validateLexicon, type ClassifiedError } from '@dina/core';
import { PEERLENS_NSIDS, type Attestation } from '@dina/protocol';

import { PDSPublisher, PDSPublisherError, type PutRecordResult } from '../pds/publisher';

export class AttestationIdentityMismatchError extends Error {
  constructor(
    readonly expectedDid: string,
    readonly actualDid: string | null,
  ) {
    super(`PDS session DID (${actualDid ?? 'null'}) does not match this node (${expectedDid})`);
    this.name = 'AttestationIdentityMismatchError';
  }
}

export class AttestationLexiconError extends Error {
  readonly validationErrors: readonly string[];

  constructor(validationErrors: readonly string[] | string) {
    const normalized =
      typeof validationErrors === 'string' ? [validationErrors] : validationErrors;
    super(`PeerLens attestation is invalid: ${normalized.join('; ')}`);
    this.name = 'AttestationLexiconError';
    this.validationErrors = normalized;
  }
}

export function attestationLexiconErrors(record: Record<string, unknown>): string[] {
  return validateLexicon(record as unknown as Attestation);
}

export async function publishAttestationToPDS(
  publisher: PDSPublisher,
  expectedDid: string,
  record: Record<string, unknown>,
  rkey: string,
): Promise<PutRecordResult> {
  const errors = attestationLexiconErrors(record);
  if (errors.length > 0) throw new AttestationLexiconError(errors);

  const actualDid = await publisher.authenticate();
  if (actualDid !== expectedDid) {
    throw new AttestationIdentityMismatchError(expectedDid, actualDid);
  }

  return publisher.putRecord(PEERLENS_NSIDS.attestation, rkey, {
    ...record,
    $type: PEERLENS_NSIDS.attestation,
  });
}

export function classifyAttestationPublishError(error: unknown): ClassifiedError {
  if (error instanceof AttestationIdentityMismatchError) {
    return { class: 'permanent', code: 'identity_mismatch', message: error.message };
  }
  if (error instanceof AttestationLexiconError) {
    return { class: 'permanent', code: 'lexicon_invalid', message: error.message };
  }
  if (error instanceof PDSPublisherError) {
    const status = error.status;
    if (status === null) return { class: 'retryable', code: 'network', message: error.message };
    if (status === 408) {
      return { class: 'retryable', code: 'request_timeout', message: error.message };
    }
    if (status === 429) {
      return { class: 'retryable', code: 'rate_limited', message: error.message };
    }
    if (status >= 500) {
      return { class: 'retryable', code: 'server_5xx', message: error.message };
    }
    if (status === 401) {
      return { class: 'permanent', code: 'unauthorized', message: error.message };
    }
    if (status === 403) {
      return { class: 'permanent', code: 'forbidden', message: error.message };
    }
    return { class: 'permanent', code: 'bad_request', message: error.message };
  }
  return {
    class: 'retryable',
    code: 'unknown',
    message: error instanceof Error ? error.message : String(error),
  };
}
