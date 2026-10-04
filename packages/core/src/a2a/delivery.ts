/**
 * Task-event delivery for Lane 2 (design §7.5): Core's outbox of the events
 * an outside client's streams and webhooks receive.
 *
 * Recording. `recordInboundChange` is the one writer. It runs inside the
 * transaction that changed a task (a commit, a new child, a claim, a
 * requeue, a settle) and compares what the client would now see
 * (`projectInboundTask`, the projection GetTask uses) with what the task's
 * last event reported. A difference is one change: the task's status time
 * moves to now, and its events (an `artifactUpdate` for a result, then a
 * `statusUpdate`) are written once per target: the task's streams (`''`)
 * and each webhook config. The same change seen twice writes nothing, so
 * every path, the repair sweep included, may call it.
 *
 * Claiming. The gateway claims due rows under a lease, oldest first, one
 * target's events in order. Every claim re-checks the egress (§7.3: the
 * client active, its grant live, the listing the call was made to still
 * there): a task whose egress is lost has its result ended for good and
 * every waiting event suppressed, and its streams are closed. A task whose
 * client cannot authenticate for now (a DID client whose key left its
 * document) is held: its streams are closed, and its waiting events wait
 * (`SUSPENDED_HOLD_MS` at a time) until the owner binds the client again,
 * or revokes it. A webhook's address and credentials leave Core only inside
 * a claim.
 *
 * Reporting. The gateway reports each claimed row, compare-and-set on the
 * claim. A webhook worth retrying waits 5 s, 30 s, 2 min, 10 min, then
 * 30 min; its sixth failure is final (A2A §4.3.3: at least once, retries
 * with backoff, a bounded number). A lapsed lease returns the row to the
 * next claim, so state survives a gateway restart.
 */

import { type DeliveryAck, type DeliveryClaim, type DeliveryItem, type DeliveryWebhook, type JsonObject } from '@dina/a2a';

import { WorkflowTaskState } from '../workflow/domain';

import { INBOUND_EFFECTFUL_CLASSES } from './action_registry';
import { inboundChangeSignal } from './change_signal';
import { a2aPrincipal, credentialGenOf, endExpiredBearers, streamClientKeyOf } from './clients';
import { newA2AId } from './ids';
import {
  inboundEgressHeld,
  inboundEgressLoss,
  inboundViewKey,
  projectInboundTask,
  readInboundSnapshot,
  type InboundCore,
} from './inbound_view';
import { webhookHeaders } from './push_configs';

import type { A2ATaskRow, OutboxRow } from './store';
import type { WorkflowTask } from '../workflow/domain';

/** How long a claimed event is the claimant's before another claim may take it. */
export const DELIVERY_LEASE_MS = 30_000;
/**
 * A claim's rounds. Each reads due rows, and every row it sees is claimed or
 * leaves the due set (for good, or for a hold), so a claim binds on this
 * only when more than 16 × 100 dead or held rows come before a live one; the
 * next claim carries on from there.
 */
const MAX_CLAIM_ROUNDS = 16;
/** The fewest rows a round reads, so a backlog of dead rows costs few queries. */
const MIN_CLAIM_BATCH = 100;
/** How long a held task's events wait before a claim looks at its client again. */
export const SUSPENDED_HOLD_MS = 60_000;


/** The wait before each retry of a webhook event; one more failure is final. */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = Object.freeze([5_000, 30_000, 120_000, 600_000, 1_800_000]);

/** The events one change of a task produces, in the order a client must see them (A2A §3.5.2). */
function changeEvents(rt: InboundCore, op: Parameters<typeof projectInboundTask>[1]): JsonObject[] {
  const task = projectInboundTask(rt, op);
  const ids = { taskId: task.id, contextId: task.contextId ?? '' };
  const events: JsonObject[] = [];
  for (const artifact of task.artifacts ?? []) {
    events.push({ artifactUpdate: { ...ids, artifact, lastChunk: true } as unknown as JsonObject });
  }
  events.push({
    statusUpdate: {
      ...ids,
      status: task.status,
      ...(task.metadata === undefined ? {} : { metadata: task.metadata }),
    } as unknown as JsonObject,
  });
  return events;
}

/**
 * A new task's first view: its creator answers it (SendMessage's Task, a
 * stream's opening Task), so it is no event; noting it makes the next
 * change one. Call inside the commit that creates the task.
 *
 * A task with no note at all (one created before migration v57, or by a
 * path that forgot to note it) has its next change recorded as an event:
 * an extra event is harmless, a lost one is not.
 */
export function noteInboundCreated(rt: InboundCore, opId: number): void {
  const op = rt.a2a.store.getTask(opId);
  if (op === null || op.direction !== 'inbound') return;
  rt.a2a.store.setEventCursor(op.id, op.event_seq, inboundViewKey(projectInboundTask(rt, op)));
}

/**
 * Record what a client could now see of one inbound task, if it changed
 * (see the module comment). Call inside the transaction that made the
 * change; it opens none of its own.
 */
