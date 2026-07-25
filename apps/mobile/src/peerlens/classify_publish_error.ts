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

import { classifyAttestationPublishError } from '@dina/brain';
import { FEATURE_NAMES, type ClassifiedError, type PublishErrorCode } from '@dina/core';

export function classifyPublishError(err: unknown): ClassifiedError {
  return classifyAttestationPublishError(err);
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
