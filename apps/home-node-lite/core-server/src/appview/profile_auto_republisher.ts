/**
 * Task 6.20 — Re-publish on config change.
 *
 * When the operator edits `service_config` (adds a capability,
 * tweaks a schema, adjusts `isPublic`), the published
 * `com.dina.service.profile` record must update so AppView indexes
 * the new shape. The `ConfigReloader` (task 5.13) detects the
 * change + fires a `changed` event; this module hooks into that
 * event + triggers a re-publish via `ServiceProfilePublisher`
 * (task 6.19).
 *
 * **Change-detection already done**: the `ConfigReloader` computes
 * equality (stable-JSON deep compare by default). This module only
 * subscribes + wires — no independent change detection.
 *
 * **Rebuild-before-publish**: on `changed`, we rebuild the full
 * profile via the caller-supplied `buildFn` before publishing.
 * Reasons:
 *   - `ProfileBuilder` computes `schema_hash` per capability — we
 *     must recompute if the schema changed.
 *   - Validation (required fields, responsePolicy alignment) runs
 *     on the FRESH config shape, catching bad edits before AppView
 *     sees them.
 *
 * **Retry on failure**: a failed publish (network error /
 * rejected_by_pds) is retried with exponential backoff. The state
 * machine is:
 *
 *   idle → publishing → publish_ok → idle
 *                   ──► publish_failed → backoff → publishing
 *                   ──► publish_rejected_malformed → idle (don't retry bad builds)
 *
 * **Malformed-profile terminal**: a `malformed_profile` failure is
 * a caller bug — retrying the same input gets the same error. We
 * fire `build_validation_failed` + stay in `idle` until the next
 * config change.
 *
 * **Event stream**: every transition fires a diagnostic event so
 * the admin UI can render "profile up-to-date" / "retrying in
 * 30s" / "build failed — review config".
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6e task 6.20.
 */

import type {
  BuildProfileInput,
  ServiceProfileRecord,
} from './profile_builder';
import type {
  PublishOutcome,
  ServiceProfilePublisher,
} from './service_profile_publisher';

export const DEFAULT_REPUBLISH_INITIAL_BACKOFF_MS = 1_000;
export const DEFAULT_REPUBLISH_MAX_BACKOFF_MS = 60_000;
export const DEFAULT_REPUBLISH_MAX_ATTEMPTS = 5;

export type BuildProfileFn = (
  config: BuildProfileInput,
) => ServiceProfileRecord;

export interface ConfigSnapshotReader<T> {
  getCurrent(): T | null;
  isReady(): boolean;
}

export type ConfigSnapshotEvent<T> =
  | { kind: 'first_load'; config: T }
  | { kind: 'changed'; previous: T; next: T }
  | { kind: string; [key: string]: unknown };

export interface AutoRepublisherOptions<T extends BuildProfileInput = BuildProfileInput> {
  configReloader: ConfigSnapshotReader<T>;
  buildFn: BuildProfileFn;
  publisher: Pick<ServiceProfilePublisher, 'publish'>;
  /** Initial backoff after first failure. Default 1s. */
  initialBackoffMs?: number;
  /** Cap on backoff. Default 60s. */
  maxBackoffMs?: number;
  /**
   * Max attempts for a single republish cycle before giving up.
   * Default 5. Giving up leaves the state as `publish_failed`; the
   * next config change triggers a fresh cycle.
   */
  maxAttempts?: number;
  /** Injectable clock — defaults to Date.now. */
  nowMsFn?: () => number;
  /** Injectable timer primitives. Defaults to native setTimeout/clearTimeout. */
  setTimerFn?: (fn: () => void, ms: number) => unknown;
  clearTimerFn?: (handle: unknown) => void;
  /** Diagnostic hook. */
  onEvent?: (event: AutoRepublisherEvent) => void;
}

export type AutoRepublisherEvent =
  | { kind: 'subscribed' }
  | { kind: 'config_change_detected' }
  | { kind: 'build_validation_failed'; error: string }
  | { kind: 'publish_attempted'; attempt: number }
  | { kind: 'publish_ok'; cid: string; uri: string; attempt: number }
  | { kind: 'publish_failed'; attempt: number; reason: string; nextBackoffMs: number | null }
  | { kind: 'gave_up'; attempts: number; lastReason: string };

export type AutoRepublisherState = 'idle' | 'publishing' | 'backoff' | 'given_up';

/**
 * Watches a `ConfigReloader` for changes + keeps the published
 * profile in sync. Wire + activate:
 *
 * ```ts
 * const rep = new ProfileAutoRepublisher({configReloader, buildFn, publisher});
 * const unsubscribe = rep.attachTo(configReloader);
 * // later, on shutdown:
 * unsubscribe();
 * ```
 *
 * The republisher does NOT own the reloader's lifecycle. The caller
 * starts/stops the reloader; the republisher just listens.
 */
export class ProfileAutoRepublisher<T extends BuildProfileInput = BuildProfileInput> {
  private readonly configReloader: AutoRepublisherOptions<T>['configReloader'];
  private readonly buildFn: BuildProfileFn;
  private readonly publisher: Pick<ServiceProfilePublisher, 'publish'>;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxAttempts: number;
  private readonly nowMsFn: () => number;
  private readonly setTimerFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimerFn: (handle: unknown) => void;
  private readonly onEvent?: (event: AutoRepublisherEvent) => void;

  private state: AutoRepublisherState = 'idle';
  private attempt = 0;
  private backoffTimer: unknown = null;
  /** True while an in-flight publish hasn't completed yet. */
  private inFlight = false;

