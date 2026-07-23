/**
 * Vault routes — the subset Brain actually calls.
 *
 *   POST /v1/vault/query       — FTS keyword search
 *   POST /v1/vault/store       — store a single item
 *   GET  /v1/vault/item/:id    — fetch by id
 *
 * batch-store, kv/*, and DELETE variants were speculative ports — no
 * consumer in the mobile MVP, gone.
 */

import { requireAgentPersonaAccess } from '../../agent/access';
import {
  storeItem,
  queryVault,
  getItem,
  getItemsForPerson,
  listRecentItems,
  deleteItem,
} from '../../vault/crud';
import { isVaultOperationAllowed, type VaultOrigin } from '../../vault/origin_capability';

import type { GrantMode } from '../../agent/grant_repository';
import type { CoreRouter, CoreRequest, CoreResponse } from '../router';

/**
 * Item A (Codex review — Brain's ambient vault authority). The typed-origin
 * matrix (`origin_capability.ts`) is enforced at the storage seam, but until
 * now the vault ROUTES stored/deleted with the default `owner_request` origin
 * for every caller — so on the server split a compromised Brain (an untrusted
 * `service` caller) held owner-equivalent write AND delete authority just by
 * reaching the route. These helpers bind the origin to WHO is calling:
 *
 *   - owner        → `owner_request`  (write + delete; the only deleter)
 *   - Brain/service→ `staging_item`   (append-only ingest — never delete, and
 *                                       crud.ts blocks overwrite-by-id)
 *   - agent/other  → `agent_ask`      (read-only; write + delete denied)
 *
 * NOTE ON CALLER TYPES: after auth the router stamps `req.callerType` with the
 * FINE-GRAINED authz role (`brain` / `connector` / `admin` / `device` / `agent`
 * / `plugin`), NOT the coarse `service` — brain/connector/admin never arrive as
 * `service` on a real signed request (see middleware `mapToAuthzRole`). The
 * mapping below is keyed on those real roles.
 *
 *   - owner (in-process app, `device`, `owner` run/watch surface, `admin`
 *     operator) → `owner_request` (write + delete; the only deleter);
 *   - service-class analyst/connector (`brain` / `connector` / `service`) →
 *     `staging_item` (append-only ingest — never delete, and crud.ts blocks
 *     overwrite-by-id), so a compromised Brain keeps its legitimate ingest write
 *     but loses ambient delete/overwrite;
 *   - everything else (`agent` / `plugin` / `unknown`) → `agent_ask` (read-only;
 *     write + delete denied). An `agent` caller is already stopped by
 *     `agentGate`; the read-only origin is defense-in-depth.
 */
const OWNER_CALLER_TYPES: ReadonlySet<string> = new Set(['device', 'owner', 'admin']);
const APPEND_CALLER_TYPES: ReadonlySet<string> = new Set(['brain', 'connector', 'service']);

function isOwnerCaller(req: CoreRequest): boolean {
  // A typed owner principal (the owner's own device / run-watch owner surface /
  // the operator admin) is the owner regardless of transport.
  if (req.callerType !== undefined) return OWNER_CALLER_TYPES.has(req.callerType);
  // No principal: the owner is the in-process app (trusted local transport). A
  // typed non-owner caller is never the owner, even over the in-process
  // transport — the principal governs, not the transport bypass.
  return req.trustedInProcess === true;
}
function writeOriginFor(req: CoreRequest): VaultOrigin {
  if (isOwnerCaller(req)) return 'owner_request';
  if (req.callerType !== undefined && APPEND_CALLER_TYPES.has(req.callerType)) return 'staging_item';
  return 'agent_ask';
}
function deleteOriginFor(req: CoreRequest): VaultOrigin {
  return isOwnerCaller(req) ? 'owner_request' : 'service_task';
}

/**
 * Deterministic agent persona-access gate (issues.txt §2), shared by EVERY
 * agent-reachable persona read/write route so the policy lives in ONE place
 * and can't drift from the authz matrix. Returns a 403 response to
 * short-circuit with, or `null` when the operation may proceed.
 *
 * Only an out-of-process AGENT caller is gated; the owner's own app
 * dispatches in-process (callerType undefined) and accesses every persona
 * freely (user-vs-agent rule). A locked/sensitive persona with no active
 * grant returns `approval_required` and the vault is NOT touched. `write`
 * is gated separately from `read` (a read grant does not authorise a write).
 */
function agentGate(
  req: CoreRequest,
  persona: string,
  mode: GrantMode,
  scope: string,
): CoreResponse | null {
  if (req.callerType !== 'agent') return null;
  const agentDID = req.callerDID ?? '';
  if (agentDID === '') {
    // An agent caller with no resolved DID can't be bound to a grant —
    // fail closed rather than match a stray empty-DID grant.
    return { status: 403, body: { error: 'access_denied', reason: 'agent caller has no DID' } };
  }
  const sessionId = req.headers['x-session'] ?? '';
  const decision = requireAgentPersonaAccess({
    agentDID,
    persona,
    mode,
    scope,
    ...(sessionId !== '' ? { sessionId } : {}),
  });
  if (decision.kind === 'approval_required') {
    return {
      status: 403,
      body: {
        error: 'approval_required',
        approval_required: true,
        task_id: decision.taskId,
        persona,
      },
    };
  }
  if (decision.kind === 'denied') {
    return { status: 403, body: { error: 'access_denied', reason: decision.reason } };
  }
  return null;
}

