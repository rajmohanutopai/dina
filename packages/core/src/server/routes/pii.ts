/**
 * PII scrub route — scrub text, return rehydration tokens.
 */

import { isScopeAuthorized } from '../../auth/agent_scope';
import { scrubPII } from '../../pii/patterns';

import type { CoreRequest, CoreRouter } from '../router';

const MAX_AGENT_SCRUB_BODY_BYTES = 128 * 1024;
const MAX_AGENT_SCRUB_TEXT_LENGTH = 100_000;

function resolveCallerDid(req: CoreRequest): string {
  const xDID = req.headers['x-did'];
  return req.callerDID ?? (typeof xDID === 'string' ? xDID : '');
}

export function registerPIIRoutes(router: CoreRouter): void {
  // Brain's internal scrub surface deliberately omits original values. Brain
  // owns its rehydration mapping through its own runtime; this route should not
  // become an agent shortcut merely because both operations use the same
  // detector.
  router.post('/v1/pii/scrub', async (req) => {
    const body = (req.body as { text?: unknown } | undefined) ?? {};
    const text = typeof body.text === 'string' ? body.text : '';
    if (text === '') {
      return { status: 400, body: { error: 'text is required' } };
    }
    if (text.length > MAX_AGENT_SCRUB_TEXT_LENGTH) {
      return { status: 413, body: { error: 'text exceeds 100000-character limit' } };
    }
    const result = scrubPII(text);
    return {
      status: 200,
      body: {
        scrubbed: result.scrubbed,
        entities: result.entities.map((e) => ({
          token: e.token,
          type: e.type,
          start: e.start,
          end: e.end,
        })),
        entityCount: result.entities.length,
      },
    };
  });

  // Coding-agent façade. The caller already holds `text`; returning the exact
  // token/value mapping adds no new disclosure and lets the CLI rehydrate
  // locally without ever sending that mapping to an external model. Keep this
  // separate from `/v1/pii/*` so runner agents cannot inherit Brain's broader
  // PII surface.
  router.post('/v1/agent/scrub', async (req) => {
    if (req.rawBody.length > MAX_AGENT_SCRUB_BODY_BYTES) {
      return { status: 413, body: { error: 'request body too large' } };
    }
    const agentDid = resolveCallerDid(req);
    if (agentDid === '') {
      return { status: 401, body: { error: 'unauthenticated: no caller DID' } };
    }
    if (!isScopeAuthorized(req.agentScope, '/v1/agent/scrub')) {
      return {
        status: 403,
        body: { error: "agent_scope 'coding' required for /v1/agent/scrub" },
      };
    }
    const body = (req.body as { text?: unknown } | undefined) ?? {};
    const text = typeof body.text === 'string' ? body.text : '';
    if (text === '') {
      return { status: 400, body: { error: 'text is required' } };
    }
    if (text.length > MAX_AGENT_SCRUB_TEXT_LENGTH) {
      return { status: 413, body: { error: 'text exceeds 100000-character limit' } };
    }
    const result = scrubPII(text);
    return {
      status: 200,
      body: {
        scrubbed: result.scrubbed,
        entities: result.entities.map((e) => ({
          token: e.token,
          type: e.type,
          start: e.start,
          end: e.end,
          value: e.value,
        })),
        entityCount: result.entities.length,
      },
    };
  });
}
