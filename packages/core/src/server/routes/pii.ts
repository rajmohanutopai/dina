/**
 * PII scrub route — scrub text, return rehydration tokens.
 */

import { isScopeAuthorized } from '../../auth/agent_scope';
import { listContacts } from '../../contacts/directory';
import { getPeopleRepository } from '../../people/repository';
import { buildPiiNameGroups, piiNamesVersion } from '../../pii/names';
import { scrubPII } from '../../pii/patterns';

import { PII_NAMES } from './paths';

import type { CoreRequest, CoreRouter } from '../router';

const MAX_AGENT_SCRUB_BODY_BYTES = 128 * 1024;
const MAX_AGENT_SCRUB_TEXT_LENGTH = 100_000;

function resolveCallerDid(req: CoreRequest): string {
  const xDID = req.headers['x-did'];
  return req.callerDID ?? (typeof xDID === 'string' ? xDID : '');
}

export function registerPIIRoutes(router: CoreRouter): void {
  // The names Brain hides from a cloud model (docs/PII_ARCHITECTURE_V2.md §5.2):
  // grouped by person, with no person IDs, DIDs or relationships. Brain-only,
  // like the rest of `/v1/pii/`. With no people graph wired the list is the
  // contacts alone.
  //
  // Freshness (REAL_LIFE_FIXES §4.3): the answer carries `version`, a hash of
  // the list. Brain sends the version it holds as `known` before every call
  // that leaves the node; when it is current Core answers `unchanged` and no
  // list. The list is built fresh on each read, so a write is visible to the
  // very next read.
  router.get(PII_NAMES, async (req) => {
    const people = getPeopleRepository()?.listPeople() ?? [];
    const groups = buildPiiNameGroups(people, listContacts());
    const version = piiNamesVersion(groups);
    const known = typeof req.query?.known === 'string' ? req.query.known : '';
    if (known !== '' && known === version) {
      return { status: 200, body: { version, unchanged: true } };
    }
    return { status: 200, body: { version, groups } };
  });

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
