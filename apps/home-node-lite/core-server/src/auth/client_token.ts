/**
 * Task 4.25 — CLIENT_TOKEN bearer auth for admin routes.
 *
 * Admin routes (e.g. `/admin/personas`, `/admin/export`) use a Bearer
 * token instead of Ed25519 — it's the browser-only auth surface and
 * Brain's service key isn't the right trust root. Tokens are issued
 * via the pairing flow (task 4.26 pairing-code path) and stored
 * SHA-256-hashed in the `device_tokens` table.
 *
 * **Why SHA-256-hashed, not plaintext.** If the `device_tokens` table
 * (inside SQLCipher) is ever exfiltrated, the raw tokens are not
 * recoverable. Authentication is a constant-time compare against the
 * hash (incoming raw token → SHA-256 → table lookup).
 *
 * **Timing.** Lookup is a Map.get on the raw-token's SHA-256 hex —
 * O(1) expected, and the SHA-256 step non-linearises any timing
 * signal from the attacker's guessed token (can't craft inputs to
 * probe hash-bucket positions). That's the real protection here; we
 * don't need an explicit constant-time byte-compare on top.
 *
 * **Separate from Ed25519.** This module does NOT touch the
 * signed-header pipeline (`extractSignedHeaders`). Admin routes check
 * `Authorization: Bearer <token>`; all other routes check X-DID +
 * X-Signature. The auth middleware (pending) dispatches on route
 * prefix — `/admin/*` → Bearer, everything else → Ed25519.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4c task 4.25.
 */

import { Crypto } from '@dina/adapters-node';

export interface ClientTokenEntry {
  /** Human-readable device label ("Rajmohan's phone", "admin-cli"). */
  deviceLabel: string;
  /** Optional expiry — ms-since-epoch. Pass 0 / undefined for no expiry. */
  expiresAtMs?: number;
}

export type BearerExtractionResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'missing' | 'malformed' };

export type ClientTokenValidationResult =
  | { ok: true; deviceLabel: string }
  | { ok: false; reason: 'missing' | 'malformed' | 'unknown_token' | 'expired' };

/**
 * Extract the raw Bearer token from an `Authorization` header value.
 * Tolerates case-insensitive scheme and surrounding whitespace.
 */
export function extractBearerToken(
  authHeader: string | undefined | null,
): BearerExtractionResult {
  if (authHeader === undefined || authHeader === null || authHeader === '') {
    return { ok: false, reason: 'missing' };
  }
  const trimmed = authHeader.trim();
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (!match || !match[1] || match[1].length === 0) {
    return { ok: false, reason: 'malformed' };
  }
  return { ok: true, token: match[1].trim() };
}

/**
 * In-memory store of known token hashes. Keyed by hex-encoded SHA-256
 * digest of the raw token — matches the `device_tokens` schema. When
 * `@dina/storage-node` lands, a `SqliteClientTokenStore` will
 * implement the same surface backed by the real table.
 */
export class InMemoryClientTokenStore {
  private readonly byHash = new Map<string, ClientTokenEntry>();
  private readonly crypto: Crypto;
  private readonly nowMsFn: () => number;

  constructor(opts?: { crypto?: Crypto; nowMsFn?: () => number }) {
    this.crypto = opts?.crypto ?? new Crypto();
    this.nowMsFn = opts?.nowMsFn ?? Date.now;
  }

  /** Register a raw token — hashed before storage. */
  async add(rawToken: string, entry: ClientTokenEntry): Promise<void> {
    const hash = await this.hashToken(rawToken);
    this.byHash.set(hash, entry);
  }

  /** Revoke by raw token. Returns true if a token was removed. */
  async revoke(rawToken: string): Promise<boolean> {
    const hash = await this.hashToken(rawToken);
    return this.byHash.delete(hash);
  }

  /**
   * Validate a raw Bearer token. Returns the structured outcome for
   * the auth middleware to map to HTTP 401 + error envelope. Expiry
   * check is inline so the store never returns a usable entry past
   * its deadline.
   */
  async validate(rawToken: string): Promise<ClientTokenValidationResult> {
    if (rawToken.length === 0) return { ok: false, reason: 'missing' };
    const hash = await this.hashToken(rawToken);
    const entry = this.byHash.get(hash);
    if (!entry) return { ok: false, reason: 'unknown_token' };
    if (
      entry.expiresAtMs !== undefined &&
      entry.expiresAtMs > 0 &&
      entry.expiresAtMs <= this.nowMsFn()
    ) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, deviceLabel: entry.deviceLabel };
  }

  /** Clear all tokens — tests use this. */
  clear(): void {
    this.byHash.clear();
  }

  size(): number {
    return this.byHash.size;
  }

  private async hashToken(raw: string): Promise<string> {
    const bytes = new TextEncoder().encode(raw);
    const digest = await this.crypto.sha256(bytes);
    return bytesToHexLower(digest);
  }
}

/**
 * One-shot convenience: extract + validate in a single call. The auth
 * middleware wires this into the `/admin/*` branch.
 */
export async function authenticateBearer(
  authHeader: string | undefined | null,
  store: { validate(token: string): Promise<ClientTokenValidationResult> },
): Promise<ClientTokenValidationResult> {
  const extracted = extractBearerToken(authHeader);
  if (!extracted.ok) return extracted;
  return store.validate(extracted.token);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytesToHexLower(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === undefined) continue;
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}
