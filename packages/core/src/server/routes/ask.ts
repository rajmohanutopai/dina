/**
 * `/api/v1/ask` routes for the CoreRouter.
 *
 * Thin glue between inbound agent requests (via MsgBox RPC bridge)
 * and the Brain-owned ask coordinator. Core owns the HTTP surface;
 * Brain owns the ask lifecycle. Dependency inversion: Core defines
 * the callback interface; boot wiring satisfies it with the Brain
 * coordinator via `setAskRouteHandler`.
 *
 * Routes:
 *   POST /api/v1/ask              → submit (fast-path 200 or async 202)
 *   GET  /api/v1/ask/:id/status   → poll
 *
 * Wire contract matches the brain-server's `registerAskRoutes` in
 * `apps/home-node-lite/brain-server/src/routes/ask.ts` so the CLI's
 * `dina ask` + poll loop works against both paths without modification.
 *
 * Source: MT-38 (OpenClaw locked-vault data request with approval resume).
 */

import type { CoreRouter } from '../router';
import { API_ASK } from './paths';

// ---------------------------------------------------------------------------
// Injectable handler contracts — Core defines; Brain satisfies
// ---------------------------------------------------------------------------

export interface AskSubmitInput {
  question: string;
  requesterDid: string;
  requestIdHeader?: string | null;
  /**
   * Dina-agent CLI session id (`sess-...`) from the `X-Session`
   * header. Used by the per-ask persona_guard to scope vault-read
   * session approvals to a single CLI session — `dina session start`
   * mints a fresh id and old grants are dropped.
   */
  sessionId?: string;
  ttlMs?: number;
}

/**
 * Minimal ask submit/status contract that Core accepts.
 * The Brain's `AskCoordinator` satisfies this interface structurally.
 */
export interface AskRouteHandler {
  handleAsk(req: AskSubmitInput): Promise<{ status: number; body: unknown }>;
  handleStatus(id: string): Promise<{ status: number; body: unknown }>;
}

export interface AskRouteOptions {
  handler?: AskRouteHandler;
}

// ---------------------------------------------------------------------------
// Module-level singleton — matches the setServiceQuerySender pattern so
// the handler can be installed after the router is created at boot.
// ---------------------------------------------------------------------------

let handlerInstance: AskRouteHandler | null = null;

export function setAskRouteHandler(h: AskRouteHandler | null): void {
  handlerInstance = h;
}

export function getAskRouteHandler(): AskRouteHandler | null {
  return handlerInstance;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAskRoutes(router: CoreRouter, options: AskRouteOptions = {}): void {
  // POST /api/v1/ask — submit
  router.post(API_ASK, async (req) => {
    const handler = options.handler ?? handlerInstance;
    if (!handler) {
      return { status: 503, body: { error: 'ask handler not configured' } };
    }
    const body = req.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { status: 400, body: { error: 'body must be a JSON object' } };
    }
    // Accept either 'question' (canonical) or 'prompt' (dina-agent CLI compat).
    const question =
      (typeof body.question === 'string' ? body.question.trim() : '') ||
      (typeof body.prompt === 'string' ? body.prompt.trim() : '');
    if (!question) {
      return { status: 400, body: { error: 'question must be a non-empty string' } };
    }
    // SECURITY: the requester identity is the AUTHENTICATED caller, never a
    // body field. The router verifies the signed request and resolves the
    // caller into `req.callerDID`. Trusting `body.requester_did` would let an
    // authenticated agent claim the owner's DID and bypass the
    // sensitive/locked persona approval gate — `persona_guard` treats
    // `requesterDid === ownerDid` as owner access. (The owner's own chat does
    // NOT use this route; it goes through the in-process ask command handler
    // with a server-configured owner DID.) See feedback_inner_body_not_authority.
    const requesterDid = typeof req.callerDID === 'string' ? req.callerDID.trim() : '';
    if (requesterDid === '') {
      return {
        status: 401,
        body: { error: 'unauthenticated: no caller identity resolved' },
      };
    }
    // A body `requester_did` is honoured only when it matches the
    // authenticated caller (older CLIs echo their own DID). A mismatch is an
    // impersonation attempt — reject it loudly rather than silently ignore.
    if (
      typeof body.requester_did === 'string' &&
      body.requester_did.trim() !== '' &&
      body.requester_did.trim() !== requesterDid
    ) {
      return {
        status: 403,
        body: { error: 'requester_did does not match the authenticated caller' },
      };
    }
    if (body.ttl_ms !== undefined && typeof body.ttl_ms !== 'number') {
      return { status: 400, body: { error: 'ttl_ms must be a number when supplied' } };
    }
    const requestIdHeader =
      typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : null;
    // The dina-agent CLI tags every request with `X-Session: sess-...`
    // (see client.py:ask). Threading it through the per-ask persona_guard
    // is how the session-scoped vault-read approval shortcut keys on
    // (agent, session, persona) — a new `dina session start` mints a
    // fresh id and old grants no longer match.
    const sessionId =
      typeof req.headers['x-session'] === 'string' ? req.headers['x-session'] : '';
    const input: AskSubmitInput = {
      question,
      requesterDid,
      requestIdHeader,
    };
    if (sessionId !== '') input.sessionId = sessionId;
    if (typeof body.ttl_ms === 'number') input.ttlMs = body.ttl_ms;
    const result = await handler.handleAsk(input);
    return { status: result.status, body: result.body };
  });

  // GET /api/v1/ask/:id/status — poll
  router.get(`${API_ASK}/:id/status`, async (req) => {
    const handler = options.handler ?? handlerInstance;
    if (!handler) {
      return { status: 503, body: { error: 'ask handler not configured' } };
    }
    const id = req.params.id ?? '';
    if (id === '') {
      return { status: 404, body: { error: 'not_found', request_id: '' } };
    }
    const result = await handler.handleStatus(id);
    return { status: result.status, body: result.body };
  });
}
