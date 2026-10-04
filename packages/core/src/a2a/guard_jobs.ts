/**
 * The guard between a remote result and the owner (design §6.5): a result
 * waits in quarantine until a guard worker (Brain) has scanned the exact
 * bytes and said `passed`. Fail closed throughout: an outage, a crash, a
 * lapsed claim, or no guard model at all leaves the result held.
 *
 *  - The guard routes are the ONLY readers of quarantined content.
 *  - A worker claims a job with a lease; a lapsed claim can be re-claimed.
 *  - A verdict applies only under the live claim and only for the digest
 *    the worker scanned. `passed` releases the result and appends the ONE
 *    owner-delivery event, in one commit; `blocked` keeps it held and
 *    appends a neutral notice.
 *  - A result no one has checked within `GUARD_HELD_NOTICE_AFTER_MS` gets one
 *    plain notice: it is held because no guard has checked it (no guard model
 *    is configured, or the guard is not running). Core cannot tell those two
 *    apart, so the notice names both.
 *
 * Events ride the operation's dispatch child (`operation_end.ts`). Their
 * details carry the operation id only; the released result is read through Core.
 */

import { isPlainObject, parseStrictJson, type JsonValue } from '@dina/a2a';

import { newA2AId } from './ids';
import {
  A2A_RESULT_BLOCKED_EVENT,
  A2A_RESULT_HELD_EVENT,
  A2A_RESULT_RELEASED_EVENT,
  appendA2AOwnerEvent,
} from './operation_end';
import { a2aDisplayText, pinnedRemoteSkills } from './remote_agents';

import type { A2ARuntime } from './runtime';
import type { A2ATaskRow, CancelState } from './store';

/**
 * A guard claim's life: room for the worker's two model calls at the
 * router's default timeout (60 s each), and its verdict. The worker bounds
 * its scan by the claim it holds (`claimed_until`), so a slower model loses
 * the claim and posts nothing, never a late verdict; the job then goes behind
 * every job not yet tried.
 */
export const GUARD_LEASE_MS = 3 * 60_000;
export const GUARD_HELD_NOTICE_AFTER_MS = 2 * 60_000;


export interface GuardWork {
  job_id: string;
  claim_id: string;
  claimed_until: number;
  /** The digest the verdict must name: sha256 of RFC 8785 of `content`. */
  digest: string;
  operation_id: string;
  agent_name: string;
  skill: string;
  /** The quarantined value, exactly as it would be released. */
  content: JsonValue;
}

/** Claim the oldest pending (or lapsed) guard job. Null when there is none. */
export function claimNextGuardJob(runtime: A2ARuntime, leaseMs = GUARD_LEASE_MS): GuardWork | null {
  return runtime.store.transaction((): GuardWork | null => {
    const now = runtime.nowMs();
    for (let job = runtime.store.nextClaimableGuardJob(now); job !== null; job = runtime.store.nextClaimableGuardJob(now)) {
      const op = runtime.store.getTask(job.operation_ref);
      const parsed = op?.result_quarantine != null ? parseStrictJson(op.result_quarantine) : null;
      if (op === null || op.state !== 'quarantined' || parsed === null || !parsed.ok || op.quarantine_digest !== job.quarantine_digest) {
        // Nothing releasable behind this job: close it, and its operation, so it is never handed out.
        runtime.store.abandonGuardJob(job.job_id, JSON.stringify({ reason: 'quarantine_unreadable' }), now);
        if (op !== null && runtime.store.updateTask(op.id, ['quarantined'], { state: 'blocked', reason_code: 'quarantine_unreadable' }, now)) {
          appendA2AOwnerEvent(runtime, op, A2A_RESULT_BLOCKED_EVENT);
        }
        continue;
      }
      const claimId = newA2AId();
      if (!runtime.store.claimGuardJob(job.job_id, { state: job.state, claimId: job.claim_id }, claimId, now + leaseMs)) {
        return null;
      }
      const agent = op.remote_agent_id === null ? null : runtime.store.getAgent(op.remote_agent_id);
      const skillId = parseSkill(op);
      return {
        job_id: job.job_id,
        claim_id: claimId,
        claimed_until: now + leaseMs,
        digest: job.quarantine_digest,
        operation_id: op.external_id,
        agent_name: agent?.name ?? '',
        skill: agent === null ? skillId : (pinnedRemoteSkills(agent).find((s) => s.id === skillId)?.name ?? skillId),
        content: parsed.value,
      };
    }
    return null;
  });
}

function parseSkill(op: A2ATaskRow): string {
  const parsed = op.consent_json === null ? null : parseStrictJson(op.consent_json);
  return parsed?.ok === true && isPlainObject(parsed.value) && typeof parsed.value.skill === 'string'
    ? parsed.value.skill
    : '';
}

export interface GuardVerdictInput {
  jobId: string;
  claimId: string;
  digest: string;
  verdict: unknown;
  /** Why the guard decided: one of `GUARD_VERDICT_CODES`. */
  code: unknown;
  /** Worker-supplied note, stored bounded for the audit; never shown as remote content. */
  note?: unknown;
}

