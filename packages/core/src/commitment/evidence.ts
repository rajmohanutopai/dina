/**
 * Evidence for promises and broken links (COMMITMENT_KERNEL §13, §15 step 8).
 *
 * After a deal binds, what each side owes is followed up. The owner's Dina
 * asks "did it happen?" about a promise the other side owes, and records the
 * answer as evidence: who said what, when. A smaller deal's run that broke
 * after binding is evidence against the party that broke it; a lapse under
 * the delivery condition is recorded with no party at fault, with the facts
 * both sides kept.
 *
 * Kept and broken promises are outcome data trust can use. Only a summary
 * ("kept 11 of 12") may ever leave, never a deal's terms, and only once both
 * owners have turned it on for that relationship (§16, item 6). Publishing it
 * to PeerLens is a later step (owner decision, 2026-10-16); this file keeps
 * the record, the consent, and the summary.
 *
 * Kept on the identity database (migration 79). No I/O beyond the store.
 */

import { DELIVERY_DAYS } from '../commerce/deal_kinds';

import type { DatabaseAdapter } from '../storage/db_adapter';

export type EvidenceSubject = 'promise' | 'run';
export type EvidenceOutcome = 'kept' | 'broken' | 'no_fault';

export interface Evidence {
  evidenceId: string;
  counterpartyDid: string;
  /** The deal it belongs to: a term agreement's proposal digest, or a run's quote. */
  dealRef: string;
  subject: EvidenceSubject;
  /** The promise's name, or the run's option id. */
  item: string;
  /** The day it was due (`YYYY-MM-DD`), or `whole` for a promise over the deal. */
  occurrence: string;
  outcome: EvidenceOutcome;
  /** Who it counts against: the counterparty, or nobody (a no-fault lapse; a kept promise). */
  fault: 'counterparty' | 'none';
  /** The owner's answer on a card, or what the protocol itself established. */
  source: 'owner' | 'protocol';
  /** The owner's own words, when they gave any (never sent anywhere). */
  note: string;
  /** Facts kept with it: a run's acceptance time, resends, the shipper's answer. */
  facts: Record<string, string>;
  recordedAt: number;
  amendedAt: number | null;
}

/** One deterministic id per thing due, so asking twice records once. */
export function evidenceId(args: {
  counterpartyDid: string;
  dealRef: string;
  subject: EvidenceSubject;
  item: string;
  occurrence: string;
}): string {
  return [args.subject, args.counterpartyDid, args.dealRef, args.item, args.occurrence].join('|');
}

export class EvidenceStore {
  constructor(private readonly db: DatabaseAdapter) {}

  private row(r: Record<string, unknown> | undefined): Evidence | null {
    if (r === undefined) return null;
    return {
      evidenceId: String(r.evidence_id),
      counterpartyDid: String(r.counterparty_did),
      dealRef: String(r.deal_ref),
      subject: String(r.subject) as EvidenceSubject,
      item: String(r.item),
      occurrence: String(r.occurrence),
      outcome: String(r.outcome) as EvidenceOutcome,
      fault: String(r.fault) as 'counterparty' | 'none',
      source: String(r.source) as 'owner' | 'protocol',
      note: String(r.note),
      facts: JSON.parse(String(r.facts_json)) as Record<string, string>,
      recordedAt: Number(r.recorded_at),
      amendedAt: r.amended_at === null ? null : Number(r.amended_at),
    };
  }

