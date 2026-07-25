import type { AgentFacadeHandler } from '@dina/core';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_MATCHES = 20;

export interface HttpServiceSearchHandlerOptions {
  brainUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function pickSearchBody(body: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of ['intent', 'capability', 'q', 'lat', 'lng', 'radius_km', 'limit']) {
    if (body[key] !== undefined) picked[key] = body[key];
  }
  return picked;
}

function sanitizeResponse(
  value: unknown,
): { matches: unknown[]; capability_candidates: unknown[] } | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.matches) || body.matches.length > MAX_MATCHES) return null;
  if (!Array.isArray(body.capability_candidates) || body.capability_candidates.length > 5) {
    return null;
  }
  for (const match of body.matches) {
    if (!match || typeof match !== 'object') return null;
    const row = match as Record<string, unknown>;
    if (typeof row.capability !== 'string' || row.capability === '') return null;
    if (!row.service || typeof row.service !== 'object') return null;
    const service = row.service as Record<string, unknown>;
    if (
      typeof service.did !== 'string' ||
      !service.did.startsWith('did:') ||
      typeof service.name !== 'string' ||
      !Array.isArray(service.capabilities) ||
      !service.capabilities.every((cap) => typeof cap === 'string')
    ) {
      return null;
    }
  }
  return {
    matches: body.matches,
    capability_candidates: body.capability_candidates,
  };
}

/**
 * Core-side adapter for Brain-owned AppView search. The plugin reaches only
 * signed Core; this local hop carries a bounded DTO and validates the result.
 */
export function makeHttpServiceSearchHandler(
  options: HttpServiceSearchHandlerOptions,
): AgentFacadeHandler {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.brainUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (ctx) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}/api/v1/internal/service/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pickSearchBody(ctx.body)),
        signal: controller.signal,
      });
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        return { status: 502, body: { error: 'service directory response exceeded the size limit' } };
      }
      let body: unknown;
      try {
        body = text === '' ? {} : (JSON.parse(text) as unknown);
      } catch {
        return { status: 502, body: { error: 'service directory returned malformed JSON' } };
      }
      if (!response.ok) {
        return {
          status: response.status >= 500 ? 503 : response.status,
          body:
            body && typeof body === 'object'
              ? body
              : { error: 'service directory request failed' },
        };
      }
      const safe = sanitizeResponse(body);
      if (safe === null) {
        return { status: 502, body: { error: 'service directory returned an invalid response' } };
      }
      return { status: 200, body: safe };
    } catch {
      return { status: 503, body: { error: 'service directory unavailable' } };
    } finally {
      clearTimeout(timeout);
    }
  };
}
