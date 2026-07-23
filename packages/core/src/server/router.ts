/**
 * Transport-agnostic routing core for Dina Core.
 *
 * Motivation: Core's HTTP handlers historically lived inside Express,
 * which coupled routing to Node's http.Server. On mobile (RN, Hermes),
 * there is no http.Server; the phone needs Core's signed-request
 * contract to be reachable via direct function call. Rather than shim a
 * fake Express req/res in JS, we lift routing out of Express entirely:
 *
 *   handleCoreRequest: (CoreRequest) => Promise<CoreResponse>
 *
 * is the pure contract. Express becomes one adapter among several
 * (in-process, MsgBox RPC, etc.) that translates its transport-specific
 * shape into CoreRequest and back.
 *
 * The router:
 *   - Holds a registry of `(method, path pattern) → handler` tuples.
 *   - Path patterns support literal segments + single `:param` captures
 *     (`/v1/workflow/tasks/:id/heartbeat`). No regex; no fancy glob; no
 *     query-string-in-path. Anything exotic belongs in the handler.
 *   - Runs the Ed25519 + nonce + rate-limit + authz pipeline (reusing
 *     the existing `authenticateRequest`) before dispatching, unless
 *     the handler is registered with `auth: 'public'`.
 *   - Path params reach the handler via `req.params`.
 *   - 404 / 401 / 403 / 503 shapes are produced here so every handler
 *     can just `return { status: 200, body: ... }` for success.
 *
 * Source: this file implements the refactor proposed by
 *   DINA_ARCHITECTURE_OVERVIEW.md "transport-agnostic kernel" principle.
 */

import { authenticateRequest, type AuthRequest, type AuthResult } from '../auth/middleware';

export interface CoreRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** Path without query string, e.g. `/v1/workflow/tasks/task-42/heartbeat`. */
  path: string;
  /** Parsed query-string parameters. Values as strings (same as Express default). */
  query: Record<string, string>;
  /** Lower-case header keys. */
  headers: Record<string, string>;
  /**
   * Parsed JSON body for JSON content-types, or the raw Uint8Array for
   * binary payloads. The router only reads it when handlers need it.
   */
  body: unknown;
  /**
   * Raw request bytes. Always available — the auth layer hashes these
   * for signature verification, regardless of whether `body` was parsed.
   */
  rawBody: Uint8Array;
  /**
   * Path parameters extracted from `:param` placeholders. Populated by
   * the dispatcher right before the handler runs.
   */
  params: Record<string, string>;
  /**
   * **In-process trust marker.** When `true`, the router skips the
   * Ed25519 auth pipeline AND the rate limiter — the request is being
   * dispatched by code running in the same JS VM as Core, so:
   *
   *   - There's no network boundary to authenticate across. A
   *     compromised Brain in the same process already has the keys it
   *     would use to sign; signing gates nothing.
   *   - The rate limiter is per-DID; in-process Brain shares Core's
   *     DID, so limiting the owner against itself is meaningless.
   *
   * ONLY `InProcessTransport` sets this flag. The Fastify HTTP adapter
   * in `apps/home-node-lite/core-server` explicitly strips it from
   * every inbound request before handing to the router, so an attacker
   * can't forge the marker over the wire.
   */
  trustedInProcess?: boolean;
  /**
   * Resolved caller type after the auth pipeline runs (issues.txt §2).
   * Set by the router from the auth result for signed routes; left
   * undefined for `public` routes and in-process (owner) dispatch.
   * Handlers gate caller-type-specific enforcement on this — e.g. the
   * agent persona-access gate fires only when `callerType === 'agent'`,
   * so the owner's own app (in-process / SPA) reads every persona freely
   * while the dina-agent CLI is gated.
   */
  callerType?: string;
  /** Resolved caller DID — the agent's DID for `callerType === 'agent'`. */
  callerDID?: string;
  /**
   * Item 6b — the agent's scope (`coding` | `runner`), DERIVED server-side from
   * the authenticated device record (never a client claim). Populated by the
   * auth middleware for `callerType === 'agent'`; undefined otherwise. The new
   * scope-gated `/v1/agent/*` façades fail closed when it is missing.
   */
  agentScope?: 'coding' | 'runner';
  /**
   * The owner control-plane capability (INTERACTIVE_SERVICES §12.5, F15). A
   * boot-minted secret the app holds in an app-layer closure and stamps on every
   * owner-marked `/v1/run|watch` request. The route guard compares it to the
   * capability the router was registered with; a caller that merely sets
   * `callerType:'owner'` (a prompt-injection-steered Brain following normal code
   * paths, which has no owner client and no secret) is rejected.
   *
   * THREAT MODEL — read honestly (F15 re-review): this is DEFENSE-IN-DEPTH against
   * the realistic in-VM threat (a steered Brain), NOT a hard boundary against a
   * Brain executing arbitrary hostile JS in the shared mobile VM. Such a Brain can
   * monkeypatch `CoreRouter.prototype.handle` to skim this field off a live owner
   * request, or read the closure via the heap — and a Brain with that capability
   * can already read the vault DEKs + master seed from RAM, so the owner boundary
   * is not the meaningful control there. STRONG owner isolation is the server-split
   * deployment (Core + Brain as separate OS processes with Ed25519-signed hops).
   * See SECURITY.md. Fabricating this field without the secret is still rejected.
   */
  ownerCapability?: string;
}

