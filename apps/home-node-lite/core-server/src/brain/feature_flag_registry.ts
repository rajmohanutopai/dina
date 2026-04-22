/**
 * Feature-flag registry — time-boxed flag store with injected clock.
 *
 * Brain subsystems check flags to gate new code paths:
 *
 *   if (flags.isEnabled('semantic-search-v2')) { ... }
 *
 * **Per-flag attributes**:
 *
 *   - `enabled`     — boolean default; tests + admin flip it.
 *   - `expiresAtMs` — optional hard expiry; after this the flag
 *                     auto-reverts to its `defaultEnabled`. Prevents
 *                     flags from outliving their intent.
 *   - `variant`     — optional string label for A/B experiments;
 *                     `isVariant('foo', 'B')` returns true when the
 *                     registered variant matches.
 *   - `description` — free-text note for ops dashboards.
 *
 * **Default state** — unregistered flags return the default passed
 * to `isEnabled(name, defaultEnabled = false)`. This lets callers
 * fall back to "safe off" without pre-registering every flag.
 *
 * **Injected clock** — deterministic for tests. Production reads
 * `Date.now`.
 *
 * **Event stream** — every register / update / expire fires an
 * event so the admin UI can render badges live.
 *
 * **Pure state** — all state is in-memory. Persistence is the
 * caller's concern (typically via `CoreClient.kvStore` + a refresh
 * loop).
 */

export interface FeatureFlag {
  name: string;
  enabled: boolean;
  /** Default state after expiry. Usually `false` (flag removed). */
  defaultEnabled: boolean;
  /** Unix ms when the flag reverts to defaultEnabled. null = no expiry. */
  expiresAtMs: number | null;
  /** Optional variant label for A/B experiments. */
  variant: string | null;
  /** Free-form description. */
  description: string | null;
  /** Unix ms when the flag was last updated. */
  updatedAtMs: number;
}

export interface RegisterFlagInput {
  name: string;
  enabled: boolean;
  defaultEnabled?: boolean;
  expiresAtMs?: number;
  variant?: string;
  description?: string;
}

export interface UpdateFlagInput {
  enabled?: boolean;
  expiresAtMs?: number | null;
  variant?: string | null;
  description?: string | null;
}

export type FeatureFlagEvent =
  | { kind: 'registered'; flag: FeatureFlag }
  | { kind: 'updated'; flag: FeatureFlag }
  | { kind: 'expired'; flag: FeatureFlag }
  | { kind: 'removed'; name: string };

export interface FeatureFlagRegistryOptions {
  nowMsFn?: () => number;
  onEvent?: (event: FeatureFlagEvent) => void;
}

export class FeatureFlagError extends Error {
  constructor(
    public readonly code:
      | 'invalid_name'
      | 'duplicate'
      | 'unknown'
      | 'invalid_expiry'
      | 'invalid_input',
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'FeatureFlagError';
  }
}

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/i;

export class FeatureFlagRegistry {
  private readonly flags = new Map<string, FeatureFlag>();
  private readonly nowMsFn: () => number;
  private readonly onEvent?: (event: FeatureFlagEvent) => void;

  constructor(opts: FeatureFlagRegistryOptions = {}) {
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
    this.onEvent = opts.onEvent;
  }

  size(): number {
    this.sweepExpired();
    return this.flags.size;
  }

  /**
   * Register a new flag. Throws on duplicate name — use `update()`
   * for existing flags.
   */
  register(input: RegisterFlagInput): FeatureFlag {
    validateRegister(input);
    if (this.flags.has(input.name)) {
      throw new FeatureFlagError('duplicate', `flag "${input.name}" already registered`);
    }
    const now = this.nowMsFn();
    const flag: FeatureFlag = {
      name: input.name,
      enabled: input.enabled,
      defaultEnabled: input.defaultEnabled ?? false,
      expiresAtMs: input.expiresAtMs ?? null,
      variant: input.variant ?? null,
      description: input.description ?? null,
      updatedAtMs: now,
    };
    this.flags.set(input.name, flag);
    this.onEvent?.({ kind: 'registered', flag: { ...flag } });
    return { ...flag };
  }

