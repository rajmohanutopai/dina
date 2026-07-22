/**
 * WatchService (PSVC-0) — create / pause / resume / cancel a poll-mode watch
 * (PUSH_SERVICES_ARCHITECTURE.md Phase 0 + DINA_WORKFLOW_CONTROL_PLANE §6).
 *
 * A poll-mode watch is a `kind='watch'` row on the existing `workflow_tasks`
 * store (the "declared, unused" anchor the control plane already types) — NOT a
 * new table. Its steady state is `running`; `next_run_at` (SECONDS) drives the
 * scheduler. Pausing clears `next_run_at` (never due); cancelling is a terminal
 * transition. Create is idempotent on the subscriber-owned `subscription_id`.
 *
 * The service never issues the `service.query` itself — the WatchPollSweeper
 * fires due watches through an injected callback (Core stages; Brain/transport
 * sends), keeping Core's no-external-calls rule intact.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { WorkflowTaskKind, WorkflowTaskState, type WorkflowTask } from '../workflow/domain';

import { type WatchFilter } from './filter';
import {
  MIN_POLL_INTERVAL_SEC,
  parseWatchPollPayload,
  serializeWatchPollPayload,
  type WatchPollPayload,
} from './payload';

import type { WorkflowRepository } from '../workflow/repository';


export interface CreatePollWatchInput {
  subscription_id: string;
  persona: string;
  service_uri: string;
  provider_did: string;
  capability: string;
  query?: Record<string, unknown>;
  poll_interval_sec: number;
  /** The provider's published schema hash, pinned at subscribe time and
   *  forwarded on every poll (else a schema-publishing provider rejects the
   *  poll as `schema_hash_required`). Omit when the provider publishes none. */
  schema_hash?: string;
  /** The provider's declared freshness (its capability `defaultTtlSeconds`),
   *  pinned from discovery. The poll interval is floored at it — polling faster
   *  than the data changes is pure waste (and pure cost). Omit when unknown. */
  freshness_sec?: number;
  condition?: string;
  /** R2-04 — optional executable wake filter (fire only when a poll result
   *  matches; absent = fire on every resolved poll). */
  filter?: WatchFilter;
}

export interface WatchServiceOptions {
  repository: WorkflowRepository;
  /** Wall-clock (ms). Default `Date.now`. */
  nowMsFn?: () => number;
  /** Opaque watch-task id minter. Default mints a random id (the task PK is
   *  decoupled from `subscription_id` so a re-subscribe after cancel — which
   *  reuses the terminal row's natural key — never PK-collides). Dedup is via
   *  the `watch:<subscription_id>` idempotency key, not the id. */
  idFn?: () => string;
}

/** The idempotency key for a subscription's watch task. */
export function watchIdempotencyKey(subscriptionId: string): string {
  return `watch:${subscriptionId}`;
}

export class WatchService {
  private readonly repo: WorkflowRepository;
  private readonly now: () => number;
  private readonly idFn: () => string;

  constructor(opts: WatchServiceOptions) {
    if (!opts.repository) throw new Error('WatchService: repository is required');
    this.repo = opts.repository;
    this.now = opts.nowMsFn ?? (() => Date.now());
    this.idFn = opts.idFn ?? (() => `watch-${bytesToHex(randomBytes(12))}`);
  }

