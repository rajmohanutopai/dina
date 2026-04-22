/**
 * Task 4.15 — JSON Schema declarations for route body / query / params /
 * response validation.
 *
 * Fastify's built-in AJV instance validates against these schemas before
 * the handler runs (body rejects with 400 via our 4.8 error envelope).
 * Types flow from `@dina/protocol/gen/core-api.d.ts` (the OpenAPI-derived
 * types) — this file doesn't re-derive them; it only provides **runtime**
 * JSON Schemas since .d.ts types vanish at compile time.
 *
 * **Reusable components.** Every Dina route that takes a DID / timestamp
 * / nonce uses the same shape — defining them once means a protocol-
 * level shape change updates every consumer. Each schema is a plain
 * JSON Schema object (Fastify + AJV's native format), no TypeBox
 * dependency. A future refactor can swap to `@sinclair/typebox` for
 * derived TypeScript types if route-handler type inference becomes
 * pain-ful enough to justify the dep.
 *
 * **Fail-loud convention.** Every schema that validates body is
 * `additionalProperties: false` — the client must not silently submit
 * keys the server doesn't understand, which prevents typos turning into
 * silently-ignored fields (e.g. `persoan: 'health'` ignored → request
 * hits the wrong persona). Validation errors land in the 4.8 envelope
 * as 400.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4b task 4.15.
 */

// ---------------------------------------------------------------------------
// Shared leaf schemas
// ---------------------------------------------------------------------------

/** `did:<method>:<id>` — string matching Dina's DID syntax. */
export const DID_SCHEMA = {
  type: 'string',
  pattern: '^did:[a-z0-9]+:.+',
  minLength: 7, // `did:x:y` minimum length
} as const;

/** RFC3339 timestamp OR epoch-ms string. Validator accepts either —
 *  per-shape check happens in `validateTimestamp` (task 4.22) downstream. */
export const TIMESTAMP_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
} as const;

/** 32 lowercase hex chars (16 random bytes). */
export const NONCE_SCHEMA = {
  type: 'string',
  pattern: '^[0-9a-f]{32}$',
} as const;

/** 128 lowercase hex chars (64-byte Ed25519 signature). */
export const SIGNATURE_SCHEMA = {
  type: 'string',
  pattern: '^[0-9a-f]{128}$',
} as const;

/** Persona name — short alphanumeric-with-underscore identifier. */
export const PERSONA_SCHEMA = {
  type: 'string',
  pattern: '^[a-z][a-z0-9_]{0,63}$',
} as const;

// ---------------------------------------------------------------------------
// Response envelopes
// ---------------------------------------------------------------------------

/** Canonical error envelope — matches task 4.18's `{error: string}` shape. */
export const ERROR_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: { type: 'string', minLength: 1 },
  },
} as const;

/** Healthz body — status + version. */
export const HEALTHZ_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'version'],
  properties: {
    status: { type: 'string', const: 'ok' },
    version: { type: 'string', minLength: 1 },
  },
} as const;

// ---------------------------------------------------------------------------
// Representative request schemas
// ---------------------------------------------------------------------------
//
// The full set of per-route request schemas lands as handlers are wired
// from @dina/core's CoreRouter (task 4.13). These examples document the
// canonical pattern every route should follow.

/** POST /v1/vault/store body shape. */
export const VAULT_STORE_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['persona', 'type'],
  properties: {
    persona: PERSONA_SCHEMA,
    type: { type: 'string', minLength: 1, maxLength: 64 },
    // `content` is intentionally `unknown` (schema `true`) — it's
    // free-form per VaultItemInput; handlers can narrow if needed.
    content: {},
    source: { type: 'string', maxLength: 128 },
  },
} as const;

/** POST /v1/vault/query body shape. */
export const VAULT_QUERY_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['persona'],
  properties: {
    persona: PERSONA_SCHEMA,
    q: { type: 'string', maxLength: 1024 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
  },
} as const;

// ---------------------------------------------------------------------------
// Helper — consistent schema-declaration shape for Fastify routes
// ---------------------------------------------------------------------------

export interface RouteSchema {
  body?: unknown;
  querystring?: unknown;
  params?: unknown;
  response?: Record<number, unknown>;
}

/**
 * Thin pass-through — keeps all route schemas declared via `defineRouteSchema`
 * so a future refactor (switching to TypeBox) has a single call-site to update.
 */
export function defineRouteSchema<T extends RouteSchema>(schema: T): T {
  return schema;
}