  /**
   * Update an existing flag in place. Pass `null` to clear optional
   * fields (variant, description, expiresAtMs).
   */
  update(name: string, input: UpdateFlagInput): FeatureFlag {
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      throw new FeatureFlagError('invalid_name', `invalid flag name ${JSON.stringify(name)}`);
    }
    this.sweepExpired();
    const current = this.flags.get(name);
    if (!current) {
      throw new FeatureFlagError('unknown', `flag "${name}" not registered`);
    }
    if (input.expiresAtMs !== undefined && input.expiresAtMs !== null) {
      if (!Number.isFinite(input.expiresAtMs) || input.expiresAtMs <= 0) {
        throw new FeatureFlagError('invalid_expiry', 'expiresAtMs must be > 0');
      }
    }
    const next: FeatureFlag = {
      ...current,
      enabled: input.enabled !== undefined ? input.enabled : current.enabled,
      expiresAtMs:
        input.expiresAtMs !== undefined
          ? input.expiresAtMs
          : current.expiresAtMs,
      variant: input.variant !== undefined ? input.variant : current.variant,
      description:
        input.description !== undefined
          ? input.description
          : current.description,
      updatedAtMs: this.nowMsFn(),
    };
    this.flags.set(name, next);
    this.onEvent?.({ kind: 'updated', flag: { ...next } });
    return { ...next };
  }

  /** Remove a flag entirely. Returns true if it existed. */
  remove(name: string): boolean {
    const existed = this.flags.delete(name);
    if (existed) this.onEvent?.({ kind: 'removed', name });
    return existed;
  }

  /**
   * Check whether a flag is enabled at the current clock tick.
   * Unregistered flags return `defaultEnabled` (fallback when a
   * caller checks before the boot-time register pass).
   */
  isEnabled(name: string, defaultEnabled = false): boolean {
    this.sweepExpired();
    const flag = this.flags.get(name);
    if (!flag) return defaultEnabled;
    return flag.enabled;
  }

  /**
   * Check whether a flag has a specific variant. Returns false when
   * the flag is disabled or not registered.
   */
  isVariant(name: string, variant: string): boolean {
    if (typeof variant !== 'string' || variant === '') return false;
    this.sweepExpired();
    const flag = this.flags.get(name);
    if (!flag || !flag.enabled) return false;
    return flag.variant === variant;
  }

  get(name: string): FeatureFlag | null {
    this.sweepExpired();
    const flag = this.flags.get(name);
    return flag ? { ...flag } : null;
  }

  list(): FeatureFlag[] {
    this.sweepExpired();
    return Array.from(this.flags.values())
      .map((f) => ({ ...f }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  clear(): void {
    this.flags.clear();
  }

  // ── Internals ────────────────────────────────────────────────────────

  private sweepExpired(): void {
    const now = this.nowMsFn();
    for (const flag of this.flags.values()) {
      if (flag.expiresAtMs !== null && flag.expiresAtMs <= now) {
        if (flag.enabled !== flag.defaultEnabled) {
          flag.enabled = flag.defaultEnabled;
          flag.updatedAtMs = now;
          this.onEvent?.({ kind: 'expired', flag: { ...flag } });
        }
        // Clear the expiry so we don't re-fire every sweep.
        flag.expiresAtMs = null;
      }
    }
  }
}

// ── Internals ──────────────────────────────────────────────────────────

function validateRegister(input: RegisterFlagInput): void {
  if (!input || typeof input !== 'object') {
    throw new FeatureFlagError('invalid_input', 'register input required');
  }
  if (typeof input.name !== 'string' || !NAME_PATTERN.test(input.name)) {
    throw new FeatureFlagError(
      'invalid_name',
      `name must match ${NAME_PATTERN.source}`,
    );
  }
  if (typeof input.enabled !== 'boolean') {
    throw new FeatureFlagError('invalid_input', 'enabled must be boolean');
  }
  if (input.defaultEnabled !== undefined && typeof input.defaultEnabled !== 'boolean') {
    throw new FeatureFlagError('invalid_input', 'defaultEnabled must be boolean');
  }
  if (input.expiresAtMs !== undefined) {
    if (!Number.isFinite(input.expiresAtMs) || input.expiresAtMs <= 0) {
      throw new FeatureFlagError('invalid_expiry', 'expiresAtMs must be > 0');
    }
  }
  if (input.variant !== undefined && typeof input.variant !== 'string') {
    throw new FeatureFlagError('invalid_input', 'variant must be a string');
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    throw new FeatureFlagError('invalid_input', 'description must be a string');
  }
}