  /**
   * Create (or return the existing) poll-mode watch for a subscription.
   * Idempotent on `subscription_id`: a repeat returns the live watch unchanged.
   * The first poll is scheduled `poll_interval_sec` out (clamped to the floor).
   */
  createPollWatch(input: CreatePollWatchInput): WorkflowTask {
    const idemKey = watchIdempotencyKey(input.subscription_id);
    const existing = this.repo.getActiveByIdempotencyKey(idemKey);
    if (existing !== null) return existing;

    // Never poll faster than (a) the hard floor, or (b) the provider's declared
    // freshness — asking again before the data can have changed only burns cost.
    const freshnessFloor =
      typeof input.freshness_sec === 'number' && input.freshness_sec > 0
        ? Math.floor(input.freshness_sec)
        : 0;
    const intervalSec = Math.max(
      MIN_POLL_INTERVAL_SEC,
      freshnessFloor,
      Math.floor(input.poll_interval_sec),
    );
    const nowMs = this.now();
    const nowSec = Math.floor(nowMs / 1000);
    const payload: WatchPollPayload = {
      type: 'watch_poll',
      subscription_id: input.subscription_id,
      persona: input.persona,
      service_uri: input.service_uri,
      provider_did: input.provider_did,
      capability: input.capability,
      query: input.query ?? {},
      poll_interval_sec: intervalSec,
      ...(input.schema_hash !== undefined && input.schema_hash !== ''
        ? { schema_hash: input.schema_hash }
        : {}),
      ...(input.condition !== undefined ? { condition: input.condition } : {}),
      ...(input.filter !== undefined ? { filter: input.filter } : {}),
    };

    const task: WorkflowTask = {
      id: this.idFn(),
      kind: WorkflowTaskKind.Watch,
      status: WorkflowTaskState.Running,
      priority: 'background',
      description: `Poll watch: ${input.capability} @ ${input.provider_did}`,
      payload: serializeWatchPollPayload(payload),
      result_summary: '',
      policy: '{}',
      origin: 'system',
      idempotency_key: idemKey,
      next_run_at: nowSec + intervalSec,
      created_at: nowMs,
      updated_at: nowMs,
    };
    this.repo.create(task);
    const created = this.repo.getById(task.id);
    return created ?? task;
  }

  /** Pause polling — clears `next_run_at` so the sweeper never fires it.
   *  Returns true iff a running watch was paused. */
  pause(watchId: string): boolean {
    return this.repo.setWatchNextRun(watchId, null, this.now());
  }

  /** Resume polling — schedules the next poll `poll_interval_sec` out.
   *  Returns true iff a running watch was resumed. */
  resume(watchId: string): boolean {
    const task = this.repo.getById(watchId);
    if (task === null || task.kind !== WorkflowTaskKind.Watch) return false;
    const payload = parseWatchPollPayload(task.payload);
    if (payload === null) return false;
    const nowMs = this.now();
    const nowSec = Math.floor(nowMs / 1000);
    return this.repo.setWatchNextRun(watchId, nowSec + payload.poll_interval_sec, nowMs);
  }

  /** Cancel a watch (terminal). Returns true iff a running watch was cancelled. */
  cancel(watchId: string): boolean {
    return this.repo.transition(
      watchId,
      WorkflowTaskState.Running,
      WorkflowTaskState.Cancelled,
      this.now(),
    );
  }

  /** List the live (running) watches. */
  listActive(limit = 100): WorkflowTask[] {
    return this.repo.listByKindAndState(WorkflowTaskKind.Watch, WorkflowTaskState.Running, limit);
  }

  /** R2-04 / R3-02 — resolve the DELIVERY POLICY for a subscription at delivery
   *  time. EXACT lookup by the subscription's idempotency key (not a bounded page
   *  scan), so a cancelled/unknown watch returns `{ active: false }` — which the
   *  pipeline treats as suppress (instant cancel + default silence), NOT the
   *  ambiguous "undefined = fire always". `filter` is present only for an active,
   *  filtered watch. */
  deliveryPolicyFor(subscriptionId: string): { active: boolean; filter?: WatchFilter } {
    const task = this.repo.getActiveByIdempotencyKey(watchIdempotencyKey(subscriptionId));
    if (task === null) return { active: false };
    // R4-04 — a PAUSED watch stays `running` but with `next_run_at` cleared. A
    // response still in flight when the owner paused must NOT surface, so a paused
    // watch reports inactive (fail closed) — consistent with the cancelled case.
    if (task.next_run_at === undefined || task.next_run_at <= 0) return { active: false };
    // R5-07 — a corrupt stored payload (incl. a present-but-invalid filter, which
    // fails the whole parse) reports INACTIVE rather than active-and-unfiltered,
    // so a malformed condition can never be reinterpreted as "fire always".
    const payload = parseWatchPollPayload(task.payload);
    if (payload === null) return { active: false };
    return { active: true, ...(payload.filter !== undefined ? { filter: payload.filter } : {}) };
  }
}

let service: WatchService | null = null;
export function setWatchService(s: WatchService | null): void {
  service = s;
}
export function getWatchService(): WatchService | null {
  return service;
}
