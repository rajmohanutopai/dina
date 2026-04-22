/**
 * Task 6.25 — Mock PDS, PLC, AppView transports.
 *
 * Testing the xRPC clients (6.2, 6.4, 6.6, 6.10-6.15) needs a
 * scripted-response dispatcher that feels like the real server but
 * never touches the network. This module provides three in-memory
 * mocks:
 *
 *   - **MockPdsTransport** — dispatches `com.atproto.server.*` +
 *     `com.atproto.repo.*` calls to pre-registered handlers.
 *     Tracks call history so tests can assert "the client
 *     invoked createSession once with handle=X".
 *   - **MockPlcTransport** — `resolveDid` lookups backed by a DID
 *     → doc map.
 *   - **MockAppViewTransport** — `com.dina.*` xRPC calls backed
 *     by method-keyed handler map.
 *
 * **Pattern**: each mock produces a fetcher function that matches
 * the shape the real client consumes. The test wires the mock into
 * the client + asserts on request history + controls response
 * bodies.
 *
 * **Deterministic state**: the mocks are purely in-memory; no
 * timers, no random. Same inputs → same outputs. Tests can snapshot
 * the request history as a stable record.
 *
 * **Not a network mock** — this is in-process. If a test needs to
 * hit a real HTTP endpoint (e.g. system tests), wire a real
 * fetch-based client; this primitive is for unit + integration
 * tests that don't need the transport layer.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6g task 6.25.
 */

// ══════════════════════════════════════════════════════════════════════
// MockPdsTransport
// ══════════════════════════════════════════════════════════════════════

export type PdsMethodName =
  | 'createAccount'
  | 'createSession'
  | 'refreshSession'
  | 'deleteSession'
  | 'createRecord'
  | 'putRecord'
  | 'getRecord'
  | 'deleteRecord'
  | 'listRecords';

export interface PdsRequestCall {
  kind: PdsMethodName;
  payload: Record<string, unknown>;
  bearer?: string;
}

export interface PdsResponseSpec {
  status: number;
  body: Record<string, unknown> | null;
}

/** Handler fn that computes a response from the incoming call. */
export type PdsHandler = (call: PdsRequestCall) => PdsResponseSpec | Promise<PdsResponseSpec>;

export interface MockPdsTransportOptions {
  handlers?: Partial<Record<PdsMethodName, PdsHandler>>;
  /** Default handler when no method-specific handler is registered. */
  defaultHandler?: PdsHandler;
}

/**
 * In-memory PDS transport. Register per-method handlers, wire the
 * produced `fetchFn` into the SessionManager / RecordCrudClient.
 */
export class MockPdsTransport {
  private readonly handlers: Map<PdsMethodName, PdsHandler> = new Map();
  private readonly defaultHandler?: PdsHandler;
  private readonly _calls: PdsRequestCall[] = [];

  constructor(opts: MockPdsTransportOptions = {}) {
    if (opts.handlers) {
      for (const [k, v] of Object.entries(opts.handlers)) {
        if (v) this.handlers.set(k as PdsMethodName, v);
      }
    }
    this.defaultHandler = opts.defaultHandler;
  }

  /** Register or replace a handler. Returns the transport for chaining. */
  handle(method: PdsMethodName, handler: PdsHandler): this {
    this.handlers.set(method, handler);
    return this;
  }

  /** Convenience: register a static response for a method. */
  respond(method: PdsMethodName, spec: PdsResponseSpec): this {
    this.handlers.set(method, () => spec);
    return this;
  }

  /** Every request observed, in order. Safe to snapshot + assert on. */
  get calls(): ReadonlyArray<PdsRequestCall> {
    return this._calls;
  }

  /** Clear the call history. Does NOT reset handlers. */
  reset(): void {
    this._calls.length = 0;
  }

  /**
   * The fetch-like function the clients call. Matches the shape
   * `SessionManager`'s `PdsClientFn` and `RecordCrudClient`'s
   * `RepoClientFn` expect.
   */
  fetchFn = async (
    kind: PdsMethodName,
    payload: Record<string, unknown>,
    bearer?: string,
  ): Promise<PdsResponseSpec> => {
    const call: PdsRequestCall = { kind, payload };
    if (bearer !== undefined) call.bearer = bearer;
    this._calls.push(call);
    const handler = this.handlers.get(kind) ?? this.defaultHandler;
    if (!handler) {
      return {
        status: 501,
        body: { error: `mock PDS: no handler for ${kind}` },
      };
    }
    return handler(call);
  };
}

// ══════════════════════════════════════════════════════════════════════
// MockPlcTransport
// ══════════════════════════════════════════════════════════════════════

