/**
 * Owner-only interactive-run control API (INTERACTIVE_SERVICES_ARCHITECTURE.md
 * §12.5). Additive, snake_case:
 *
 *   POST /v1/run/start
 *   POST /v1/run/:id/pause | /resume | /stop
 *   POST /v1/run/:id/update
 *   GET  /v1/run/:id/status
 *
 * (POST /v1/run/:id/decide arrives with the message lifecycle, ISVC-4.)
 *
 * OWNER-ONLY — "a real boundary, not `trustedInProcess`" (§12.5). Every mutation
 * rejects Brain/agent/plugin/service in-handler. Enforcement is two-layered:
 *   (1) the authz matrix (`auth/authz.ts`) denies every SIGNED caller on the
 *       `/v1/run` prefix (no signed caller resolves to `owner` in V1); and
 *   (2) this in-handler guard rejects any request whose resolved caller is not
 *       the owner — the enforcement point for the in-process path, where
 *       `trustedInProcess` bypasses the matrix. Brain's shared in-process
 *       transport carries no `callerType` (undefined) and is rejected here; only
 *       the dedicated owner dispatch stamps `callerType='owner'`.
 */

import { CommandIdempotencyConflictError, recordOrReplayCommand } from '../../run/command_receipt';
import {
  RunValidationError,
  type MaxCountBasis,
  type OnStop,
  type PriorityCeiling,
  type RunTransport,
} from '../../run/domain';
import { getMessageRepository } from '../../run/message';
import { getRunRepository } from '../../run/repository';
import {
  RunNotFoundError,
  getRunService,
  type RunService,
} from '../../run/service';

import type { CoreRouter, CoreRequest, CoreResponse } from '../router';

function j(status: number, body: unknown): CoreResponse {
  return { status, body };
}

/** Reject any non-owner caller (§12.5). Returns a 403 response, or null to
 *  proceed. `req.callerType === 'owner'` is set ONLY by the owner dispatch. */
function ownerOnlyGuard(req: CoreRequest): CoreResponse | null {
  if (req.callerType !== 'owner') {
    return j(403, {
      error: 'access_denied',
      reason: 'only the owner may create or steer an interactive run',
    });
  }
  return null;
}

