/**
 * A2A Lane 1 routes (design §4.3, plan §3.8).
 *
 * Brain (the signed service key on a server; in-process on the phone):
 *   POST /v1/a2a/delegate              propose a message to a bound skill
 *   GET  /v1/a2a/agents                the active agents and their bound skills
 *   GET  /v1/a2a/operations/:id        an operation's state; the result once released
 *   POST /v1/a2a/guard/next            claim a held result to scan (the only quarantine reader)
 *   POST /v1/a2a/guard/verdict         the digest-bound verdict
 *   POST /v1/a2a/turns                 the owner's words at the start of a chat turn
 * The guard claim is a POST: it changes state.
 *
 * Owner (the owner capability; handler-checked like every /v1/owner route):
 *   /v1/owner/a2a/remote-agents[/:id[/verify|revoke|activate|credentials|bindings…]]
 *   /v1/owner/a2a/operations[/:id[/cancel]]
 *
 * Every view is owner-safe text: remote prose has invisible characters
 * removed and is bounded; quarantined content appears in no view.
 */

import { A2A_DID_BINDING_PATH, isPlainObject } from '@dina/a2a';

import { getA2ACardKeyRotation } from '../../a2a/card_key_rotation';
import {
  createA2AClient,
  getA2AClient,
  issueA2AGrant,
  listA2AClients,
  listA2AGrants,
  revokeA2AClient,
  revokeA2AGrant,
  rotateA2AClientToken,
} from '../../a2a/clients';
import {
  cardSchemeChoices,
  createRemoteCredential,
  credentialScopeOf,
  rotateRemoteCredential,
} from '../../a2a/credentials';
import { issueDidChallenge } from '../../a2a/did_binding';
import { remoteAgentEvidence } from '../../a2a/directory_evidence';
import { placeholderLegend } from '../../a2a/entities';
import { claimNextGuardJob, outboundOperationView, submitGuardVerdict } from '../../a2a/guard_jobs';
import { newA2AId } from '../../a2a/ids';
import { buildInboundCard, getA2ACardConfig } from '../../a2a/inbound_card';
import { cancelOutboundOperation } from '../../a2a/permits';
import { OUTBOUND_PRINCIPAL, proposeDelegation } from '../../a2a/proposal';
import { getA2APublisher, publicationView, readPublication, setDirectoryListing } from '../../a2a/publication';
import { getA2AReleaseLog } from '../../a2a/release_log';
import {
  activateRemoteAgent,
  bindRemoteSkill,
  createNoneCredential,
  liveRemoteBindings,
  pinnedRemoteSkills,
  registerRemoteAgent,
  reverifyRemoteAgent,
  revokeRemoteAgent,
  revokeRemoteCredential,
  unbindRemoteSkill,
  a2aDisplayText,
} from '../../a2a/remote_agents';
import { bindRunner, listRunnerBindings, unbindRunner } from '../../a2a/runner_bindings';
import { getA2ARuntime, getA2AStore, type A2ARuntime } from '../../a2a/runtime';
import { ownerPresenceRefusal } from '../../commerce/owner_presence';
import { getNodeDID } from '../../pairing/ceremony';
import { getServiceGrantRepository, type ServiceGrant } from '../../service/service_grant_repository';
import { parseReleaseSession } from '../../vault/release';

import { makeOwnerGuard } from './owner_guard';
import {
  A2A_AGENTS,
  A2A_SELF,
  A2A_DELEGATE,
  A2A_GUARD_NEXT,
  A2A_GUARD_VERDICT,
  A2A_OPERATIONS,
  A2A_TURNS,
  OWNER_A2A_OPERATIONS,
  OWNER_A2A_CLIENTS,
  OWNER_A2A_GRANTS,
  OWNER_A2A_DIRECTORY_LISTING,
  OWNER_A2A_PUBLISHER,
  OWNER_A2A_CARD_KEY,
  OWNER_A2A_REMOTE_AGENTS,
  OWNER_A2A_RUNNERS,
} from './paths';

import type { A2AStore, RemoteAgentRow, RemoteCredentialRow } from '../../a2a/store';
import type { CoreRequest, CoreResponse, CoreRouter } from '../router';

