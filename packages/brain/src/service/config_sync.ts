/**
 * Config-push handler — bridges Core's local `service_config` to the PDS
 * profile record.
 *
 * Flow (matches Python `brain.main`):
 *   1. Core fires `config_changed` after a successful PUT.
 *   2. This class's listener reads the fresh config (either directly from
 *      the in-process state, or via a remote CoreHTTPClient in the future
 *      mobile split) and converts it into a `ServicePublisherConfig`.
 *   3. `ServicePublisher.sync(publisherConfig)` either (a) publishes the
 *      AT-Proto record when `isDiscoverable=true`, or (b) removes it when the
 *      operator flips `isDiscoverable=false`.
 *
 * Concurrency: PDS writes are IO-bound and not instantaneous. If a second
 * config change arrives while a sync is still in-flight, we fold it into a
 * single trailing sync — every caller that asked for a push sees the **most
 * recent** config reflected on PDS, without stacking up parallel writes.
 *
 * Error handling: a sync failure is NOT thrown to the Core listener path
 * (that would break the config write). It is surfaced via the injectable
 * `onError` callback so the caller can log, alert, or retry.
 *
 * Source: brain/src/main.py + brain/src/service/service_publisher.py
 *         (config_changed event plumbing).
 */

import type { ServicePublisher, ServicePublisherConfig } from './service_publisher';
import type { ServiceConfig } from '@dina/protocol';

/** Minimal shape of the event source — matches `onServiceConfigChanged`. */
export interface ConfigChangeSource {
  /**
   * Subscribe to config changes. Must return an unsubscribe function.
   * Payload is `null` when the config is cleared.
   */
  onServiceConfigChanged(listener: (cfg: ServiceConfig | null) => void): () => void;
}

/** Options for `ConfigSync`. */
export interface ConfigSyncOptions {
  /** The PDS publisher bound to this home node's identity. */
  publisher: ServicePublisher;
  /**
   * Source of config-change events. In-process: pass the module namespace
   * `{ onServiceConfigChanged }` imported from `@dina/core`. Cross-process:
   * a thin adapter that maps remote events to this interface.
   */
  source: ConfigChangeSource;
  /**
   * Called when a sync fails. The sync itself never throws into the event
   * listener path; callers inspect / log the error here. Omit to swallow.
   */
  onError?: (err: unknown) => void;
  /** Called on every successful sync. Useful for metrics. */
  onSynced?: (result: { published: true; uri: string } | { published: false }) => void;
}

/**
 * Converts Core's internal `ServiceConfig` (capability map) into the shape
 * expected by the PDS publisher (capability array + responsePolicy map).
 *
 * Exported for tests and for callers that want to trigger a publish from
 * code without going through the event loop.
 */
export function toPublisherConfig(cfg: ServiceConfig): ServicePublisherConfig {
  const capabilities = Object.keys(cfg.capabilities);
  const responsePolicy: Record<string, 'auto' | 'review'> = {};
  for (const [name, entry] of Object.entries(cfg.capabilities)) {
    responsePolicy[name] = entry.responsePolicy;
  }
  const out: ServicePublisherConfig = {
    isDiscoverable: cfg.isDiscoverable,
    name: cfg.name,
    capabilities,
    responsePolicy,
  };
  if (cfg.description !== undefined) {
    out.description = cfg.description;
  }
  if (cfg.capabilitySchemas !== undefined) {
    out.capabilitySchemas = cfg.capabilitySchemas;
  }
  return out;
}

/**
 * Subscribes to config-change events and pushes the resulting profile to
 * the PDS. Construct once at brain startup and call `start()` / `stop()`
 * to control the subscription lifecycle.
 */
export class ConfigSync {
  private readonly publisher: ServicePublisher;
  private readonly source: ConfigChangeSource;
  private readonly onError: (err: unknown) => void;
  private readonly onSynced?: (
    result: { published: true; uri: string } | { published: false },
  ) => void;
  private unsubscribe: (() => void) | null = null;
  /** Promise for the currently in-flight sync, or `null` when idle. */
  private inFlight: Promise<void> | null = null;
  /**
   * Snapshot of the most recent config seen while a sync was in flight. If
   * non-null when the current sync finishes, it triggers a trailing sync.
   */
  private pending: ServiceConfig | null | undefined = undefined;

  constructor(options: ConfigSyncOptions) {
    if (!options.publisher) throw new Error('ConfigSync: publisher is required');
    if (!options.source) throw new Error('ConfigSync: source is required');
    this.publisher = options.publisher;
    this.source = options.source;
    this.onError =
      options.onError ??
      (() => {
        /* swallowed by default */
      });
    this.onSynced = options.onSynced;
  }

  /** Begin listening for config changes. Idempotent. */
  start(): void {
    if (this.unsubscribe !== null) return;
    this.unsubscribe = this.source.onServiceConfigChanged((cfg) => {
      this.schedule(cfg);
    });
  }

  /**
   * Stop listening and drop any queued trailing sync. An in-flight sync
   * runs to completion; callers that need to await it should `await`
   * `flush()` after `stop()`.
   */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.pending = undefined;
  }

  /** Manually trigger a sync for `cfg`. Returns the in-flight promise. */
  syncNow(cfg: ServiceConfig | null): Promise<void> {
    this.schedule(cfg);
    return this.inFlight ?? Promise.resolve();
  }

  /**
   * Await the in-flight sync (and any trailing sync that has already been
   * scheduled by a listener). Useful in tests and at shutdown.
   */
  async flush(): Promise<void> {
    while (this.inFlight !== null) {
      const current = this.inFlight;
      // eslint-disable-next-line no-await-in-loop
      await current.catch(() => {
        /* swallowed — propagated via onError */
      });
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Enqueue a sync for `cfg`. If nothing is in flight, runs immediately;
   * otherwise remembers the latest config so the trailing run uses it.
   *
   * Crucially: we record `pending = cfg` BEFORE checking in-flight. This
   * means an update that arrives between "current sync finished" and
   * "pending drain" is still picked up — avoiding the classic "listener
   * observes stale config" race.
   */
  private schedule(cfg: ServiceConfig | null): void {
    this.pending = cfg;
    if (this.inFlight === null) {
      this.runNext();
    }
  }

  /**
   * Drain one entry from `pending` and run a sync. When the sync resolves,
   * if a further update has landed we recurse — otherwise we return to idle.
   */
  private runNext(): void {
    if (this.pending === undefined) {
      this.inFlight = null;
      return;
    }
    const next = this.pending;
    this.pending = undefined;
    this.inFlight = this.doSync(next).finally(() => {
      // Chain the trailing sync (if any) and continue draining.
      this.runNext();
    });
  }

  private async doSync(cfg: ServiceConfig | null): Promise<void> {
    try {
      if (cfg === null) {
        await this.publisher.unpublish();
        this.onSynced?.({ published: false });
        return;
      }
      const publisherConfig = toPublisherConfig(cfg);
      if (!publisherConfig.isDiscoverable) {
        await this.publisher.unpublish();
        this.onSynced?.({ published: false });
        return;
      }
      const result = await this.publisher.publish(publisherConfig);
      this.onSynced?.({ published: true, uri: result.uri });
    } catch (err) {
      this.onError(err);
    }
  }
}