export interface CoreResponse {
  status: number;
  /** Optional response headers. Router adds Content-Type automatically. */
  headers?: Record<string, string>;
  /**
   * JSON-serialisable body. `undefined` means empty response (204 is
   * the usual pairing but callers can send any status).
   */
  body?: unknown;
}

/** Per-handler authorisation mode. */
export type AuthMode =
  | 'signed' // Default: full Ed25519 + authz pipeline (authenticateRequest)
  | 'public'; // No auth (e.g. /healthz)

export type CoreHandler = (req: CoreRequest) => Promise<CoreResponse> | CoreResponse;

export interface RouteRegistration {
  method: CoreRequest['method'];
  path: string;
  handler: CoreHandler;
  /** Default: 'signed'. Set 'public' for health-check endpoints. */
  auth?: AuthMode;
}

interface CompiledRoute extends Required<RouteRegistration> {
  /** Segments split on `/`; empty leading segment ignored. */
  segments: string[];
  /** Set of segment indices that are `:param` captures. */
  paramIndices: number[];
}

export class CoreRouter {
  private readonly routes: CompiledRoute[] = [];

  register(route: RouteRegistration): this {
    if (!route.path.startsWith('/')) {
      throw new Error(`CoreRouter: path must start with '/' (got "${route.path}")`);
    }
    const compiled: CompiledRoute = {
      method: route.method,
      path: route.path,
      handler: route.handler,
      auth: route.auth ?? 'signed',
      segments: splitPath(route.path),
      paramIndices: [],
    };
    compiled.segments.forEach((seg, i) => {
      if (seg.startsWith(':')) compiled.paramIndices.push(i);
    });
    // Validate uniqueness — identical method + path is almost certainly
    // a mistake (the second registration silently wins otherwise).
    for (const r of this.routes) {
      if (r.method === compiled.method && r.path === compiled.path) {
        throw new Error(`CoreRouter: duplicate route ${route.method} ${route.path}`);
      }
    }
    this.routes.push(compiled);
    return this;
  }

  /** Convenience helpers — terser registration. */
  get(path: string, handler: CoreHandler, opts?: { auth?: AuthMode }): this {
    return this.register({ method: 'GET', path, handler, auth: opts?.auth });
  }
  post(path: string, handler: CoreHandler, opts?: { auth?: AuthMode }): this {
    return this.register({ method: 'POST', path, handler, auth: opts?.auth });
  }
  put(path: string, handler: CoreHandler, opts?: { auth?: AuthMode }): this {
    return this.register({ method: 'PUT', path, handler, auth: opts?.auth });
  }
  delete(path: string, handler: CoreHandler, opts?: { auth?: AuthMode }): this {
    return this.register({ method: 'DELETE', path, handler, auth: opts?.auth });
  }

  /** How many routes are registered. */
  size(): number {
    return this.routes.length;
  }

