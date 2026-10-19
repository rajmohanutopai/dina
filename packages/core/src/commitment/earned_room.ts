/**
 * Earned room (COMMITMENT_KERNEL §10 "Earned room", §15 step 13).
 *
 * An automatic limit is the owner's guess before any deal. When the owner
 * keeps saying yes to figures just past it, Core offers to widen it; the
 * owner's yes widens it, and a declined deal inside the wider room or a
 * broken promise in that kind puts the owner's own figure back at once.
 *
 * Plain counting, in Core: no model reads or writes any of it, and Brain
 * takes no part. Each kind that has an automatic limit inside a hard one,
 * with a card between, contributes a `LimitPort`; a limit is a floor (a
 * lower figure gives more away), the only shape the kinds have today.
 *
 * Every write here is synchronous and opens no transaction of its own unless
 * its caller has none: the decision that causes it (an answered card, a
 * broken promise, a declined deal) and what it does to the record land in one
 * transaction, so a crash cannot keep one without the other.
 *
 * Each limit has a generation. The owner's own save of the kind's policy
 * bumps it, and so does any change Core sees in a limit's basis (its figures,
 * currency and unit) that Core did not write itself. A record, an offer and
 * earned room count only in the generation they were made in: an owner who
 * changes a limit, even back to an earlier figure, starts it again.
 *
 * Hard limits, never-rules, the walk-away point and totals never move here.
 */

import { appendAudit } from '../audit/service';
import { WorkflowTaskKind, WorkflowTaskState, type WorkflowTask } from '../workflow/domain';
import {
  getWorkflowService,
  type ApprovalDecisionHandler,
  type WorkflowHooks,
  type WorkflowService,
} from '../workflow/service';

import type { DatabaseAdapter } from '../storage/db_adapter';

/** "Let Dina agree down to this alone?" — Core's words, the owner's yes, in person. */
export const EARNED_ROOM_OFFER_TYPE = 'earned_room_offer';
/** "Dina is back to your own limit" — a notice; answering only marks it seen. */
export const EARNED_ROOM_NOTICE_TYPE = 'earned_room_narrowed';
export const EARNED_ROOM_CARD_TYPES: readonly string[] = [
  EARNED_ROOM_OFFER_TYPE,
  EARNED_ROOM_NOTICE_TYPE,
];

/** Yeses in a row that earn room (owner decision, §16 item 13). */
export const EARN_AFTER_YESES = 5;
/** All of them within this window. */
export const EARN_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

const OFFER_LIFETIME_SEC = 7 * 24 * 60 * 60;
const NOTICE_LIFETIME_SEC = 14 * 24 * 60 * 60;
/** The reason a withdrawn offer's card is cancelled with: not the owner's no. */
const WITHDRAWN = 'withdrawn: a promise in these deals was broken';

export type LimitAnswer = 'yes' | 'no' | 'lapsed';
export type NarrowReason = 'declined' | 'broken';

/** A limit as it stands: its figures, and the basis its generation follows. */
export interface LimitNow {
  hard: bigint;
  auto: bigint;
  /** The figures, currency and unit together. */
  basis: string;
}

/** One kind's automatic limits, as Core reads and writes them. */
export interface LimitPort {
  kind: string;
  /**
   * The limit now; null when it no longer exists. Throws when it cannot be
   * read just now (stored settings that do not validate): nothing is decided
   * on a limit Core cannot see, and the record is left as it is.
   */
  read(limitKey: string): LimitNow | null;
  /** Core's own write of the automatic figure (never counted as the owner's change). */
  writeAuto(limitKey: string, value: bigint, nowMs: number): boolean;
  /** What the figures are, in the owner's words: "offers on the rent for slot-3". */
  describe(limitKey: string): string;
  /** A figure in the owner's words: "INR 2100.00", "12%". */
  format(limitKey: string, value: bigint): string;
}

export interface EarnedRoomRow {
  kind: string;
  limitKey: string;
  state: 'offered' | 'earned' | 'declined' | 'narrowed';
  /** The owner's own automatic figure: what a narrowing puts back. */
  ownerFigure: bigint;
  /** The figure offered or earned. */
  figure: bigint;
  /** The limit's generation the offer was made in. */
  stamp: string;
  cardId: string;
  /** Only cards decided after this count toward the next offer; for an earned row, when it was earned. */
  since: number;
  /** A narrowing whose notice is still to be raised (no workflow when it was made). */
  noticePending: NarrowReason | '';
}

