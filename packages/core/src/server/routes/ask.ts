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
    if (typeof body.question !== 'string' || body.question.trim() === '') {
      return { status: 400, body: { error: 'question must be a non-empty string' } };
    }
    // requesterDid is optional from the agent — fall back to the agent's DID
    // from the auth context (set in x-did header by the auth middleware).
    const requesterDid =
      typeof body.requester_did === 'string' && body.requester_did.trim() !== ''
        ? body.requester_did
        : typeof req.headers['x-did'] === 'string'
          ? req.headers['x-did']
          : '';
    if (requesterDid === '') {
      return {
        status: 400,
        body: { error: 'requester_did is required (or supply via X-DID header)' },
      };
    }
    if (body.ttl_ms !== undefined && typeof body.ttl_ms !== 'number') {
      return { status: 400, body: { error: 'ttl_ms must be a number when supplied' } };
    }
    const requestIdHeader =
      typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : null;
    const input: AskSubmitInput = {
      question: body.question,
      requesterDid,
      requestIdHeader,
    };
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
