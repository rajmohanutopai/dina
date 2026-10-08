/**
 * Failover for read-only service queries (REAL_LIFE_FIXES §9).
 *
 * When a query to one provider is about to expire unanswered, Core points
 * the SAME task at the next ranked candidate and sends the query there, so
 * the owner's one card answers from the next provider. Only capabilities the
 * catalog marks `action_class: 'read'` fail over: a request that acts (a
 * booking, an order) is never resent blindly, because the first provider may
 * have acted. Each candidate keeps its own listing URI and schema hash;
 * candidates needing a grant are never stored as fallbacks. The attempts
 * list lives on the task, so a restart continues where it stopped and an
 * owner cancel (a terminal task) stops it.
 */

/**
 * True when a service query that went quiet after hand-off may still have
 * acted: any capability the catalog does not mark `read`, including one it
 * does not know. Its expiry ends as `outcome_unknown`, never "no response".
 */
export function serviceQueryMayHaveActed(payload: string): boolean {
  try {
    const p = JSON.parse(payload) as { capability?: unknown };
    return typeof p.capability === 'string' && !isReadOnlyCapability(p.capability);
  } catch {
    return false;
  }
}

import { getCatalogCapability } from '@dina/protocol';

import { WorkflowTaskKind, WorkflowTaskState, type WorkflowTask } from '../workflow/domain';

import { providerStanding, recordProviderOutcome } from './provider_outcomes';

import type { WorkflowRepository } from '../workflow/repository';

/** One fallback provider for a query (stored on the task payload). */
export interface ServiceFallback {
  to_did: string;
  service_uri?: string;
  schema_hash?: string;
  service_name?: string;
}

export const MAX_FALLBACKS = 2;

type FailoverSender = (toDID: string, type: string, body: Record<string, unknown>) => Promise<void>;
let sender: FailoverSender | null = null;

/** Wired with the service-query sender (`setServiceQuerySender`). */
export function setFailoverSender(s: FailoverSender | null): void {
  sender = s;
}

/** True when a capability only reads (safe to ask another provider). */
export function isReadOnlyCapability(capability: string): boolean {
  return getCatalogCapability(capability)?.action_class === 'read';
}

/** Validate fallbacks from a request body; drops anything malformed. */
export function readFallbacks(raw: unknown, chosenDid: string): ServiceFallback[] {
  if (!Array.isArray(raw)) return [];
  const out: ServiceFallback[] = [];
  for (const f of raw) {
    if (f === null || typeof f !== 'object') continue;
    const r = f as Record<string, unknown>;
    if (typeof r.to_did !== 'string' || !r.to_did.startsWith('did:') || r.to_did === chosenDid) continue;
    if (out.some((x) => x.to_did === r.to_did)) continue;
    out.push({
      to_did: r.to_did,
      ...(typeof r.service_uri === 'string' ? { service_uri: r.service_uri } : {}),
      ...(typeof r.schema_hash === 'string' ? { schema_hash: r.schema_hash } : {}),
      ...(typeof r.service_name === 'string' ? { service_name: r.service_name.slice(0, 200) } : {}),
    });
    if (out.length >= MAX_FALLBACKS) break;
  }
  return out;
}

interface QueryPayload {
  to_did: string;
  capability: string;
  params: unknown;
  query_id: string;
  ttl_seconds: number;
  service_name?: string;
  service_uri?: string;
  schema_hash?: string;
  fallbacks?: ServiceFallback[];
  attempts?: string[];
  [k: string]: unknown;
}

/**
 * Retarget running read-only queries whose deadline has passed and that
 * have a fallback left. Runs just before the expiry sweep, so a retargeted
 * task is no longer due. Returns the ids it retargeted.
 */
export function failoverExpiringServiceQueries(
  repo: Pick<WorkflowRepository, 'listByKindAndState' | 'retargetServiceQuery' | 'appendEvent'>,
  nowSec: number,
  nowMs: number,
  failTask: (id: string, reason: string) => void,
): string[] {
  if (sender === null) return [];
  const send = sender;
  const out: string[] = [];
  let running: WorkflowTask[];
  try {
    running = repo.listByKindAndState(WorkflowTaskKind.ServiceQuery, WorkflowTaskState.Running, 200);
  } catch {
    return [];
  }
  for (const task of running) {
    if (task.expires_at === undefined || task.expires_at > nowSec) continue;
    let p: QueryPayload;
    try {
      p = JSON.parse(task.payload) as QueryPayload;
    } catch {
      continue;
    }
    if (!isReadOnlyCapability(p.capability)) continue;
    const tried = new Set([...(p.attempts ?? []), p.to_did]);
    const remaining = (p.fallbacks ?? []).filter((f) => !tried.has(f.to_did));
    const next = remaining.find((f) => !providerStanding(f.to_did, nowMs).ejected);
    if (next === undefined) continue;

    // The provider that just went quiet: it was handed the query (running).
    recordProviderOutcome(p.to_did, 'expired', { handedOff: true, now: nowMs });

    const payload: QueryPayload = {
      ...p,
      to_did: next.to_did,
      service_uri: next.service_uri ?? '',
      schema_hash: next.schema_hash ?? '',
      service_name: next.service_name ?? p.service_name ?? '',
      attempts: [...(p.attempts ?? []), p.to_did],
      fallbacks: remaining.filter((f) => f.to_did !== next.to_did),
    };
    const ttl = typeof p.ttl_seconds === 'number' && p.ttl_seconds > 0 ? p.ttl_seconds : 60;
    if (!repo.retargetServiceQuery(task.id, JSON.stringify(payload), nowSec + ttl, nowMs)) continue;
    out.push(task.id);
    // The card stays pending and says who is being asked now.
    repo.appendEvent({
      task_id: task.id,
      at: nowMs,
      event_kind: 'retargeted',
      needs_delivery: true,
      delivery_attempts: 0,
      delivery_failed: false,
      details: JSON.stringify({
        response_status: 'retargeted',
        capability: p.capability,
        previous_service_name: p.service_name ?? '',
        service_name: payload.service_name ?? '',
      }),
    });
    const body: Record<string, unknown> = {
      query_id: p.query_id,
      capability: p.capability,
      params: p.params,
      ttl_seconds: ttl,
      ...(next.schema_hash !== undefined && next.schema_hash !== '' ? { schema_hash: next.schema_hash } : {}),
      ...(next.service_uri !== undefined && next.service_uri !== '' ? { service_uri: next.service_uri } : {}),
    };
    void send(next.to_did, 'service.query', body).catch((err: unknown) => {
      failTask(task.id, `send_failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  return out;
}