export function registerVaultRoutes(router: CoreRouter): void {
  router.post('/v1/vault/query', async (req) => {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const persona = req.query.persona ?? 'general';
    const text = typeof body.text === 'string' ? body.text : '';
    const mode = (body.mode as 'fts5' | 'semantic' | 'hybrid' | undefined) ?? 'fts5';
    const rawLimit = Number(body.limit) || 20;
    const limit = Math.max(1, Math.min(rawLimit, 100));

    const gate = agentGate(req, persona, 'read', text);
    if (gate !== null) return gate;

    try {
      const results = queryVault(persona, { mode, text, limit });
      return { status: 200, body: { items: results, count: results.length } };
    } catch (err) {
      return { status: 400, body: { error: errMsg(err) } };
    }
  });

  router.post('/v1/vault/store', async (req) => {
    const persona = req.query.persona ?? 'general';
    // Write gate (issues.txt §2): authz currently denies `agent` on store,
    // but gate here too so the policy is enforced in ONE place regardless of
    // the authz matrix — a sensitive/locked persona needs a `write` grant.
    const gate = agentGate(req, persona, 'write', '');
    if (gate !== null) return gate;
    // Item A — bind the write origin to the caller. A non-`service`, non-owner
    // caller gets a read-only origin and is refused here rather than silently
    // no-op'ing at the seam.
    const origin = writeOriginFor(req);
    if (!isVaultOperationAllowed(origin, 'write')) {
      return { status: 403, body: { error: 'access_denied', reason: 'origin may not write' } };
    }
    try {
      // The stored item is whatever the caller sent — the Brain client is
      // trusted to supply a well-shaped VaultItem (but only to APPEND: crud.ts
      // blocks a non-owner origin from overwriting an existing item by id).
      const id = storeItem(persona, req.body as Parameters<typeof storeItem>[1], origin);
      return { status: 201, body: { id } };
    } catch (err) {
      const msg = errMsg(err);
      // An origin-matrix violation (write/overwrite denied) is an authz
      // failure → 403, not a malformed-request 400.
      if (/may not (write|overwrite)/.test(msg)) {
        return { status: 403, body: { error: 'access_denied', reason: msg } };
      }
      return { status: 400, body: { error: msg } };
    }
  });

  router.get('/v1/vault/item/:id', async (req) => {
    const persona = req.query.persona ?? 'general';
    const gate = agentGate(req, persona, 'read', req.params.id ?? '');
    if (gate !== null) return gate;
    const item = getItem(persona, req.params.id);
    if (!item) return { status: 404, body: { error: 'Item not found' } };
    return { status: 200, body: item };
  });

  // Paginate a persona's vault (newest first). Backs CoreClient.vaultList,
  // which the brain's browse_vault tool uses out-of-process.
  router.get('/v1/vault/list', async (req) => {
    const persona = req.query.persona ?? 'general';
    const gate = agentGate(req, persona, 'read', '');
    if (gate !== null) return gate;
    const rawLimit = Number(req.query.limit) || 20;
    const limit = Math.max(1, Math.min(rawLimit, 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    // Optional type filter — the client (CoreClient.vaultList) advertises
    // it, so honour it here rather than silently paginating everything.
    const type =
      typeof req.query.type === 'string' && req.query.type !== '' ? req.query.type : undefined;
    try {
      // Fetch one extra to report whether more pages exist without a
      // separate full count.
      const window = listRecentItems(persona, offset + limit + 1, type);
      const page = window.slice(offset, offset + limit);
      return { status: 200, body: { items: page, count: page.length } };
    } catch (err) {
      return { status: 400, body: { error: errMsg(err) } };
    }
  });

  // Delete a single item (soft-delete in the repo). Backs CoreClient.vaultDelete.
  router.delete('/v1/vault/item/:id', async (req) => {
    const persona = req.query.persona ?? 'general';
    const gate = agentGate(req, persona, 'write', req.params.id ?? '');
    if (gate !== null) return gate;
    // Item A — only the owner deletes. A non-owner caller (Brain/service, agent)
    // maps to an origin the matrix denies for delete, so a compromised Brain
    // cannot destroy owner vault items via this route.
    const origin = deleteOriginFor(req);
    if (!isVaultOperationAllowed(origin, 'delete')) {
      return { status: 403, body: { error: 'access_denied', reason: 'origin may not delete' } };
    }
    try {
      const deleted = deleteItem(persona, req.params.id, origin);
      return { status: 200, body: { deleted } };
    } catch (err) {
      return { status: 400, body: { error: errMsg(err) } };
    }
  });

  // Structured recall: items a person is a subject of (vault_item_subjects).
  // GET /v1/vault/subjects?persona=…&person_id=…&limit=…
  router.get('/v1/vault/subjects', async (req) => {
    const persona = req.query.persona ?? 'general';
    const personId = req.query.person_id ?? '';
    const rawLimit = Number(req.query.limit) || 20;
    const limit = Math.max(1, Math.min(rawLimit, 100));
    if (personId === '') return { status: 400, body: { error: 'person_id is required' } };
    const gate = agentGate(req, persona, 'read', personId);
    if (gate !== null) return gate;
    try {
      const results = getItemsForPerson(persona, personId, limit);
      return { status: 200, body: { items: results, count: results.length } };
    } catch (err) {
      return { status: 400, body: { error: errMsg(err) } };
    }
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
