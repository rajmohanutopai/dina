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

import { getFetchEligibilityProbe } from '../../run/admission';
import { getClassificationJobRepository } from '../../run/classification';
import { CommandIdempotencyConflictError, recordOrReplayCommand } from '../../run/command_receipt';
import { getRunDispatchService, getRunPayloadView } from '../../run/dispatch';
import {
  RunValidationError,
  isRunTerminal,
  MAX_QUEUE_CAP,
  type MaxCountBasis,
  type OnStop,
  type PriorityCeiling,
  type RunTransport,
} from '../../run/domain';
import { runToListItem } from '../../run/list';
import { getMessageRepository } from '../../run/message';
import { getRunRepository } from '../../run/repository';
import { getReservationRepository } from '../../run/reservation';
import {
  RunNotFoundError,
  getRunService,
  type RunService,
} from '../../run/service';

import { makeOwnerGuard, type OwnerGuard } from './owner_guard';

import type { CoreRouter, CoreRequest, CoreResponse } from '../router';

function j(status: number, body: unknown): CoreResponse {
  return { status, body };
}

/** Build the owner guard bound to the boot-minted capability (§12.5, F15). The
 *  secret is captured in this closure (not a module global), so a prompt-injection-
 *  steered Brain following normal code paths can't obtain it. It is DEFENSE-IN-
 *  DEPTH, not a hard boundary: a Brain executing arbitrary hostile JS in the shared
 *  mobile VM can still skim the secret off a live owner request (patch
 *  CoreRouter.prototype.handle) — out of scope for any in-VM mechanism; the server
 *  split is the strong boundary (see router.ts CoreRequest.ownerCapability +
 *  SECURITY.md). FAIL CLOSED: a router registered without a capability (Brain's own
 *  router, or a server split with no in-process owner surface) rejects every owner
 *  call. A caller must BOTH be owner-marked AND present the exact capability. */
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

