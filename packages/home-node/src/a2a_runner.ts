/**
 * The A2A Lane 1 runner (design §4.1, §6.3–§6.4): the host's in-process
 * claimant of `a2a:<remote_agent_id>` lanes, and the only code that talks to
 * remote agents. It carries bytes; every decision is Core's.
 *
 * For each claimed dispatch child:
 *  1. Core's dispatch transaction (`beginOutboundDispatch`) re-checks
 *     authority, consumes the permit and moves to `transmitting`, or ends
 *     the operation, or says to resume polling after a lost lease.
 *  2. `SendMessage` through the outbound port (`a2aFetch`: resolve-then-pin,
 *     no redirects, caps). A transport failure before the TLS handshake
 *     finished is `not_sent`; any later one is `outcome_unknown`.
 *  3. A bare `Message` answer is a finished result (design §6.4); a `Task`
 *     is acknowledged, then polled with `GetTask` (a read, safe to repeat)
 *     until it ends or the deadline passes, heartbeating the claim, and
 *     acting on the owner's cancel request with `CancelTask`.
 *  4. Every outcome is recorded through Core, claim-bound.
 * Remote text never becomes a reason or a log line: logs carry ids, states
 * and codes only.
 *
 * Each tick also runs Core's sweepers: approvals with no permit, lapsed
 * permits, orphaned dispatches, held-result notices, Lane 2's inbound
 * calls, and the purge of operations past retention.
 */

import {
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  JSONRPC_ERROR_CODES,
  a2aLaneFor,
  buildJsonRpcRequest,
  outboundDisposition,
  parseJsonRpcResponseText,
  parseSendMessageResult,
  validateTask,
  type JsonObject,
} from '@dina/a2a';
import {
  A2A_FETCH_LIMITS,
  DID_REFRESH_INTERVAL_MS,
  a2aFetch,
  artifactParts,
  beginOutboundDispatch,
  dispatchCredentialRef,
  forgetCachedToken,
  getA2AReleaseLog,
  hasOpenCancelRequest,
  inboundCore,
  purgeEndedA2AOperations,
  purgeExpiredA2ANonces,
  recordCancelRefused,
  remoteAuthHeaders,
  recordRemoteOutcome,
  refreshBoundDidKeys,
  sweepA2AInbound,
  sweepA2AOutbound,
  sweepHeldResultNotices,
  takeCancelRequest,
  type A2ARuntime,
  type DispatchClaim,
  type DispatchTarget,
  type OutgoingPart,
  type RemoteOutcome,
  type WorkflowTask,
} from '@dina/core';

export interface A2ADispatchRunnerOptions {
  /**
   * The current Lane 1 runtime, read per tick: a host swaps its workflow
   * service during boot, and the runner must follow. Null means Lane 1 is
   * not available right now; the tick does nothing.
   */
  runtime: () => A2ARuntime | null;
  /** The identity recorded on claims and reports. */
  runnerDid: string;
  /** Claim lease; the runner heartbeats well inside it. */
  leaseMs?: number;
  /** How often to sweep and look for new work. */
  tickMs?: number;
  /** Waits between GetTask polls; the last value repeats. */
  pollBackoffMs?: readonly number[];
  /** How long after sending Dina keeps polling before the outcome is unknown. */
  pollDeadlineMs?: number;
  maxConcurrent?: number;
  sleep?: (ms: number) => Promise<void>;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Metadata-only log (ids, states, codes). */
  log?: (entry: Record<string, unknown>) => void;
}

const ACCEPTED_OUTPUT_MODES = ['text/plain', 'application/json'];

interface DispatchSettings {
  leaseMs: number;
  backoff: readonly number[];
  deadlineMs: number;
  sleep: (ms: number) => Promise<void>;
  log: (entry: Record<string, unknown>) => void;
  /** True once the runner is stopping: a poll loop leaves, its claim lapses. */
  stopped: () => boolean;
}

type RpcAnswer =
  | { kind: 'result'; value: unknown }
  | { kind: 'rpc_error'; code: number }
  | { kind: 'transport'; sent: boolean; error: string }
  /** HTTP 401/403: the remote refused the credential before the request ran. */
  | { kind: 'auth_refused' }
  /** Dina could not build the credential's headers; nothing was sent. */
  | { kind: 'no_credential' }
  /** The credential's token endpoint did not answer this time; nothing was sent, and asking again may work. */
  | { kind: 'token_unavailable' }
  | { kind: 'malformed' };

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

/** One claimed dispatch child, carried from the dispatch transaction to its recorded end. */
class Dispatch {
  private rpcSeq = 0;
  private readonly claim: DispatchClaim;

