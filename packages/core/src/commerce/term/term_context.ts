/**
 * What every part of the term engine shares (SHELF_SPACE_NEGOTIATION §5, §7):
 * its injected dependencies, the clock and timings, and the three outward
 * acts — record a send intent, send a receipt, raise or close an owner card.
 *
 * INJECTED, NOT IMPORTED. The transport (the D2D sender), the owner's inbox
 * (the workflow service), the contact list and the pack registry each belong
 * to another subsystem; the engine is handed small ports to them, so it can
 * be exercised end to end in a test with two engines wired to each other.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import {
  sealTermRecord,
  type Sha256Fn,
  type TermPackRef,
  type TermReceipt,
  type TermReceiptOutcome,
} from '@dina/commerce-protocol';

import { AfterCommit, DELIVERY_TIMINGS, Outbox } from '../../commitment';

import type { OwnerCardPort, OwnerCardSpec, ValueModel } from '../../commitment';
import type { StrategySettings } from '../../commitment/strategy_store';
import type { NegotiationSubmitter } from '../../commitment/strategy_submit';
import type { FirstPartyPackEntry } from '../first_party_packs';
import type { TermStore } from './term_store';

export const hash: Sha256Fn = (data) => sha256(data);

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** §5.3 / §9 timings. The resend schedule is the kernel's (`DELIVERY_TIMINGS`). */
export const TERM_TIMINGS = {
  ...DELIVERY_TIMINGS,
  /**
   * Agreement documents stop resending after 33 days, not §5.3's 30. The
   * receiver may hold a document for 30 days from its ARRIVAL (`heldForMs`)
   * and then refuse it; arrival trails sending by up to two days (a day in the
   * relay, then resends). The sender must still be resending, once a day, when
   * that refusal can come, or one lost receipt leaves its owner told "not
   * delivered" for a document the other side received.
   */
  agreementResendForMs: 33 * DAY_MS,
  /** A request's default deadline for a first offer (§5.3). */
  requestRespondByMs: 3 * DAY_MS,
  /** An offer's default life (§9). */
  offerValidForMs: 3 * DAY_MS,
  /** A counter's default deadline (§9). */
  counterRespondByMs: 12 * HOUR_MS,
  /** A proposal may arrive up to 7 days after its offer's `valid_until` (§7.1 step 5). */
  proposalArrivalGraceMs: 7 * DAY_MS,
  /** The store's card for a proposal lapses 3 days after arrival (§7.1 step 5). */
  decideByMs: 3 * DAY_MS,
  /**
   * A termination's notice runs from its `terminated_at`, which the sender
   * writes. The receiver accepts that date only if the document reached it
   * within 3 days of it (a day in the relay, then 6-hourly resends), and not
   * from the future beyond a clock's drift. Otherwise a party could backdate a
   * termination and skip the exit notice. A refused one is refused on both
   * sides (`refusedByPeer`), and the owner terminates again with notice from now.
   */
  terminationArrivalWindowMs: 3 * DAY_MS,
  clockDriftMs: 5 * 60 * 1000,
  /** A document held for a prerequisite is refused after 30 days (§5.3). */
  heldForMs: 30 * DAY_MS,
  /** The brand's loop deadline, default and ceiling (§9). */
  brandDeadlineDefaultMs: 3 * DAY_MS,
  brandDeadlineMaxMs: 7 * DAY_MS,
} as const;