const json = (status: number, body: unknown): CoreResponse => ({ status, body });

const NOT_FOUND = new Set(['not_found', 'agent_not_found', 'client_not_found', 'listing_not_found']);
// A refused credential request names what was wrong, never echoes a secret.
const CONFLICT = new Set([
  'did_bound',
  'already_registered',
  'already_active',
  'already_finished',
  'cancel_refused',
  'too_many_pending',
  'raced',
  'revoked',
  'client_revoked',
]);
/** Refusals that clear with time. */
const TOO_MANY = new Set(['too_many_recent']);

function refusal(reason: string, extra: Record<string, unknown> = {}): CoreResponse {
  const status = NOT_FOUND.has(reason) ? 404 : CONFLICT.has(reason) ? 409 : TOO_MANY.has(reason) ? 429 : 400;
  return json(status, { error: reason, ...extra });
}

function body(req: CoreRequest): Record<string, unknown> {
  return isPlainObject(req.body) ? req.body : {};
}

/** Brain on a server (the signed service key) or in-process on the phone. */
function isBrain(req: CoreRequest): boolean {
  return req.callerType === 'brain' || (req.trustedInProcess === true && req.callerType === undefined);
}

export function agentView(store: A2AStore, agent: RemoteAgentRow): Record<string, unknown> {
  const bindings = liveRemoteBindings(store, agent);
  return {
    agent_id: agent.agent_id,
    name: agent.name,
    card_url: agent.card_url,
    endpoint: agent.endpoint,
    status: agent.status,
    signature_state: agent.signature_state,
    signature_detail: agent.signature_detail,
    card_hash: agent.card_hash,
    approved_at: agent.approved_at,
    last_verified_at: agent.last_verified_at,
    skills: pinnedRemoteSkills(agent),
    bindings: bindings.map((b) => ({
      skill: b.skill,
      action_class: b.action_class,
      credential_ref: b.credential_ref,
      revision: b.revision,
      result_schema: b.result_schema_json === null ? null : (JSON.parse(b.result_schema_json) as unknown),
    })),
    credentials: store.listCredentials(agent.agent_id).map(credentialView),
    schemes: cardSchemeChoices(agent.schemes_json),
  };
}

/** A credential as the owner sees it: kind, scope, revision, status — never its material. */
export function credentialView(c: RemoteCredentialRow): Record<string, unknown> {
  return {
    credential_ref: c.credential_ref,
    kind: c.kind,
    revision: c.revision,
    status: c.status,
    scope: credentialScopeOf(c),
  };
}

/** What Brain may know about callable agents: names, bound skills, classes. */
export function brainAgentsView(store: A2AStore): Record<string, unknown>[] {
  return store
    .listAgents('active')
    .map((agent) => {
      const skills = new Map(pinnedRemoteSkills(agent).map((s) => [s.id, s]));
      const card = (() => {
        try {
          return JSON.parse(agent.card_json) as Record<string, unknown>;
        } catch {
          return {};
        }
      })();
      return {
        agent_id: agent.agent_id,
        name: agent.name,
        description: a2aDisplayText(card.description, 400),
        skills: liveRemoteBindings(store, agent).map((b) => ({
          skill: b.skill,
          name: skills.get(b.skill)?.name ?? b.skill,
          description: skills.get(b.skill)?.description ?? '',
          action_class: b.action_class,
        })),
      };
    })
    .filter((a) => a.skills.length > 0);
}

