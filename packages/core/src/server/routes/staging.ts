/**
 * Staging inbox routes — ingest / claim / resolve / fail / extend-lease.
 */

import { STAGING_ITEM_TTL_S } from '../../constants';
import { resolvePersonaName } from '../../persona/names';
import { validatePersonaName } from '../../persona/service';
import {
  ingest,
  claim,
  resolve,
  resolveMultiDetailed,
  fail,
  extendLease,
  getItem,
  OWNER_DIRECT_SOURCES,
} from '../../staging/service';

import type { CoreRouter } from '../router';

/**
 * PLG-32 #16: a resolve can't fan out to more personas than a reasonable vault
 * ever holds. Bounds the approval-card / secondary-copy blast radius of a single
 * (brain-only) resolve call.
 */
const MAX_RESOLVE_PERSONAS = 64;

/** Trim + lowercase + alias-resolve a wire persona name to its canonical form. */
function canonicalPersona(raw: string): string {
  return resolvePersonaName(raw.trim());
}

/**
 * PLG-31 #9: structural caps on an ingested `data` object. The 2 MB Fastify
 * body limit bounds raw size, but a deeply-nested / many-keyed 2 MB object still
 * drives serialization, hashing, and downstream LLM cost. Reject anything too
 * deep / wide to process cheaply.
 */
const MAX_INGEST_DEPTH = 24;
const MAX_INGEST_ARRAY = 4096;
const MAX_INGEST_KEYS = 512;
const MAX_INGEST_STRING = 128 * 1024;

function ingestDataViolation(value: unknown, depth = 0): string | null {
  if (depth > MAX_INGEST_DEPTH) return `nests deeper than ${MAX_INGEST_DEPTH} levels`;
  if (typeof value === 'string') {
    return value.length > MAX_INGEST_STRING
      ? `contains a string over ${MAX_INGEST_STRING} chars`
      : null;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_INGEST_ARRAY) return `has an array over ${MAX_INGEST_ARRAY} elements`;
    for (const v of value) {
      const bad = ingestDataViolation(v, depth + 1);
      if (bad !== null) return bad;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length > MAX_INGEST_KEYS) return `has an object with over ${MAX_INGEST_KEYS} keys`;
    for (const k of keys) {
      const bad = ingestDataViolation((value as Record<string, unknown>)[k], depth + 1);
      if (bad !== null) return bad;
    }
    return null;
  }
  return null;
}