function requireService(): RunService | CoreResponse {
  const svc = getRunService();
  if (svc === null) {
    return j(503, { error: 'unavailable', reason: 'run service not wired' });
  }
  return svc;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Run `fn` (a `recordOrReplayCommand(...).response` call), mapping the typed
 *  idempotency-key-reuse conflict to a 409 rather than letting it bubble to a
 *  generic 500 (VERIF #6). */
function replayOrConflict(fn: () => CoreResponse): CoreResponse {
  try {
    return fn();
  } catch (err) {
    if (err instanceof CommandIdempotencyConflictError) {
      return j(409, { error: 'conflict', reason: 'idempotency_key reused with a different request' });
    }
    throw err;
  }
}

const CEILING_RANK: Record<PriorityCeiling, number> = {
  fiduciary: 1,
  solicited: 2,
  engagement: 3,
};

export function registerRunRoutes(router: CoreRouter): void {
  // POST /v1/run/start — create a run.
  router.post('/v1/run/start', async (req) => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const svc = requireService();
    if ('status' in svc) return svc;

    const body = isRecord(req.body) ? req.body : {};
    const now = Date.now();

    // TTL: accept absolute `expires_at` (ms) or relative `ttl_seconds`.
    let expiresAt: number | undefined;
    if (typeof body.expires_at === 'number') {
      expiresAt = body.expires_at;
    } else if (typeof body.ttl_seconds === 'number') {
      expiresAt = now + Math.round(body.ttl_seconds * 1000);
    }
    if (expiresAt === undefined) {
      return j(400, { error: 'invalid', field: 'expires_at', reason: 'expires_at or ttl_seconds is required' });
    }

    try {
      const run = svc.create({
        service_uri: String(body.service_uri ?? ''),
        provider_did: String(body.provider_did ?? ''),
        persona: String(body.persona ?? ''),
        idempotency_key: String(body.idempotency_key ?? ''),
        transport: typeof body.transport === 'string' ? (body.transport as RunTransport) : undefined,
        provider_grant_id: typeof body.provider_grant_id === 'string' ? body.provider_grant_id : null,
        interval_ms: typeof body.interval_ms === 'number' ? body.interval_ms : undefined,
        queue_cap: typeof body.queue_cap === 'number' ? body.queue_cap : undefined,
        action_risk_ceiling:
          typeof body.action_risk_ceiling === 'string' ? body.action_risk_ceiling : undefined,
        priority_ceiling: body.priority_ceiling as PriorityCeiling | undefined,
        classify_timeout_ms:
          typeof body.classify_timeout_ms === 'number' ? body.classify_timeout_ms : undefined,
        muted: typeof body.muted === 'boolean' ? body.muted : undefined,
        on_stop: body.on_stop as OnStop | undefined,
        max_count: typeof body.max_count === 'number' ? body.max_count : null,
        max_count_basis:
          typeof body.max_count_basis === 'string'
            ? (body.max_count_basis as MaxCountBasis)
            : undefined,
        stop_on_exhaustion:
          typeof body.stop_on_exhaustion === 'boolean' ? body.stop_on_exhaustion : undefined,
        expires_at: expiresAt,
        drain_deadline_ms:
          typeof body.drain_deadline_ms === 'number' ? body.drain_deadline_ms : undefined,
      });
      return j(201, {
        run_id: run.run_id,
        config_version: run.config_version,
        transport: run.transport,
        erasure_mode: run.erasure_mode,
        // V1 pull has no subscription ledger; effective = the run's own mode.
        effective_erasure_mode: run.erasure_mode,
      });
    } catch (err) {
      if (err instanceof RunValidationError) {
        return j(400, { error: 'invalid', field: err.field, reason: err.message });
      }
      throw err;
    }
  });

  // POST /v1/run/:id/decide — the owner approves / denies / acknowledges a
  // classified message (§12.5). Records the decision with a fresh
  // decision_revision; the run-engine then risk-gates + dispatches an approve.
  router.post('/v1/run/:id/decide', async (req) => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const messages = getMessageRepository();
    if (messages === null) return j(503, { error: 'unavailable', reason: 'message store not wired' });

    const body = isRecord(req.body) ? req.body : {};
    const messageId = typeof body.message_id === 'string' ? body.message_id : '';
    const decision = body.decision;
    if (messageId === '') return j(400, { error: 'invalid', field: 'message_id' });
    if (decision !== 'approve' && decision !== 'deny' && decision !== 'acknowledge') {
      return j(400, { error: 'invalid', field: 'decision' });
    }

    const runId = String(req.params.id ?? '');
    // 404 on a genuinely-unknown message is request-deterministic (messages are
    // never deleted), so it is safe outside the idempotency barrier below.
    if (messages.getById(messageId)?.run_id !== runId) return j(404, { error: 'not_found' });

    const runs = getRunRepository();

    // Everything state-dependent lives inside `compute` so a REPLAYED decide
    // returns the stored response rather than a fresh 409 once the message has
    // moved past `classified` / the run has terminated (VERIF #6 replay
    // correctness). On a first call `compute` runs immediately.
    const compute = (): CoreResponse => {
      const msg = messages.getById(messageId);
      if (msg === null || msg.run_id !== runId) return j(404, { error: 'not_found' });
      const run = runs?.getById(runId) ?? null;
      // No new decision under a fencing/terminal barrier (§5.1) — the run is
      // shedding work; only a permissive drain still admits decisions (VERIF #8).
      if (
        run !== null &&
        (['completed', 'stopped', 'expired'].includes(run.state) ||
          (run.state === 'draining' && run.drain_strength === 'fencing'))
      ) {
        return j(409, { error: 'conflict', reason: `run is ${run.state}; no new decisions` });
      }

      const nowMs = Date.now();
      // Recheck the message's own signed expiry before surfacing-for-decision
      // (§6.3): an expired message can never be decided (VERIF #11).
      if (nowMs >= msg.expires_at && msg.state === 'classified') {
        messages.transition(messageId, 'classified', 'expired', nowMs);
        return j(409, { error: 'conflict', reason: 'message expired' });
      }
      if (msg.state !== 'classified') {
        return j(409, { error: 'conflict', reason: `message is ${msg.state}, not classified` });
      }
      // Acknowledge only applies to informational; approve/deny to action.
      if (decision === 'acknowledge' && msg.kind !== 'informational') {
        return j(400, { error: 'invalid', reason: 'acknowledge is for informational messages' });
      }
      if ((decision === 'approve' || decision === 'deny') && msg.kind !== 'action') {
        return j(400, { error: 'invalid', reason: 'approve/deny is for action messages' });
      }

      const nextRevision = msg.decision_revision + 1;
      if (!messages.decide(messageId, decision, nextRevision, nowMs)) {
        return j(409, { error: 'conflict', reason: 'message no longer classified' });
      }
      // Decided-basis count barrier (§5.1 / VERIF #10): a decision bumps
      // decided_count; when it reaches max_count on a decided-basis run, open the
      // permissive `count` barrier so the run terminates on its count.
      if (run !== null && runs !== null) {
        const decided = runs.incrementDecided(runId, nowMs);
        if (run.max_count_basis === 'decided' && run.max_count !== null && decided >= run.max_count) {
          runs.applyBarrier(runId, 'count', 'permissive', nowMs + run.drain_deadline_ms, nowMs);
        }
      }
      const after = messages.getById(messageId);
      return j(200, { message_id: messageId, state: after?.state, decision, decision_revision: nextRevision });
    };

    // Durable per-command idempotency (§12.5 / VERIF #6): a replayed decide with
    // the same key returns the stored response without re-deciding.
    const idemKey = typeof body.idempotency_key === 'string' ? body.idempotency_key : '';
    if (idemKey === '') return compute();
    const owner = typeof req.callerDID === 'string' && req.callerDID !== '' ? req.callerDID : 'owner';
    return replayOrConflict(
      () =>
        recordOrReplayCommand<CoreResponse>({
          ownerPrincipal: owner,
          runId,
          route: 'decide',
          idempotencyKey: idemKey,
          requestBody: { message_id: messageId, decision },
          compute,
        }).response,
    );
  });

  // POST /v1/run/:id/pause
  router.post('/v1/run/:id/pause', async (req) => steer(req, 'pause'));
  // POST /v1/run/:id/resume
  router.post('/v1/run/:id/resume', async (req) => steer(req, 'resume'));
  // POST /v1/run/:id/stop
  router.post('/v1/run/:id/stop', async (req) => steer(req, 'stop'));

  // POST /v1/run/:id/update — owner config change, gated on config_version.
  router.post('/v1/run/:id/update', async (req) => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const svc = requireService();
    if ('status' in svc) return svc;

    const runId = String(req.params.id ?? '');
    const body = isRecord(req.body) ? req.body : {};
    if (typeof body.config_version !== 'number') {
      return j(400, { error: 'invalid', field: 'config_version', reason: 'config_version is required' });
    }

    const run = svc.get(runId);
    if (run === null) return j(404, { error: 'not_found' });

    const patch: Parameters<RunService['updateConfig']>[1] = {};
    if (typeof body.interval_ms === 'number') patch.interval_ms = body.interval_ms;
    if (typeof body.queue_cap === 'number') patch.queue_cap = body.queue_cap;
    if (typeof body.muted === 'boolean') patch.muted = body.muted;
    if (typeof body.provider_grant_id === 'string' || body.provider_grant_id === null) {
      patch.provider_grant_id = body.provider_grant_id as string | null;
    }

    if (typeof body.priority_ceiling === 'string') {
      const next = body.priority_ceiling as PriorityCeiling;
      if (next === 'fiduciary') {
        return j(400, { error: 'invalid', field: 'priority_ceiling', reason: 'fiduciary (Tier-1) is Phase 2' });
      }
      // Lower-only: a ceiling change may only make the run *quieter*
      // (numerically larger rank), never louder (§12.5 "priority_ceiling(lower-only)").
      if (CEILING_RANK[next] < CEILING_RANK[run.priority_ceiling]) {
        return j(400, {
          error: 'invalid',
          field: 'priority_ceiling',
          reason: 'priority_ceiling may only be lowered (made quieter), never raised',
        });
      }
      patch.priority_ceiling = next;
    }

    const newVersion = svc.updateConfig(runId, patch, body.config_version);
    if (newVersion === null) {
      return j(409, { error: 'conflict', reason: 'config_version mismatch' });
    }
    return j(200, { config_version: newVersion });
  });

  // GET /v1/run/:id/status
  router.get('/v1/run/:id/status', async (req) => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const svc = requireService();
    if ('status' in svc) return svc;

    const run = svc.get(String(req.params.id ?? ''));
    if (run === null) return j(404, { error: 'not_found' });

    // A run is fetch-paused (a derived condition under `active`) when it cannot
    // currently admit — for ISVC-1 the observable trigger is a set
    // `paused_reason` or the run being past its hard TTL. The full derived-set
    // (queue full / interval / count / persona lock) lands with admission (ISVC-3).
    const now = Date.now();
    const fetchPaused = run.paused_reason !== null || now >= run.expires_at;

    return j(200, {
      run_id: run.run_id,
      state: run.state,
      transport: run.transport,
      erasure_mode: run.erasure_mode,
      effective_erasure_mode: run.erasure_mode,
      drain_cause: run.drain_cause,
      drain_strength: run.drain_strength,
      fetch_paused: fetchPaused,
      paused_reason: run.paused_reason,
      provider_grant_valid_until: run.provider_grant_expires_at_sec,
      counts: {
        produced: run.produced_count,
        decided: run.decided_count,
        max_count: run.max_count,
        max_count_basis: run.max_count_basis,
        queue_cap: run.queue_cap,
      },
      pending: [],
      next_fetch_at: run.next_fetch_at,
      config_version: run.config_version,
    });
  });
}

