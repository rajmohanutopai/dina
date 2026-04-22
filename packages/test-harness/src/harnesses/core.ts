/**
 * Core HTTP test harness — boots a REAL HTTP server on localhost.
 *
 * Wires up a minimal Core server with injectable mock or real deps.
 * The server listens on an OS-assigned port, runs real auth middleware,
 * routes through real handlers, and returns real HTTP responses.
 *
 * Usage:
 *   const harness = await CoreTestHarness.create();
 *   const res = await harness.request('POST', '/v1/vault/store', body, { as: 'brain' });
 *   expect(res.status).toBe(201);
 *   await harness.teardown();
 */

import {
  Router,
  TestHTTPServer,
  type ParsedRequest,
  type RouteResponse,
  type Middleware,
} from './http-server';
import type { SignatureValidator } from '../ports';
import { MockSignatureValidator } from '../mocks';

// ---------------------------------------------------------------------------
// Auth middleware (real Ed25519 validation via injected validator)
// ---------------------------------------------------------------------------

/** Paths that bypass auth */
const PUBLIC_PATHS = new Set(['/healthz', '/readyz', '/.well-known/atproto-did']);

function authMiddleware(validator: SignatureValidator): Middleware {
  return async (req: ParsedRequest, next: () => Promise<RouteResponse>): Promise<RouteResponse> => {
    // Public paths — no auth required
    if (PUBLIC_PATHS.has(req.path)) {
      return next();
    }

    // Ed25519 signature auth
    const did = req.headers['x-did'];
    const timestamp = req.headers['x-timestamp'];
    const nonce = req.headers['x-nonce'];
    const signature = req.headers['x-signature'];

    if (!did || !timestamp || !nonce || !signature) {
      return {
        status: 401,
        body: {
          error: 'missing auth headers',
          required: ['X-DID', 'X-Timestamp', 'X-Nonce', 'X-Signature'],
        },
      };
    }

    try {
      const result = validator.verifySignature(
        did,
        req.method,
        req.path,
        req.query,
        timestamp,
        nonce,
        req.body,
        signature,
      );
      // Attach caller identity to request for handlers
      (req as ParsedRequest & { callerKind: string; callerIdentity: string }).callerKind =
        result.kind;
      (req as ParsedRequest & { callerIdentity: string }).callerIdentity = result.identity;
    } catch {
      return { status: 401, body: { error: 'invalid signature' } };
    }

    return next();
  };
}

// ---------------------------------------------------------------------------
// Request signer — builds Ed25519 signed headers for test requests
// ---------------------------------------------------------------------------

/**
 * Injected signer that produces real Ed25519 auth headers.
 * Provided by the crypto module.
 */
export type RequestSigner = (
  method: string,
  path: string,
  query: string,
  body: Uint8Array,
  privateKey: Uint8Array,
  did: string,
) => Promise<{ 'X-DID': string; 'X-Timestamp': string; 'X-Nonce': string; 'X-Signature': string }>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Route registrar function — called during harness creation to register
 * handlers on the router. Override this to wire real Core services instead
 * of the built-in stubs.
 *
 * The built-in stubs are minimal in-memory implementations that verify
 * the HTTP/auth/routing layer but NOT the real service behavior. To
 * exercise the real services, inject a custom registrar that wires real
 * VaultService, StagingService, etc.
 */
export type RouteRegistrar = (router: Router) => void;

export interface CoreTestHarnessConfig {
  /** Injected Ed25519 signature validator. Default: MockSignatureValidator (accepts all). */
  signatureValidator?: SignatureValidator;
  /** Injected request signer for authenticated test requests. */
  requestSigner?: RequestSigner;
  /**
   * Service keys — maps role name to DID + private key.
   * Used for `as: 'brain'`, `as: 'admin'`, `as: 'connector'`.
   * Example: `{ brain: { did: 'did:key:z6Mk...', privateKey: new Uint8Array(...) } }`
   */
  serviceKeys?: Record<string, { did: string; privateKey: Uint8Array }>;
  /**
   * Device keys — maps device label to DID + private key.
   * Used for `as: 'myPhone'` or any string not matching a service role.
   */
  deviceKeys?: Record<string, { did: string; privateKey: Uint8Array }>;
  /**
   * Custom route registrar. If provided, replaces the built-in stub routes.
   * Use this to wire real Core services when they exist.
   * If not provided, built-in stubs are used (in-memory, no real services).
   */
  routeRegistrar?: RouteRegistrar;
}