  constructor(
    private readonly rt: A2ARuntime,
    private readonly settings: DispatchSettings,
    task: WorkflowTask,
    runnerDid: string,
  ) {
    this.claim = { childTaskId: task.id, claimId: task.claim_id ?? '', runnerDid };
  }

  async run(): Promise<void> {
    if (this.claim.claimId === '') return;
    // Build the credential's headers BEFORE the permit is consumed: an OAuth
    // token may take a round trip, and a crash then must not read as a send.
    const ref = dispatchCredentialRef(this.rt, this.claim.childTaskId);
    const auth = ref === null ? null : await remoteAuthHeaders(this.rt.store, ref, this.rt.nowMs());
    const start = beginOutboundDispatch(
      this.rt,
      this.claim,
      ref === null || auth === null ? {} : { credential: { ref, problem: auth.ok ? null : auth.reason } },
    );
    this.settings.log({ event: 'a2a.dispatch', task_id: this.claim.childTaskId, kind: start.kind });
    // The poll ends a fixed time after the send, however often a restart or
    // a lost lease resumes it (§6.4).
    if (start.kind === 'send') {
      await this.send(start, start.messageId, start.parts, auth?.ok === true ? auth.headers : {}, start.sentAt + this.settings.deadlineMs);
    } else if (start.kind === 'resume') await this.poll(start, start.remoteTaskId, start.sentAt + this.settings.deadlineMs);
  }

  private record(outcome: RemoteOutcome): boolean {
    const out = recordRemoteOutcome(this.rt, this.claim, outcome);
    this.settings.log({
      event: 'a2a.outcome',
      task_id: this.claim.childTaskId,
      outcome: outcome.kind,
      state: out.ok ? out.state : out.reason,
    });
    return out.ok;
  }

