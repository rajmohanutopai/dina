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
  condition?: string;
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

    const intervalSec = Math.max(MIN_POLL_INTERVAL_SEC, Math.floor(input.poll_interval_sec));
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
      ...(input.condition !== undefined ? { condition: input.condition } : {}),
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
}

let service: WatchService | null = null;
export function setWatchService(s: WatchService | null): void {
  service = s;
}
export function getWatchService(): WatchService | null {
  return service;
}