export interface RequestOptions {
  /**
   * Authenticate as a named caller. Looked up in serviceKeys first, then
   * deviceKeys. Common values: 'brain', 'admin', 'connector', or a device
   * label. 'anonymous' (or omitted) sends no auth headers.
   */
  as?: string;
  /** Custom headers (merged after auth headers). */
  headers?: Record<string, string>;
  /** Query string (without leading ?). */
  query?: string;
}

export interface TestResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  raw: string;
}

// ---------------------------------------------------------------------------
// Core Test Harness
// ---------------------------------------------------------------------------

export class CoreTestHarness {
  private httpServer: TestHTTPServer;
  private router: Router;
  private config: CoreTestHarnessConfig;

  /** Exposed for test assertions — the signature validator used by auth middleware. */
  public readonly signatureValidator: SignatureValidator;

  private constructor(
    httpServer: TestHTTPServer,
    router: Router,
    config: CoreTestHarnessConfig,
    validator: SignatureValidator,
  ) {
    this.httpServer = httpServer;
    this.router = router;
    this.config = config;
    this.signatureValidator = validator;
  }

  /**
   * Create and boot a Core test harness.
   *
   * Starts a real HTTP server on an OS-assigned port with real auth
   * middleware. Routes come from either:
   * - `config.routeRegistrar` (real Core services — caller-supplied)
   * - Built-in stubs (in-memory, no real services — default)
   */
  static async create(config?: CoreTestHarnessConfig): Promise<CoreTestHarness> {
    const cfg = config ?? {};
    const validator = cfg.signatureValidator ?? new MockSignatureValidator();

    const router = new Router();

    // Auth middleware — runs on every non-public request (ALWAYS real)
    router.use(authMiddleware(validator));

    if (cfg.routeRegistrar) {
      // Real services — wired by the caller
      cfg.routeRegistrar(router);
    } else {
      // Built-in STUB routes — in-memory state, no real services.
      // These verify the HTTP/auth/routing layer only.
      // Replace with real services via config.routeRegistrar.
      registerStubRoutes(router);
    }

    // Boot the server
    const httpServer = new TestHTTPServer(router);
    await httpServer.start();

    return new CoreTestHarness(httpServer, router, cfg, validator);
  }

  /**
   * Try to create a harness. Returns null if socket binding fails
   * (sandboxed environments). Use in beforeAll with a skip guard:
   *
   *   let harness: CoreTestHarness | null;
   *   beforeAll(async () => { harness = await CoreTestHarness.tryCreate(); });
   *   beforeEach(() => { if (!harness) return; }); // or use describe.skip
   */
  static async tryCreate(config?: CoreTestHarnessConfig): Promise<CoreTestHarness | null> {
    try {
      return await CoreTestHarness.create(config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('EPERM') || msg.includes('EACCES') || msg.includes('Cannot bind')) {
        return null;
      }
      throw err; // re-throw non-socket errors
    }
  }

  /** Base URL of the running server (e.g., http://127.0.0.1:34567). */
  get baseURL(): string {
    return this.httpServer.baseURL;
  }

