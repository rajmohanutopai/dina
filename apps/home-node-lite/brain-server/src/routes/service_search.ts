import { AppViewError, type AppViewClient, type ServiceProfile } from '@dina/brain';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const MAX_INTENT_CHARS = 500;
const MAX_CAPABILITY_CHARS = 200;
const MAX_QUERY_CHARS = 500;
const MAX_RESULTS = 20;
const MAX_CAPABILITY_CANDIDATES = 5;

interface SearchBody {
  intent?: unknown;
  capability?: unknown;
  q?: unknown;
  lat?: unknown;
  lng?: unknown;
  radius_km?: unknown;
  limit?: unknown;
}

export interface RegisterServiceSearchRoutesOptions {
  appView: Pick<AppViewClient, 'searchCapabilities' | 'searchServices'>;
  prefix?: string;
}

interface ServiceMatch {
  capability: string;
  service: ServiceProfile;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function validateBody(
  body: SearchBody,
):
  | {
      ok: true;
      input: {
        intent?: string;
        capability?: string;
        q?: string;
        lat?: number;
        lng?: number;
        radiusKm?: number;
        limit: number;
      };
    }
  | { ok: false; error: string } {
  const intent = typeof body.intent === 'string' ? body.intent.trim() : '';
  const capability = typeof body.capability === 'string' ? body.capability.trim() : '';
  if ((intent === '') === (capability === '')) {
    return { ok: false, error: 'provide exactly one of intent or capability' };
  }
  if (intent.length > MAX_INTENT_CHARS) {
    return { ok: false, error: `intent exceeds ${MAX_INTENT_CHARS} characters` };
  }
  if (capability.length > MAX_CAPABILITY_CHARS) {
    return { ok: false, error: `capability exceeds ${MAX_CAPABILITY_CHARS} characters` };
  }
  const q = typeof body.q === 'string' ? body.q.trim() : '';
  if (q.length > MAX_QUERY_CHARS) {
    return { ok: false, error: `q exceeds ${MAX_QUERY_CHARS} characters` };
  }
  const lat = finiteNumber(body.lat);
  const lng = finiteNumber(body.lng);
  if ((lat === undefined) !== (lng === undefined)) {
    return { ok: false, error: 'lat and lng must be supplied together' };
  }
  if (lat !== undefined && (lat < -90 || lat > 90)) {
    return { ok: false, error: 'lat must be between -90 and 90' };
  }
  if (lng !== undefined && (lng < -180 || lng > 180)) {
    return { ok: false, error: 'lng must be between -180 and 180' };
  }
  const radiusKm = finiteNumber(body.radius_km);
  if (body.radius_km !== undefined && (radiusKm === undefined || radiusKm <= 0 || radiusKm > 500)) {
    return { ok: false, error: 'radius_km must be greater than 0 and at most 500' };
  }
  const rawLimit = finiteNumber(body.limit);
  if (
    body.limit !== undefined &&
    (rawLimit === undefined || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_RESULTS)
  ) {
    return { ok: false, error: `limit must be an integer from 1 to ${MAX_RESULTS}` };
  }
  return {
    ok: true,
    input: {
      ...(intent !== '' ? { intent } : {}),
      ...(capability !== '' ? { capability } : {}),
      ...(q !== '' ? { q } : {}),
      ...(lat !== undefined ? { lat } : {}),
      ...(lng !== undefined ? { lng } : {}),
      ...(radiusKm !== undefined ? { radiusKm } : {}),
      limit: rawLimit ?? 10,
    },
  };
}

/**
 * Internal, bounded AppView adapter. Core authenticates the coding agent and
 * forwards only this DTO; the plugin never talks to Brain or AppView directly.
 */
export function registerServiceSearchRoutes(
  app: FastifyInstance,
  options: RegisterServiceSearchRoutesOptions,
): void {
  const prefix = options.prefix ?? '/api/v1/internal';
  app.post(
    `${prefix}/service/search`,
    async (req: FastifyRequest<{ Body: SearchBody }>, reply: FastifyReply) => {
      const parsed = validateBody(req.body ?? {});
      if (!parsed.ok) return reply.status(400).send({ error: parsed.error });
      const input = parsed.input;
      try {
        const capabilities =
          input.capability !== undefined
            ? [
                {
                  canonical: input.capability,
                  description: '',
                  domain: '',
                },
              ]
            : (
                await options.appView.searchCapabilities({
                  intent: input.intent!,
                  ...(input.lat !== undefined ? { lat: input.lat } : {}),
                  ...(input.lng !== undefined ? { lng: input.lng } : {}),
                })
              ).slice(0, MAX_CAPABILITY_CANDIDATES);

        const matches: ServiceMatch[] = [];
        const seen = new Set<string>();
        for (const candidate of capabilities) {
          if (matches.length >= input.limit) break;
          const services = await options.appView.searchServices({
            capability: candidate.canonical,
            ...(input.q !== undefined ? { q: input.q } : {}),
            ...(input.lat !== undefined ? { lat: input.lat } : {}),
            ...(input.lng !== undefined ? { lng: input.lng } : {}),
            ...(input.radiusKm !== undefined ? { radiusKm: input.radiusKm } : {}),
            limit: Math.min(input.limit, MAX_RESULTS),
          });
          for (const service of services) {
            const key = `${candidate.canonical}\u0000${service.uri ?? service.did}`;
            if (seen.has(key)) continue;
            seen.add(key);
            matches.push({ capability: candidate.canonical, service });
            if (matches.length >= input.limit) break;
          }
        }
        return reply.status(200).send({
          matches,
          capability_candidates: capabilities,
        });
      } catch (error) {
        const status =
          error instanceof AppViewError && error.status !== null && error.status < 500
            ? 502
            : 503;
        return reply.status(status).send({ error: 'service directory unavailable' });
      }
    },
  );
}