export function recordInboundChange(rt: InboundCore, opId: number): void {
  const store = rt.a2a.store;
  const op = store.getTask(opId);
  if (op === null || op.direction !== 'inbound') return;
  const key = inboundViewKey(projectInboundTask(rt, op));
  if (op.event_state === key) return;
  const now = rt.a2a.nowMs();
  // A visible change: its time is now (the event's timestamp, ListTasks' order).
  if (op.status_updated_at !== now) store.updateTask(op.id, [op.state], { status_updated_at: now }, now);
  const events = changeEvents(rt, { ...op, status_updated_at: now });
  const webhooks = store.pushConfigsOf(op.id);
  let seq = op.event_seq;
  for (const event of events) {
    seq += 1;
    const row = {
      operation_ref: op.id,
      source_event_id: `${op.external_id}#${seq}`,
      seq,
      event_json: JSON.stringify(event),
      created_at: now,
    };
    store.insertOutboxRow({ ...row, target_kind: 'sse', target_id: '' });
    for (const hook of webhooks) store.insertOutboxRow({ ...row, target_kind: 'webhook', target_id: hook.id });
  }
  store.setEventCursor(op.id, seq, key);
  // A SendMessage waiting on the task looks again once this commit is done.
  inboundChangeSignal(store).notify(op.id);
}

/**
 * End for good a task whose egress is lost (§7.3), the same way from every
 * path that finds it (a read, a claim, the sweep). Two kinds of task hold
 * something for the caller: a completed result, which stays the owner's
 * while the task becomes the neutral end settle would have given it
 * (`outcome_unknown` for an effectful call, whose effect ran, else
 * `failed`); and a question a round asks the caller (§7.7), which is not
 * shown again: the task ends `failed` (asking is only ever pre-effect) and
 * its waiting round is retired, since no answer could let it run. Either
 * change is recorded. Returns the task as it now stands, or null when its
 * egress holds. Opens its own transaction; inside one, it joins it.
 *
 * The loss is final, so the next claim finds it too: that claim suppresses
 * the task's waiting events, the change recorded here among them, and tells
 * the gateway to close the task's streams.
 */
export function endLostEgress(rt: InboundCore, op: A2ATaskRow): A2ATaskRow | null {
  if (op.direction !== 'inbound') return null;
  const snapshot = readInboundSnapshot(op);
  if (snapshot !== null && inboundEgressLoss(rt, op, snapshot) === null) return null;
  return rt.a2a.store.transaction(() => {
    const store = rt.a2a.store;
    const now = rt.a2a.nowMs();
    const effectful = snapshot !== null && INBOUND_EFFECTFUL_CLASSES.has(snapshot.action_class);
    if (store.updateTask(op.id, ['completed'], { state: effectful ? 'outcome_unknown' : 'failed', reason_code: 'authority_revoked' }, now)) {
      recordInboundChange(rt, op.id);
    } else if (op.input_required_json !== null && op.internal_id !== null) {
      const waiting = rt.a2a.workflow.store().getById(op.internal_id);
      // The question goes with it: an ended task asks nothing, and keeps no question to show.
      const ended = { state: 'failed', reason_code: 'authority_revoked', input_required_json: null } as const;
      if (waiting?.status === WorkflowTaskState.Awaiting && store.updateTask(op.id, ['open'], ended, now)) {
        rt.a2a.workflow.cancel(waiting.id, 'a2a_authority_revoked');
        recordInboundChange(rt, op.id);
      }
    }
    return store.getTask(op.id);
  });
}

/**
 * The workflow repository's requeue observer for inbound children: a child
 * whose lease lapsed before any effect goes back to the queue, and its task
 * reads SUBMITTED again. Runs inside the repository's transaction.
 */
export function inboundRequeueObserver(core: () => InboundCore | null): (task: WorkflowTask) => void {
  return (task) => {
    const rt = core();
    if (rt === null) return;
    const link = rt.a2a.store.getChild(task.id);
    if (link === null || link.role !== 'execution') return;
    const op = rt.a2a.store.getTask(link.operation_ref);
    if (op === null || op.direction !== 'inbound' || op.state !== 'open' || op.internal_id !== task.id) return;
    recordInboundChange(rt, op.id);
  };
}

/**
 * Claim the events due for delivery (see the module comment): every due
 * stream event, oldest first, up to `limit`; and the next event of up to
 * `webhookLimit` webhooks, taken in turn across clients. `webhookLimit` is
 * how many POSTs the claimant can start now, so none waits in its queue
 * while its lease runs out. Stream and webhook rows are found by separate
 * queries, so neither kind's backlog can crowd out the other.
 *
 * Each task's egress is checked once per claim (§7.3): a task whose egress
 * is lost is ended for good, its waiting events suppressed and its streams
 * closed.
 */