/** Shared pause/resume/stop handler (§5.1 state-gated, version-unconditional). */
function steer(req: CoreRequest, command: 'pause' | 'resume' | 'stop'): CoreResponse {
  const denied = ownerOnlyGuard(req);
  if (denied !== null) return denied;
  const svc = requireService();
  if ('status' in svc) return svc;

  const runId = String(req.params.id ?? '');
  const body = isRecord(req.body) ? req.body : {};
  const onStop = typeof body.on_stop === 'string' ? (body.on_stop as OnStop) : undefined;

  const compute = (): CoreResponse => {
    try {
      let result;
      if (command === 'pause') result = svc.pause(runId);
      else if (command === 'resume') result = svc.resume(runId);
      else result = svc.stop(runId, onStop);
      return j(200, { state: result.state });
    } catch (err) {
      if (err instanceof RunNotFoundError) return j(404, { error: 'not_found' });
      throw err;
    }
  };

  // Durable per-command idempotency (§12.5 / VERIF #6): a replayed old command
  // (same key) returns the stored response WITHOUT re-executing — so a replayed
  // old `resume` can never undo a newer `pause`.
  const idemKey = typeof body.idempotency_key === 'string' ? body.idempotency_key : '';
  if (idemKey === '') return compute();
  const owner = typeof req.callerDID === 'string' && req.callerDID !== '' ? req.callerDID : 'owner';
  return replayOrConflict(
    () =>
      recordOrReplayCommand<CoreResponse>({
        ownerPrincipal: owner,
        runId,
        route: command,
        idempotencyKey: idemKey,
        requestBody: { on_stop: onStop ?? null },
        compute,
      }).response,
  );
}
