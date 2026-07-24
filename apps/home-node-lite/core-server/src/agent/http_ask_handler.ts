/**
 * Split-node Ask bridge.
 *
 * Public agent traffic terminates at Core, where the signed caller DID and
 * live session are verified. Brain owns the one AskCoordinator implementation,
 * so Core forwards only the authenticated DTO over loopback HTTP instead of
 * duplicating reasoning state in the Core process.
 */

import type { AskRouteHandler, AskSubmitInput } from '@dina/core';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface HttpAskHandlerOptions {
  brainUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function readJsonResponse(
  response: Response,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    return { ok: false, error: 'brain response exceeded the size limit' };
  }
  if (text === '') return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: 'brain returned a malformed response' };
  }
}

export function makeHttpAskHandler(options: HttpAskHandlerOptions): AskRouteHandler {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.brainUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      const parsed = await readJsonResponse(response);
      if (!parsed.ok) return { status: 502, body: { error: parsed.error } };
      const body = parsed.body;
      if (
        !response.ok &&
        body !== null &&
        typeof body === 'object' &&
        (body as { error?: unknown }).error === undefined
      ) {
        return { status: response.status, body: { error: `brain returned ${response.status}` } };
      }
      return { status: response.status, body };
    } catch {
      return { status: 503, body: { error: 'ask brain unavailable' } };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    handleAsk(input: AskSubmitInput) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (input.requestIdHeader) headers['x-request-id'] = input.requestIdHeader;
      return call(`${base}/api/v1/ask`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          question: input.question,
          requesterDid: input.requesterDid,
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
          ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
        }),
      });
    },

    handleStatus(id: string, requesterDid?: string, sessionId?: string) {
      const query = new URLSearchParams();
      if (requesterDid !== undefined) query.set('requesterDid', requesterDid);
      if (sessionId !== undefined) query.set('sessionId', sessionId);
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return call(`${base}/api/v1/ask/${encodeURIComponent(id)}/status${suffix}`);
    },
  };
}