  /**
   * Iterate every registered route's public metadata.
   *
   * Used by Fastify-binder code in `apps/home-node-lite/core-server`
   * (task 4.13) to walk the router and register equivalent Fastify
   * routes. Returns a fresh array so callers can't mutate the
   * internal `routes` list. Handler identity is preserved so the
   * binder can invoke it via the same `CoreRouter.handle` dispatch
   * that router-internal code uses.
   */
  list(): {
    method: CoreRequest['method'];
    path: string;
    handler: CoreHandler;
    auth?: AuthMode;
  }[] {
    return this.routes.map((r) => ({
      method: r.method,
      path: r.path,
      handler: r.handler,
      ...(r.auth !== undefined ? { auth: r.auth } : {}),
    }));
  }

  /**
   * Dispatch a CoreRequest: match route → if signed, run auth → run
   * handler → normalise response. Auth happens BEFORE a full 404 so
   * that an unauthenticated probe can't distinguish "route exists" from
   * "route doesn't exist" based on 401 vs 404.
   *
   * Public routes (auth='public') skip auth entirely.
   */
  async handle(req: CoreRequest): Promise<CoreResponse> {
    const segments = splitPath(req.path);
    const match = this.match(req.method, segments);

    // Found a public route — run it without touching auth.
    if (match !== null && match.route.auth === 'public') {
      return this.runHandler(req, match.route, match.params);
    }

    // In-process dispatch bypass — `InProcessTransport` sets this flag
    // on every request because there's no network boundary to
    // authenticate across (see `CoreRequest.trustedInProcess`). The
    // Fastify HTTP adapter strips this flag on inbound HTTP requests
    // so external callers can't forge it.
    if (req.trustedInProcess === true) {
      if (match === null) {
        return jsonResponse(404, { error: `no route for ${req.method} ${req.path}` });
      }
      return this.runHandler(req, match.route, match.params);
    }

    // For every other request (matched signed route OR unknown path),
    // auth runs first so an unauthenticated probe sees a uniform 401
    // regardless of whether the path exists.
    let dispatchReq = req;
    if (this.shouldAuth(req.method, segments)) {
      const authResult = authenticateCore(req);
      if (!authResult.authenticated) {
        return authErrorResponse(authResult);
      }
      // Thread the resolved identity onto the request so handlers can
      // enforce caller-type rules (the agent persona-access gate, §2).
      // PLG-31 #1: thread the FINE-GRAINED authz role, not the coarse caller
      // type — `brain`, `admin`, and every connector all collapse to
      // `callerType:service`, so a handler that must tell a connector apart
      // from the brain (staging owner-direct gate) can only do it here. Falls
      // back to the coarse type for the impossible authzRole-less success.
      dispatchReq = {
        ...req,
        callerType: authResult.authzRole ?? authResult.callerType,
        callerDID: authResult.did,
        // Item C — the device-derived agent_scope (agent/plugin callers only),
        // so scope-gated handlers (coding façades) read a signed value.
        ...(authResult.agentScope !== undefined ? { agentScope: authResult.agentScope } : {}),
      };
    }

    if (match === null) {
      return jsonResponse(404, { error: `no route for ${req.method} ${req.path}` });
    }
    return this.runHandler(dispatchReq, match.route, match.params);
  }

  /**
   * Whether auth should run for this request. A path matching a public
   * route (regardless of method) is allowed through without auth —
   * matches Express's historical "/healthz is open" behavior.
   */
  private shouldAuth(method: CoreRequest['method'], segments: string[]): boolean {
    for (const r of this.routes) {
      if (r.auth !== 'public') continue;
      if (r.segments.length !== segments.length) continue;
      let match = true;
      for (let i = 0; i < r.segments.length; i++) {
        const pat = r.segments[i];
        if (pat.startsWith(':')) continue;
        if (pat !== segments[i]) {
          match = false;
          break;
        }
      }
      if (match && r.method === method) return false;
    }
    return true;
  }

