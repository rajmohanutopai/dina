/**
 * Ports — the two external dependencies of the claim pipeline, kept
 * behind interfaces so the pipeline is fully testable with fakes and
 * the real adapters are independently verifiable.
 */

/**
 * Per-device claimed-state + token validity, backed by Apple
 * DeviceCheck (the state lives in APPLE's bits — we keep no device
 * ledger; spec "zero device ledger on our side").
 *
 * `check` validates the token AND reads claimed-state in one call.
 * Three outcomes, never a throw:
 *   - 'invalid'     — a forged/expired token (Apple 4xx) → TERMINAL refusal.
 *   - 'unavailable' — a transient Apple outage/throttle (5xx/429/network)
 *                     or OUR misconfig — must NOT brick the device; the
 *                     client retries next launch.
 *   - { claimed }   — a valid token + its bit state.
 */
export interface DeviceState {
  check(token: string): Promise<'invalid' | 'unavailable' | { claimed: boolean }>;
  /** Mark the device as having claimed its grant (bit0 = true). */
  setClaimed(token: string): Promise<void>;
}

/** Spend-capped runtime key minting (OpenRouter provisioning API). */
export interface KeyProvisioner {
  createCappedKey(args: {
    limitUsd: number;
    /** Opaque label — NEVER identity-bearing (spec: anonymous claim). */
    label: string;
  }): Promise<{ key: string; orKeyId: string }>;
}

/** Grant ledger — ops-only, identity-free (spec §ledger). */
export interface GrantLedger {
  insert(row: { grantId: string; orKeyId: string; platform: string; grantedAt: number }): void;
  /** Grants minted since `sinceMs` (drives the global daily ceiling). */
  countSince(sinceMs: number): number;
  close(): void;
}
