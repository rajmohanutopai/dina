/**
 * Canonical-payload builder for Ed25519-signed HTTP requests.
 *
 * Wire format (immutable — changing it breaks every Dina implementation):
 *   `{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{NONCE}\n{SHA256_HEX(BODY)}`
 *
 * Timestamp: RFC3339 (e.g. `2026-04-09T12:00:00Z`)
 * Nonce: random hex string
 * Body hash: lowercase hex of SHA-256(body bytes)
 *
 * **Zero runtime deps** — the caller provides `bodyHash` already computed,
 * keeping this package crypto-backend-free. The original `@dina/core`
 * version accepted raw body bytes and called `sha256()` internally;
 * Phase 1b task 1.18 reshaped the signature so `@dina/protocol` stays pure.
 *
 * Source: extracted from `@dina/core/src/auth/canonical.ts` per
 * docs/HOME_NODE_LITE_TASKS.md task 1.18.
 */

/**
 * Build the canonical string for Ed25519 request signing.
 *
 * @param method     HTTP method (GET, POST, …).
 * @param path       URL path, e.g. `"/v1/vault/query"`.
 * @param query      Query string without leading `?` (empty string if none).
 * @param timestamp  RFC3339 timestamp, e.g. `"2026-04-09T12:00:00Z"`.
 * @param nonce      Random hex string for replay protection.
 * @param bodyHash   Lowercase hex-encoded SHA-256(body). Caller hashes; this
 *                   module ships no crypto backend.
 * @returns          The canonical string to sign (no trailing newline).
 */
export function buildCanonicalPayload(
  method: string,
  path: string,
  query: string,
  timestamp: string,
  nonce: string,
  bodyHash: string,
): string {
  return `${method}\n${path}\n${query}\n${timestamp}\n${nonce}\n${bodyHash}`;
}