export function registerA2ARoutes(router: CoreRouter, ownerCapability?: string): void {
  const ownerGuard = makeOwnerGuard(ownerCapability, 'remote agents are the owner’s to manage');
  const runtime = (): A2ARuntime | CoreResponse =>
    getA2ARuntime() ?? json(503, { error: 'a2a_unavailable' });
  const store = (): A2AStore | CoreResponse => getA2AStore() ?? json(503, { error: 'a2a_unavailable' });
  const isResponse = (v: unknown): v is CoreResponse =>
    isPlainObject(v) && typeof (v as { status?: unknown }).status === 'number' && 'body' in v;
  const brainOnly = (req: CoreRequest): CoreResponse | null =>
    isBrain(req) ? null : json(403, { error: 'access_denied', reason: 'brain only' });
  const brainOrOwner = (req: CoreRequest): CoreResponse | null => (isBrain(req) ? null : ownerGuard(req));

  // ------------------------------------------------------------------ Brain

  router.post(A2A_DELEGATE, async (req) => {
    const denied = brainOnly(req);
    if (denied !== null) return denied;
    const rt = runtime();
    if (isResponse(rt)) return rt;
    const b = body(req);
    if (typeof b.agent_id !== 'string' || typeof b.skill !== 'string') {
      return json(400, { error: 'agent_id and skill are required' });
    }
    const out = proposeDelegation(rt, {
      agentId: b.agent_id,
      skill: b.skill,
      ...(b.text !== undefined ? { text: b.text } : {}),
      ...(b.data !== undefined ? { data: b.data } : {}),
      ...(typeof b.reply_to === 'string' && b.reply_to !== '' ? { replyTo: b.reply_to.slice(0, 200) } : {}),
      releaseSession: b.release_session,
      ...(b.sources !== undefined ? { sources: b.sources } : {}),
    });
    if (!out.ok) return refusal(out.reason);
    return json(201, {
      operation_id: out.operationId,
      approval_task_id: out.approvalTaskId,
      consent_hash: out.consentHash,
      expires_at_ms: out.expiresAtMs,
      projection: out.projection,
      labels: out.labels,
    });
  });

  router.get(A2A_AGENTS, async (req) => {
    const denied = brainOrOwner(req);
    if (denied !== null) return denied;
    const s = store();
    if (isResponse(s)) return s;
    return json(200, { agents: brainAgentsView(s) });
  });

  // The node's own DID, so Brain's directory search never offers the owner
  // this node's own card (§8.4). Needs no Lane 1 state: a node without a DID
  // has published no card.
  router.get(A2A_SELF, async (req) => {
    const denied = brainOrOwner(req);
    if (denied !== null) return denied;
    const did = getNodeDID();
    return did === null ? json(503, { error: 'node_did_unavailable' }) : json(200, { did });
  });

  router.get(`${A2A_OPERATIONS}/:id`, async (req) => {
    const denied = brainOrOwner(req);
    if (denied !== null) return denied;
    const rt = runtime();
    if (isResponse(rt)) return rt;
    const view = outboundOperationView(rt, req.params.id ?? '');
    return view === null ? json(404, { error: 'not_found' }) : json(200, view);
  });

  router.post(A2A_GUARD_NEXT, async (req) => {
    const denied = brainOnly(req);
    if (denied !== null) return denied;
    const rt = runtime();
    if (isResponse(rt)) return rt;
    const work = claimNextGuardJob(rt);
    return work === null ? json(204, {}) : json(200, work);
  });

  router.post(A2A_GUARD_VERDICT, async (req) => {
    const denied = brainOnly(req);
    if (denied !== null) return denied;
    const rt = runtime();
    if (isResponse(rt)) return rt;
    const b = body(req);
    if (typeof b.job_id !== 'string' || typeof b.claim_id !== 'string' || typeof b.digest !== 'string') {
      return json(400, { error: 'job_id, claim_id and digest are required' });
    }
    const out = submitGuardVerdict(rt, {
      jobId: b.job_id,
      claimId: b.claim_id,
      digest: b.digest,
      verdict: b.verdict,
      code: b.code,
      note: b.note,
    });
    if (!out.ok) {
      const status = out.reason === 'not_found' ? 404 : out.reason === 'bad_verdict' ? 400 : 409;
      return json(status, { error: out.reason });
    }
    return json(200, { state: out.state });
  });

  // The owner's words at the start of a chat turn (§4.2 (a)): Brain's chat
  // entry records them before any model sees the turn, so text a model later
  // produces cannot pass as the owner's. Installed on both boots.
  router.post(A2A_TURNS, async (req) => {
    const denied = brainOnly(req);
    if (denied !== null) return denied;
    const log = getA2AReleaseLog();
    if (log === null) return json(503, { error: 'a2a_unavailable' });
    const b = body(req);
    const sessionId = parseReleaseSession(b.release_session);
    const turnId = parseReleaseSession(b.turn_id);
    if (sessionId === null || turnId === null) return json(400, { error: 'release_session and turn_id are required' });
    if (typeof b.text !== 'string' || b.text.trim() === '') return json(400, { error: 'text is required' });
    return json(200, { recorded: log.recordUtterance(sessionId, turnId, b.text) });
  });

  // ------------------------------------------------------------------ Owner

  const ownerRoute =
    (handler: (req: CoreRequest, s: A2AStore) => Promise<CoreResponse> | CoreResponse) =>
    async (req: CoreRequest): Promise<CoreResponse> => {
      const denied = ownerGuard(req);
      if (denied !== null) return denied;
      const s = store();
      if (isResponse(s)) return s;
      return handler(req, s);
    };
  const agentOr404 = (s: A2AStore, id: string): RemoteAgentRow | CoreResponse =>
    s.getAgent(id) ?? json(404, { error: 'not_found' });

  // Inbound clients and their grants (design §5.1, §5.2). The bearer is in
  // the response that mints it, and nowhere else.
  const grantView = (g: ServiceGrant): Record<string, unknown> => ({
    grant_id: g.grantId,
    principal: g.granteeDid,
    service_rkey: g.serviceRkey,
    capability: g.capability,
    expires_at: g.expiresAt ?? null,
    revoked_at: g.revokedAt ?? null,
    created_at: g.createdAt,
  });
  const grantRepo = () => getServiceGrantRepository() ?? json(503, { error: 'grants_unavailable' });

  router.post(
    OWNER_A2A_CLIENTS,
    ownerRoute((req, s) => {
      const out = createA2AClient(s, body(req), Date.now());
      return out.ok ? json(201, { client: out.client, token: out.token }) : refusal(out.reason);
    }),
  );

  router.get(
    OWNER_A2A_CLIENTS,
    ownerRoute((_req, s) => json(200, { clients: listA2AClients(s) })),
  );

  router.post(
    `${OWNER_A2A_CLIENTS}/:id/rotate`,
    ownerRoute((req, s) => {
      const out = rotateA2AClientToken(s, req.params.id ?? '', Date.now());
      return out.ok ? json(200, { token: out.token, token_expires_at: out.token_expires_at }) : refusal(out.reason);
    }),
  );

  // M4 (§5.1): a single-use challenge for one client and the DID the owner
  // names (body `{did}`), handed to the client out of band; the holder of
  // that DID's key signs it to bind the client to the DID.
  router.post(
    `${OWNER_A2A_CLIENTS}/:id/did-challenge`,
    ownerRoute((req, s) => {
      const nodeDid = getNodeDID();
      if (nodeDid === null) return json(503, { error: 'node_did_unavailable' });
      const out = issueDidChallenge(s, req.params.id ?? '', body(req).did, Date.now());
      return out.ok
        ? json(201, {
            challenge: out.challenge,
            expires_at: out.expires_at,
            node_did: nodeDid,
            client_id: req.params.id,
            did: out.did,
            binding_path: A2A_DID_BINDING_PATH,
          })
        : refusal(out.reason);
    }),
  );

  router.post(
    `${OWNER_A2A_CLIENTS}/:id/revoke`,
    ownerRoute((req, s) => {
      const grants = grantRepo();
      if (isResponse(grants)) return grants;
      const out = revokeA2AClient(s, grants, req.params.id ?? '', Date.now());
      return out.ok ? json(200, { grants_revoked: out.grants_revoked }) : refusal(out.reason);
    }),
  );

  router.post(
    `${OWNER_A2A_CLIENTS}/:id/grants`,
    ownerRoute((req, s) => {
      const grants = grantRepo();
      if (isResponse(grants)) return grants;
      const b = body(req);
      if (typeof b.service_rkey !== 'string' || typeof b.capability !== 'string') {
        return json(400, { error: 'service_rkey and capability are required' });
      }
      const out = issueA2AGrant(
        s,
        grants,
        { client_id: req.params.id ?? '', service_rkey: b.service_rkey, capability: b.capability, expires_at: b.expires_at },
        Date.now(),
      );
      return out.ok ? json(201, grantView(out.grant)) : refusal(out.reason);
    }),
  );

  router.get(
    `${OWNER_A2A_CLIENTS}/:id/grants`,
    ownerRoute((req, s) => {
      const grants = grantRepo();
      if (isResponse(grants)) return grants;
      const id = req.params.id ?? '';
      if (getA2AClient(s, id) === null) return json(404, { error: 'client_not_found' });
      return json(200, { grants: listA2AGrants(grants, id).map(grantView) });
    }),
  );

  router.post(
    `${OWNER_A2A_GRANTS}/:grantId/revoke`,
    ownerRoute((req) => {
      const grants = grantRepo();
      if (isResponse(grants)) return grants;
      return revokeA2AGrant(grants, req.params.grantId ?? '', Date.now())
        ? json(200, { revoked: true })
        : json(404, { error: 'not_found' });
    }),
  );

  // Runner bindings (design §7.3): a lane is executable over A2A only while
  // bound to an active paired runner, whose DID each call then pins.
  router.get(
    OWNER_A2A_RUNNERS,
    ownerRoute((_req, s) => json(200, { runners: listRunnerBindings(s) })),
  );

  router.post(
    OWNER_A2A_RUNNERS,
    ownerRoute((req, s) => {
      const b = body(req);
      const out = bindRunner(s, { lane: b.lane, device_did: b.device_did }, Date.now());
      return out.ok ? json(201, out.binding) : refusal(out.reason);
    }),
  );

  router.post(
    `${OWNER_A2A_RUNNERS}/:lane/unbind`,
    ownerRoute((req, s) => {
      const out = unbindRunner(s, req.params.lane ?? '', Date.now());
      return out.ok ? json(200, { unbound: true }) : refusal(out.reason);
    }),
  );

  // Lane 3 (design §8.2): the directory listing switch, off until the owner
  // turns it on, and the publisher's fencing ceremony, which needs the
  // repository and so runs in the host's publisher.
  const publicationInputs = async (s: A2AStore) => {
    const config = getA2ACardConfig();
    const nodeDid = getNodeDID();
    if (config === null || nodeDid === null) return { gatewayLive: false, projectableSkills: 0 };
    const built = await buildInboundCard(s, { nodeDid, config });
    return { gatewayLive: true, projectableSkills: built.ok ? built.card.skills.length : 0 };
  };
  const publisherView = async (s: A2AStore) => publicationView(readPublication(s), await publicationInputs(s));

  router.get(
    OWNER_A2A_PUBLISHER,
    ownerRoute(async (_req, s) => json(200, await publisherView(s))),
  );

  // The card key (UCP plan §4.8, U7): the ring, and the owner's rotation. A rotation changes
  // the key every remote agent pinned with the card, so it needs the owner present.
  router.get(
    OWNER_A2A_CARD_KEY,
    ownerRoute(async () => {
      const rotation = getA2ACardKeyRotation();
      return rotation === null ? json(503, { error: 'card_unconfigured' }) : json(200, rotation.view());
    }),
  );
  router.post(
    OWNER_A2A_CARD_KEY,
    ownerRoute(async (req) => {
      const rotation = getA2ACardKeyRotation();
      if (rotation === null) return json(503, { error: 'card_unconfigured' });
      if (body(req).action !== 'rotate') return json(400, { error: 'invalid_action' });
      if (!rotation.ready()) return json(409, { error: 'card_key_unknown' });
      const refusal = ownerPresenceRefusal(req, Date.now(), 'confirm it is you first');
      if (refusal !== null) return json(refusal.status, refusal.body);
      const out = await rotation.rotate();
      // No DID document to record the key in: a restore could not tell a rotation happened.
      if (out === 'no_did_document') return json(409, { error: 'no_did_document' });
      if (out === 'unknown') return json(409, { error: 'card_key_unknown' });
      return json(200, rotation.view());
    }),
  );

  router.post(
    OWNER_A2A_DIRECTORY_LISTING,
    ownerRoute(async (req, s) => {
      const enabled = body(req).enabled;
      if (typeof enabled !== 'boolean') return json(400, { error: 'enabled must be true or false' });
      setDirectoryListing(s, enabled, Date.now(), newA2AId);
      getA2APublisher()?.nudge();
      return json(200, await publisherView(s));
    }),
  );

  router.post(
    `${OWNER_A2A_PUBLISHER}/activate`,
    ownerRoute(async (req, s) => {
      const port = getA2APublisher();
      if (port === null) return json(503, { error: 'publisher_unavailable' });
      const refence = body(req).refence;
      if (refence !== undefined && typeof refence !== 'boolean') return json(400, { error: 'refence must be true or false' });
      const out = await port.activate({ refence: refence === true });
      return out.ok ? json(200, await publisherView(s)) : json(409, { error: out.reason });
    }),
  );

  router.post(
    `${OWNER_A2A_PUBLISHER}/deactivate`,
    ownerRoute(async (_req, s) => {
      const port = getA2APublisher();
      if (port === null) return json(503, { error: 'publisher_unavailable' });
      const out = await port.deactivate();
      return out.ok ? json(200, await publisherView(s)) : json(409, { error: out.reason });
    }),
  );

  router.post(
    OWNER_A2A_REMOTE_AGENTS,
    ownerRoute(async (req, s) => {
      const b = body(req);
      if (typeof b.card_url !== 'string') return json(400, { error: 'card_url is required' });
      const out = await registerRemoteAgent({ store: s }, b.card_url);
      if (!out.ok) {
        return refusal(out.reason, out.existingAgentId !== undefined ? { agent_id: out.existingAgentId } : {});
      }
      return json(201, agentView(s, out.agent));
    }),
  );

  router.get(
    OWNER_A2A_REMOTE_AGENTS,
    ownerRoute((_req, s) => json(200, { agents: s.listAgents().map((a) => agentView(s, a)) })),
  );

  router.get(
    `${OWNER_A2A_REMOTE_AGENTS}/:id`,
    ownerRoute((req, s) => {
      const agent = agentOr404(s, req.params.id ?? '');
      return isResponse(agent) ? agent : json(200, agentView(s, agent));
    }),
  );

  // The directory's PeerLens evidence for this agent, when its card names a Dina node (§6.1, §8.4): display only.
  router.get(
    `${OWNER_A2A_REMOTE_AGENTS}/:id/evidence`,
    ownerRoute(async (req, s) => {
      const agent = agentOr404(s, req.params.id ?? '');
      return isResponse(agent) ? agent : json(200, await remoteAgentEvidence(agent));
    }),
  );

  router.post(
    `${OWNER_A2A_REMOTE_AGENTS}/:id/verify`,
    ownerRoute(async (req, s) => {
      const out = await reverifyRemoteAgent({ store: s }, req.params.id ?? '');
      return out.ok ? json(200, { changed: out.changed, agent: agentView(s, out.agent) }) : refusal(out.reason);
    }),
  );

  router.post(
    `${OWNER_A2A_REMOTE_AGENTS}/:id/revoke`,
    ownerRoute((req, s) =>
      revokeRemoteAgent({ store: s }, req.params.id ?? '') ? json(200, { status: 'revoked' }) : refusal('not_found'),
    ),
  );

  router.post(
    `${OWNER_A2A_REMOTE_AGENTS}/:id/activate`,
    ownerRoute((req, s) => {
      const out = activateRemoteAgent({ store: s }, req.params.id ?? '');
      return out.ok ? json(200, { status: 'active' }) : refusal(out.reason);
    }),
  );

  router.post(
    `${OWNER_A2A_REMOTE_AGENTS}/:id/credentials`,
    ownerRoute((req, s) => {
      const b = body(req);
      const kind = b.kind ?? 'none';
      const out =
        kind === 'none'
          ? createNoneCredential({ store: s }, req.params.id ?? '')
          : createRemoteCredential({ store: s }, req.params.id ?? '', {
              kind,
              scheme: b.scheme,
              secret: b.secret,
              scopes: b.scopes,
            });
      return out.ok ? json(201, credentialView(out.credential)) : refusal(out.reason);
    }),
  );

  // Rotation: new material under a new reference; bindings move to it (§5.3).
  router.post(
    `${OWNER_A2A_REMOTE_AGENTS}/:id/credentials/:ref/rotate`,
    ownerRoute((req, s) => {
      const credential = s.getCredential(req.params.ref ?? '');
      if (credential === null || credential.remote_agent_id !== req.params.id) return refusal('not_found');
      const out = rotateRemoteCredential({ store: s }, credential.credential_ref, body(req).secret);
      return out.ok ? json(201, credentialView(out.credential)) : refusal(out.reason);
    }),
  );

  router.post(
    `${OWNER_A2A_REMOTE_AGENTS}/:id/credentials/:ref/revoke`,
    ownerRoute((req, s) => {
      const credential = s.getCredential(req.params.ref ?? '');
      if (credential === null || credential.remote_agent_id !== req.params.id) return refusal('not_found');
      return revokeRemoteCredential({ store: s }, credential.credential_ref)
        ? json(200, { status: 'revoked' })
        : refusal('already_finished');
    }),
  );

  router.post(
    `${OWNER_A2A_REMOTE_AGENTS}/:id/bindings`,
    ownerRoute((req, s) => {
      const b = body(req);
      if (typeof b.skill !== 'string' || typeof b.action_class !== 'string' || typeof b.credential_ref !== 'string') {
        return json(400, { error: 'skill, action_class and credential_ref are required' });
      }
      const out = bindRemoteSkill({ store: s }, req.params.id ?? '', {
        skill: b.skill,
        actionClass: b.action_class,
        credentialRef: b.credential_ref,
        ...(b.result_schema !== undefined && b.result_schema !== null ? { resultSchema: b.result_schema } : {}),
      });
      return out.ok
        ? json(200, { skill: out.binding.skill, action_class: out.binding.action_class, revision: out.binding.revision })
        : refusal(out.reason);
    }),
  );

  router.post(
    `${OWNER_A2A_REMOTE_AGENTS}/:id/bindings/:skill/revoke`,
    ownerRoute((req, s) =>
      // The router hands route params over decoded once; a second decode would read another id.
      unbindRemoteSkill({ store: s }, req.params.id ?? '', req.params.skill ?? '')
        ? json(200, { status: 'revoked' })
        : refusal('not_found'),
    ),
  );

  router.get(
    OWNER_A2A_OPERATIONS,
    ownerRoute((_req, s) => {
      const rt = getA2ARuntime();
      if (rt === null) return json(503, { error: 'a2a_unavailable' });
      const operations = s
        .listTasks('outbound', OUTBOUND_PRINCIPAL, 100)
        .map((op) => outboundOperationView(rt, op.external_id))
        .filter((v) => v !== null);
      return json(200, { operations });
    }),
  );

  router.get(
    `${OWNER_A2A_OPERATIONS}/:id`,
    ownerRoute((req, s) => {
      const rt = getA2ARuntime();
      if (rt === null) return json(503, { error: 'a2a_unavailable' });
      const view = outboundOperationView(rt, req.params.id ?? '');
      if (view === null) return json(404, { error: 'not_found' });
      // The owner's surface alone: what the placeholders in this answer stand
      // for, beside it, never written into the remote's text (§6.5).
      const op = s.getTaskByExternal('outbound', OUTBOUND_PRINCIPAL, view.operation_id);
      const legend = op === null || view.result === null ? [] : placeholderLegend(rt, op.id, op.external_id);
      return json(200, { ...view, placeholder_legend: legend });
    }),
  );

  router.post(
    `${OWNER_A2A_OPERATIONS}/:id/cancel`,
    ownerRoute((req) => {
      const rt = getA2ARuntime();
      if (rt === null) return json(503, { error: 'a2a_unavailable' });
      const out = cancelOutboundOperation(rt, req.params.id ?? '');
      return out.ok ? json(200, { state: out.state }) : refusal(out.reason);
    }),
  );
}