  /** The first record for a thing due stands; a later answer is an amendment. */
  record(e: Omit<Evidence, 'evidenceId' | 'amendedAt'>): Evidence {
    const id = evidenceId(e);
    this.db.execute(
      `INSERT OR IGNORE INTO commitment_evidence
         (evidence_id, counterparty_did, deal_ref, subject, item, occurrence, outcome, fault,
          source, note, facts_json, recorded_at, amended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        id,
        e.counterpartyDid,
        e.dealRef,
        e.subject,
        e.item,
        e.occurrence,
        e.outcome,
        e.fault,
        e.source,
        e.note,
        JSON.stringify(e.facts),
        e.recordedAt,
      ],
    );
    return this.get(id) as Evidence;
  }

  get(id: string): Evidence | null {
    return this.row(
      this.db.query(`SELECT * FROM commitment_evidence WHERE evidence_id = ?`, [id])[0],
    );
  }

  /**
   * The owner corrects or disputes a record they gave: the outcome and their
   * words change, the time it was amended is kept. What the protocol itself
   * established (a no-fault lapse) is not the owner's to change.
   */
  amend(
    id: string,
    change: { outcome: 'kept' | 'broken'; note: string },
    nowMs: number,
  ): Evidence | null {
    const held = this.get(id);
    if (held === null || held.source !== 'owner') return null;
    this.db.execute(
      `UPDATE commitment_evidence SET outcome = ?, fault = ?, note = ?, amended_at = ?
        WHERE evidence_id = ?`,
      [
        change.outcome,
        change.outcome === 'broken' ? 'counterparty' : 'none',
        change.note,
        nowMs,
        id,
      ],
    );
    return this.get(id);
  }

  forCounterparty(counterpartyDid: string): Evidence[] {
    return this.db
      .query(
        `SELECT * FROM commitment_evidence WHERE counterparty_did = ? ORDER BY recorded_at, evidence_id`,
        [counterpartyDid],
      )
      .map((r) => this.row(r) as Evidence);
  }

  /** A "did it happen?" card was raised: remembered until it is settled. */
  noteAsked(cardId: string, payloadJson: string, nowMs: number): void {
    this.db.execute(
      `INSERT OR IGNORE INTO commitment_evidence_asks (card_id, payload_json, asked_at) VALUES (?, ?, ?)`,
      [cardId, payloadJson, nowMs],
    );
  }

  /** Cards raised and not yet settled. */
  openAsks(): { cardId: string; payloadJson: string }[] {
    return this.db
      .query(`SELECT card_id, payload_json FROM commitment_evidence_asks ORDER BY asked_at`)
      .map((r) => ({ cardId: String(r.card_id), payloadJson: String(r.payload_json) }));
  }

  settleAsk(cardId: string): void {
    this.db.execute(`DELETE FROM commitment_evidence_asks WHERE card_id = ?`, [cardId]);
  }

  /** Each owner's own switch, and the other side's word on theirs. */
  consent(counterpartyDid: string): { self: boolean; peer: boolean } {
    const r = this.consentRow(counterpartyDid);
    // After a restore the other side's word is unconfirmed until the reply
    // that echoes the challenge: until then it counts as no.
    return { self: r.selfOn, peer: r.peerOn && !r.askPeer };
  }

  private consentRow(counterpartyDid: string): {
    selfOn: boolean;
    peerOn: boolean;
    told: boolean;
    selfRev: number;
    peerRev: number;
    askPeer: boolean;
    askNonce: string;
    echoNonce: string;
  } {
    const r = this.db.query(
      `SELECT self_on, peer_on, told, self_rev, peer_rev, ask_peer, ask_nonce, echo_nonce
         FROM commitment_evidence_consent
        WHERE counterparty_did = ?`,
      [counterpartyDid],
    )[0];
    return {
      selfOn: Number(r?.self_on ?? 0) === 1,
      peerOn: Number(r?.peer_on ?? 0) === 1,
      told: Number(r?.told ?? 0) === 1,
      selfRev: Number(r?.self_rev ?? 0),
      peerRev: Number(r?.peer_rev ?? 0),
      askPeer: Number(r?.ask_peer ?? 0) === 1,
      askNonce: String(r?.ask_nonce ?? ''),
      echoNonce: String(r?.echo_nonce ?? ''),
    };
  }

  private writeConsent(
    counterpartyDid: string,
    row: {
      selfOn: boolean;
      peerOn: boolean;
      told: boolean;
      selfRev: number;
      peerRev: number;
      askPeer: boolean;
      askNonce: string;
      echoNonce: string;
    },
    nowMs: number,
  ): void {
    this.db.execute(
      `INSERT OR REPLACE INTO commitment_evidence_consent
         (counterparty_did, self_on, peer_on, told, self_rev, peer_rev, ask_peer, ask_nonce,
          echo_nonce, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        counterpartyDid,
        row.selfOn ? 1 : 0,
        row.peerOn ? 1 : 0,
        row.told ? 1 : 0,
        row.selfRev,
        row.peerRev,
        row.askPeer ? 1 : 0,
        row.askNonce,
        row.echoNonce,
        nowMs,
      ],
    );
  }

  /**
   * The owner's own switch: its revision rises — to the time of the change,
   * or one past the last, whichever is larger, so a restore from an older
   * backup can never number a change below one the other side already kept —
   * and the other side is not yet told.
   */
  setOwnConsent(counterpartyDid: string, on: boolean, nowMs: number): void {
    const r = this.consentRow(counterpartyDid);
    const selfRev = Math.max(r.selfRev + 1, nowMs);
    this.writeConsent(counterpartyDid, { ...r, selfOn: on, told: false, selfRev }, nowMs);
  }

  /**
   * The other side's word on its switch: kept only when newer than the last
   * kept, so a delayed or replayed older word never undoes a newer one.
   */
  setPeerConsent(
    counterpartyDid: string,
    on: boolean,
    rev: number,
    replyTo: string,
    nowMs: number,
  ): boolean {
    const r = this.consentRow(counterpartyDid);
    // After a restore this node forgot the other side's word and asked with a
    // challenge. Every newer word is still kept, as unconfirmed (it counts as
    // no until confirmed); the reply that echoes the challenge confirms — and
    // the newest word of all stands, so a reply overtaken by a later
    // revocation never undoes it.
    if (r.askPeer) {
      const newer = rev > r.peerRev;
      const peer = newer ? { peerOn: on, peerRev: rev } : { peerOn: r.peerOn, peerRev: r.peerRev };
      if (r.askNonce !== '' && replyTo === r.askNonce) {
        this.writeConsent(counterpartyDid, { ...r, ...peer, askPeer: false, askNonce: '' }, nowMs);
        return true;
      }
      if (newer) this.writeConsent(counterpartyDid, { ...r, ...peer }, nowMs);
      return false;
    }
    if (rev <= r.peerRev) return false;
    this.writeConsent(counterpartyDid, { ...r, peerOn: on, peerRev: rev }, nowMs);
    return true;
  }

