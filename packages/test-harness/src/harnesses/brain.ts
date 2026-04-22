/**
 * Brain HTTP test harness — boots a REAL HTTP server on localhost.
 *
 * Wires up a minimal Brain server with injectable mock or real deps.
 * Auth uses Ed25519 signature validation (same as Core — no fake headers).
 *
 * Usage:
 *   const harness = await BrainTestHarness.create();
 *   const res = await harness.processEvent({ type: 'reminder_fired', ... });
 *   expect(res.status).toBe(200);
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
import type { RequestSigner } from './core';

// ---------------------------------------------------------------------------
// Auth middleware (same pattern as Core — Ed25519 only)
// ---------------------------------------------------------------------------

const PUBLIC_PATHS = new Set(['/healthz']);

function brainAuthMiddleware(validator: SignatureValidator): Middleware {
  return async (req: ParsedRequest, next: () => Promise<RouteResponse>): Promise<RouteResponse> => {
    if (PUBLIC_PATHS.has(req.path)) return next();

    const did = req.headers['x-did'];
    const timestamp = req.headers['x-timestamp'];
    const nonce = req.headers['x-nonce'];
    const signature = req.headers['x-signature'];

    if (!did || !timestamp || !nonce || !signature) {
      return { status: 401, body: { error: 'missing auth headers' } };
    }

    try {
      validator.verifySignature(
        did,
        req.method,
        req.path,
        req.query,
        timestamp,
        nonce,
        req.body,
        signature,
      );
    } catch {
      return { status: 401, body: { error: 'invalid signature' } };
    }

    return next();
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type BrainRouteRegistrar = (
  router: Router,
  state: { processedEvents: unknown[]; reasonQueries: string[] },
) => void;

export interface BrainTestHarnessConfig {
  /** Injected Ed25519 signature validator. Default: MockSignatureValidator. */
  signatureValidator?: SignatureValidator;
  /** Injected request signer for authenticated test requests. */
  requestSigner?: RequestSigner;
  /** Core service DID (for asCoreService requests). */
  coreDID?: string;
  /** Core service private key. */
  corePrivateKey?: Uint8Array;
  /** UI device DID (for asUIDevice requests). */
  uiDeviceDID?: string;
  /** UI device private key. */
  uiDevicePrivateKey?: Uint8Array;
  /** Mock LLM response — returned by /v1/reason (stub mode only). */
  llmResponse?: { answer: string; sources: string[] };
  /**
   * Custom route registrar. If provided, replaces the built-in stub routes.
   * Use to wire real Brain services when they exist.
   */
  routeRegistrar?: BrainRouteRegistrar;
}

export type BrainCallerRole = 'core' | 'ui-device' | 'anonymous';

export interface BrainRequestOptions {
  as?: BrainCallerRole;
  headers?: Record<string, string>;
}

export interface BrainTestResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  raw: string;
}

// ---------------------------------------------------------------------------
// Brain Test Harness
// ---------------------------------------------------------------------------

export class BrainTestHarness {
  private httpServer: TestHTTPServer;
  private config: BrainTestHarnessConfig;

  /** Tracks all /v1/process calls for assertion. */
  public processedEvents: unknown[] = [];
  /** Tracks all /v1/reason calls for assertion. */
  public reasonQueries: string[] = [];

  public readonly signatureValidator: SignatureValidator;

  private constructor(
    httpServer: TestHTTPServer,
    config: BrainTestHarnessConfig,
    validator: SignatureValidator,
  ) {
    this.httpServer = httpServer;
    this.config = config;
    this.signatureValidator = validator;
  }

