/**
 * Coding-agent audit projection.
 *
 * The general audit API is owner/admin-only. A coding agent may inspect only
 * gate decisions whose actor is its own authenticated DID. The route projects
 * known metadata fields and never returns the raw audit detail blob.
 */

import { isScopeAuthorized } from '../../auth/agent_scope';
import { getAuditRepository } from '../../audit/repository';
import { parseAuditDetail, queryAudit } from '../../audit/service';

import type { AuditEntry } from '../../audit/hash_chain';
import type { CoreRouter } from '../router';

const MAX_AGENT_AUDIT_LIMIT = 50;
const AUDIT_QUERY_WINDOW = 200;

function project(entry: AuditEntry): Record<string, unknown> {
  const detail = parseAuditDetail(entry.detail);
  const detailRecord = detail as Record<string, unknown>;
  const metadata =
    detail.metadata !== null && typeof detail.metadata === 'object' ? detail.metadata : {};
  const value = (key: string): string => {
    const candidate = detailRecord[key] ?? metadata?.[key];
    return typeof candidate === 'string' ? candidate : '';
  };
  const action = entry.action.startsWith('coding_gate:')
    ? entry.action.slice('coding_gate:'.length)
    : entry.action;
  return {
    id: entry.seq,
    timestamp: new Date(entry.ts * 1000).toISOString(),
    action,
    tool: entry.resource,
    risk: value('risk'),
    outcome: value('outcome'),
    reason: value('reason'),
  };
}

export function registerAgentAuditRoutes(router: CoreRouter): void {
  router.get('/v1/agent/audit', async (req) => {
    const agentDid = typeof req.callerDID === 'string' ? req.callerDID.trim() : '';
    if (agentDid === '') {
      return { status: 401, body: { error: 'unauthenticated: no caller DID' } };
    }
    if (!isScopeAuthorized(req.agentScope, '/v1/agent/audit')) {
      return {
        status: 403,
        body: { error: "agent_scope 'coding' required for /v1/agent/audit" },
      };
    }

    const requestedLimit = Number.parseInt(req.query.limit ?? '', 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), MAX_AGENT_AUDIT_LIMIT)
      : 20;
    const actionFilter = (req.query.action ?? '').trim();

    const repository = getAuditRepository();
    const candidates = repository
      ? await repository.query({ actor: agentDid, limit: AUDIT_QUERY_WINDOW })
      : queryAudit({ actor: agentDid, limit: AUDIT_QUERY_WINDOW });

    const entries = candidates
      .filter((entry) => entry.action.startsWith('coding_gate:'))
      .filter(
        (entry) =>
          actionFilter === '' ||
          entry.action === actionFilter ||
          entry.action === `coding_gate:${actionFilter}`,
      )
      .slice(0, limit)
      .map(project);

    return { status: 200, body: { entries } };
  });
}