  /**
   * Relationships whose other side has not yet been told this node's current
   * switch, or whose word this node still waits for after a restore (asked
   * again on each tick until an echoing reply comes).
   */
  untold(): { counterpartyDid: string; on: boolean; rev: number; ask: string; echo: string }[] {
    return this.db
      .query(
        `SELECT counterparty_did, self_on, self_rev, ask_peer, ask_nonce, echo_nonce
           FROM commitment_evidence_consent WHERE told = 0 OR ask_peer = 1`,
      )
      .map((r) => ({
        counterpartyDid: String(r.counterparty_did),
        on: Number(r.self_on) === 1,
        rev: Number(r.self_rev),
        ask: Number(r.ask_peer) === 1 ? String(r.ask_nonce) : '',
        echo: String(r.echo_nonce),
      }));
  }

  /**
   * The other side restored from a backup and asks for this node's switch,
   * with a challenge: the switch is sent again, echoing it. A node that never
   * set its switch answers that it is off.
   */
  markAsked(counterpartyDid: string, nonce: string, nowMs: number): void {
    const r = this.consentRow(counterpartyDid);
    this.writeConsent(
      counterpartyDid,
      { ...r, told: false, echoNonce: nonce, selfRev: Math.max(r.selfRev, 1) },
      nowMs,
    );
  }

  /** The other side took this revision of the switch. */
  told(counterpartyDid: string, rev: number): void {
    this.db.execute(
      `UPDATE commitment_evidence_consent SET told = 1, echo_nonce = ''
        WHERE counterparty_did = ? AND self_rev = ?`,
      [counterpartyDid, rev],
    );
  }
}

/**
 * The summary of one relationship: promises the other side kept, of those it
 * owed and was answered on. A no-fault lapse counts neither way. `shareable`
 * only when both owners turned it on for this relationship; even then it is
 * the counts alone, never what was promised.
 */
export function promiseSummary(
  evidence: readonly Evidence[],
  consent: { self: boolean; peer: boolean },
): { kept: number; of: number; noFault: number; shareable: boolean } {
  let kept = 0;
  let broken = 0;
  let noFault = 0;
  for (const e of evidence) {
    if (e.outcome === 'kept') kept += 1;
    else if (e.outcome === 'broken') broken += 1;
    else noFault += 1;
  }
  return { kept, of: kept + broken, noFault, shareable: consent.self && consent.peer };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days to look back for promises due: older ones are not asked about. */
export const EVIDENCE_LOOKBACK_DAYS = 14;

/**
 * The days a promise fell due on, that are now over and still recent enough
 * to ask about. A promise naming a weekday (`day`) falls due on that day,
 * from the deal's start, every `every_days` (7 when not given), until its end
 * or now; one with no day falls due once, at the deal's end (`whole`).
 * `dayOf` gives a moment's weekday in the owner's zone.
 */
export function occurrencesDue(args: {
  dimensions: Readonly<Record<string, string>>;
  startMs: number;
  endMs: number;
  nowMs: number;
  dayOf: (atMs: number) => string | null;
  dateOf: (atMs: number) => string | null;
}): string[] {
  const { dimensions } = args;
  // Over: the day has passed (a day's grace for the evening's work).
  const overBy = args.nowMs - DAY_MS;
  const since = args.nowMs - EVIDENCE_LOOKBACK_DAYS * DAY_MS;
  const day = dimensions.day;
  if (day === undefined || !(DELIVERY_DAYS as readonly string[]).includes(day)) {
    if (args.endMs > overBy || args.endMs < since) return [];
    return ['whole'];
  }
  const every = Number(dimensions.every_days ?? '7');
  const step = Number.isSafeInteger(every) && every >= 1 && every <= 366 ? every : 7;
  let at = args.startMs;
  for (let i = 0; i < 7 && args.dayOf(at) !== day; i += 1) at += DAY_MS;
  if (args.dayOf(at) !== day) return [];
  const out: string[] = [];
  const last = Math.min(args.endMs, overBy);
  for (; at <= last; at += step * DAY_MS) {
    if (at < since) continue;
    const date = args.dateOf(at);
    if (date !== null) out.push(date);
  }
  return out;
}

/** A promise in the owner's words for a card: its name and its dimensions, nothing priced. */
export function describePromise(promise: {
  name: string;
  dimensions: Readonly<Record<string, string>>;
}): string {
  const dims = Object.entries(promise.dimensions)
    .filter(([k]) => k !== 'every_days')
    .map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`)
    .join(', ');
  const name = promise.name.replace(/_/g, ' ');
  return dims === '' ? name : `${name} (${dims})`;
}
