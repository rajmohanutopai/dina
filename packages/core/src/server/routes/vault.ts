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

import type { GrantMode } from '../../agent/grant_repository';
import type { CoreRouter, CoreRequest, CoreResponse } from '../router';

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
    try {
      // The stored item is whatever the caller sent — the Brain client is
      // trusted to supply a well-shaped VaultItem.
      const id = storeItem(persona, req.body as Parameters<typeof storeItem>[1]);
      return { status: 201, body: { id } };
    } catch (err) {
      return { status: 400, body: { error: errMsg(err) } };
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
    try {
      const deleted = deleteItem(persona, req.params.id);
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