export function registerRunRoutes(router: CoreRouter, ownerCapability?: string): void {
  const ownerOnlyGuard = makeOwnerGuard(
    ownerCapability,
    'only the owner may create or steer an interactive run',
  );
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

    const idemKey = String(body.idempotency_key ?? '');
    const createParams = {
      service_uri: String(body.service_uri ?? ''),
      provider_did: String(body.provider_did ?? ''),
      persona: String(body.persona ?? ''),
      idempotency_key: idemKey,
      transport: typeof body.transport === 'string' ? (body.transport as RunTransport) : undefined,
      provider_grant_id: typeof body.provider_grant_id === 'string' ? body.provider_grant_id : null,
      // The locally-known grant binding + expiry are persisted (§10/§13) so the
      // pacer can fetch-pause a run whose provider grant has lapsed. Without this
      // the expiry stays null and `providerGrantValid` never trips.
      provider_grant_expires_at_sec:
        typeof body.provider_grant_expires_at_sec === 'number'
          ? body.provider_grant_expires_at_sec
          : null,
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
        typeof body.max_count_basis === 'string' ? (body.max_count_basis as MaxCountBasis) : undefined,
      stop_on_exhaustion:
        typeof body.stop_on_exhaustion === 'boolean' ? body.stop_on_exhaustion : undefined,
      expires_at: expiresAt,
      drain_deadline_ms:
        typeof body.drain_deadline_ms === 'number' ? body.drain_deadline_ms : undefined,
    };

    // `svc.create` throws RunValidationError on bad params — let it propagate
    // OUTSIDE the idempotency receipt so a rejected start consumes no receipt (a
    // corrected retry is allowed to act).
    const compute = (): CoreResponse => {
      const run = svc.create(createParams);
      return j(201, {
        run_id: run.run_id,
        config_version: run.config_version,
        transport: run.transport,
        erasure_mode: run.erasure_mode,
        // V1 pull has no subscription ledger; effective = the run's own mode.
        effective_erasure_mode: run.erasure_mode,
      });
    };

    try {
      // Durable start idempotency (§12.5): `start` keys on
      // (owner_principal, route, idempotency_key) and stores the resulting run_id,
      // so a replay returns the SAME run_id even after that run terminated —
      // stronger than `create`'s live-run dedup alone. A same-key/different-body
      // start is a 409 (key reuse).
      if (idemKey === '') return compute();
      const owner = typeof req.callerDID === 'string' && req.callerDID !== '' ? req.callerDID : 'owner';
      // Hash the RAW client request (minus the key), NOT the normalized
      // `createParams`: the latter carries the DERIVED absolute `expires_at`
      // (now + ttl_seconds) which differs on every replay, so a genuine retry of a
      // ttl-based start would spuriously 409. The raw body (same ttl_seconds each
      // time) is stable across replays.
      const { idempotency_key: _k, ...rawBodyForHash } = body;
      return replayOrConflict(
        () =>
          recordOrReplayCommand<CoreResponse>({
            ownerPrincipal: owner,
            runId: '',
            route: 'start',
            idempotencyKey: idemKey,
            requestBody: rawBodyForHash,
            compute,
          }).response,
      );
    } catch (err) {
      if (err instanceof RunValidationError) {
        return j(400, { error: 'invalid', field: err.field, reason: err.message });
      }
      throw err;
    }
  });

  // GET /v1/run/list — the owner's active (non-terminal-first) runs, as safe
  // display DTOs (the full RunRecord — config + crypto fields — never leaves
  // Core). Owner-only, like every other /v1/run/* surface (§12.5). This is the
  // path the mobile run screen uses via InProcessOwnerRunClient, so the UI never
  // touches `getRunService().store()` directly.
  router.get('/v1/run/list', async (req) => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const svc = requireService();
    if ('status' in svc) return svc;
    return j(200, { runs: svc.store().listActive().map(runToListItem) });
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
    // REQUIRED optimistic-concurrency token (§12.5): the `decision_revision` the
    // owner UI rendered. A decision that omits it is rejected — an obsolete card
    // must never authorize a message.
    const decisionRevision =
      typeof body.decision_revision === 'number' ? body.decision_revision : undefined;
    if (messageId === '') return j(400, { error: 'invalid', field: 'message_id' });
    if (decision !== 'approve' && decision !== 'deny' && decision !== 'acknowledge') {
      return j(400, { error: 'invalid', field: 'decision' });
    }
    if (decisionRevision === undefined) {
      return j(400, { error: 'invalid', field: 'decision_revision', reason: 'decision_revision is required' });
    }
    // REQUIRED durable idempotency key (§12.5): every owner mutation is receipted.
    const decideIdemKey = typeof body.idempotency_key === 'string' ? body.idempotency_key : '';
    if (decideIdemKey === '') {
      return j(400, { error: 'invalid', field: 'idempotency_key', reason: 'idempotency_key is required' });
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
      // Recheck the RUN's hard bounds before authorizing a decision (§5.1/§8/§18
      // "hard bounds in guards"): a decision must not pass an elapsed hard TTL —
      // OR, while draining, an elapsed `drain_deadline_at` — just because the
      // sweeper has not force-terminated yet. This closes the window where a
      // permissive drain (not caught by the fencing check above) is past its
      // deadline but still admits a decision.
      if (run !== null && nowMs >= run.expires_at) {
        return j(409, { error: 'conflict', reason: 'run past its hard TTL' });
      }
      if (
        run !== null &&
        run.state === 'draining' &&
        run.drain_deadline_at !== null &&
        nowMs >= run.drain_deadline_at
      ) {
        return j(409, { error: 'conflict', reason: 'run past its drain deadline' });
      }
      // Recheck the message's own signed expiry before surfacing-for-decision
      // (§6.3): an expired message can never be decided (VERIF #11).
      if (nowMs >= msg.expires_at && msg.state === 'classified') {
        messages.transition(messageId, 'classified', 'expired', nowMs);
        return j(409, { error: 'conflict', reason: 'message expired' });
      }
      if (msg.state !== 'classified') {
        return j(409, { error: 'conflict', reason: `message is ${msg.state}, not classified` });
      }
      // Optimistic concurrency (§12.5): the owner UI passes the REQUIRED
      // `decision_revision` it rendered; a stale card (revision moved on) is
      // rejected so an obsolete decision can never authorize a message.
      if (msg.decision_revision !== decisionRevision) {
        return j(409, {
          error: 'conflict',
          reason: `decision_revision mismatch (expected ${decisionRevision}, have ${msg.decision_revision})`,
        });
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
      // permissive `count` barrier so the run terminates on its count. Route it
      // through `applyTerminationCause` (which applies `decideBarrier`) so the
      // barrier is MONOTONIC — a permissive `count` over an existing permissive
      // drain (`finish_pending` stop / `exhaustion`) is a no-op that preserves
      // the existing cause/label and never pushes `drain_deadline_at` later
      // (§5.1 "strengthen only, never weaken").
      const svc = getRunService();
      if (run !== null && runs !== null) {
        const decided = runs.incrementDecided(runId, nowMs);
        if (
          run.max_count_basis === 'decided' &&
          run.max_count !== null &&
          decided >= run.max_count &&
          svc !== null
        ) {
          svc.applyTerminationCause(run, 'count');
        }
      }
      const after = messages.getById(messageId);
      return j(200, { message_id: messageId, state: after?.state, decision, decision_revision: nextRevision });
    };

    // Durable per-command idempotency (§12.5 / VERIF #6): a replayed decide with
    // the same key returns the stored response without re-deciding.
    const owner = typeof req.callerDID === 'string' && req.callerDID !== '' ? req.callerDID : 'owner';
    return replayOrConflict(
      () =>
        recordOrReplayCommand<CoreResponse>({
          ownerPrincipal: owner,
          runId,
          route: 'decide',
          idempotencyKey: decideIdemKey,
          requestBody: { message_id: messageId, decision, decision_revision: decisionRevision },
          compute,
        }).response,
    );
  });

  // POST /v1/run/:id/confirm-risk — the owner confirms a MODERATE/HIGH action,
  // advancing it `risk_pending → risk_authorized` so the engine can dispatch it
  // (§6.3/§6.4, E76-08). The engine auto-authorizes SAFE actions; MODERATE/HIGH
  // (incl. the fail-safe null→MODERATE default) wait for THIS explicit owner
  // confirm — the driver never self-authorizes. Owner-only + durable (receipted);
  // a replayed / non-`risk_pending` confirm is an idempotent no-op.
  router.post('/v1/run/:id/confirm-risk', async (req) => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const messages = getMessageRepository();
    if (messages === null) return j(503, { error: 'unavailable', reason: 'message store not wired' });
    const dispatch = getRunDispatchService();
    if (dispatch === null) {
      return j(503, { error: 'unavailable', reason: 'dispatch service not wired' });
    }
    const body = isRecord(req.body) ? req.body : {};
    const messageId = typeof body.message_id === 'string' ? body.message_id : '';
    if (messageId === '') return j(400, { error: 'invalid', field: 'message_id' });
    const idemKey = typeof body.idempotency_key === 'string' ? body.idempotency_key : '';
    if (idemKey === '') {
      return j(400, { error: 'invalid', field: 'idempotency_key', reason: 'idempotency_key is required' });
    }
    const runId = String(req.params.id ?? '');
    // The message must belong to THIS run (the owner addressed a specific run).
    if (messages.getById(messageId)?.run_id !== runId) return j(404, { error: 'not_found' });

    const compute = (): CoreResponse => {
      const authorized = dispatch.authorizeRisk(messageId);
      const after = messages.getById(messageId);
      return j(200, { message_id: messageId, state: after?.state, authorized });
    };
    const owner = typeof req.callerDID === 'string' && req.callerDID !== '' ? req.callerDID : 'owner';
    return replayOrConflict(
      () =>
        recordOrReplayCommand<CoreResponse>({
          ownerPrincipal: owner,
          runId,
          route: 'confirm_risk',
          idempotencyKey: idemKey,
          requestBody: { message_id: messageId },
          compute,
        }).response,
    );
  });

  // POST /v1/run/:id/pause
  router.post('/v1/run/:id/pause', async (req) => steer(req, 'pause', ownerOnlyGuard));
  // POST /v1/run/:id/resume
  router.post('/v1/run/:id/resume', async (req) => steer(req, 'resume', ownerOnlyGuard));
  // POST /v1/run/:id/stop
  router.post('/v1/run/:id/stop', async (req) => steer(req, 'stop', ownerOnlyGuard));

  // POST /v1/run/:id/update — owner config change, gated on config_version.
  router.post('/v1/run/:id/update', async (req) => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const svc = requireService();
    if ('status' in svc) return svc;

    const runId = String(req.params.id ?? '');
    const body = isRecord(req.body) ? req.body : {};
    const configVersion = body.config_version;
    if (typeof configVersion !== 'number') {
      return j(400, { error: 'invalid', field: 'config_version', reason: 'config_version is required' });
    }

    // Request-deterministic field validation, up front (§5 bounds) — the same
    // ranges creation enforces, so `update` cannot smuggle an out-of-range value
    // past `validateCreateParams` (§18 "Command/state"). Value-only checks are
    // safe outside the idempotency barrier; the lower-only ceiling + terminal
    // guard are state-dependent and live in `compute`.
    if (body.interval_ms !== undefined) {
      if (typeof body.interval_ms !== 'number' || !Number.isInteger(body.interval_ms) || body.interval_ms < 0) {
        return j(400, { error: 'invalid', field: 'interval_ms', reason: 'interval_ms must be a non-negative integer' });
      }
    }
    if (body.queue_cap !== undefined) {
      if (
        typeof body.queue_cap !== 'number' ||
        !Number.isInteger(body.queue_cap) ||
        body.queue_cap < 1 ||
        body.queue_cap > MAX_QUEUE_CAP
      ) {
        return j(400, { error: 'invalid', field: 'queue_cap', reason: `queue_cap must be an integer in 1..${MAX_QUEUE_CAP}` });
      }
    }
    if (body.priority_ceiling !== undefined) {
      const next = body.priority_ceiling;
      if (next !== 'solicited' && next !== 'engagement' && next !== 'fiduciary') {
        return j(400, { error: 'invalid', field: 'priority_ceiling', reason: 'priority_ceiling must be solicited|engagement' });
      }
      if (next === 'fiduciary') {
        return j(400, { error: 'invalid', field: 'priority_ceiling', reason: 'fiduciary (Tier-1) is Phase 2' });
      }
    }
    // Rebinding to a REAL grant must state the replacement's expiry EXPLICITLY —
    // a number (unix seconds) or `null` for an intentionally non-expiring grant
    // — so an omitted expiry is never silently read as "never expires" (§10). This
    // value-only check is up-front (outside the idempotency barrier) so a rejected
    // update consumes no receipt and a corrected retry may act.
    if (typeof body.provider_grant_id === 'string' && body.provider_grant_id !== '') {
      const exp = body.provider_grant_expires_at_sec;
      if (exp !== null && typeof exp !== 'number') {
        return j(400, {
          error: 'invalid',
          field: 'provider_grant_expires_at_sec',
          reason:
            'provider_grant_expires_at_sec (a number, or null for non-expiring) is required when rebinding a provider_grant_id',
        });
      }
      if (typeof exp === 'number' && (!Number.isInteger(exp) || exp < 0)) {
        return j(400, {
          error: 'invalid',
          field: 'provider_grant_expires_at_sec',
          reason: 'provider_grant_expires_at_sec must be a non-negative integer (unix seconds)',
        });
      }
    }

    const compute = (): CoreResponse => {
      const run = svc.get(runId);
      if (run === null) return j(404, { error: 'not_found' });
      // Terminal states are absorbing (§5.1) — never accept a config change on a
      // completed/stopped/expired run (it would return a misleading 200).
      if (isRunTerminal(run.state)) {
        return j(409, { error: 'conflict', reason: `run is ${run.state} (terminal); config is frozen` });
      }

      const patch: Parameters<RunService['updateConfig']>[1] = {};
      if (typeof body.interval_ms === 'number') patch.interval_ms = body.interval_ms;
      if (typeof body.queue_cap === 'number') patch.queue_cap = body.queue_cap;
      if (typeof body.muted === 'boolean') patch.muted = body.muted;
      if (typeof body.provider_grant_id === 'string' || body.provider_grant_id === null) {
        patch.provider_grant_id = body.provider_grant_id as string | null;
        // Rebind persists the REPLACEMENT grant's expiry too (§10): "Core auto-
        // revalidates and resumes." Carrying only the id would leave the OLD
        // (expired) timestamp, so a fetch-paused run could never resume; the pacer
        // clears `paused_reason` on the next valid reserve. Clearing the grant to
        // null clears its expiry. The expiry was validated (number|null) up-front.
        patch.provider_grant_expires_at_sec =
          body.provider_grant_id === null ? null : (body.provider_grant_expires_at_sec as number | null);
      }
      if (typeof body.priority_ceiling === 'string') {
        const next = body.priority_ceiling as PriorityCeiling;
        // Lower-only: a ceiling change may only make the run *quieter* (larger
        // rank), never louder (§12.5 "priority_ceiling(lower-only)").
        if (CEILING_RANK[next] < CEILING_RANK[run.priority_ceiling]) {
          return j(400, {
            error: 'invalid',
            field: 'priority_ceiling',
            reason: 'priority_ceiling may only be lowered (made quieter), never raised',
          });
        }
        patch.priority_ceiling = next;
      }

      // (An interval change recomputes next_fetch_at inside RunService.updateConfig
      // — §11 — using the run's own clock, so a shorter cadence takes effect now.)
      const newVersion = svc.updateConfig(runId, patch, configVersion);
      if (newVersion === null) {
        return j(409, { error: 'conflict', reason: 'config_version mismatch' });
      }
      return j(200, { config_version: newVersion });
    };

    // Durable owner-command idempotency (§12.5), REQUIRED: a replayed update with
    // the same key returns the stored response instead of a spurious 409.
    const idemKey = typeof body.idempotency_key === 'string' ? body.idempotency_key : '';
    if (idemKey === '') {
      return j(400, { error: 'invalid', field: 'idempotency_key', reason: 'idempotency_key is required' });
    }
    const owner = typeof req.callerDID === 'string' && req.callerDID !== '' ? req.callerDID : 'owner';
    return replayOrConflict(
      () =>
        recordOrReplayCommand<CoreResponse>({
          ownerPrincipal: owner,
          runId,
          route: 'update',
          idempotencyKey: idemKey,
          requestBody: {
            config_version: configVersion,
            interval_ms: body.interval_ms ?? null,
            queue_cap: body.queue_cap ?? null,
            muted: body.muted ?? null,
            priority_ceiling: body.priority_ceiling ?? null,
            provider_grant_id: body.provider_grant_id ?? null,
            // Normalized into the receipt hash (§12.5/§352) so a same-key replay
            // with a DIFFERENT replacement expiry conflicts (409) instead of
            // replaying the first response and silently dropping the new expiry.
            provider_grant_expires_at_sec:
              typeof body.provider_grant_expires_at_sec === 'number'
                ? body.provider_grant_expires_at_sec
                : null,
          },
          compute,
        }).response,
    );
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
    // currently admit. Round-A A-11: the plane registers the admission gate as a
    // side-effect-free probe, so this reports the FULL derived set (§5 —
    // barrier/state, TTL, paused_reason, cadence, queue cap, count budget,
    // persona lock, grant), not just paused_reason/TTL. Probe absent (plane not
    // composed — degraded/test boots) → the paused_reason/TTL approximation.
    const now = Date.now();
    const probe = getFetchEligibilityProbe();
    const fetchBlockedReason =
      probe !== null
        ? probe(run.run_id)
        : run.paused_reason !== null
          ? 'paused'
          : now >= run.expires_at
            ? 'past_ttl'
            : null;
    const fetchPaused = fetchBlockedReason !== null;

    // Real pending-decisions list (§11/§12.5 "pending decisions in order"): the
    // classified, awaiting-owner-decision messages, in sequence order. The full
    // RunMessage (params / envelope) never leaves Core — only the decidable
    // display fields.
    const messages = getMessageRepository();
    // 81B-07 — expire any decidable message past its own or the run's hard bound
    // BEFORE surfacing, so an expired action is never offered for a new decision and
    // stops counting against the queue. Idempotent (skips already-terminal rows).
    if (messages !== null) {
      // 81B-07b / R2-03 — expire each decidable message past its bound AND fence its
      // still-`pending` classification job ATOMICALLY (the cancels run inside
      // expireDecidable's commit; both repos share the db adapter), so a crash can't
      // leave an `expired` message with an orphaned job scanned forever by sweeps.
      const jobs = getClassificationJobRepository();
      messages.expireDecidable(run.run_id, now, run.expires_at, (expiredIds) => {
        if (jobs !== null) for (const id of expiredIds) jobs.cancel(id, 'expired', now);
      });
    }
    const allMsgs = messages === null ? [] : messages.listByRun(run.run_id);
    // 81B-06 — render the bounded CardSpec title/body Core holds for each decidable
    // message so the owner sees WHAT they are approving/denying, not just an opaque
    // digest. Only Core can decrypt (open persona); locked/absent → empty text (the
    // owner still sees the service attribution + action_type). Never `params`/vault.
    const view = getRunPayloadView();
    const renderView = (messageId: string): { title: string; body: string } =>
      view === null ? { title: '', body: '' } : view(messageId, run.persona);
    const pending = allMsgs
      .filter((m) => m.state === 'classified' && now < m.expires_at)
      .sort((a, b) => a.sequence - b.sequence)
      .map((m) => ({
        message_id: m.message_id,
        kind: m.kind,
        sequence: m.sequence,
        action_type: m.action_type,
        final_tier: m.final_tier,
        content_digest: m.content_digest,
        ...renderView(m.message_id),
        // The owner UI passes this back as the REQUIRED `decision_revision`
        // so a stale card can never authorize a message (§12.5).
        decision_revision: m.decision_revision,
      }));
    // E76-11 — actions the owner has APPROVED that are parked in `risk_pending`
    // awaiting an explicit MODERATE/HIGH risk confirmation (§6.3/§6.4). The mobile
    // Activity surface renders these with a Confirm button wired to
    // `OwnerRunClient.confirmRisk`; without them a MODERATE action never dispatches.
    const pendingRisk = allMsgs
      .filter((m) => m.state === 'risk_pending' && now < m.expires_at)
      .sort((a, b) => a.sequence - b.sequence)
      .map((m) => ({
        message_id: m.message_id,
        kind: m.kind,
        sequence: m.sequence,
        action_type: m.action_type,
        content_digest: m.content_digest,
        ...renderView(m.message_id),
      }));

    return j(200, {
      run_id: run.run_id,
      state: run.state,
      // 81B-06 — service attribution: the owner must see WHICH provider/service this
      // run's decisions belong to (run-scoped; every message shares it).
      service_uri: run.service_uri,
      provider_did: run.provider_did,
      transport: run.transport,
      erasure_mode: run.erasure_mode,
      effective_erasure_mode: run.erasure_mode,
      drain_cause: run.drain_cause,
      drain_strength: run.drain_strength,
      fetch_paused: fetchPaused,
      // A-11 — WHY fetch is currently blocked (null when eligible): the
      // admission gate's first blocking reason (`not_active` | `past_ttl` |
      // `paused` | `cadence_not_elapsed` | `queue_full` | `count_exhausted` |
      // `persona_locked` | `grant_unavailable`).
      fetch_blocked_reason: fetchBlockedReason,
      paused_reason: run.paused_reason,
      provider_grant_valid_until: run.provider_grant_expires_at_sec,
      counts: {
        produced: run.produced_count,
        decided: run.decided_count,
        max_count: run.max_count,
        max_count_basis: run.max_count_basis,
        queue_cap: run.queue_cap,
      },
      pending,
      pending_risk: pendingRisk,
      // R5-01/§7 — slots whose held-by-lock response proved UNRECOVERABLE on
      // unlock replay. Each pauses fetch (`paused_reason: 'response_lost'`)
      // until the provider re-fills the freed cursor or the owner skips it
      // (POST /v1/run/:id/skip-lost). Metadata only — the payload is gone.
      lost: (getReservationRepository()?.listByRun(run.run_id) ?? [])
        .filter((r) => r.state === 'response_lost')
        .sort((a, b) => a.cursor - b.cursor)
        .map((r) => ({
          reservation_id: r.reservation_id,
          cursor: r.cursor,
          reason: r.error_reason,
          at: r.error_at,
        })),
      next_fetch_at: run.next_fetch_at,
      config_version: run.config_version,
    });
  });

  // POST /v1/run/:id/skip-lost — the owner gives up on a `response_lost` slot
  // (§7/§13): terminal `skipped`, the pull cursor advances PAST the position
  // (a permanent gap — the skipped item is never fetched or admitted again),
  // and when no lost slot remains the run's `paused_reason` clears so the
  // pacer resumes at the NEXT position. (An owner who wants the provider's
  // retry uses RESUME instead, which leaves the cursor on the lost position.)
  router.post('/v1/run/:id/skip-lost', async (req) => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const svc = requireService();
    if ('status' in svc) return svc;
    const reservations = getReservationRepository();
    const runs = getRunRepository();
    if (reservations === null || runs === null) {
      return j(503, { error: 'unavailable', reason: 'reservation store not wired' });
    }
    const body = isRecord(req.body) ? req.body : {};
    const reservationId = typeof body.reservation_id === 'string' ? body.reservation_id : '';
    if (reservationId === '') return j(400, { error: 'invalid', field: 'reservation_id' });
    const idemKey = typeof body.idempotency_key === 'string' ? body.idempotency_key : '';
    if (idemKey === '') {
      return j(400, { error: 'invalid', field: 'idempotency_key', reason: 'idempotency_key is required' });
    }
    const runId = String(req.params.id ?? '');
    if (svc.get(runId) === null) return j(404, { error: 'not_found' });
    // The reservation must belong to THIS run (the owner addressed a specific run).
    if (reservations.getById(reservationId)?.run_id !== runId) return j(404, { error: 'not_found' });

    const compute = (): CoreResponse => {
      const now = Date.now();
      const lostRes = reservations.getById(reservationId);
      const skipped = reservations.skipLost(reservationId, now);
      if (!skipped || lostRes === null) {
        const state = reservations.getById(reservationId)?.state ?? 'missing';
        return j(409, { error: 'conflict', reason: `reservation is ${state}, not response_lost` });
      }
      // Round-B NEW-6 (§13 "pull: the fetch_cursor advances past it") — a skip
      // is a PERMANENT gap: advance the pull cursor past the skipped position
      // (no produced count) so the pacer fetches the NEXT position and a late
      // provider replay of the skipped item is never admitted. (An owner who
      // wants the provider's retry uses RESUME instead — that leaves the
      // cursor parked on the lost position.)
      // B-04 — multiple UNORDERED losses: an out-of-order skip (cursor ahead of
      // the run cursor) is a no-op CAS; when the CURRENT position is skipped,
      // advance through EVERY contiguous already-skipped cursor so the run can
      // never resume onto a position the owner permanently skipped.
      if (runs.advanceCursorPastSkipped(runId, lostRes.cursor, now)) {
        const skippedCursors = new Set(
          reservations
            .listByRun(runId)
            .filter((r) => r.state === 'skipped')
            .map((r) => r.cursor),
        );
        let cursor = lostRes.cursor + 1;
        while (skippedCursors.has(cursor) && runs.advanceCursorPastSkipped(runId, cursor, now)) {
          cursor += 1;
        }
      }
      // Recompute the pause: with the last lost slot resolved, fetch resumes.
      const anyLost = reservations
        .listByRun(runId)
        .some((r) => r.state === 'response_lost');
      const run = runs.getById(runId);
      if (!anyLost && run !== null && run.paused_reason === 'response_lost') {
        runs.setPausedReason(runId, null, now);
      }
      return j(200, { reservation_id: reservationId, state: 'skipped', fetch_resumed: !anyLost });
    };
    const owner = typeof req.callerDID === 'string' && req.callerDID !== '' ? req.callerDID : 'owner';
    return replayOrConflict(
      () =>
        recordOrReplayCommand<CoreResponse>({
          ownerPrincipal: owner,
          runId,
          route: 'skip_lost',
          idempotencyKey: idemKey,
          requestBody: { reservation_id: reservationId },
          compute,
        }).response,
    );
  });
}

/** Shared pause/resume/stop handler (§5.1 state-gated, version-unconditional). */
function steer(
  req: CoreRequest,
  command: 'pause' | 'resume' | 'stop',
  ownerOnlyGuard: OwnerGuard,
): CoreResponse {
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

  // Durable per-command idempotency (§12.5 / VERIF #6): every owner mutation
  // carries a REQUIRED key + is receipted, so a replayed old `resume` can never
  // undo a newer `pause` — even across restart. A keyless mutation is rejected.
  const idemKey = typeof body.idempotency_key === 'string' ? body.idempotency_key : '';
  if (idemKey === '') {
    return j(400, { error: 'invalid', field: 'idempotency_key', reason: 'idempotency_key is required' });
  }
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