  /**
   * Send an HTTP request to Core.
   *
   * @param as - Caller role: 'brain', 'admin', or a device DID. If the
   *   harness has a requestSigner + matching keys, real Ed25519 headers are
   *   injected. If using MockSignatureValidator (default), any headers pass.
   */
  async request(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<TestResponse> {
    const url = new URL(path, this.baseURL);
    if (options?.query) url.search = `?${options.query}`;

    const bodyStr = body ? JSON.stringify(body) : '';
    const bodyBytes = new TextEncoder().encode(bodyStr);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Auth injection
    const role = options?.as ?? 'anonymous';
    if (role !== 'anonymous') {
      // Look up keys: check serviceKeys first (brain/admin/connector), then deviceKeys
      const keyEntry = this.config.serviceKeys?.[role] ?? this.config.deviceKeys?.[role];

      if (keyEntry && this.config.requestSigner) {
        // Real Ed25519 signing
        const authHeaders = await this.config.requestSigner(
          method,
          path,
          options?.query ?? '',
          bodyBytes,
          keyEntry.privateKey,
          keyEntry.did,
        );
        Object.assign(headers, authHeaders);
      } else {
        // No real signer or no keys for this role — inject minimal headers
        // for MockSignatureValidator. Tests using real auth MUST configure
        // both requestSigner and serviceKeys/deviceKeys.
        headers['X-DID'] = keyEntry?.did ?? `did:key:z6Mk${role}`;
        headers['X-Timestamp'] = new Date().toISOString();
        headers['X-Nonce'] = Math.random().toString(36).substring(2);
        headers['X-Signature'] = 'mock-signature';
      }
    }

    // Merge custom headers last (override auth if needed)
    if (options?.headers) Object.assign(headers, options.headers);

    const res = await fetch(url.toString(), {
      method,
      headers,
      body: bodyStr || undefined,
    });

    const raw = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }

    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });

    return { status: res.status, headers: responseHeaders, body: parsed, raw };
  }

  // -------------------------------------------------------------------------
  // Convenience methods — use factories for defaults
  // -------------------------------------------------------------------------

  /** POST /v1/staging/ingest as Brain */
  async ingestItem(overrides: Record<string, unknown> = {}): Promise<TestResponse> {
    const { makeStagingItem } = await import('../factories');
    const item = makeStagingItem(overrides as never);
    return this.request('POST', '/v1/staging/ingest', item, { as: 'brain' });
  }

  /** POST /v1/staging/claim as Brain */
  async claimItems(limit = 10): Promise<TestResponse> {
    return this.request('POST', '/v1/staging/claim', null, {
      as: 'brain',
      query: `limit=${limit}`,
    });
  }

  /** POST /v1/vault/store as Brain */
  async storeVaultItem(
    persona: string,
    overrides: Record<string, unknown> = {},
  ): Promise<TestResponse> {
    const { makeVaultItem } = await import('../factories');
    const item = makeVaultItem(overrides as never);
    return this.request('POST', '/v1/vault/store', { persona, item }, { as: 'brain' });
  }

  /** POST /v1/vault/query as Brain */
  async queryVault(persona: string, text: string, limit = 20): Promise<TestResponse> {
    return this.request(
      'POST',
      '/v1/vault/query',
      { persona, mode: 'fts5', text, limit },
      { as: 'brain' },
    );
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Stop the server and clean up. */
  async teardown(): Promise<void> {
    await this.httpServer.stop();
  }
}

// ---------------------------------------------------------------------------
// Built-in stub routes (in-memory, no real services)
//
// These exist ONLY so the harness can boot and serve requests before real
// Core services are implemented. They verify HTTP plumbing and auth, not
// business logic. Replace by passing config.routeRegistrar with real
// service wiring when available.
// ---------------------------------------------------------------------------

function registerStubRoutes(router: Router): void {
  const vaultItems = new Map<string, unknown>();
  const stagingItems: Array<Record<string, unknown>> = [];

  router.get('/healthz', async () => ({ status: 200, body: { status: 'ok' } }));
  router.get('/readyz', async () => ({ status: 200, body: { status: 'ready' } }));

  router.post('/v1/vault/store', async (req) => {
    const body = req.bodyJSON as Record<string, unknown> | undefined;
    if (!body?.persona || !body?.item) {
      return { status: 400, body: { error: 'missing persona or item' } };
    }
    const item = body.item as Record<string, unknown>;
    const id = (item.id as string) ?? `vi-${++stubSeq}`;
    vaultItems.set(id, { ...item, id });
    return { status: 201, body: { id } };
  });

  router.post('/v1/vault/query', async (req) => {
    const body = req.bodyJSON as Record<string, unknown> | undefined;
    const text = (body?.text as string) ?? '';
    const limit = (body?.limit as number) ?? 20;
    const results = Array.from(vaultItems.values())
      .filter(
        (item: any) =>
          item.summary?.toLowerCase().includes(text.toLowerCase()) ||
          item.body?.toLowerCase().includes(text.toLowerCase()),
      )
      .slice(0, limit);
    return { status: 200, body: { items: results } };
  });

  router.post('/v1/staging/ingest', async (req) => {
    const body = req.bodyJSON as Record<string, unknown> | undefined;
    const id = `stg-${++stubSeq}`;
    stagingItems.push({ ...body, id, status: 'received' });
    return { status: 201, body: { id, status: 'received' } };
  });

  router.post('/v1/staging/claim', async (req) => {
    const limitStr = req.query.split('limit=')[1];
    const limit = limitStr ? parseInt(limitStr, 10) : 10;
    const now = Math.floor(Date.now() / 1000);
    const claimed = stagingItems
      .filter((item) => item.status === 'received')
      .slice(0, limit)
      .map((item) => {
        item.status = 'classifying';
        item.lease_until = now + 900;
        return item;
      });
    return { status: 200, body: claimed };
  });

  router.get('/v1/approvals', async () => {
    return { status: 200, body: { approvals: [] } };
  });

  router.post('/v1/pii/scrub', async (req) => {
    const body = req.bodyJSON as Record<string, unknown> | undefined;
    return { status: 200, body: { scrubbed: body?.text ?? '', entities: [] } };
  });
}

let stubSeq = 0;