  private async runHandler(
    req: CoreRequest,
    route: CompiledRoute,
    params: Record<string, string>,
  ): Promise<CoreResponse> {
    const enrichedReq: CoreRequest = { ...req, params: { ...req.params, ...params } };
    try {
      const resp = await route.handler(enrichedReq);
      return normalise(resp);
    } catch (err) {
      // Don't leak internal exception details to the caller — a handler bug's
      // message can carry stack / internal paths / echoed user input. Return a
      // generic 500. This RETURNS a response (rather than re-throwing) so the
      // Fastify adapter AND the in-process transport see the same masked error
      // uniformly. Log only the error CLASS server-side (PII-safe — never the
      // message, which could echo vault content / user queries).

      console.error(`[router] handler threw: ${err instanceof Error ? err.name : 'unknown'}`);
      return jsonResponse(500, { error: 'internal error' });
    }
  }

  private match(
    method: CoreRequest['method'],
    segments: string[],
  ): { route: CompiledRoute; params: Record<string, string> } | null {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      if (r.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < r.segments.length; i++) {
        const pattern = r.segments[i];
        const value = segments[i];
        if (pattern.startsWith(':')) {
          params[pattern.slice(1)] = decodeURIComponent(value);
          continue;
        }
        if (pattern !== value) {
          ok = false;
          break;
        }
      }
      if (ok) return { route: r, params };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auth adaptation — CoreRequest → AuthRequest → AuthResult
// ---------------------------------------------------------------------------

export function authenticateCore(req: CoreRequest): AuthResult {
  const queryString = serialiseQuery(req.query);
  // The auth middleware reads headers by their canonical X-* casing.
  // CoreRouter normalises incoming headers to lower-case, so re-build a
  // case-insensitive view that surfaces whichever casing the request
  // actually carried.
  const authReq: AuthRequest = {
    method: req.method,
    path: req.path,
    query: queryString,
    body: req.rawBody,
    headers: withAuthHeaderAliases(req.headers),
  };
  try {
    return authenticateRequest(authReq);
  } catch {
    // Malformed auth material (an unparseable RFC3339 timestamp, a bad-hex
    // X-Signature, etc.) must fail CLOSED as a normal rejected AuthResult —
    // never throw out of the auth layer. A throw here would escape the
    // pre-dispatch auth step (router.ts handle()) and surface as a 500 / crash
    // the MsgBox RPC handler, instead of the uniform 401 every other rejection
    // returns. Don't echo the offending value (it's attacker-controlled).
    return {
      authenticated: false,
      rejectedAt: 'signature',
      reason: 'malformed authentication material',
    };
  }
}

/**
 * Return a headers map where X-DID / X-Timestamp / X-Nonce / X-Signature
 * / X-Agent-DID are resolvable by either the lowercase or canonical
 * casing. Leaves unrelated headers alone.
 */
function withAuthHeaderAliases(headers: Record<string, string>): Record<string, string> {
  const aliases: Record<string, string> = {
    'X-DID': headers['x-did'] ?? headers['X-DID'] ?? '',
    'X-Timestamp': headers['x-timestamp'] ?? headers['X-Timestamp'] ?? '',
    'X-Nonce': headers['x-nonce'] ?? headers['X-Nonce'] ?? '',
    'X-Signature': headers['x-signature'] ?? headers['X-Signature'] ?? '',
    'X-Agent-DID': headers['x-agent-did'] ?? headers['X-Agent-DID'] ?? '',
  };
  return { ...headers, ...aliases };
}

function authErrorResponse(result: AuthResult): CoreResponse {
  const status = result.rejectedAt === 'authorization' ? 403 : 401;
  return jsonResponse(status, {
    error: result.reason ?? 'authentication failed',
    rejected_at: result.rejectedAt ?? 'unknown',
  });
}

function serialiseQuery(q: Record<string, string>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.join('&');
}

// ---------------------------------------------------------------------------
// Response normalisation
// ---------------------------------------------------------------------------

function normalise(resp: CoreResponse): CoreResponse {
  if (resp.status === undefined) {
    throw new Error('CoreResponse missing status');
  }
  return resp;
}

function jsonResponse(status: number, body: unknown): CoreResponse {
  return { status, body };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitPath(path: string): string[] {
  const cleaned = path.split('?')[0].replace(/\/+$/, '');
  return cleaned.split('/').slice(1);
}