export interface MockPlcTransportOptions {
  /** did → doc mapping. Unknown DIDs resolve to 404. */
  docs?: Record<string, Record<string, unknown>>;
  /** Default Cache-Control for successful responses. */
  cacheControl?: string | null;
}

export interface PlcRequestCall {
  did: string;
}

export interface PlcFetchWithHeadersResult {
  body: Record<string, unknown> | null;
  cacheControl: string | null;
}

export class MockPlcTransport {
  private readonly docs: Map<string, Record<string, unknown>> = new Map();
  private readonly defaultCacheControl: string | null;
  private readonly _calls: PlcRequestCall[] = [];

  constructor(opts: MockPlcTransportOptions = {}) {
    if (opts.docs) {
      for (const [did, doc] of Object.entries(opts.docs)) {
        this.docs.set(did, doc);
      }
    }
    this.defaultCacheControl = opts.cacheControl ?? null;
  }

  /** Register a doc for a DID. Returns the transport for chaining. */
  setDoc(did: string, doc: Record<string, unknown>): this {
    this.docs.set(did, doc);
    return this;
  }

  /** Remove a DID's doc (makes subsequent lookups return 404). */
  removeDoc(did: string): this {
    this.docs.delete(did);
    return this;
  }

  get calls(): ReadonlyArray<PlcRequestCall> {
    return this._calls;
  }

  reset(): void {
    this._calls.length = 0;
  }

  /**
   * Fetcher matching `FetchWithHeadersFn` from
   * `CachingPlcResolver` (6.10).
   */
  fetchFn = async (did: string): Promise<PlcFetchWithHeadersResult> => {
    this._calls.push({ did });
    const doc = this.docs.get(did);
    if (doc === undefined) {
      return { body: null, cacheControl: null };
    }
    return { body: doc, cacheControl: this.defaultCacheControl };
  };

  /**
   * Simpler fetcher matching `PlcFetchFn` from `plc_resolver.ts`
   * (6.6). Returns the raw body on 200 / null on 404.
   */
  plainFetchFn = async (did: string): Promise<Record<string, unknown> | null> => {
    this._calls.push({ did });
    return this.docs.get(did) ?? null;
  };
}

// ══════════════════════════════════════════════════════════════════════
// MockAppViewTransport
// ══════════════════════════════════════════════════════════════════════

export type AppViewMethodName =
  | 'trust.resolve'
  | 'service.search'
  | 'service.getProfile'
  | 'contact.resolve'
  | 'review.list';

export interface AppViewRequestCall {
  method: AppViewMethodName;
  input: unknown;
}

export interface AppViewResponseSpec {
  status: number;
  body: Record<string, unknown> | null;
}

export type AppViewHandler = (
  call: AppViewRequestCall,
) => AppViewResponseSpec | Promise<AppViewResponseSpec>;

export interface MockAppViewTransportOptions {
  handlers?: Partial<Record<AppViewMethodName, AppViewHandler>>;
  defaultHandler?: AppViewHandler;
}

export class MockAppViewTransport {
  private readonly handlers: Map<AppViewMethodName, AppViewHandler> = new Map();
  private readonly defaultHandler?: AppViewHandler;
  private readonly _calls: AppViewRequestCall[] = [];

  constructor(opts: MockAppViewTransportOptions = {}) {
    if (opts.handlers) {
      for (const [k, v] of Object.entries(opts.handlers)) {
        if (v) this.handlers.set(k as AppViewMethodName, v);
      }
    }
    this.defaultHandler = opts.defaultHandler;
  }

  handle(method: AppViewMethodName, handler: AppViewHandler): this {
    this.handlers.set(method, handler);
    return this;
  }

  respond(method: AppViewMethodName, spec: AppViewResponseSpec): this {
    this.handlers.set(method, () => spec);
    return this;
  }

  get calls(): ReadonlyArray<AppViewRequestCall> {
    return this._calls;
  }

  reset(): void {
    this._calls.length = 0;
  }

  /**
   * Generic dispatch helper — each xRPC client's fetcher receives
   * the method name baked in; this returns a bound fetchFn.
   *
   * Pattern: `const trustResolve = mock.fetcher('trust.resolve')`
   * + hand `trustResolve` to `createTrustResolveClient({fetchFn: trustResolve})`.
   */
  fetcher(method: AppViewMethodName): (input: unknown) => Promise<AppViewResponseSpec> {
    return async (input: unknown) => {
      this._calls.push({ method, input });
      const handler = this.handlers.get(method) ?? this.defaultHandler;
      if (!handler) {
        return {
          status: 501,
          body: { error: `mock AppView: no handler for ${method}` },
        };
      }
      return handler({ method, input });
    };
  }
}
