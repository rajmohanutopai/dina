/**
 * Guardian D2D dispatcher — routes inbound D2D message bodies to the
 * type-specific handler registered at boot.
 *
 * Role (matches Python `brain/src/service/guardian.py` dispatch block):
 *   - One registry per brain process.
 *   - Handlers register by D2D message type (e.g. `service.query`).
 *   - `dispatch(type, message)` looks up the handler, invokes it, and
 *     isolates its errors so one bad handler never takes the whole Guardian
 *     down.
 *   - A pre-dispatch "scan" hook (PII scrub, action-risk classification) is
 *     run before routing. Handlers see the scanned message, not the raw one.
 *
 * Why a registry and not a switch? New D2D message types (service.query,
 * service.response, future families) are plugged in by the owning module
 * at startup rather than by editing this file. Keeps cross-feature coupling
 * low.
 *
 * Source: brain/src/service/guardian.py (D2D event dispatch)
 */

import type { DinaMessage } from '@dina/test-harness';

/** Runtime body shape once parsed (opaque here — handlers validate). */
export type D2DBody = Record<string, unknown>;

/** Scan outcome — produces a possibly-transformed body for the handler. */
export interface ScanResult {
  /** The body the handler should see. May be identical to `input`. */
  body: D2DBody;
  /** `true` if the scan flagged the message as dropped before dispatch. */
  dropped?: boolean;
  /** Free-form reason used for audit when `dropped` is `true`. */
  reason?: string;
}

/** Handler signature for a registered D2D message type. */
export type D2DHandler = (fromDID: string, body: D2DBody, raw: DinaMessage) => void | Promise<void>;

/** Pre-dispatch scanner (PII, action-risk, density check, …). */
export type D2DScanner = (messageType: string, body: D2DBody, raw: DinaMessage) => ScanResult;

/** Outcome of `dispatch()`. */
export interface DispatchResult {
  /** `true` iff a handler was found and invoked (even if it threw). */
  routed: boolean;
  /** `true` iff the scanner dropped the message before dispatch. */
  dropped: boolean;
  /** Reason for drop, or the handler error message if isolated. */
  reason?: string;
  /** Error thrown by the handler (caught and wrapped). Null on success. */
  handlerError: unknown | null;
}

/**
 * Create a dispatcher instance. Multiple instances are supported (one per
 * brain context) but most code paths use the default module-level instance
 * accessed via `getDefaultDispatcher()`.
 */
export class D2DDispatcher {
  private readonly handlers = new Map<string, D2DHandler>();
  private scanner: D2DScanner | null = null;
  private onError: (err: unknown, messageType: string) => void = () => {
    /* silenced */
  };

  /**
   * Register a handler for a D2D message type. Overwrites any previous
   * handler for the same type. Returns a disposer that unregisters.
   */
  register(messageType: string, handler: D2DHandler): () => void {
    if (!messageType) throw new Error('D2DDispatcher: messageType is required');
    if (typeof handler !== 'function') {
      throw new Error('D2DDispatcher: handler must be a function');
    }
    this.handlers.set(messageType, handler);
    return () => {
      // Only unregister if the stored handler is still ours.
      if (this.handlers.get(messageType) === handler) {
        this.handlers.delete(messageType);
      }
    };
  }

  /** Returns `true` iff a handler is registered for `messageType`. */
  isRegistered(messageType: string): boolean {
    return this.handlers.has(messageType);
  }

  /** List registered types. Primarily for diagnostics. */
  registeredTypes(): string[] {
    return Array.from(this.handlers.keys()).sort();
  }

  /**
   * Install a pre-dispatch scanner. Replaces any previous scanner. Pass
   * `null` to clear.
   */
  setScanner(scanner: D2DScanner | null): void {
    this.scanner = scanner;
  }

  /** Install the error-isolation observer. */
  setErrorObserver(observer: (err: unknown, messageType: string) => void): void {
    this.onError = observer;
  }

  /**
   * Route a parsed D2D message to its registered handler. Returns a
   * `DispatchResult` rather than throwing so callers can log / audit both
   * the drop and isolated-handler-error paths uniformly.
   */
  async dispatch(fromDID: string, raw: DinaMessage, body: D2DBody): Promise<DispatchResult> {
    const messageType = raw.type;
    const handler = this.handlers.get(messageType);
    if (handler === undefined) {
      return {
        routed: false,
        dropped: false,
        reason: `no handler registered for ${messageType}`,
        handlerError: null,
      };
    }

    let scanned = body;
    if (this.scanner !== null) {
      const scanResult = this.scanner(messageType, body, raw);
      if (scanResult.dropped === true) {
        return {
          routed: false,
          dropped: true,
          reason: scanResult.reason ?? 'dropped by scanner',
          handlerError: null,
        };
      }
      scanned = scanResult.body;
    }

    try {
      await handler(fromDID, scanned, raw);
      return { routed: true, dropped: false, handlerError: null };
    } catch (err) {
      this.onError(err, messageType);
      return {
        routed: true,
        dropped: false,
        reason: (err as Error).message ?? String(err),
        handlerError: err,
      };
    }
  }

  /** Reset all state — for tests. */
  reset(): void {
    this.handlers.clear();
    this.scanner = null;
    this.onError = () => {
      /* silenced */
    };
  }
}

// ---------------------------------------------------------------------------
// Default module-level instance
// ---------------------------------------------------------------------------

let defaultInstance: D2DDispatcher | null = null;

/**
 * Return the process-wide default dispatcher, creating it on first call.
 * Mirrors the singleton pattern used by other guardian modules.
 */
export function getDefaultDispatcher(): D2DDispatcher {
  if (defaultInstance === null) {
    defaultInstance = new D2DDispatcher();
  }
  return defaultInstance;
}

/** Reset the default instance — tests only. */
export function resetDefaultDispatcher(): void {
  defaultInstance = null;
}