  static async create(config?: BrainTestHarnessConfig): Promise<BrainTestHarness> {
    const cfg = config ?? {};
    const validator = cfg.signatureValidator ?? new MockSignatureValidator();
    const llmResponse = cfg.llmResponse ?? { answer: 'mock answer', sources: [] };

    const router = new Router();
    router.use(brainAuthMiddleware(validator));

    const processedEvents: unknown[] = [];
    const reasonQueries: string[] = [];

    if (cfg.routeRegistrar) {
      cfg.routeRegistrar(router, { processedEvents, reasonQueries });
    } else {
      // Built-in STUB routes — verify HTTP/auth plumbing only.
      // Replace via config.routeRegistrar with real Brain services.
      registerBrainStubRoutes(router, { processedEvents, reasonQueries }, llmResponse);
    }

    const httpServer = new TestHTTPServer(router);
    await httpServer.start();

    const harness = new BrainTestHarness(httpServer, cfg, validator);
    harness.processedEvents = processedEvents;
    harness.reasonQueries = reasonQueries;
    return harness;
  }

  get baseURL(): string {
    return this.httpServer.baseURL;
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    options?: BrainRequestOptions,
  ): Promise<BrainTestResponse> {
    const url = new URL(path, this.baseURL);
    const bodyStr = body ? JSON.stringify(body) : '';
    const bodyBytes = new TextEncoder().encode(bodyStr);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const role = options?.as ?? 'anonymous';
    if (role !== 'anonymous') {
      // Look up keys for this role
      let did: string | undefined;
      let privateKey: Uint8Array | undefined;

      if (role === 'core' && this.config.coreDID && this.config.corePrivateKey) {
        did = this.config.coreDID;
        privateKey = this.config.corePrivateKey;
      } else if (
        role === 'ui-device' &&
        this.config.uiDeviceDID &&
        this.config.uiDevicePrivateKey
      ) {
        did = this.config.uiDeviceDID;
        privateKey = this.config.uiDevicePrivateKey;
      }

      if (did && privateKey && this.config.requestSigner) {
        // Real Ed25519 signing
        const authHeaders = await this.config.requestSigner(
          method,
          path,
          '',
          bodyBytes,
          privateKey,
          did,
        );
        Object.assign(headers, authHeaders);
      } else {
        // No real signer or no keys — inject minimal headers for MockSignatureValidator.
        // Same fallback pattern as Core harness.
        headers['X-DID'] =
          did ?? (role === 'core' ? 'did:key:z6MkCoreService' : 'did:key:z6MkUIDevice');
        headers['X-Timestamp'] = new Date().toISOString();
        headers['X-Nonce'] = Math.random().toString(36).substring(2);
        headers['X-Signature'] = 'mock-signature';
      }
    }

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

  // Convenience methods
  async processEvent(event: Record<string, unknown>): Promise<BrainTestResponse> {
    return this.request('POST', '/v1/process', event, { as: 'core' });
  }

  async reason(query: string): Promise<BrainTestResponse> {
    return this.request('POST', '/v1/reason', { prompt: query }, { as: 'core' });
  }

  async teardown(): Promise<void> {
    await this.httpServer.stop();
  }
}

// ---------------------------------------------------------------------------
// Built-in stub routes (no real Brain services)
// ---------------------------------------------------------------------------

function registerBrainStubRoutes(
  router: Router,
  state: { processedEvents: unknown[]; reasonQueries: string[] },
  llmResponse: { answer: string; sources: string[] },
): void {
  router.get('/healthz', async () => ({
    status: 200,
    body: { status: 'ok', components: { llm: 'available', core: 'reachable' } },
  }));

  router.post('/v1/process', async (req) => {
    state.processedEvents.push(req.bodyJSON);
    return { status: 200, body: { processed: true } };
  });

  router.post('/v1/reason', async (req) => {
    const body = req.bodyJSON as Record<string, unknown> | undefined;
    const prompt = (body?.prompt as string) ?? '';
    state.reasonQueries.push(prompt);
    return { status: 200, body: llmResponse };
  });

  router.post('/v1/pii/scrub', async (req) => {
    const body = req.bodyJSON as Record<string, unknown> | undefined;
    return { status: 200, body: { scrubbed: body?.text ?? '', entities: [] } };
  });
}
