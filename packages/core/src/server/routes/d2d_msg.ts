/**
 * D2D messaging — POST /v1/msg/send.
 *
 * Thin authenticated wrapper over a caller-supplied `D2DSender`. Brain
 * calls it for low-level D2D traffic (not the service-query pipeline,
 * which goes through /v1/service/query). createNode wires the sender
 * to the same `sendD2D` used by the Response Bridge, so egress is
 * consistent: one signed code path, one set of gates, one set of
 * audit entries — regardless of what kicked it off.
 *
 * The endpoint returns 503 when no sender is wired (test nodes that
 * never plan to emit D2D) so callers fail loudly rather than silently
 * queueing into the void.
 *
 * Issue #16.
 */

import type { CoreRouter, CoreRequest, CoreResponse } from '../router';

/** Callback that performs the actual D2D send. */
export type D2DSender = (
  recipientDID: string,
  messageType: string,
  body: Record<string, unknown>,
) => Promise<void>;

let senderInstance: D2DSender | null = null;

/** Wire the production sender at startup. Tests inject a spy. */
export function setD2DSender(sender: D2DSender | null): void {
  senderInstance = sender;
}

export function getD2DSender(): D2DSender | null {
  return senderInstance;
}

export function registerD2DMsgRoutes(router: CoreRouter): void {
  router.post('/v1/msg/send', async (req: CoreRequest): Promise<CoreResponse> => {
    const sender = senderInstance;
    if (sender === null) {
      return j(503, { error: 'D2D sender not wired' });
    }
    if (req.body === undefined || req.body === null) {
      return j(400, { error: 'empty body' });
    }
    if (typeof req.body !== 'object' || Array.isArray(req.body)) {
      return j(400, { error: 'body must be a JSON object' });
    }
    const b = req.body as Record<string, unknown>;
    const recipientDID = typeof b.recipient_did === 'string' ? b.recipient_did : '';
    const messageType = typeof b.type === 'string' ? b.type : '';
    const payload =
      b.body !== undefined && b.body !== null && typeof b.body === 'object'
        ? (b.body as Record<string, unknown>)
        : null;
    if (recipientDID === '') {
      return j(400, { error: 'recipient_did is required' });
    }
    if (messageType === '') {
      return j(400, { error: 'type is required' });
    }
    if (payload === null) {
      return j(400, { error: 'body is required and must be an object' });
    }
    try {
      await sender(recipientDID, messageType, payload);
    } catch (err) {
      return j(502, {
        error: `send failed: ${(err as Error).message ?? String(err)}`,
      });
    }
    return j(200, { ok: true });
  });
}

function j(status: number, body: unknown): CoreResponse {
  return { status, body };
}
