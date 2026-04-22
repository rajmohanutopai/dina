/**
 * Task 4.15 — body schema validation tests.
 *
 * Proves the declared schemas are wired into Fastify's built-in AJV
 * validator and that bad bodies land in the 4.8 error envelope as 400.
 * Also covers the happy path and edge cases for each representative
 * schema.
 */

import { pino } from 'pino';
import { createServer } from '../src/server';
import {
  defineRouteSchema,
  VAULT_STORE_BODY_SCHEMA,
  VAULT_QUERY_BODY_SCHEMA,
  ERROR_RESPONSE_SCHEMA,
  HEALTHZ_RESPONSE_SCHEMA,
  DID_SCHEMA,
  NONCE_SCHEMA,
  SIGNATURE_SCHEMA,
  PERSONA_SCHEMA,
} from '../src/server/route_schemas';
import type { Logger } from '../src/logger';
import type { CoreServerConfig } from '../src/config';

function baseConfig(): CoreServerConfig {
  return {
    network: { host: '127.0.0.1', port: 0 },
    storage: { vaultDir: '/tmp/test', cachePages: 1000 },
    runtime: { logLevel: 'silent', rateLimitPerMinute: 60, prettyLogs: false },
    msgbox: {},
    cors: {},
  };
}
function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

describe('route schemas (task 4.15)', () => {
  describe('VAULT_STORE_BODY_SCHEMA wired into Fastify AJV', () => {
    async function buildApp() {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      app.post('/v1/vault/store', {
        schema: defineRouteSchema({ body: VAULT_STORE_BODY_SCHEMA }),
        handler: async (req) => ({ ok: true, echo: req.body }),
      });
      return app;
    }

    it('accepts a well-formed body', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/vault/store',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          persona: 'health',
          type: 'note',
          content: { summary: 'hi' },
          source: 'test',
        }),
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('rejects missing required field (persona)', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/vault/store',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ type: 'note' }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: expect.stringMatching(/persona/i) });
      await app.close();
    });

    it('rejects unknown additional property (typo protection)', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/vault/store',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          persoan: 'health', // typo
          type: 'note',
        }),
      });
      // `additionalProperties: false` → AJV rejects.
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('rejects invalid persona shape', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/vault/store',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          persona: 'Health-Bad!', // must be lowercase alphanum_only
          type: 'note',
        }),
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe('VAULT_QUERY_BODY_SCHEMA', () => {
    async function buildApp() {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      app.post('/v1/vault/query', {
        schema: defineRouteSchema({ body: VAULT_QUERY_BODY_SCHEMA }),
        handler: async (req) => ({ ok: true, echo: req.body }),
      });
      return app;
    }

    it('accepts persona + q + limit', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/vault/query',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ persona: 'health', q: 'hello', limit: 50 }),
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('rejects limit > 500', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/vault/query',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ persona: 'health', limit: 1000 }),
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('rejects non-integer limit', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/vault/query',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ persona: 'health', limit: 3.14 }),
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe('leaf schema patterns (validated via a dummy route)', () => {
    it.each([
      // [label, schema, valid values, invalid values]
      [
        'DID_SCHEMA',
        DID_SCHEMA,
        ['did:plc:abc', 'did:key:z6Mk123', 'did:web:example.com'],
        ['plc:abc', 'did:', '', 'did:PLC:upper'],
      ],
      [
        'NONCE_SCHEMA',
        NONCE_SCHEMA,
        ['a'.repeat(32), '0123456789abcdef'.repeat(2)],
        ['a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), 'z'.repeat(32), ''],
      ],
      [
        'SIGNATURE_SCHEMA',
        SIGNATURE_SCHEMA,
        ['f'.repeat(128)],
        ['f'.repeat(127), 'F'.repeat(128), 'g'.repeat(128), ''],
      ],
      [
        'PERSONA_SCHEMA',
        PERSONA_SCHEMA,
        ['health', 'work_log', 'a', 'persona_42'],
        ['Health', '_leading', '9leading', 'with-dash', '', 'a'.repeat(100)],
      ],
    ])('%s validates correctly', async (_label, schema, valid, invalid) => {
      const app = await createServer({ config: baseConfig(), logger: silentLogger() });
      app.post('/v', {
        schema: defineRouteSchema({
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['v'],
            properties: { v: schema },
          },
        }),
        handler: async () => ({ ok: true }),
      });

      for (const v of valid) {
        const res = await app.inject({
          method: 'POST',
          url: '/v',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ v }),
        });
        expect([res.statusCode, v]).toEqual([200, v]);
      }
      for (const v of invalid) {
        const res = await app.inject({
          method: 'POST',
          url: '/v',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ v }),
        });
        expect([res.statusCode, v]).toEqual([400, v]);
      }
      await app.close();
    });
  });

  describe('response-schema structural sanity', () => {
    it('ERROR_RESPONSE_SCHEMA is the canonical error envelope shape', () => {
      expect(ERROR_RESPONSE_SCHEMA.additionalProperties).toBe(false);
      expect(ERROR_RESPONSE_SCHEMA.required).toEqual(['error']);
      expect(ERROR_RESPONSE_SCHEMA.properties.error.type).toBe('string');
    });

    it('HEALTHZ_RESPONSE_SCHEMA pins status=ok + version', () => {
      expect(HEALTHZ_RESPONSE_SCHEMA.properties.status.const).toBe('ok');
      expect(HEALTHZ_RESPONSE_SCHEMA.required).toEqual(['status', 'version']);
    });
  });

  describe('defineRouteSchema pass-through', () => {
    it('returns the schema object unchanged (stable call-site for refactor)', () => {
      const input = { body: { type: 'object' } } as const;
      expect(defineRouteSchema(input)).toBe(input);
    });
  });
});