  /**
   * One JSON-RPC call. The credential's headers are built for this request
   * alone, in memory, from the reference the owner approved (§5.3).
   */
  private async rpc(
    target: DispatchTarget,
    method: 'SendMessage' | 'GetTask' | 'CancelTask',
    params: JsonObject,
    headers?: Record<string, string>,
  ): Promise<RpcAnswer> {
    let authHeaders = headers;
    if (authHeaders === undefined) {
      // After the send, reads follow the credential through any rotation: the
      // owner replacing a secret mid-task must not strand its result.
      const ref = this.rt.store.liveSuccessor(target.credentialRef)?.credential_ref ?? target.credentialRef;
      const auth = await remoteAuthHeaders(this.rt.store, ref, this.rt.nowMs());
      if (!auth.ok) return { kind: auth.reason === 'token_unavailable' ? 'token_unavailable' : 'no_credential' };
      authHeaders = auth.headers;
    }
    this.rpcSeq += 1;
    const id = `dina-${this.rpcSeq}`;
    const response = await a2aFetch({
      method: 'POST',
      url: target.endpoint,
      headers: { ...authHeaders, [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION },
      body: JSON.stringify(buildJsonRpcRequest(id, method, params)),
      ...A2A_FETCH_LIMITS.rpc,
    });
    if (!response.ok) return { kind: 'transport', sent: response.sent, error: response.error };
    if (response.status === 401 || response.status === 403) {
      // A cached token may simply have expired: the next request fetches a new one.
      forgetCachedToken(this.rt.store.liveSuccessor(target.credentialRef)?.credential_ref ?? target.credentialRef);
      return { kind: 'auth_refused' };
    }
    const parsed = parseJsonRpcResponseText(response.body, id);
    if ('malformed' in parsed) return { kind: 'malformed' };
    if (!parsed.ok) return { kind: 'rpc_error', code: parsed.error.code };
    return { kind: 'result', value: parsed.result };
  }

  /** SendMessage under the headers built before the permit was consumed: the send uses the approved credential. */
  private async send(
    target: DispatchTarget,
    messageId: string,
    parts: OutgoingPart[],
    headers: Record<string, string>,
    deadline: number,
  ): Promise<void> {
    const answer = await this.rpc(
      target,
      'SendMessage',
      {
        ...(target.tenant !== '' ? { tenant: target.tenant } : {}),
        message: { messageId, role: 'ROLE_USER', parts: parts as unknown as JsonObject[] },
        configuration: { returnImmediately: true, acceptedOutputModes: ACCEPTED_OUTPUT_MODES },
      },
      headers,
    );
    switch (answer.kind) {
      case 'transport':
        this.record(
          answer.sent
            ? { kind: 'unknown', reason: `transport_${answer.error}` }
            : { kind: 'not_sent', reason: answer.error },
        );
        return;
      case 'no_credential':
        // Nothing left: Dina could not build the credential's headers.
        this.record({ kind: 'not_sent', reason: 'credential_unusable' });
        return;
      case 'token_unavailable':
        this.record({ kind: 'not_sent', reason: 'token_unavailable' });
        return;
      case 'auth_refused':
        this.record({ kind: 'failed', reason: 'remote_auth_refused' });
        return;
      case 'malformed':
        this.record({ kind: 'unknown', reason: 'response_malformed' });
        return;
      case 'rpc_error':
        // Core decides from the code and the action class whether anything may have happened.
        this.record({ kind: 'send_error', code: answer.code });
        return;
      case 'result':
        break;
    }
    const result = parseSendMessageResult(answer.value);
    if ('error' in result) {
      this.record({ kind: 'unknown', reason: 'response_invalid' });
      return;
    }
    if (result.kind === 'message') {
      this.record({ kind: 'result', parts: result.message.parts });
      return;
    }
    const task = result.task;
    if (this.finish(task)) return;
    const acknowledged = this.record({
      kind: 'acknowledged',
      remoteTaskId: String(task.id),
      ...(typeof task.contextId === 'string' ? { remoteContextId: task.contextId } : {}),
    });
    if (acknowledged) await this.poll(target, String(task.id), deadline);
  }

  /** Record a task that has ended; false while it is still running or its state is unknown. */
  private finish(task: Record<string, unknown>): boolean {
    const status = task.status as { state?: unknown } | undefined;
    const disposition = outboundDisposition(String(status?.state ?? ''));
    switch (disposition.kind) {
      case 'completed':
        this.record({ kind: 'result', parts: artifactParts(task as JsonObject) });
        return true;
      case 'fail':
        this.record({ kind: 'failed', reason: disposition.reason });
        return true;
      case 'cancelled':
        this.record({ kind: 'cancelled' });
        return true;
      default:
        return false;
    }
  }

  /** True when the credential reads would use (after any rotation) is an OAuth client. */
  private isOAuth(target: DispatchTarget): boolean {
    const live = this.rt.store.liveSuccessor(target.credentialRef);
    return live?.kind === 'oauth2_client';
  }

  /** Extend the claim's lease; false (logged) when the claim was lost. */
  private renew(): boolean {
    const held = this.rt.workflow
      .store()
      .heartbeatTask(this.claim.childTaskId, this.claim.runnerDid, this.rt.nowMs(), this.settings.leaseMs, this.claim.claimId);
    if (!held) this.settings.log({ event: 'a2a.claim_lost', task_id: this.claim.childTaskId });
    return held;
  }

  private async poll(target: DispatchTarget, remoteTaskId: string, deadline: number): Promise<void> {
    const taskRef: JsonObject = { ...(target.tenant !== '' ? { tenant: target.tenant } : {}), id: remoteTaskId };
    const { backoff } = this.settings;
    // A refused credential is retried once, and only for OAuth (the cached
    // token may have expired and a fresh one is fetched); a static key or
    // token refused once stays refused.
    let authRetries = this.isOAuth(target) ? 1 : 0;
    for (let attempt = 0; ; attempt += 1) {
      if (this.settings.stopped()) return; // the claim lapses; the next runner resumes
      if (this.rt.nowMs() >= deadline) {
        this.record({ kind: 'unknown', reason: 'deadline' });
        return;
      }
      await this.settings.sleep(backoff[Math.min(attempt, backoff.length - 1)] as number);
      // Renew the claim before EVERY remote call, so no gap between renewals
      // is longer than one call plus one sleep (checked against the lease in
      // the runner's constructor): a second runner never polls the same task.
      if (!this.renew()) return;
      if (takeCancelRequest(this.rt, this.claim) || hasOpenCancelRequest(this.rt, this.claim)) {
        if (await this.cancelRemote(target, taskRef)) return;
        if (!this.renew()) return;
      }
      const answer = await this.rpc(target, 'GetTask', taskRef);
      if (answer.kind === 'rpc_error' && answer.code === JSONRPC_ERROR_CODES.taskNotFound) {
        this.record({ kind: 'unknown', reason: 'remote_task_lost' });
        return;
      }
      if (answer.kind === 'auth_refused') {
        if (authRetries > 0) {
          authRetries -= 1;
          continue;
        }
        // The request was sent and the remote may have acted; Dina can no longer ask.
        this.record({ kind: 'unknown', reason: 'remote_auth_refused_after_send' });
        return;
      }
      if (answer.kind === 'no_credential') {
        this.record({ kind: 'unknown', reason: 'credential_unusable_after_send' });
        return;
      }
      // Transport trouble, a token endpoint that did not answer, a malformed
      // answer, or another error: GetTask is a read, so try again until the
      // deadline.
      if (answer.kind !== 'result' || validateTask(answer.value) !== null) continue;
      // A read went through: the next refused credential earns its own refresh.
      authRetries = this.isOAuth(target) ? 1 : 0;
      if (this.finish(answer.value as Record<string, unknown>)) return;
    }
  }

  /** Ask the remote to cancel. True when the operation has ended. */
  private async cancelRemote(target: DispatchTarget, taskRef: JsonObject): Promise<boolean> {
    const answer = await this.rpc(target, 'CancelTask', taskRef);
    if (answer.kind === 'rpc_error' && CANCEL_REFUSALS.has(answer.code)) {
      // The remote says this cancel cannot happen: the owner's request is
      // answered "no", and the task runs on to its own end.
      recordCancelRefused(this.rt, this.claim);
      return false;
    }
    // Any other error (an internal one, a code Dina does not know), a
    // transport failure or a malformed answer says nothing of the cancel:
    // ask again on the next poll.
    if (answer.kind !== 'result' || validateTask(answer.value) !== null) return false;
    return this.finish(answer.value as Record<string, unknown>);
  }
}

/** The errors that answer a cancel "no" for good: anything else is asked again. */
const CANCEL_REFUSALS: ReadonlySet<number> = new Set([
  JSONRPC_ERROR_CODES.taskNotCancelable,
  JSONRPC_ERROR_CODES.taskNotFound,
  JSONRPC_ERROR_CODES.unsupportedOperation,
  JSONRPC_ERROR_CODES.methodNotFound,
]);

/** Node's timers hold the process open unless unref'd; Hermes' are numbers with no unref. */
function unrefTimer<T>(handle: T): T {
  (handle as { unref?: () => void }).unref?.();
  return handle;
}

export class A2ADispatchRunner {
  private readonly runtime: () => A2ARuntime | null;
  private readonly runnerDid: string;
  private readonly tickMs: number;
  private readonly maxConcurrent: number;
  private readonly settings: DispatchSettings;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly jobs = new Set<Promise<void>>();
  private handle: unknown = null;
  private ticking: Promise<void> | null = null;
  /** The background re-check of bound client DIDs (design §5.1), when one runs. */
  private refreshing: Promise<void> | null = null;
  private lastDidRefreshMs = Number.NEGATIVE_INFINITY;
  private stopped = false;