/** Codes a verdict may carry; a blocked result's reason code names one. */
export const GUARD_VERDICT_CODES: ReadonlySet<string> = new Set([
  'instruction_pattern',
  'model_pass',
  'model_block',
  'guard_unparseable',
]);

export type GuardVerdictOutcome =
  | { ok: true; state: 'completed' | 'blocked' }
  | { ok: false; reason: 'not_found' | 'bad_verdict' | 'digest_mismatch' | 'claim_lost' | 'operation_ended' };

export function submitGuardVerdict(runtime: A2ARuntime, input: GuardVerdictInput): GuardVerdictOutcome {
  if (input.verdict !== 'passed' && input.verdict !== 'blocked') return { ok: false, reason: 'bad_verdict' };
  if (typeof input.code !== 'string' || !GUARD_VERDICT_CODES.has(input.code)) {
    return { ok: false, reason: 'bad_verdict' };
  }
  if ((input.verdict === 'passed') !== (input.code === 'model_pass')) return { ok: false, reason: 'bad_verdict' };
  const verdict = input.verdict;
  const code = input.code;
  return runtime.store.transaction((): GuardVerdictOutcome => {
    const job = runtime.store.getGuardJob(input.jobId);
    if (job === null) return { ok: false, reason: 'not_found' };
    if (input.digest !== job.quarantine_digest) return { ok: false, reason: 'digest_mismatch' };
    if (job.state !== 'claimed' || job.claim_id !== input.claimId) return { ok: false, reason: 'claim_lost' };
    const now = runtime.nowMs();
    const op = runtime.store.getTask(job.operation_ref);
    if (op === null || op.state !== 'quarantined' || op.quarantine_digest !== job.quarantine_digest) {
      // The operation stopped waiting (cancelled, or closed by the claim sweep): close the job, say nothing.
      runtime.store.abandonGuardJob(job.job_id, JSON.stringify({ reason: 'operation_ended' }), now);
      return { ok: false, reason: 'operation_ended' };
    }
    const note = a2aDisplayText(typeof input.note === 'string' ? input.note : '', 300);
    if (!runtime.store.resolveGuardJob(job.job_id, input.claimId, verdict, JSON.stringify({ verdict, code, note }), now)) {
      return { ok: false, reason: 'claim_lost' };
    }
    const moved =
      verdict === 'passed'
        ? runtime.store.updateTask(
            op.id,
            ['quarantined'],
            { state: 'completed', result_json: op.result_quarantine, result_quarantine: null, guard_receipt_id: job.job_id },
            now,
          )
        : runtime.store.updateTask(op.id, ['quarantined'], { state: 'blocked', reason_code: `guard_blocked:${code}` }, now);
    // Read and written in this one transaction, so the move cannot miss; if it ever did, roll it all back.
    if (!moved) throw new Error('a2a guard verdict: operation moved inside its own transaction');
    appendA2AOwnerEvent(runtime, op, verdict === 'passed' ? A2A_RESULT_RELEASED_EVENT : A2A_RESULT_BLOCKED_EVENT);
    return { ok: true, state: verdict === 'passed' ? 'completed' : 'blocked' };
  });
}

/** Tell the owner, once per result, that a result is held because nothing has checked it. */
export function sweepHeldResultNotices(runtime: A2ARuntime): number {
  const now = runtime.nowMs();
  let sent = 0;
  for (const job of runtime.store.guardJobsAwaitingNotice(now - GUARD_HELD_NOTICE_AFTER_MS)) {
    try {
      runtime.store.transaction(() => {
        if (!runtime.store.markHeldNoticeSent(job.job_id, now)) return;
        const op = runtime.store.getTask(job.operation_ref);
        if (op === null || op.state !== 'quarantined') return;
        appendA2AOwnerEvent(runtime, op, A2A_RESULT_HELD_EVENT);
        sent += 1;
      });
    } catch {
      // One job's notice failing (rolled back, retried next sweep) never holds up the others.
    }
  }
  return sent;
}

/** What Brain may read about an outbound operation: its state, and the result only once released. */
export interface OutboundOperationView {
  operation_id: string;
  state: string;
  reason: string | null;
  agent_name: string;
  skill: string;
  reply_to: string | null;
  result: JsonValue | null;
  /** The owner's cancel request, if any: `requested`, `attempting` (asked of the remote), `confirmed` or `refused`. */
  cancel: CancelState | null;
  updated_at: number;
}

export function outboundOperationView(runtime: A2ARuntime, operationId: string): OutboundOperationView | null {
  const op = runtime.store.getTaskByExternal('outbound', 'owner', operationId);
  if (op === null) return null;
  const agent = op.remote_agent_id === null ? null : runtime.store.getAgent(op.remote_agent_id);
  const released = op.state === 'completed' && op.result_json !== null ? parseStrictJson(op.result_json) : null;
  return {
    operation_id: op.external_id,
    state: op.state,
    reason: op.reason_code,
    agent_name: agent?.name ?? '',
    skill: parseSkill(op),
    reply_to: op.reply_to,
    // Quarantined content is never part of this view (design §6.5), and nor
    // are originals: only the owner's own surfaces get the placeholder legend.
    result: released?.ok === true ? released.value : null,
    cancel: runtime.store.getCancelRequest(op.id)?.state ?? null,
    updated_at: op.status_updated_at,
  };
}