export class EarnedRoomStore {
  constructor(private readonly db: DatabaseAdapter) {}

  /** For a caller with no transaction of its own (a decision handler, boot). Never nested. */
  atomically(fn: () => void): void {
    this.db.transaction(fn);
  }

  /** A card's answer, once; a replay changes nothing. */
  recordCard(args: {
    kind: string;
    limitKey: string;
    cardId: string;
    figure: bigint;
    stamp: string;
    answer: LimitAnswer;
    decidedAt: number;
  }): boolean {
    return (
      this.db.run(
        `INSERT OR IGNORE INTO commitment_limit_cards
           (kind, limit_key, card_id, figure, stamp, answer, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          args.kind,
          args.limitKey,
          args.cardId,
          args.figure.toString(10),
          args.stamp,
          args.answer,
          args.decidedAt,
        ],
      ) > 0
    );
  }

  /** The latest cards for one limit in one generation, decided after `since`, newest first. */
  latestCards(
    kind: string,
    limitKey: string,
    since: number,
    stamp: string,
    n: number,
  ): { figure: bigint; answer: LimitAnswer; decidedAt: number }[] {
    return this.db
      .query(
        `SELECT figure, answer, decided_at FROM commitment_limit_cards
          WHERE kind = ? AND limit_key = ? AND decided_at > ? AND stamp = ?
          ORDER BY decided_at DESC, card_id DESC LIMIT ?`,
        [kind, limitKey, since, stamp, n],
      )
      .map((r) => ({
        figure: BigInt(String(r.figure)),
        answer: String(r.answer) as LimitAnswer,
        decidedAt: Number(r.decided_at),
      }));
  }

  room(kind: string, limitKey: string): EarnedRoomRow | null {
    const row = this.db.query(
      `SELECT * FROM commitment_earned_room WHERE kind = ? AND limit_key = ?`,
      [kind, limitKey],
    )[0];
    return row === undefined ? null : fromRow(row);
  }

  rooms(kind: string): EarnedRoomRow[] {
    return this.db
      .query(`SELECT * FROM commitment_earned_room WHERE kind = ?`, [kind])
      .map(fromRow);
  }

  putRoom(row: EarnedRoomRow): void {
    this.db.execute(
      `INSERT OR REPLACE INTO commitment_earned_room
         (kind, limit_key, state, owner_figure, figure, stamp, card_id, since, notice_pending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.kind,
        row.limitKey,
        row.state,
        row.ownerFigure.toString(10),
        row.figure.toString(10),
        row.stamp,
        row.cardId,
        row.since,
        row.noticePending,
      ],
    );
  }

  generation(kind: string, limitKey: string): { generation: number; basis: string } | null {
    const row = this.db.query(
      `SELECT generation, basis FROM commitment_limit_generations WHERE kind = ? AND limit_key = ?`,
      [kind, limitKey],
    )[0];
    return row === undefined
      ? null
      : { generation: Number(row.generation), basis: String(row.basis) };
  }

  /** The limits Core keeps a generation for, in one kind. */
  limitKeys(kind: string): string[] {
    return this.db
      .query(`SELECT limit_key FROM commitment_limit_generations WHERE kind = ?`, [kind])
      .map((r) => String(r.limit_key));
  }

  putGeneration(kind: string, limitKey: string, generation: number, basis: string): void {
    this.db.execute(
      `INSERT OR REPLACE INTO commitment_limit_generations (kind, limit_key, generation, basis)
       VALUES (?, ?, ?, ?)`,
      [kind, limitKey, generation, basis],
    );
  }
}

function fromRow(r: Record<string, unknown>): EarnedRoomRow {
  const pending = String(r.notice_pending ?? '');
  return {
    kind: String(r.kind),
    limitKey: String(r.limit_key),
    state: String(r.state) as EarnedRoomRow['state'],
    ownerFigure: BigInt(String(r.owner_figure)),
    figure: BigInt(String(r.figure)),
    stamp: String(r.stamp),
    cardId: String(r.card_id),
    since: Number(r.since),
    noticePending: pending === 'declined' || pending === 'broken' ? pending : '',
  };
}

// ---------------------------------------------------------------------------
// Wiring: the store, each kind's port, and how a broken promise is found
// ---------------------------------------------------------------------------

let installedStore: EarnedRoomStore | null = null;
const ports = new Map<string, LimitPort>();
let brokenCheck: ((kind: string, sinceMs: number) => boolean) | null = null;

export function installEarnedRoomStore(store: EarnedRoomStore | null): void {
  installedStore = store;
}

export function getEarnedRoomStore(): EarnedRoomStore | null {
  return installedStore;
}

/**
 * A kind's limits come online with its runtime. Room it earned is checked
 * then against promises broken since: a narrowing a crash kept from landing
 * is made before the kind decides anything alone (its notice waits for the
 * workflow, and boot raises it).
 */
export function installLimitPort(port: LimitPort, nowMs: number = Date.now()): void {
  ports.set(port.kind, port);
  const store = installedStore;
  if (store === null) return;
  try {
    store.atomically(() => {
      narrowWhereBroken(store, port.kind, nowMs);
    });
  } catch {
    /* the next trigger or boot tries again */
  }
}

export function uninstallLimitPort(kind: string): void {
  ports.delete(kind);
}

/**
 * Was a promise in deals of this kind recorded broken since `sinceMs`? The
 * evidence handler answers; with none installed, Core assumes one was, so
 * nothing is offered on a record it cannot check.
 */
export function installBrokenPromiseCheck(
  check: ((kind: string, sinceMs: number) => boolean) | null,
): void {
  brokenCheck = check;
}

function brokenSince(kind: string, sinceMs: number): boolean {
  return brokenCheck === null || brokenCheck(kind, sinceMs);
}

// ---------------------------------------------------------------------------
// Generations
// ---------------------------------------------------------------------------

/**
 * The owner saved the kind's policy (or published what its limits are
 * measured against). Called in the save's own transaction, after the write:
 * each limit Core keeps a record for is looked at now, and one whose basis
 * moved starts a new generation. A save that leaves a limit as it stands (an
 * edit elsewhere, or the same figures saved again) changes nothing for it,
 * and looking after every save catches a change and a change back.
 */
export function ownerChangedLimits(kind: string): void {
  const store = installedStore;
  if (store === null || !ports.has(kind)) return;
  for (const key of store.limitKeys(kind)) limitStamp(kind, key);
}

/**
 * The limit's generation now: '' when the kind has no limit here; null when
 * it cannot be read just now. A basis Core did not write itself starts a new
 * generation for the limit.
 */
export function limitStamp(kind: string, limitKey: string): string | null {
  const store = installedStore;
  const port = ports.get(kind);
  if (store === null || port === undefined) return '';
  let limit: LimitNow | null;
  try {
    limit = port.read(limitKey);
  } catch {
    return null;
  }
  const seen = store.generation(kind, limitKey);
  if (limit === null) {
    // Gone: the removal is a generation of its own, so a limit made again
    // with the same figures starts a fresh record.
    if (seen !== null && seen.basis !== '')
      store.putGeneration(kind, limitKey, seen.generation + 1, '');
    return '';
  }
  let generation = seen?.generation ?? 1;
  if (seen === null) store.putGeneration(kind, limitKey, generation, limit.basis);
  else if (seen.basis !== limit.basis) {
    generation += 1;
    store.putGeneration(kind, limitKey, generation, limit.basis);
  }
  return String(generation);
}

/** Core wrote the limit itself: its basis moves, its generation does not. */
function coreWrote(store: EarnedRoomStore, port: LimitPort, kind: string, limitKey: string): void {
  const seen = store.generation(kind, limitKey);
  const limit = port.read(limitKey);
  if (limit !== null) store.putGeneration(kind, limitKey, seen?.generation ?? 1, limit.basis);
}

// ---------------------------------------------------------------------------
// Earning
// ---------------------------------------------------------------------------

/**
 * A card raised only because a figure went past an automatic limit was
 * answered. Called inside the transaction that records the answer at its
 * source; a yes may complete a run that earns an offer.
 */
export function recordLimitCard(
  args: {
    kind: string;
    limitKey: string;
    cardId: string;
    figure: bigint;
    /** The limit's generation when the card was raised (`limitStamp`). */
    stamp: string;
    answer: LimitAnswer;
  },
  nowMs: number,
): void {
  const store = installedStore;
  if (store === null || args.stamp === '') return;
  const fresh = store.recordCard({ ...args, decidedAt: nowMs });
  if (fresh && args.answer === 'yes') considerEarning(store, args.kind, args.limitKey, nowMs);
}

/** The offer, raised when the last five cards in this generation were yeses within the window. */
export function considerEarning(
  store: EarnedRoomStore,
  kind: string,
  limitKey: string,
  nowMs: number,
): boolean {
  const port = ports.get(kind);
  const workflow = getWorkflowService();
  if (port === undefined || workflow === null) return false;
  const stamp = limitStamp(kind, limitKey);
  if (stamp === null || stamp === '') return false;
  let limit: LimitNow | null;
  try {
    limit = port.read(limitKey);
  } catch {
    return false;
  }
  if (limit === null) return false;
  let row = store.room(kind, limitKey);
  if (row !== null && row.state === 'offered') {
    // An offer whose card is still open waits for its answer. One whose card
    // closed without settling it (expired, failed) is a no from then on.
    const card = workflow.store().getById(row.cardId);
    const status = card?.status;
    if (
      status === WorkflowTaskState.PendingApproval ||
      status === WorkflowTaskState.Queued ||
      status === WorkflowTaskState.Running
    )
      return false;
    row = { ...row, state: 'declined', since: card?.updated_at ?? row.since };
    store.putRoom(row);
  }
  if (row !== null && row.state === 'earned') {
    // Earned and standing: nothing to offer. A new generation since: the
    // figure is the owner's now, and the record starts again from here.
    if (row.stamp !== stamp) store.putRoom({ ...row, state: 'narrowed', since: nowMs });
    return false;
  }
  const since = row?.since ?? 0;
  const cards = store.latestCards(kind, limitKey, since, stamp, EARN_AFTER_YESES);
  if (cards.length < EARN_AFTER_YESES || cards.some((c) => c.answer !== 'yes')) return false;
  const oldest = Math.min(...cards.map((c) => c.decidedAt));
  const newest = Math.max(...cards.map((c) => c.decidedAt));
  if (oldest < nowMs - EARN_WINDOW_MS) return false;
  // A broken promise in this kind within the window earns nothing; no way to
  // check counts as one.
  if (brokenSince(kind, nowMs - EARN_WINDOW_MS)) return false;
  let figure = limit.auto;
  for (const c of cards) if (c.figure < figure) figure = c.figure;
  if (figure < limit.hard) figure = limit.hard;
  // Only an offer that widens the room.
  if (figure >= limit.auto) return false;
  const tag = hashKey(limitKey);
  const cardId = `earned-room-${kind}-${String(nowMs)}-${tag}`.slice(0, 120);
  const description =
    `You said yes to the last ${String(EARN_AFTER_YESES)} ${port.describe(limitKey)} below your automatic limit, ` +
    `the lowest at ${port.format(limitKey, figure)}. Let Dina agree down to ` +
    `${port.format(limitKey, figure)} alone? Your own limit, ${port.format(limitKey, limit.auto)}, ` +
    `comes back if you decline a deal in the wider room or a promise in these deals is broken.`;
  try {
    workflow.create({
      id: cardId,
      kind: WorkflowTaskKind.Approval,
      description,
      payload: JSON.stringify({
        type: EARNED_ROOM_OFFER_TYPE,
        kind,
        limit_key: limitKey,
        figure: figure.toString(10),
        owner_figure: limit.auto.toString(10),
        stamp,
      }),
      // The limit by its tag only: the key names a slot or an item, and Brain
      // reads a card's idempotency key.
      idempotencyKey: `earned_room:${kind}:${tag}:${String(newest)}`,
      correlationId: EARNED_ROOM_OFFER_TYPE,
      origin: 'system',
      initialState: WorkflowTaskState.PendingApproval,
      expiresAtSec: Math.floor(nowMs / 1000) + OFFER_LIFETIME_SEC,
    });
  } catch {
    return false; // this run already raised its card
  }
  store.putRoom({
    kind,
    limitKey,
    state: 'offered',
    ownerFigure: limit.auto,
    figure,
    stamp,
    cardId,
    since,
    noticePending: '',
  });
  appendAudit('commitment', 'earned_room_offered', kind, `figure=${figure.toString(10)}`);
  return true;
}

/** A short, stable tag for a limit (the key itself names a slot or an item). */
function hashKey(key: string): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// The owner's answer
// ---------------------------------------------------------------------------

interface OfferPayload {
  type: typeof EARNED_ROOM_OFFER_TYPE;
  kind: string;
  limit_key: string;
  figure: string;
  owner_figure: string;
  stamp: string;
}

function parseOffer(text: string): OfferPayload | null {
  try {
    const p = JSON.parse(text) as Partial<OfferPayload>;
    if (
      p.type !== EARNED_ROOM_OFFER_TYPE ||
      typeof p.kind !== 'string' ||
      typeof p.limit_key !== 'string' ||
      typeof p.figure !== 'string' ||
      typeof p.owner_figure !== 'string' ||
      typeof p.stamp !== 'string' ||
      !/^\d{1,30}$/.test(p.figure) ||
      !/^\d{1,30}$/.test(p.owner_figure)
    )
      return null;
    return p as OfferPayload;
  } catch {
    return null;
  }
}

/**
 * Apply an approved offer, checked again as it lands: still the open offer
 * (or one whose row a crash kept from being written), the same generation,
 * the figure inside the hard limit, and no promise in the kind broken in the
 * window. One already applied is recognised by its own row and left as it
 * is. The card completes with what happened; nothing widens on a stale yes.
 */
function settleOffer(
  workflow: WorkflowService,
  store: EarnedRoomStore,
  task: WorkflowTask,
  nowMs: number,
  from: 'queued' | 'running',
): void {
  const p = parseOffer(task.payload);
  if (p === null) return;
  let applied = false;
  let claimed = from === 'running';
  // No port for the kind yet, or a limit that cannot be read just now: the
  // card stays running and boot settles it.
  let later = false;
  store.atomically(() => {
    if (!claimed) {
      try {
        claimed = workflow
          .store()
          .transition(task.id, WorkflowTaskState.Queued, WorkflowTaskState.Running, nowMs);
      } catch {
        claimed = false;
      }
    }
    if (!claimed) return;
    const row = store.room(p.kind, p.limit_key);
    if (row !== null && row.state === 'earned' && row.cardId === task.id) {
      applied = true; // applied before a crash kept the card from closing
      return;
    }
    const port = ports.get(p.kind);
    const stamp = port === undefined ? '' : limitStamp(p.kind, p.limit_key);
    if (port === undefined || stamp === null) {
      later = true;
      return;
    }
    const ours = row !== null && row.state === 'offered' && row.cardId === task.id;
    const limit = stamp === '' ? null : port.read(p.limit_key);
    const figure = BigInt(p.figure);
    if (
      (ours || row === null) &&
      limit !== null &&
      stamp === p.stamp &&
      figure >= limit.hard &&
      figure < limit.auto &&
      !brokenSince(p.kind, nowMs - EARN_WINDOW_MS) &&
      port.writeAuto(p.limit_key, figure, nowMs)
    ) {
      coreWrote(store, port, p.kind, p.limit_key);
      applied = true;
      store.putRoom({
        kind: p.kind,
        limitKey: p.limit_key,
        state: 'earned',
        ownerFigure: BigInt(p.owner_figure),
        figure,
        stamp,
        cardId: task.id,
        since: nowMs,
        noticePending: '',
      });
    } else if (ours && row !== null) {
      store.putRoom({ ...row, state: 'declined', since: nowMs });
    }
  });
  if (!claimed || later) return;
  if (applied) appendAudit('commitment', 'earned_room_widened', p.kind, `figure=${p.figure}`);
  try {
    workflow.complete(
      task.id,
      JSON.stringify({ widened: applied }),
      applied
        ? 'automatic limit widened'
        : 'the limit or the record changed since; nothing widened',
    );
  } catch {
    /* already closed */
  }
}

export function makeEarnedRoomDecisionHandler(deps: {
  store: () => EarnedRoomStore | null;
  workflow: () => WorkflowService | null;
  nowMs: () => number;
}): ApprovalDecisionHandler {
  return ({ task, decision }) => {
    let type: unknown;
    try {
      type = (JSON.parse(task.payload) as { type?: unknown }).type;
    } catch {
      return;
    }
    if (type === EARNED_ROOM_NOTICE_TYPE) {
      closeNotice(deps.workflow(), task, deps.nowMs());
      return;
    }
    const p = parseOffer(task.payload);
    const store = deps.store();
    if (p === null || store === null) return;
    const workflow = deps.workflow();
    if (decision === 'approved') {
      if (workflow !== null) settleOffer(workflow, store, task, deps.nowMs(), 'queued');
      return;
    }
    // A no or a lapse: kept, and the next offer needs five more yeses. A card
    // Core withdrew is already settled (its row moved first): nothing to do.
    const row = store.room(p.kind, p.limit_key);
    if (row === null || row.state !== 'offered' || row.cardId !== task.id) return;
    store.atomically(() => {
      store.putRoom({ ...row, state: 'declined', since: deps.nowMs() });
    });
  };
}

function closeNotice(workflow: WorkflowService | null, task: WorkflowTask, nowMs: number): void {
  if (workflow === null) return;
  try {
    workflow
      .store()
      .transition(task.id, WorkflowTaskState.Queued, WorkflowTaskState.Running, nowMs);
    workflow.complete(task.id, JSON.stringify({ seen: true }), 'seen');
  } catch {
    /* a lapse or a raced close: nothing to do */
  }
}

/** Earned room's contribution to the workflow service, composed at every host. */
export function earnedRoomWorkflowHooks(over: { nowMs?: () => number } = {}): WorkflowHooks {
  return {
    responseEgressGate: () => ({ kind: 'passthrough' }),
    approvalDecisionHandler: makeEarnedRoomDecisionHandler({
      store: getEarnedRoomStore,
      workflow: getWorkflowService,
      nowMs: over.nowMs ?? Date.now,
    }),
  };
}

/**
 * Boot: finish offers the owner approved that a crash left unapplied, take
 * back room in any kind whose promises were broken since it was earned, and
 * raise every narrowing notice that waited for the workflow.
 */
export function reconcileEarnedRoomAtBoot(nowMs: number = Date.now()): number {
  const workflow = getWorkflowService();
  const store = installedStore;
  if (workflow === null || store === null) return 0;
  let n = 0;
  for (const task of workflow.store().getByCorrelationId(EARNED_ROOM_OFFER_TYPE)) {
    if (task.status === WorkflowTaskState.Queued)
      settleOffer(workflow, store, task, nowMs, 'queued');
    else if (task.status === WorkflowTaskState.Running)
      settleOffer(workflow, store, task, nowMs, 'running');
    else continue;
    n += 1;
  }
  for (const [kind, port] of ports) {
    try {
      store.atomically(() => {
        n += narrowWhereBroken(store, kind, nowMs);
        for (const row of store.rooms(kind)) {
          if (row.noticePending === '') continue;
          if (raiseNotice(port, row, row.noticePending, nowMs))
            store.putRoom({ ...row, noticePending: '' });
        }
      });
    } catch {
      /* tried again at the next boot or trigger */
    }
  }
  n += cancelWithdrawnOffers();
  return n;
}

// ---------------------------------------------------------------------------
// Taking it back
// ---------------------------------------------------------------------------

const REASON_WORDS: Record<NarrowReason, string> = {
  declined: 'You declined a deal inside the room Dina had earned.',
  broken: 'A promise in these deals was recorded broken.',
};

/**
 * Put the owner's own figure back for one limit (or every earned limit of the
 * kind), and tell the owner; an offer still open for it is withdrawn (its
 * card is cancelled after the commit, `cancelWithdrawnOffers`). Narrowing only shrinks what Dina may do alone, so it needs
 * no yes. A limit in a new generation is the owner's: it is left as it is.
 * Called inside the transaction that records the trigger.
 */
export function narrowRoom(
  kind: string,
  limitKey: string | null,
  reason: NarrowReason,
  nowMs: number,
): number {
  const store = installedStore;
  const port = ports.get(kind);
  if (store === null || port === undefined) return 0;
  const rows = (limitKey === null ? store.rooms(kind) : [store.room(kind, limitKey)]).filter(
    (r): r is EarnedRoomRow => r !== null,
  );
  let n = 0;
  for (const row of rows) {
    if (row.state === 'offered') {
      // Not earned yet: the open offer is withdrawn, and the record starts
      // again. Its card is cancelled once this transaction has committed
      // (`cancelWithdrawnOffers`): the workflow's cancel is its own write.
      store.putRoom({ ...row, state: 'declined', since: nowMs });
      continue;
    }
    if (row.state !== 'earned') continue;
    const stamp = limitStamp(kind, row.limitKey);
    // Cannot be read just now: the room stands, and the owner's figure is
    // kept; boot and the next install look again for broken promises.
    if (stamp === null) continue;
    if (stamp !== row.stamp) {
      store.putRoom({ ...row, state: 'narrowed', since: nowMs });
      continue;
    }
    if (!port.writeAuto(row.limitKey, row.ownerFigure, nowMs)) continue;
    coreWrote(store, port, kind, row.limitKey);
    const told = raiseNotice(port, row, reason, nowMs);
    store.putRoom({ ...row, state: 'narrowed', since: nowMs, noticePending: told ? '' : reason });
    n += 1;
    appendAudit('commitment', 'earned_room_narrowed', kind, `reason=${reason}`);
  }
  return n;
}

/**
 * Cancel the card of every offer withdrawn while its card still asks: run
 * after the transaction that withdrew it, and at boot. Each cancel is the
 * workflow's own write; the handler then finds the row moved and does nothing.
 */
export function cancelWithdrawnOffers(): number {
  const store = installedStore;
  const workflow = getWorkflowService();
  if (store === null || workflow === null) return 0;
  let n = 0;
  for (const kind of ports.keys()) {
    for (const row of store.rooms(kind)) {
      if (row.state !== 'declined') continue;
      if (workflow.store().getById(row.cardId)?.status !== WorkflowTaskState.PendingApproval)
        continue;
      try {
        workflow.cancel(row.cardId, WITHDRAWN);
        n += 1;
      } catch {
        /* closed meanwhile */
      }
    }
  }
  return n;
}

/** Earned room in a kind whose promises were broken since it was earned goes back. */
function narrowWhereBroken(store: EarnedRoomStore, kind: string, nowMs: number): number {
  let n = 0;
  for (const row of store.rooms(kind)) {
    // Earned: anything broken since it was earned. Offered: anything broken in
    // the window the offer was judged on.
    const from = row.state === 'offered' ? nowMs - EARN_WINDOW_MS : row.since;
    if ((row.state === 'earned' || row.state === 'offered') && brokenSince(kind, from))
      n += narrowRoom(kind, row.limitKey, 'broken', nowMs);
  }
  return n;
}

/** The notice; false when there is no workflow yet to carry it. */
function raiseNotice(
  port: LimitPort,
  row: EarnedRoomRow,
  reason: NarrowReason,
  nowMs: number,
): boolean {
  const workflow = getWorkflowService();
  if (workflow === null) return false;
  const description =
    `Dina is back to your own automatic limit for ${port.describe(row.limitKey)}: ` +
    `${port.format(row.limitKey, row.ownerFigure)}. ${REASON_WORDS[reason]}`;
  try {
    workflow.create({
      id: `earned-room-back-${row.kind}-${String(nowMs)}-${hashKey(row.limitKey)}`.slice(0, 120),
      kind: WorkflowTaskKind.Approval,
      description,
      payload: JSON.stringify({ type: EARNED_ROOM_NOTICE_TYPE, kind: row.kind, reason }),
      correlationId: EARNED_ROOM_NOTICE_TYPE,
      origin: 'system',
      initialState: WorkflowTaskState.PendingApproval,
      expiresAtSec: Math.floor(nowMs / 1000) + NOTICE_LIFETIME_SEC,
    });
  } catch {
    /* the same notice already stands */
  }
  return true;
}

/**
 * Is a deal's figure inside the earned room (past the owner's own figure,
 * within the earned one)? A floor: lower gives more away.
 */
export function insideEarnedRoom(kind: string, limitKey: string, figure: bigint): boolean {
  const row = installedStore?.room(kind, limitKey) ?? null;
  return row !== null && row.state === 'earned' && figure < row.ownerFigure && figure >= row.figure;
}