  constructor(options: A2ADispatchRunnerOptions) {
    this.runtime = options.runtime;
    this.runnerDid = options.runnerDid;
    this.tickMs = options.tickMs ?? 2_000;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    const backoff = options.pollBackoffMs ?? [1_000, 2_000, 4_000, 8_000, 15_000];
    if (backoff.length === 0) throw new Error('A2ADispatchRunner: pollBackoffMs is empty');
    const leaseMs = options.leaseMs ?? 60_000;
    // The longest stretch without a renewal: an OAuth token fetch, one remote
    // call, and the longest sleep.
    const longestGap = A2A_FETCH_LIMITS.token.timeoutMs + A2A_FETCH_LIMITS.rpc.timeoutMs + Math.max(...backoff);
    if (leaseMs <= longestGap) {
      throw new Error(`A2ADispatchRunner: leaseMs ${leaseMs} must exceed one call plus the longest sleep (${longestGap})`);
    }
    this.settings = {
      leaseMs,
      backoff,
      deadlineMs: options.pollDeadlineMs ?? 30 * 60_000,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => unrefTimer(setTimeout(resolve, ms)))),
      log: options.log ?? (() => undefined),
      stopped: () => this.stopped,
    };
    this.setIntervalFn = options.setInterval ?? ((fn, ms) => unrefTimer(setInterval(fn, ms)));
    this.clearIntervalFn = options.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  }

  start(): void {
    if (this.handle !== null) return;
    this.stopped = false;
    void this.tick();
    this.handle = this.setIntervalFn(() => void this.tick(), this.tickMs);
  }

  /** Stop claiming; in-flight dispatches finish their current step and their claims lapse. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.handle !== null) this.clearIntervalFn(this.handle);
    this.handle = null;
    await this.flush();
  }

  /** Wait for the current tick and every in-flight dispatch. */
  async flush(): Promise<void> {
    while (this.ticking !== null || this.jobs.size > 0 || this.refreshing !== null) {
      await Promise.all([this.ticking, this.refreshing, ...this.jobs]);
    }
  }

  /** One pass: sweeps, then claims. Never rejects; a failing step is logged and the next tick tries again. */
  tick(): Promise<void> {
    if (this.ticking !== null) return this.ticking;
    this.ticking = this.runTick()
      .catch((err: unknown) => {
        this.settings.log({ event: 'a2a.tick_failed', error: errorName(err) });
      })
      .finally(() => {
        this.ticking = null;
      });
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    const rt = this.runtime();
    if (rt === null) return;
    // Each sweep on its own: a fault in one never starves the other.
    try {
      const swept = sweepA2AOutbound(rt);
      if (swept.failed > 0) this.settings.log({ event: 'a2a.sweep_ops_failed', count: swept.failed });
    } catch (err) {
      this.settings.log({ event: 'a2a.sweep_failed', error: errorName(err) });
    }
    try {
      // Lane 2: review cards approved with no execution minted, and calls
      // whose child ended with no settle (a crash between the two commits).
      sweepA2AInbound(inboundCore(rt), (entry) => this.settings.log({ event: 'a2a.inbound_sweep_op_failed', ...entry }));
    } catch (err) {
      this.settings.log({ event: 'a2a.inbound_sweep_failed', error: errorName(err) });
    }
    try {
      sweepHeldResultNotices(rt);
    } catch (err) {
      this.settings.log({ event: 'a2a.notice_sweep_failed', error: errorName(err) });
    }
    try {
      // The owner's words and the release log expire after a day: sweep them
      // here too, so an idle server keeps nothing past its time.
      getA2AReleaseLog()?.purgeExpired();
    } catch (err) {
      this.settings.log({ event: 'a2a.release_log_sweep_failed', error: errorName(err) });
    }
    try {
      const purged = purgeEndedA2AOperations(rt);
      if (purged > 0) this.settings.log({ event: 'a2a.purged', count: purged });
    } catch (err) {
      this.settings.log({ event: 'a2a.purge_failed', error: errorName(err) });
    }
    try {
      // Lane 2's spent request nonces, once their signatures have aged out
      // (measured on the wall clock, as the time check is).
      purgeExpiredA2ANonces(rt.store);
    } catch (err) {
      this.settings.log({ event: 'a2a.nonce_purge_failed', error: errorName(err) });
    }
    this.maybeRefreshDids(rt);
    if (this.stopped) return;
    const lanes = new Set(
      rt.store
        .listTasksInStates('outbound', ['queued', 'running'])
        .map((op) => op.remote_agent_id)
        .filter((id): id is string => id !== null),
    );
    for (const agentId of lanes) {
      while (this.jobs.size < this.maxConcurrent && !this.stopped) {
        let task: WorkflowTask | null;
        try {
          task = rt.workflow
            .store()
            .claimDelegationTask(this.runnerDid, rt.nowMs(), this.settings.leaseMs, a2aLaneFor(agentId));
        } catch (err) {
          this.settings.log({ event: 'a2a.claim_failed', error: errorName(err) });
          break;
        }
        if (task === null) break;
        this.launch(rt, task);
      }
    }
  }

  /**
   * Re-resolve bound client DIDs every `DID_REFRESH_INTERVAL_MS`, in the
   * background: resolution goes over the network, and neither the tick nor
   * a dispatch slot waits for it.
   */
  private maybeRefreshDids(rt: A2ARuntime): void {
    const now = rt.nowMs();
    if (this.refreshing !== null || now - this.lastDidRefreshMs < DID_REFRESH_INTERVAL_MS) return;
    this.lastDidRefreshMs = now;
    this.refreshing = refreshBoundDidKeys(rt.store, rt.nowMs)
      .then((counts) => {
        if (counts.suspended > 0 || counts.unresolved > 0) this.settings.log({ event: 'a2a.did_refresh', ...counts });
      })
      .catch((err: unknown) => {
        this.settings.log({ event: 'a2a.did_refresh_failed', error: errorName(err) });
      })
      .finally(() => {
        this.refreshing = null;
      });
  }

  private launch(rt: A2ARuntime, task: WorkflowTask): void {
    const job = new Dispatch(rt, this.settings, task, this.runnerDid)
      .run()
      .catch((err: unknown) => {
        this.settings.log({ event: 'a2a.dispatch_crashed', task_id: task.id, error: errorName(err) });
      })
      .finally(() => {
        this.jobs.delete(job);
      });
    this.jobs.add(job);
  }
}