export function claimDeliveries(
  rt: InboundCore,
  args: { claimant: string; limit: number; webhookLimit: number },
): DeliveryClaim {
  const store = rt.a2a.store;
  return store.transaction(() => {
    const now = rt.a2a.nowMs();
    const items: DeliveryItem[] = [];
    // A bearer that ran out ended what it set up (§10), before anything here is handed out.
    endExpiredBearers(store, now);
    // The fences of clients whose credential ended lately, in every claim while they hold:
    // the gateway applies them before it publishes this claim's events.
    const fenced = store
      .streamFences(now)
      .map((f) => ({ client: streamClientKeyOf(a2aPrincipal(f.client_id)), before_gen: f.credential_gen }));
    const closed = new Set<string>();
    // Each stream event carries its client's credential generation (§10): an older stream ends instead of getting it.
    const gens = new Map<string, number>();
    const genOf = (principal: string): number => {
      let gen = gens.get(principal);
      if (gen === undefined) {
        gen = credentialGenOf(store, principal);
        gens.set(principal, gen);
      }
      return gen;
    };
    // Each task's egress is checked once per claim; a lost one is ended here.
    const lost = new Map<number, boolean>();
    const egressLost = (op: A2ATaskRow): boolean => {
      let known = lost.get(op.id);
      if (known === undefined) {
        known = endLostEgress(rt, op) !== null;
        lost.set(op.id, known);
        if (known) {
          store.suppressOutbox(op.id);
          closed.add(op.external_id);
        }
      }
      return known;
    };
    // A held task's events wait, in order, out of the due set; its streams close.
    const held = new Map<number, boolean>();
    const egressHeld = (op: A2ATaskRow): boolean => {
      let known = held.get(op.id);
      if (known === undefined) {
        const snapshot = readInboundSnapshot(op);
        known = snapshot !== null && inboundEgressHeld(rt, snapshot);
        held.set(op.id, known);
        if (known) {
          store.deferOutbox(op.id, now + SUSPENDED_HOLD_MS, now);
          closed.add(op.external_id);
        }
      }
      return known;
    };
    /**
     * Fill up to `want` claims from `due`. Every row a round sees is claimed
     * or leaves the due set: for good (its task's egress lost, its config
     * gone) or for a hold (its client cannot authenticate for now; a lapsed
     * claim of the task is given back and held with the rest). So each
     * round fills the window or shrinks what is due, and a backlog of dead
     * or held rows never keeps a live task's events out of a claim.
     * A round reads at least `MIN_CLAIM_BATCH` rows, so dead rows cost few
     * queries.
     */
    const fill = (due: (n: number) => OutboxRow[], want: number): void => {
      let taken = 0;
      for (let round = 0; taken < want && round < MAX_CLAIM_ROUNDS; round += 1) {
        const batch = due(Math.max(want - taken, MIN_CLAIM_BATCH));
        if (batch.length === 0) return;
        for (const row of batch) {
          const op = store.getTask(row.operation_ref);
          if (op === null) {
            store.suppressOutboxRow(row.id);
            continue;
          }
          if (egressLost(op) || egressHeld(op)) continue;
          if (taken >= want) break;
          let webhook: DeliveryWebhook | undefined;
          if (row.target_kind === 'webhook') {
            const config = store.getPushConfig(op.id, row.target_id);
            if (config === null) {
              store.suppressOutboxRow(row.id);
              continue;
            }
            webhook = { url: config.url, headers: webhookHeaders(config) };
          }
          const claimId = newA2AId();
          if (!store.claimOutboxRow(row.id, claimId, args.claimant, now + DELIVERY_LEASE_MS, now)) continue;
          taken += 1;
          const base = { id: row.id, claim_id: claimId, task_id: op.external_id, seq: row.seq, event: JSON.parse(row.event_json) as JsonObject };
          items.push(
            webhook === undefined
              ? { ...base, target: 'sse', credential_gen: genOf(op.principal) }
              : { ...base, target: 'webhook', webhook },
          );
        }
      }
    };
    fill((n) => store.dueStreamRows(now, n), args.limit);
    fill((n) => store.dueWebhookHeads(now, n), args.webhookLimit);
    return { items, closed: [...closed], fenced };
  });
}

/** Apply the gateway's reports; returns how many held (a stale or foreign claim changes nothing). */
export function ackDeliveries(rt: InboundCore, args: { claimant: string; acks: readonly DeliveryAck[] }): number {
  const store = rt.a2a.store;
  return store.transaction(() => {
    const now = rt.a2a.nowMs();
    let applied = 0;
    for (const ack of args.acks) {
      const row = store.getOutboxRow(ack.id);
      if (row === null) continue;
      const claim = { claimId: ack.claim_id, claimant: args.claimant };
      let to: Parameters<typeof store.settleOutboxRow>[2];
      if (ack.outcome === 'retry') {
        const delay = WEBHOOK_RETRY_DELAYS_MS[row.attempts - 1];
        to = row.target_kind === 'webhook' && delay !== undefined ? { status: 'pending', nextAttemptAt: now + delay } : { status: 'failed' };
      } else {
        to = { status: ack.outcome };
      }
      if (store.settleOutboxRow(row.id, claim, to)) applied += 1;
    }
    return applied;
  });
}
