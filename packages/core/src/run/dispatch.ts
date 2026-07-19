/**
 * Risk gate + the atomic outbox claim (INTERACTIVE_SERVICES_ARCHITECTURE.md
 * §6.3/§8). After the owner APPROVES an action message, the risk gate runs
 * (reusing Dina's SAFE/MODERATE/HIGH/BLOCKED semantics), then a single atomic
 * claim mints and sends AT MOST ONE delegation.
 *
 *   approved → risk_pending → risk_authorized → dispatch_pending → sending → dispatched
 *                    │                                                          → completed|failed
 *                    └► policy_refused   (BLOCKED / above ceiling / gate deny)
 *
 * The delegation id is stable: H(run_id, message_id, decision_revision). A
 * crash re-send carries the same id; the receiver deduplicates. So an approved
 * action sends ZERO delegations (refused / fenced / expired / past a hard bound)
 * or exactly ONE.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { isRunTerminal, type RunRecord } from './domain';
import { getMessageRepository, type MessageRecord, type MessageRepository } from './message';
import { getRunRepository, type RunRepository } from './repository';

export type RiskClass = 'SAFE' | 'MODERATE' | 'HIGH' | 'BLOCKED';

const RISK_RANK: Record<RiskClass, number> = { SAFE: 0, MODERATE: 1, HIGH: 2, BLOCKED: 3 };

function riskRank(v: string): number {
  return RISK_RANK[v as RiskClass] ?? RISK_RANK.MODERATE; // fail-safe MODERATE
}

/** Stable delegation id (§6.3): H(run_id, message_id, decision_revision). */
export function deriveDelegationId(runId: string, messageId: string, decisionRevision: number): string {
  const bytes = new TextEncoder().encode(`${runId}\n${messageId}\n${decisionRevision}`);
  return `del-${bytesToHex(sha256(bytes)).slice(0, 32)}`;
}

export type RiskOutcome =
  | { state: 'risk_authorized' }
  | { state: 'risk_pending' } // MODERATE/HIGH within ceiling — awaits owner confirm/unlock
  | { state: 'policy_refused'; reason: 'blocked' | 'above_ceiling' | 'not_approved' };

export type ClaimOutcome =
  | { claimed: true; delegation_id: string }
  | { claimed: false; reason: 'not_authorized' | 'guard_failed' };

export interface RunDispatchServiceOptions {
  messageRepo?: MessageRepository;
  runRepo?: RunRepository;
  nowMsFn?: () => number;
  /** Whether the run's persona is currently open (§8 claim guard). */
  isPersonaOpen?: (persona: string) => boolean;
  /** Runs the claim's transitions atomically (rollback on throw). Default is a
   *  passthrough; pass the SQLite `db.transaction` so the claim is a single
   *  atomic step (§8) and a crash never strands a `dispatch_pending` row. */
  tx?: (fn: () => void) => void;
}

const CLAIM_ABORT = Symbol('claim-abort');

export class RunDispatchService {
  private readonly messages: MessageRepository;
  private readonly runs: RunRepository;
  private readonly now: () => number;
  private readonly personaOpen: (persona: string) => boolean;
  private readonly tx: (fn: () => void) => void;

  constructor(opts: RunDispatchServiceOptions = {}) {
    const messages = opts.messageRepo ?? getMessageRepository();
    const runs = opts.runRepo ?? getRunRepository();
    if (messages === null || runs === null) {
      throw new Error('RunDispatchService: message + run repositories must be wired');
    }
    this.messages = messages;
    this.runs = runs;
    this.now = opts.nowMsFn ?? (() => Date.now());
    this.personaOpen = opts.isPersonaOpen ?? (() => true);
    this.tx = opts.tx ?? ((fn) => fn());
  }

  /**
   * Run the risk gate for an APPROVED action message (§6.3). Re-derives the
   * risk class against the run's ceiling. SAFE → risk_authorized; MODERATE/HIGH
   * within ceiling → risk_pending (owner confirm); BLOCKED / above-ceiling →
   * policy_refused (terminal).
   */
  evaluateRisk(messageId: string): RiskOutcome {
    const msg = this.messages.getById(messageId);
    if (msg === null || msg.state !== 'approved') return { state: 'policy_refused', reason: 'not_approved' };
    const run = this.runs.getById(msg.run_id);
    if (run === null) return { state: 'policy_refused', reason: 'not_approved' };
    const nowMs = this.now();

    // Recheck the message's own signed expiry before authorizing (§6.3): an
    // expired action never authorizes or dispatches (VERIF #11).
    if (nowMs >= msg.expires_at || nowMs >= run.expires_at) {
      this.messages.transition(messageId, 'approved', 'expired', nowMs);
      return { state: 'policy_refused', reason: 'not_approved' };
    }

    // Fail closed while the persona is LOCKED (§18 hard bounds): risk state must
    // not advance (approved → risk_authorized) under a closed persona. Hold the
    // message `approved` (no-op) — it re-gates once the persona re-opens; a lock
    // that lands after authorization is caught again at the claim guard.
    if (!this.personaOpen(run.persona)) {
      return { state: 'risk_pending' };
    }

    // Fail closed if the run is SHEDDING (§18 "hard bounds in guards"): a
    // terminal / fencing-draining / past-drain-deadline run never newly
    // authorizes an action. Hold the message `approved` (a no-op outcome) so the
    // barrier / deadline sweep fences it — never mint a stale `risk_authorized`
    // on a run that can no longer dispatch. (The claim guard enforces the same
    // bound at the dispatch linearization point.)
    if (
      isRunTerminal(run.state) ||
      (run.state === 'draining' &&
        (run.drain_strength === 'fencing' ||
          (run.drain_deadline_at !== null && nowMs >= run.drain_deadline_at)))
    ) {
      return { state: 'risk_pending' };
    }

    const risk = (msg.risk_class ?? 'MODERATE') as string;
    // Run the gate's lifecycle transitions atomically (VERIF #5): a crash
    // mid-gate must not strand the message at an intermediate state.
    let result: RiskOutcome = { state: 'risk_pending' };
    this.tx(() => {
      this.messages.transition(messageId, 'approved', 'risk_pending', nowMs);
      if (risk === 'BLOCKED') {
        this.messages.transition(messageId, 'risk_pending', 'policy_refused', nowMs);
        result = { state: 'policy_refused', reason: 'blocked' };
      } else if (riskRank(risk) > riskRank(run.action_risk_ceiling)) {
        this.messages.transition(messageId, 'risk_pending', 'policy_refused', nowMs);
        result = { state: 'policy_refused', reason: 'above_ceiling' };
      } else if (risk === 'SAFE') {
        this.messages.transition(messageId, 'risk_pending', 'risk_authorized', nowMs);
        result = { state: 'risk_authorized' };
      } else {
        // MODERATE / HIGH within ceiling — awaits an explicit owner confirmation.
        result = { state: 'risk_pending' };
      }
    });
    return result;
  }