export function registerStagingRoutes(router: CoreRouter): void {
  router.post('/v1/staging/ingest', async (req) => {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const source = requiredString(body.source, 'source');
    const sourceId = requiredString(body.source_id, 'source_id');
    if (source.kind === 'error') return { status: 400, body: { error: source.error } };
    if (sourceId.kind === 'error') return { status: 400, body: { error: sourceId.error } };

    const dataRaw = body.data;
    if (dataRaw !== undefined && !isPlainRecord(dataRaw)) {
      return { status: 400, body: { error: 'data must be an object when supplied' } };
    }
    // PLG-31 #9: structural limits on the data payload.
    if (dataRaw !== undefined) {
      const violation = ingestDataViolation(dataRaw);
      if (violation !== null) return { status: 400, body: { error: `data ${violation}` } };
    }
    // PLG-31 #1: a CONNECTOR is an external push source and must not be able to
    // claim OWNER-DIRECT provenance. `user_remember` is the owner's typed remember
    // (produced only by the brain); honoring it from a connector lets an external
    // source bypass the locked-persona approval gate. Reject an owner-direct source
    // in EITHER the `source` field OR a smuggled `data.source` (the brain drain
    // reads `data.source ?? source`) when the authenticated caller is a connector.
    const dataSource = isPlainRecord(dataRaw) ? dataRaw.source : undefined;
    const claimsOwnerDirect =
      OWNER_DIRECT_SOURCES.has(source.value) ||
      (typeof dataSource === 'string' && OWNER_DIRECT_SOURCES.has(dataSource));
    if (claimsOwnerDirect && req.callerType === 'connector') {
      return {
        status: 403,
        body: { error: 'a connector may not originate an owner-direct remember' },
      };
    }
    const producerRaw = body.producer_id;
    if (producerRaw !== undefined && typeof producerRaw !== 'string') {
      return { status: 400, body: { error: 'producer_id must be a string when supplied' } };
    }
    const expiresRaw = body.expires_at;
    if (expiresRaw !== undefined && !isFiniteNumber(expiresRaw)) {
      return { status: 400, body: { error: 'expires_at must be a finite number when supplied' } };
    }
    // PLG-31 #10: clamp caller-supplied retention to a policy window — a past
    // timestamp would drop the row on the next sweep before it drains, a far-future
    // one would defeat the TTL purge and retain it forever.
    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAt =
      expiresRaw !== undefined
        ? Math.min(Math.max(Math.floor(expiresRaw), nowSec + 60), nowSec + STAGING_ITEM_TTL_S)
        : undefined;
    // PLG-31 #1: stamp producer_id from the AUTHENTICATED caller when available —
    // immutable provenance a body value can't override. Falls back to the body for
    // the in-process (owner) path where no caller DID is attached.
    const producerId =
      typeof req.callerDID === 'string' && req.callerDID !== '' ? req.callerDID : producerRaw;

    const result = ingest({
      source: source.value,
      source_id: sourceId.value,
      ...(producerId !== undefined ? { producer_id: producerId } : {}),
      ...(dataRaw !== undefined ? { data: dataRaw } : {}),
      ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    });
    const item = getItem(result.id);
    return {
      status: result.duplicate ? 200 : 201,
      body: {
        id: result.id,
        duplicate: result.duplicate,
        status: item?.status ?? 'received',
      },
    };
  });

  router.post('/v1/staging/claim', async (req) => {
    const limit = clampInt(req.query.limit, 10, 1, 50);
    const items = claim(limit);
    return { status: 200, body: { items, count: items.length } };
  });

  router.post('/v1/staging/resolve', async (req) => {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const id = typeof body.id === 'string' ? body.id : '';
    // PLG-31 #11: validate `data` is an object like ingest does — resolve used to
    // blind-cast it, so an array/primitive could enter the classified-item path
    // and store as a garbage vault row.
    if (body.data !== undefined && !isPlainRecord(body.data)) {
      return { status: 400, body: { error: 'data must be an object when supplied' } };
    }
    // PLG-32 #15: the classified `data` becomes a PERSISTENT vault row (unlike
    // ingest's raw `data`), yet resolve only checked its shape. Apply the same
    // structural caps ingest uses so a deep/oversized classified object can't
    // bypass them into the vault + downstream embedding/FTS cost.
    if (body.data !== undefined) {
      const violation = ingestDataViolation(body.data);
      if (violation !== null) return { status: 400, body: { error: `data ${violation}` } };
    }
    const data = body.data as Record<string, unknown> | undefined;
    // GAP-MULTI-01: prefer the `personas` array when supplied (port of
    // main-dina's `staging_resolve_multi`); otherwise use the single-persona form.
    // PLG-32 #16: canonicalize each name (trim + lowercase + alias) BEFORE the
    // dedup — the PLG-31 #7 dedup used raw strings, so 'health', ' health ', and
    // 'Health' survived as three separate targets (three approval cards + copies
    // for one logical persona). Grammar-validate + cap the count at the wire
    // boundary too.
    const rawPersonas = Array.isArray(body.personas)
      ? (body.personas as unknown[]).filter(
          (p): p is string => typeof p === 'string' && p.trim() !== '',
        )
      : null;
    try {
      if (rawPersonas !== null && rawPersonas.length > 0) {
        const personas: string[] = [];
        const seen = new Set<string>();
        for (const raw of rawPersonas) {
          const name = canonicalPersona(raw);
          const invalid = validatePersonaName(name);
          if (invalid !== null) return { status: 400, body: { error: invalid } };
          if (!seen.has(name)) {
            seen.add(name);
            personas.push(name);
          }
        }
        if (personas.length > MAX_RESOLVE_PERSONAS) {
          return {
            status: 400,
            body: { error: `too many personas (max ${MAX_RESOLVE_PERSONAS})` },
          };
        }
        const accessRaw = body.persona_access;
        if (!isPlainRecord(accessRaw)) {
          return {
            status: 400,
            body: { error: 'persona_access must be an object for multi-persona resolve' },
          };
        }
        // Re-key persona_access to canonical names so a caller keying it by a
        // non-canonical spelling still matches its canonical target.
        const canonAccess = new Map<string, boolean>();
        for (const [k, v] of Object.entries(accessRaw)) {
          if (typeof v === 'boolean') canonAccess.set(canonicalPersona(k), v);
        }
        const targets: { persona: string; personaOpen: boolean }[] = [];
        for (const persona of personas) {
          const open = canonAccess.get(persona);
          if (typeof open !== 'boolean') {
            return {
              status: 400,
              body: { error: `persona_access.${persona} must be a boolean` },
            };
          }
          targets.push({ persona, personaOpen: open });
        }
        const resolved = resolveMultiDetailed(id, targets, data);
        const item = getItem(id);
        return {
          status: 200,
          body: {
            id,
            status: item?.status ?? 'unknown',
            personas,
            stored_personas: resolved.storedPersonas,
            pending_personas: resolved.pendingPersonas,
            failed_personas: resolved.failedPersonas,
          },
        };
      }
      if (typeof body.persona !== 'string' || body.persona.trim().length === 0) {
        return { status: 400, body: { error: 'persona must be a non-empty string' } };
      }
      if (typeof body.persona_open !== 'boolean') {
        return { status: 400, body: { error: 'persona_open must be a boolean' } };
      }
      const persona = canonicalPersona(body.persona);
      const invalid = validatePersonaName(persona);
      if (invalid !== null) return { status: 400, body: { error: invalid } };
      const personaOpen = body.persona_open;
      resolve(id, persona, personaOpen, data);
      const item = getItem(id);
      return { status: 200, body: { id, status: item?.status ?? 'unknown' } };
    } catch (err) {
      return { status: 400, body: { error: errMsg(err) } };
    }
  });

  router.post('/v1/staging/fail', async (req) => {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const id = typeof body.id === 'string' ? body.id : '';
    try {
      fail(id);
      const item = getItem(id);
      return { status: 200, body: { id, retry_count: item?.retry_count ?? 0 } };
    } catch (err) {
      return { status: 400, body: { error: errMsg(err) } };
    }
  });

  router.post('/v1/staging/extend-lease', async (req) => {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const id = typeof body.id === 'string' ? body.id : '';
    // PLG-31 #8: a bare `typeof === 'number'` let NaN / negative / fractional /
    // huge values through — NaN produces an unreclaimable stuck 'classifying' lease
    // (NaN < now is always false). Require a positive integer within a policy cap.
    const secondsRaw = body.seconds === undefined ? 300 : body.seconds;
    if (
      typeof secondsRaw !== 'number' ||
      !Number.isInteger(secondsRaw) ||
      secondsRaw <= 0 ||
      secondsRaw > STAGING_ITEM_TTL_S
    ) {
      return {
        status: 400,
        body: { error: `seconds must be a positive integer ≤ ${STAGING_ITEM_TTL_S}` },
      };
    }
    const seconds = secondsRaw;
    try {
      extendLease(id, seconds);
      return { status: 200, body: { id, extended_by: seconds } };
    } catch (err) {
      return { status: 400, body: { error: errMsg(err) } };
    }
  });
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requiredString(
  value: unknown,
  field: string,
): { kind: 'ok'; value: string } | { kind: 'error'; error: string } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { kind: 'error', error: `${field} must be a non-empty string` };
  }
  return { kind: 'ok', value: value.trim() };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
