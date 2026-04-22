/**
 * Task 4.65 — live-reload device tokens into the auth validator.
 *
 * The auth middleware on `/admin/*` routes authenticates incoming
 * `Authorization: Bearer <token>` headers. Its source of truth is the
 * `DeviceTokenRegistry` (task 4.64). Because this validator holds a
 * *reference* to the registry (not a snapshot), any `issue(...)` from
 * `/v1/pair/complete` (task 4.63) or `revoke(...)` from
 * `/v1/pair/devices/:id` DELETE (task 4.66) is visible on the very
 * next request — no restart, no explicit reload step. That's what
 * "live reload" means in practice: the interface is pull-based so the
 * data is always fresh.
 *
 * **Why a separate validator module** from
 * `src/auth/client_token.ts`. That file's `InMemoryClientTokenStore`
 * pre-dates 4.64 and owns its own independent Map. We keep it
 * around for the backend-agnostic shape
 * (`ClientTokenValidationResult`) and simply adapt `DeviceTokenRegistry`
 * to the same interface. Middleware code that already speaks
 * `validate(raw) → ClientTokenValidationResult` can be rewired to
 * this validator with a one-line swap — no behavioural drift.
 *
 * **touch-on-success semantics** (opt-in). When the caller sets
 * `touchOnSuccess: true` the validator updates `lastSeen` after a
 * successful lookup. The default is `false` so a rate-limited or
 * body-limit-rejected request doesn't inflate lastSeen before the
 * handler runs. The `/admin/*` dispatcher (pending) flips it to
 * `true` in the post-handler hook.
 *
 * **Revoked handling**: `DeviceTokenRegistry.verify` already skips
 * revoked records, so a revoke is instantly reflected without this
 * module needing to second-guess the registry's bookkeeping.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4h task 4.65.
 */

import type { DeviceTokenRegistry, DeviceTokenRecord } from '../pair/device_tokens';
import { extractBearerToken } from './client_token';

export interface DeviceTokenValidatorOptions {
  /**
   * When true, `validate(rawToken)` updates `lastSeen` after a
   * successful lookup. Default false — the caller owns that decision.
   */
  touchOnSuccess?: boolean;
}

/**
 * Structured validation result.
 *
 * Shape parity with `ClientTokenValidationResult` (same `ok` + `reason`
 * variants) so middleware can plug either validator in; extended on
 * the success branch with the full `DeviceTokenRecord` for handlers
 * that want to branch on role / deviceId without a second lookup.
 */
export type DeviceTokenValidationDetail =
  | { ok: true; deviceLabel: string; record: DeviceTokenRecord }
  | { ok: false; reason: 'missing' | 'malformed' | 'unknown_token' };

/**
 * Live-reloading validator backed by a `DeviceTokenRegistry`.
 *
 * `validate(rawToken)` reads through to the registry on every call,
 * so newly-issued tokens authenticate instantly and revoked tokens
 * fail instantly. That's the entire "live reload" story — there's
 * no snapshot to invalidate.
 */
export class DeviceTokenBearerValidator {
  private readonly registry: DeviceTokenRegistry;
  private readonly touchOnSuccess: boolean;

  constructor(registry: DeviceTokenRegistry, opts: DeviceTokenValidatorOptions = {}) {
    this.registry = registry;
    this.touchOnSuccess = opts.touchOnSuccess ?? false;
  }

  /**
   * Validate a raw Bearer token. Structured result matches
   * `ClientTokenValidationResult` so callers can plug this in where
   * `InMemoryClientTokenStore.validate` was expected.
   *
   *   ok=true  → `{ok: true, deviceLabel, record?}`
   *   ok=false → `{ok: false, reason: 'missing' | 'unknown_token'}`
   *
   * This implementation never returns `'expired'` or `'malformed'`:
   *   - Expiry is NOT a field on DeviceTokenRecord (revoke is the
   *     lifecycle end-state; tokens are durable until revoked).
   *   - Malformed is handled by `extractBearerToken` (see
   *     `authenticateBearerFromDeviceRegistry` below).
   */
  validate(rawToken: string): DeviceTokenValidationDetail {
    if (rawToken.length === 0) {
      return { ok: false, reason: 'missing' };
    }
    const record = this.registry.verify(rawToken);
    if (record === undefined) {
      return { ok: false, reason: 'unknown_token' };
    }
    if (this.touchOnSuccess) {
      // Registry manages lastSeen; the throw-on-unknown contract is
      // unreachable here because verify already returned the record.
      this.registry.touch(record.deviceId);
    }
    return { ok: true, deviceLabel: record.deviceName, record };
  }
}

/**
 * One-shot convenience: extract + validate against a live
 * `DeviceTokenRegistry`. Mirrors `authenticateBearer` in
 * `client_token.ts` but with the richer (record-carrying) result.
 */
export function authenticateBearerFromDeviceRegistry(
  authHeader: string | undefined | null,
  validator: DeviceTokenBearerValidator,
): DeviceTokenValidationDetail {
  const extracted = extractBearerToken(authHeader);
  if (!extracted.ok) return extracted;
  return validator.validate(extracted.token);
}