  /** Owner confirmation/unlock for a MODERATE/HIGH message (risk_pending →
   *  risk_authorized). Returns true iff it was risk_pending AND every hard bound
   *  still holds — persona open, message + run not expired, run not
   *  fencing/terminal, and (while draining) before the deadline. A lock or a
   *  barrier/deadline that landed between risk evaluation and this owner
   *  confirmation must NOT leave a stale `risk_authorized` (§18 hard bounds). */
  authorizeRisk(messageId: string): boolean {
    const msg = this.messages.getById(messageId);
    if (msg === null || msg.state !== 'risk_pending') return false;
    const run = this.runs.getById(msg.run_id);
    if (run === null) return false;
    const nowMs = this.now();
    if (!this.personaOpen(run.persona)) return false; // persona lock → hold
    if (nowMs >= msg.expires_at || nowMs >= run.expires_at) return false;
    if (
      isRunTerminal(run.state) ||
      (run.state === 'draining' &&
        (run.drain_strength === 'fencing' ||
          (run.drain_deadline_at !== null && nowMs >= run.drain_deadline_at)))
    ) {
      return false;
    }
    return this.messages.transition(messageId, 'risk_pending', 'risk_authorized', nowMs);
  }

  /**
   * The atomic outbox claim (§8) — the dispatch linearization point. Guard:
   * "persona open AND message not expired AND now < run.expires_at AND (run
   * active OR (run draining AND drain_strength=permissive AND now <
   * drain_deadline_at))". On success mints the stable delegation id, sets it on
   * the message, and CAS-advances risk_authorized → dispatch_pending → sending.
   * A fencing cause / elapsed bound / persona lock makes the claim fail; the row
   * is NOT sent (it holds / fences per the caller).
   */
  claimDispatch(messageId: string): ClaimOutcome {
    const msg = this.messages.getById(messageId);
    if (msg === null || msg.state !== 'risk_authorized') {
      return { claimed: false, reason: 'not_authorized' };
    }
    const run = this.runs.getById(msg.run_id);
    if (run === null) return { claimed: false, reason: 'not_authorized' };
    const nowMs = this.now();

    if (!this.claimGuardHolds(run, msg, nowMs)) return { claimed: false, reason: 'guard_failed' };

    const delegationId = deriveDelegationId(run.run_id, messageId, msg.decision_revision);
    // The claim is ONE atomic step (§8): risk_authorized → dispatch_pending (mint
    // the delegation) → sending. If either CAS fails, the transaction rolls back
    // and the message stays risk_authorized — no stranded dispatch_pending row.
    let claimed = false;
    try {
      this.tx(() => {
        if (!this.messages.transition(messageId, 'risk_authorized', 'dispatch_pending', nowMs)) {
          throw CLAIM_ABORT;
        }
        this.messages.setDelegationId(messageId, delegationId, nowMs);
        if (!this.messages.transition(messageId, 'dispatch_pending', 'sending', nowMs)) {
          throw CLAIM_ABORT;
        }
        claimed = true;
      });
    } catch (e) {
      if (e !== CLAIM_ABORT) throw e;
      claimed = false;
    }
    return claimed ? { claimed: true, delegation_id: delegationId } : { claimed: false, reason: 'guard_failed' };
  }

  /** Mark a claimed delegation as physically sent (sending → dispatched). */
  markDispatched(messageId: string): boolean {
    return this.messages.transition(messageId, 'sending', 'dispatched', this.now());
  }

  /** A send that failed before completion (sending → failed). */
  markSendFailed(messageId: string): boolean {
    return this.messages.transition(messageId, 'sending', 'failed', this.now());
  }

  private claimGuardHolds(run: RunRecord, msg: MessageRecord, nowMs: number): boolean {
    if (isRunTerminal(run.state)) return false;
    if (!this.personaOpen(run.persona)) return false; // persona lock → hold (caller re-arms)
    if (nowMs >= msg.expires_at) return false; // message expired
    if (nowMs >= run.expires_at) return false; // run hard TTL
    if (run.state === 'active') return true;
    // draining: only a PERMISSIVE cause lets a cause-retained approval dispatch,
    // and only before the deadline (a fencing cause never dispatches, §8).
    if (
      run.state === 'draining' &&
      run.drain_strength === 'permissive' &&
      run.drain_deadline_at !== null &&
      nowMs < run.drain_deadline_at
    ) {
      return true;
    }
    return false;
  }
}
