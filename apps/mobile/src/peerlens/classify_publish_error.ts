/**
 * The ONE PeerLens publish-error classifier — shared by the immediate (inline)
 * publish attempt and the durable worker, so retry policy can't diverge
 * (docs/PEERLENS_PUBLISH_JOBS_DESIGN.md §5).
 *
 * Maps a thrown error → a {@link ClassifiedError} (`retryable | permanent` +
 * a stable {@link PublishErrorCode} + the technical message stored on the job).
 * Lives mobile-side because it pattern-matches `PDSPublisherError` (`@dina/brain`)
 * and the mobile attestation error classes — `@dina/core` (where the job row +
 * vocabulary live) cannot import those.
 *
 *   retryable: network (status null), 408, 429, 5xx, + unknown (durable-outbox
 *              default — bounded by MAX_PUBLISH_ATTEMPTS, so it can't loop forever)
 *   permanent: identity mismatch, lexicon/text-too-long, 400, 401, 403
 */

import { PDSPublisherError } from '@dina/brain';
import { FEATURE_NAMES, type ClassifiedError, type PublishErrorCode } from '@dina/core';

import { AttestationIdentityMismatchError, AttestationLexiconError } from './publish_attestation';

export function classifyPublishError(err: unknown): ClassifiedError {
  if (err instanceof AttestationIdentityMismatchError) {
    return { class: 'permanent', code: 'identity_mismatch', message: err.message };
  }
  if (err instanceof AttestationLexiconError) {
    return { class: 'permanent', code: 'lexicon_invalid', message: err.message };
  }
  if (err instanceof PDSPublisherError) {
    const s = err.status;
    if (s === null) return { class: 'retryable', code: 'network', message: err.message };
    if (s === 408) return { class: 'retryable', code: 'request_timeout', message: err.message };
    if (s === 429) return { class: 'retryable', code: 'rate_limited', message: err.message };
    if (s >= 500) return { class: 'retryable', code: 'server_5xx', message: err.message };
    if (s === 401) return { class: 'permanent', code: 'unauthorized', message: err.message };
    if (s === 403) return { class: 'permanent', code: 'forbidden', message: err.message };
    // 400 and any other 4xx — the request itself is rejected; retrying it as-is
    // can't succeed without the user changing something.
    return { class: 'permanent', code: 'bad_request', message: err.message };
  }
  // Unknown / unexpected: treat as transient. The durable queue exists to retry
  // transient faults; a deterministic permanent rejection arrives typed (above),
  // so an untyped error is more likely a flaky native/network hiccup. Bounded by
  // MAX_PUBLISH_ATTEMPTS → it still dead-letters to "Needs attention", never loops.
  return {
    class: 'retryable',
    code: 'unknown',
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * User-facing copy for a publish-error code — what the card / Outbox shows. The
 * classifier's `message` is technical (stored on the job for diagnostics); this
 * is the human-readable line. Distinct from the technical message so we never
 * surface a raw HTTP string to the user.
 */
export function describePublishErrorCode(code: PublishErrorCode): string {
  switch (code) {
    case 'identity_mismatch':
      return "This device's PDS account doesn't match your identity. Check your infrastructure settings or re-onboard.";
    case 'lexicon_invalid':
      return 'This review is too long or malformed for the network. Edit it and try again.';
    case 'unauthorized':
    case 'forbidden':
      return `Couldn't publish to ${FEATURE_NAMES.peerlens} — your PDS credentials may be wrong or expired. Check your infrastructure settings or re-onboard.`;
    case 'bad_request':
      return `${FEATURE_NAMES.peerlens} couldn't accept this review. Please check the content and try again.`;
    case 'no_credentials':
      return `Connect a PDS account to publish to ${FEATURE_NAMES.peerlens}.`;
    case 'retries_exhausted':
      return "Couldn't publish after several tries. Tap Try again when you're back online.";
    case 'network':
    case 'timeout':
    case 'request_timeout':
    case 'server_5xx':
    case 'rate_limited':
    case 'lease_expired':
    case 'demo_scope':
    case 'unknown':
      return "Couldn't publish right now — we'll keep trying.";
  }
}