export function mintId(prefix: string): string {
  return `${prefix}-${bytesToHex(randomBytes(12))}`;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** An owner card the engine raises: the kernel's card port (`commitment/cards.ts`). */
export type TermCardSpec = OwnerCardSpec;
export type TermCardPort = OwnerCardPort;

/** The term half this node has active. Its pinned parameters are on `entry`. */
export interface ActiveTermPack {
  entry: FirstPartyPackEntry;
  installId: string;
}

/** The commerce runtime's ONE transaction coordinator (`CommerceTransaction`). */
export interface TermTransaction {
  atomically<T>(label: string, body: () => T): T;
}

export interface TermEngineDeps {
  store: TermStore;
  /** For the acts that must land together. `TermContext.atomically` never nests it. */
  transaction: TermTransaction;
  selfDid: () => string;
  now: () => number;
  /** The active first-party term half for a role, or null (pack absent, paused, revoked). */
  activePack: (role: 'term_seller' | 'term_buyer') => ActiveTermPack | null;
  /**
   * Is the half installed at all — active or PAUSED by a hold it can come back
   * from (the owner, an advisory, a restore), as opposed to revoked, never
   * installed, or held for a revoked device (which no resume lifts)?
   * A paused half keeps its listings: its requests are refused on arrival, and
   * resuming makes them live again. Only a gone half's listings are withdrawn.
   */
  packHeld: (role: 'term_seller' | 'term_buyer') => boolean;
  /**
   * Is the Commerce Pack active on this node (`runtime.money()`)? Shelf
   * settlements go through it, so a new shelf deal binds only when it is
   * (COMMITMENT_KERNEL §12; `term_money.ts`).
   */
  moneyAvailable: () => boolean;
  /**
   * The owner's value model for a deal kind (COMMITMENT_KERNEL §7), and the
   * personas, closed now, whose entries cover a part in `touches`. Absent or
   * null: no model beyond the shelf limits.
   */
  valueModels?: (kind: string, touches: readonly string[]) => { model: ValueModel; closedPersonas: string[] } | null;
  /**
   * The strategy slot (COMMITMENT_KERNEL §11): who fills it per kind, the
   * verdict budgets, and the door to the reasoning backend. Absent: the
   * pack's fixed style plays every turn, as before.
   */
  strategy?: {
    settings: (kind: string) => StrategySettings;
    charge: (args: {
      kind: string;
      negotiationId: string;
      count: number;
      nowMs: number;
      thresholdVersion: number;
    }) => { ok: true } | { ok: false; spent: 'negotiation' | 'owner' };
    submit: NegotiationSubmitter;
    /** Any budget left, checked before Brain is asked (a spent one retires Brain). */
    canSpend: (args: { kind: string; negotiationId: string; nowMs: number; thresholdVersion: number }) =>
      | { ok: true }
      | { ok: false; spent: 'negotiation' | 'owner' };
    /** The model as Brain may see it: untagged entries and Brain-readable personas only. */
    brainModel: (kind: string) => ValueModel | null;
  };
  /** Is this DID one of the owner's contacts? (§6.2 — contacts skip the stranger card.) */
  isContact: (did: string) => boolean;
  /** Has the owner blocked this DID? A blocked peer passes no term gate. */
  isBlocked: (did: string) => boolean;
  /** Best-effort push of one term document as a `commerce.trade` message. */
  send: (toDid: string, kind: string, document: unknown) => Promise<boolean>;
  cards: TermCardPort;
  /** §5.3 probing budget: true when this request or counter may spend it. */
  spendProbing: (fromDid: string, nowMs: number) => boolean;
  /** Errors from best-effort sends; metadata only. */
  log?: (event: string, fields: Record<string, string | number>) => void;
}

/** Shared helpers over the deps. */
export class TermContext {
  /**
   * Effects outside this node's database — a send, a receipt, a card raised in
   * the workflow — wait for the open transaction to commit (`AfterCommit`).
   * Every effect has a durable row behind it (an outbox intent, an answer, a
   * kept card) that the sweep can act on again if the process dies first.
   */
  private readonly effects: AfterCommit;
  readonly outbox: Outbox;

  constructor(readonly deps: TermEngineDeps) {
    this.effects = new AfterCommit(deps.transaction, 'term');
    this.outbox = new Outbox({
      outbox: deps.store,
      effects: this.effects,
      // Through `deps` at call time: a test may swap the sender after building.
      send: (toDid, kind, document) => this.deps.send(toDid, kind, document),
      now: () => this.deps.now(),
    });
  }

  get store(): TermStore {
    return this.deps.store;
  }

  now(): number {
    return this.deps.now();
  }

  /**
   * Run `body` in one transaction, then the outside effects it queued. Called
   * inside another act, it joins that act's transaction: the outer act commits
   * both or neither.
   */
  atomically<T>(label: string, body: () => T): T {
    return this.effects.atomically(label, body);
  }

  /** Run an outside effect now, or after the open transaction commits. */
  private afterCommit(effect: () => void): void {
    this.effects.run(effect);
  }

  self(): string {
    return this.deps.selfDid();
  }

  log(event: string, fields: Record<string, string | number> = {}): void {
    this.deps.log?.(event, fields);
  }

  /** The pack ref documents carry for an active half. */
  packRef(pack: ActiveTermPack): TermPackRef {
    const term = pack.entry.term;
    if (term === undefined) throw new Error('term: not a term pack');
    return { plugin_id: term.packId, schema_major: term.schemaMajor };
  }

  /** Record a send intent and try once now (§5.3), through the kernel's outbox. */
  enqueue(args: {
    toDid: string;
    kind: string;
    digest: string;
    document: unknown;
    stopAtMs: number;
  }): void {
    this.outbox.enqueue(args);
  }

  /**
   * Send again a document this node already holds (a resend, or the current
   * head answering a stale counter). Best effort, after any open transaction.
   */
  resend(toDid: string, kind: string, document: unknown, digest?: string): void {
    this.outbox.resend(toDid, kind, document, digest);
  }

  /** Take a card down from the inbox, after any open transaction commits. */
  closeCard(cardId: string, reason: string): void {
    this.afterCommit(() => this.deps.cards.close(cardId, reason));
  }

  /**
   * Raise an owner card: keep it (with its inbox line and payload, so it can
   * be raised again if the inbox was not there yet), then raise it. False when
   * a card with this id already exists — one card per question.
   */
  raiseCard(card: {
    cardId: string;
    type: string;
    requestId: string;
    refDigest: string;
    /** What Core binds the decision to (`materialJson`); defaults to the payload. */
    material?: unknown;
    description: string;
    payload: Record<string, unknown>;
    decideBy: number;
  }): boolean {
    const kept = this.store.putCard({
      cardId: card.cardId,
      cardType: card.type,
      requestId: card.requestId,
      refDigest: card.refDigest,
      state: 'pending',
      materialJson: JSON.stringify(card.material ?? card.payload),
      description: card.description,
      payloadJson: JSON.stringify(card.payload),
      decideBy: card.decideBy,
      createdAt: this.now(),
    });
    if (!kept) return false;
    this.afterCommit(() => {
      this.deps.cards.raise({
        cardId: card.cardId,
        type: card.type,
        description: card.description,
        payload: card.payload,
        expiresAtMs: card.decideBy,
      });
    });
    return true;
  }

  /** Send this node's current answer to an inbound document (§5.3). */
  sendReceipt(args: {
    toDid: string;
    ofDigest: string;
    outcome: TermReceiptOutcome;
    protocolVersion: string;
  }): void {
    const receipt = sealTermRecord(
      'term_receipt',
      {
        protocol_version: args.protocolVersion,
        receipt_id: mintId('trcp'),
        of_digest: args.ofDigest,
        outcome: args.outcome,
        issued_at: iso(this.now()),
      },
      hash,
    ) as unknown as TermReceipt;
    this.outbox.sendOnce(args.toDid, 'term_receipt', receipt);
  }
}