  constructor(opts: AutoRepublisherOptions<T>) {
    if (!opts?.configReloader) {
      throw new TypeError('ProfileAutoRepublisher: configReloader is required');
    }
    if (typeof opts.buildFn !== 'function') {
      throw new TypeError('ProfileAutoRepublisher: buildFn is required');
    }
    if (!opts.publisher || typeof opts.publisher.publish !== 'function') {
      throw new TypeError('ProfileAutoRepublisher: publisher is required');
    }
    this.configReloader = opts.configReloader;
    this.buildFn = opts.buildFn;
    this.publisher = opts.publisher;
    this.initialBackoffMs = opts.initialBackoffMs ?? DEFAULT_REPUBLISH_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_REPUBLISH_MAX_BACKOFF_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_REPUBLISH_MAX_ATTEMPTS;
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
    this.setTimerFn =
      opts.setTimerFn ??
      ((fn, ms) => setTimeout(fn, ms));
    this.clearTimerFn =
      opts.clearTimerFn ??
      ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onEvent = opts.onEvent;
  }

  /**
   * Subscribe to a reloader's events. Returns an unsubscribe fn.
   * Typical wiring:
   *
   * ```ts
   * const reloader = new ConfigReloader({
   *   ...,
   *   onEvent: (e) => republisher.onConfigEvent(e),
   * });
   * ```
   *
   * For callers that can't pipe events in via the reloader's
   * onEvent directly, this helper returns an adapter fn they can
   * hook into their event bus.
   */
  onConfigEvent(event: ConfigSnapshotEvent<T>): void {
    if (event.kind === 'changed' || event.kind === 'first_load') {
      this.onEvent?.({ kind: 'config_change_detected' });
      this.triggerPublish();
    }
  }

  /**
   * Manually trigger a publish cycle — useful for admin "republish
   * now" buttons + test-driven flows. If an attempt is already
   * in flight, this is a no-op (the in-flight attempt uses the
   * latest config via `configReloader.getCurrent()`).
   */
  triggerPublish(): void {
    if (this.inFlight) return;
    this.clearBackoff();
    this.attempt = 0;
    void this.publishCycle();
  }

  /** Current state — for tests + admin UI. */
  getState(): AutoRepublisherState {
    return this.state;
  }

  /** Current attempt number within the in-flight cycle. */
  getAttempt(): number {
    return this.attempt;
  }

  /**
   * Stop any pending retry + return the republisher to idle. Does
   * NOT abort an in-flight publish (there's no mid-publish cancel
   * on `putRecord`); just prevents the next retry.
   */
  stop(): void {
    this.clearBackoff();
    if (this.state === 'backoff' || this.state === 'given_up') {
      this.state = 'idle';
    }
  }

  // ── Internals ────────────────────────────────────────────────────────

  private async publishCycle(): Promise<void> {
    const config = this.configReloader.getCurrent();
    if (!config) {
      // Reloader hasn't had a successful fetch yet — nothing to publish.
      // Next `first_load` will re-trigger.
      return;
    }

    // Rebuild the profile from current config.
    let profile: ServiceProfileRecord;
    try {
      profile = this.buildFn(config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onEvent?.({ kind: 'build_validation_failed', error: msg });
      this.state = 'idle';
      return;
    }

    this.inFlight = true;
    this.state = 'publishing';
    this.attempt++;
    this.onEvent?.({ kind: 'publish_attempted', attempt: this.attempt });

    let outcome: PublishOutcome;
    try {
      outcome = await this.publisher.publish(profile);
    } catch (err) {
      // Publisher should never throw (it returns structured outcomes),
      // but defend against bugs.
      outcome = {
        ok: false,
        reason: 'network_error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
    this.inFlight = false;

    if (outcome.ok) {
      this.onEvent?.({
        kind: 'publish_ok',
        cid: outcome.cid,
        uri: outcome.uri,
        attempt: this.attempt,
      });
      this.state = 'idle';
      this.attempt = 0;
      return;
    }

    // Malformed profile → don't retry (same input → same failure).
    if (outcome.reason === 'malformed_profile') {
      this.onEvent?.({
        kind: 'build_validation_failed',
        error: outcome.detail,
      });
      this.state = 'idle';
      this.attempt = 0;
      return;
    }

    // Transient failure → maybe retry.
    const failedReason =
      outcome.reason === 'network_error'
        ? outcome.error
        : outcome.error;
    if (this.attempt >= this.maxAttempts) {
      this.onEvent?.({
        kind: 'gave_up',
        attempts: this.attempt,
        lastReason: failedReason,
      });
      this.onEvent?.({
        kind: 'publish_failed',
        attempt: this.attempt,
        reason: failedReason,
        nextBackoffMs: null,
      });
      this.state = 'given_up';
      return;
    }

    const backoffMs = Math.min(
      this.initialBackoffMs * Math.pow(2, Math.max(0, this.attempt - 1)),
      this.maxBackoffMs,
    );
    this.onEvent?.({
      kind: 'publish_failed',
      attempt: this.attempt,
      reason: failedReason,
      nextBackoffMs: backoffMs,
    });
    this.state = 'backoff';
    this.backoffTimer = this.setTimerFn(() => {
      this.backoffTimer = null;
      if (this.state === 'backoff') {
        void this.publishCycle();
      }
    }, backoffMs);
  }

  private clearBackoff(): void {
    if (this.backoffTimer !== null) {
      this.clearTimerFn(this.backoffTimer);
      this.backoffTimer = null;
    }
  }
}
