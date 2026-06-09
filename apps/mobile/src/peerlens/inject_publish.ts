/**
 * Dev/E2E test-inject publish path — shared by the submit fast-path AND the
 * background worker so an inject-only build (no real PDS account) can BOTH
 * publish inline and drain queued jobs the same way.
 *
 * In dev/E2E the test-inject endpoint stands in for a PDS: it writes the record
 * straight into AppView's DB instead of a PDS, returning the same `(uri, cid)`
 * shape so the durable job completes identically. Active only when
 * `EXPO_PUBLIC_DINA_TEST_INJECT_TOKEN` is set (`isTestPublishConfigured()`);
 * the inject endpoint 404s in prod.
 */

import {
  injectAttestation,
  isTestPublishConfigured,
  type InjectAttestationRequest,
} from './appview_runtime';

import type { PDSPublisher } from '@dina/brain';

export { isTestPublishConfigured };

/**
 * Sentinel publisher for inject-only builds. Inject doesn't need a real PDS
 * publisher, but the credential gate / worker guard check for one — passing this
 * non-undefined sentinel satisfies them; `injectPublish` ignores its argument.
 */
export const INJECT_SENTINEL_PUBLISHER = {} as PDSPublisher;

/**
 * Publish via the test-inject endpoint. Same signature as the real
 * `publishAttestationToPDS` so it's a drop-in `publishToPDS` for both the inline
 * attempt and the worker tick.
 */
export async function injectPublish(
  _pds: unknown,
  did: string,
  record: Record<string, unknown>,
  rkey: string,
): Promise<{ uri: string; cid: string }> {
  const result = await injectAttestation({
    authorDid: did,
    rkey,
    cid: `bafyreim${Date.now().toString(36)}`,
    record: record as InjectAttestationRequest['record'],
  });
  return { uri: result.uri, cid: result.cid };
}
