/**
 * Service approval inbox — data layer for MOBILE-008.
 *
 * Backs the approval screen that lists workflow tasks with
 * `kind=approval` / `state=pending_approval`, and lets the operator
 * approve or deny each.
 *
 * The inbox is client-injected: the app-layer bootstrap installs a
 * `CoreClient` once via `setInboxCoreClient`; the hook then calls
 * through it. Tests inject a fake client.
 *
 * Source: SERVICE_DISCOVERY_DESIGN.md MOBILE-008.
 */

import { markNotificationRead } from '@dina/brain/notifications';
import { buildPluginResultCard } from '@dina/core';

import type { CoreClient, WorkflowTask } from '@dina/core';
import type { CardSpec } from '@dina/protocol';

/**
 * Approval-task variants the inbox knows how to render.
 *
 * - `service_query` — bus-driver flow. Approval gates a `service.query`
 *   D2D round-trip; deny → send `unavailable` to the requester.
 * - `intent_validation` — `dina validate` flow from OpenClaw / sample
 *   agents. Approval gates an agent action (send_email, transfer_money,
 *   etc.); the agent polls `/v1/intent/:id/status`. Deny is a plain
 *   workflow cancel — there is no service.query requester to notify.
 * - `staging_persona_access` — `/remember` wants to store into a locked
 *   persona; approve drains the staged memory, deny drops it.
 * - `vault_read` — `ask` request that touches a sensitive/locked persona;
 *   approve allows the vault read for this request, deny cancels it. Backed
 *   by a workflow task (`kind=approval`, `payload.type=vault_read_request`
 *   or Core's direct `payload.type=agent_persona_access`) — same store as
 *   every other approval kind.
 * - `remote_coding_gate` — a HIGH-risk coding action proposed by a paired
 *   laptop Core. The phone owns the decision; raw tool arguments never cross.
 * - `agent_action` — an exact, bounded Talk or delegation action. It is always
 *   one-shot and shows its human-visible recipient/task detail.
 * - `unknown` — payload doesn't match a known shape; render with what
 *   we can read and surface a generic deny.
 */
export type InboxEntryKind =
  | 'service_query'
  | 'intent_validation'
  | 'staging_persona_access'
  | 'vault_read'
  | 'remote_coding_gate'
  | 'agent_action'
  /** PLUGIN_ARCHITECTURE §15.5 — a carded plugin invocation: the exact envelope a runner would claim. */
  | 'plugin_invocation'
  /** GROUP_COORDINATION §6 — a held reply that would carry a household health disclosure; yes sends it, no sends the reply without it. */
  | 'disclosure_review'
  | 'unknown';

export interface InboxEntry {
  id: string;
  /** Discriminator the UI uses to pick a render template + deny path. */
  kind: InboxEntryKind;
  /** service_query: capability name. intent_validation: action name. */
  capability: string;
  /** service_query: provider/service display name; intent_validation: ''. */
  serviceName: string;
  description: string;
  /** service_query: requester DID. intent_validation: agent DID (when present). */
  requesterDID: string;
  /** service_query: serialized params. intent_validation: target text. */
  paramsPreview: string;
  /** intent_validation only — surfaces SAFE/MODERATE/HIGH/BLOCKED. */
  riskLevel?: 'SAFE' | 'MODERATE' | 'HIGH' | 'BLOCKED';
  /**
   * PLG-29 #1: agent_persona_access only — the EXACT access mode the agent
   * requested. The grant payload carries read|write, but the projection used to
   * drop it and every request rendered as generic "Vault access", so a request
   * for WRITE authority looked identical to read. Surface it in the trusted
   * approval chrome. An unreadable/absent mode defaults to 'write' (fail safe:
   * never under-state the authority being granted).
   */
  accessMode?: 'read' | 'write';
  /**
   * plugin_invocation only — the effect statement (§15.5), read off the PINNED
   * envelope: the consented action class, and whether a retry after a lost
   * lease is safe (the capability declared idempotency).
   */
  effect?: { actionClass: string; retryIdempotent: boolean; installId: string };
  /**
   * plugin_invocation only — Core's word on whether a standing approval could
   * ever silence this capability (§8). Drives "Allow for 24 hours" (§15.5).
   */
  grantCanSilence?: boolean;
  /**
   * plugin_invocation only — §11: what Dina's OWN projection added beyond the
   * params, as counts and category names. The owner is told a filing carries
   * two business-registry facts; the facts themselves are already in the
   * params preview, and a second copy here would make the card the leak.
   */
  contextSummary?: { categories: string[]; itemCount: number };
  createdAt: number;
  expiresAt?: number;
}

/** Subset of `CoreClient` the inbox uses — easier to fake in tests. */
export type InboxCoreClient = Pick<
  CoreClient,
  | 'listWorkflowTasks'
  | 'approveWorkflowTask'
  | 'cancelWorkflowTask'
  | 'getWorkflowTask'
  // `sendServiceRespond` is used by denyPending so the requester gets
  // an `unavailable` D2D. Review #1: the respond already terminates
  // the approval task, so we only call cancelWorkflowTask as a fallback
  // when respond failed.
  | 'sendServiceRespond'
>;

let client: InboxCoreClient | null = null;

/**
 * Install the Core client used by the inbox. Call once from the app
 * bootstrap after identity + HTTP-server wiring is ready.
 */
export function setInboxCoreClient(next: InboxCoreClient | null): void {
  client = next;
}

/** Clear the bound client — tests use this for isolation. */
export function resetInboxCoreClient(): void {
  client = null;
}

/** Raised when the inbox is used before a client is wired. */
export class InboxNotConfiguredError extends Error {
  constructor() {
    super('Service inbox Core client not configured — call setInboxCoreClient');
    this.name = 'InboxNotConfiguredError';
  }
}

/**
 * Fetch pending approvals ordered oldest-first. Single source of truth:
 * workflow tasks (`kind=approval, state=pending_approval`). Covers all
 * approval kinds — service_query, intent_validation, staging_persona_access,
 * and vault_read_request (the latter via workflow tasks created by the
 * persona guard when an ask touches a locked persona).
 *
 * Empty array when nothing is waiting. Never throws on "no items".
 */
export async function listPendingApprovals(limit = 50): Promise<InboxEntry[]> {
  const c = requireClient();
  const [approvals, delegations] = await Promise.all([
    c.listWorkflowTasks({ kind: 'approval', state: 'pending_approval', limit }),
    // §15.5 — a carded plugin invocation is ONE delegation task parked
    // `pending_approval` on its plugin lane (the same task the runner later
    // claims). Only tasks carrying the pinned plugin envelope belong here.
    c.listWorkflowTasks({ kind: 'delegation', state: 'pending_approval', limit }),
  ]);
  return [...approvals, ...delegations.filter(isPluginInvocation)]
    .map(toEntry)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Is this task a plugin invocation (§9.1 pinned envelope)? Decided by the payload type alone. */
export function isPluginInvocation(task: Pick<WorkflowTask, 'payload'>): boolean {
  return safeParse(task.payload).type === 'plugin_invocation';
}

/**
 * The OWNER DECISION on a resolved approval (PLG-31 #16 — kept separate from the
 * execution result). The Completed tab shows this as the primary badge:
 *   - `approved` — owner approved (queued / running / completed / recorded / failed)
 *   - `denied`   — owner denied (cancelled by operator)
 *   - `expired`  — TTL lapsed before the owner decided
 *   - `unknown`  — PLG-31 #14: `outcome_unknown` — the owner approved but an
 *                  external effect may have happened that Dina cannot confirm (§9.5)
 */
export type ApprovalOutcome = 'approved' | 'denied' | 'expired' | 'unknown';

/**
 * The EXECUTION result of the approved work, orthogonal to the owner decision
 * (PLG-31 #16). An owner-approved task that then FAILS reads `outcome: 'approved'`
 * + `executionResult: 'failed'`, not "Denied".
 */
export type ExecutionResult = 'pending' | 'completed' | 'failed' | 'unknown';

/** A resolved approval row — base entry plus its terminal outcome + time. */
export type ResolvedInboxEntry = InboxEntry & {
  outcome: ApprovalOutcome;
  /** PLG-31 #16: the execution result, separate from the owner decision. */
  executionResult?: ExecutionResult;
  /**
   * plugin_invocation only, on a COMPLETED task (§15.6): the runner's answer
   * as Dina-owned `label: value` lines over the fields the pinned result
   * schema admitted — Core's `/complete` refused anything outside it. Scalars
   * only, bounded in count and length; nested values are named, not shown.
   * This is untrusted-mode rendering: the plugin gets no layout, no links, no
   * badges — the owner reads facts in Dina's chrome.
   */
  resultLines?: string[];
  /**
   * plugin_invocation only, on a COMPLETED task (§15.6): the runner's answer
   * rendered through the card TEMPLATE the manifest declared and the owner
   * consented to, filled from the same schema-validated fields and passed
   * through `validateCardSpec` in untrusted mode. Core builds it
   * (`buildPluginResultCard`) so the phone and the web render the same bytes
   * and neither decides what is safe. Absent when the capability declares no
   * template, which is when `resultLines` is what the owner reads.
   */
  resultCard?: CardSpec;
  /** When the approval reached its terminal state (task.updated_at). */
  resolvedAt: number;
};

const MAX_RESULT_LINES = 12;
const MAX_RESULT_VALUE_CHARS = 120;
const MAX_RESULT_KEY_CHARS = 40;

/** One line of text: control, bidi and zero-width characters dropped, newlines folded, bounded. */
function oneLine(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The validated result of a completed plugin invocation, flattened to bounded lines. */
export function pluginResultLines(task: Pick<WorkflowTask, 'status' | 'result' | 'payload'>): string[] | undefined {
  if (task.status !== 'completed' || !isPluginInvocation(task)) return undefined;
  const parsed = safeParse(task.result ?? '');
  const lines: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (lines.length >= MAX_RESULT_LINES) {
      lines.push('…');
      break;
    }
    let shown: string;
    if (value === null || value === undefined) shown = '—';
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') shown = String(value);
    else if (Array.isArray(value)) shown = `${value.length} item${value.length === 1 ? '' : 's'}`;
    else shown = 'details';
    // Key and value are both the runner's bytes: one clean, bounded line each.
    lines.push(`${oneLine(key, MAX_RESULT_KEY_CHARS)}: ${oneLine(shown, MAX_RESULT_VALUE_CHARS)}`);
  }
  return lines;
}

/**
 * How a completed plugin invocation answers (§15.6): through the card
 * TEMPLATE the manifest declared and the owner consented to when there is
 * one, and on the `label: value` floor when there is not.
 *
 * Core builds the card (`buildPluginResultCard`) — the phone decides nothing
 * about what is safe to render, which is §15.13's rule: policy duplicated
 * across two clients is policy that diverges. The lines are kept either way,
 * so a template that renders to nothing still leaves the owner an answer.
 */
function pluginAnswer(
  task: WorkflowTask,
): { resultLines?: string[]; resultCard?: CardSpec } {
  if (!isPluginInvocation(task) || task.status !== 'completed') return {};
  const card = buildPluginResultCard({
    status: task.status,
    payload: task.payload,
    ...(task.result !== undefined ? { result: task.result } : {}),
  });
  return { resultLines: pluginResultLines(task) ?? [], ...(card !== null ? { resultCard: card } : {}) };
}

/**
 * The set of `state` values that count as "no longer pending" — i.e.
 * everything the Completed tab shows. `pending_approval` is the only
 * state excluded (it's the Pending tab's domain).
 *
 * The Core route (`GET /v1/workflow/tasks`) only filters by a SINGLE
 * state, so we fan out one query per state and merge. On mobile each call
 * is an in-process read against the local SQLCipher DB (cheap). On the web
 * thin-client each call is a SEPARATE HTTP GET to the brain proxy, so a
 * resolved-history load costs N (=6) round-trips — acceptable for the
 * Completed tab's infrequent loads, but a candidate for a single
 * multi-state query if it ever shows on a hot path.
 */
const RESOLVED_APPROVAL_STATES: readonly string[] = [
  'completed',
  'queued',
  'running',
  'recorded',
  'cancelled',
  'failed',
  // PLG-31 #14: a terminal state Core sets when an external effect MAY have
  // happened but cannot be confirmed (§9.5). It was omitted here, so those tasks
  // vanished from BOTH the pending and resolved lists — hiding exactly the case
  // the owner most needs to see.
  'outcome_unknown',
];

/**
 * Fetch resolved approvals across every terminal/decided state, tagged
 * with an outcome and ordered most-recent-first (history reads newest at
 * the top). Read-only — the Completed tab renders these without action
 * buttons.
 *
 * `limit` caps the TOTAL merged result, not the per-state query.
 */
export async function listResolvedApprovals(limit = 50): Promise<ResolvedInboxEntry[]> {
  const c = requireClient();
  // PLG-32 #26: fan out per-state, but do NOT silently swallow every rejection to
  // []. On the web thin-client each state is a separate HTTP GET, so an auth /
  // network / DB failure on one state used to drop that state's tasks with no
  // signal — a plausible-but-incomplete history (a dropped 'cancelled'/'failed'
  // state hides real denials/failures). Now: if EVERY state fails, throw so the
  // caller surfaces a real error instead of an empty-looking "no history"; if only
  // SOME fail, keep the partial result but log which states were lost.
  // Plugin invocations ride `delegation` tasks (§15.5), so each state is read
  // for both kinds; only delegations carrying the plugin envelope are kept.
  // Doubles the fan-out on the web thin client — the Completed tab is a cold
  // path, and a single multi-kind query stays the fix if it ever isn't.
  const queries = RESOLVED_APPROVAL_STATES.flatMap((state) => [
    { kind: 'approval' as const, state },
    { kind: 'delegation' as const, state },
  ]);
  const settled = await Promise.allSettled(
    queries.map((q) => c.listWorkflowTasks({ kind: q.kind, state: q.state as WorkflowTask['status'], limit })),
  );
  const failedStates = [
    ...new Set(queries.filter((_, i) => settled[i]?.status === 'rejected').map((q) => q.state)),
  ];
  if (failedStates.length === RESOLVED_APPROVAL_STATES.length) {
    const first = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult | undefined;
    throw first?.reason instanceof Error
      ? first.reason
      : new Error('failed to load approval history');
  }
  if (failedStates.length > 0) {
    console.warn(
      `[inbox] resolved-history is INCOMPLETE — ${failedStates.length} state fetch(es) failed: ${failedStates.join(', ')}`,
    );
  }
  const batches = settled.map((s, i) =>
    s.status !== 'fulfilled' ? [] : queries[i]?.kind === 'delegation' ? s.value.filter(isPluginInvocation) : s.value,
  );
  const merged: ResolvedInboxEntry[] = [];
  for (const tasks of batches) {
    for (const task of tasks) {
      merged.push({
        ...toEntry(task),
        outcome: outcomeForTask(task),
        executionResult: executionResultForTask(task),
        ...pluginAnswer(task),
        resolvedAt: task.updated_at ?? task.created_at,
      });
    }
  }
  // Newest first; cap the merged total.
  merged.sort((a, b) => b.resolvedAt - a.resolvedAt);
  return merged.slice(0, limit);
}

/**
 * Map a resolved workflow task to its display outcome.
 *
 * The TTL sweeper closes a lapsed approval as `state='failed'` with
 * `error='expired'` (see `repository.expireTasks`) — so `error==='expired'`
 * is the ONLY way to tell an expiry apart from a genuine run failure or an
 * explicit operator deny on the wire. Operator deny resolves the task as
 * `cancelled`.
 */
function outcomeForTask(task: WorkflowTask): ApprovalOutcome {
  if (task.error === 'expired') return 'expired';
  switch (task.status) {
    // PLG-31 #16: OWNER DECISION only. A task that reached queued/running/
    // completed/recorded/failed got PAST pending_approval — i.e. the owner
    // APPROVED it; a later execution failure is NOT an owner denial (that lived
    // in `executionResult`). Only an operator cancel is a denial.
    case 'cancelled':
    case 'canceled':
      return 'denied';
    // PLG-31 #14: unconfirmed external effect — its own bucket, not "denied".
    case 'outcome_unknown':
      return 'unknown';
    case 'completed':
    case 'queued':
    case 'running':
    case 'recorded':
    case 'failed':
      return 'approved';
    default:
      return 'unknown';
  }
}

/** PLG-31 #16: the EXECUTION result, orthogonal to the owner decision above. */
function executionResultForTask(task: WorkflowTask): ExecutionResult | undefined {
  if (task.error === 'expired') return undefined; // expired before running
  // A remote coding-gate mirror is a phone-owned decision receipt, not work
  // that runs on the phone. Its queued state means "approved"; rendering an
  // execution result of "pending" would imply an executor is stuck here.
  const payloadType = safeParse(task.payload).type;
  if (payloadType === 'remote_coding_gate_v1' || payloadType === 'remote_facade_action_v1') {
    return undefined;
  }
  switch (task.status) {
    case 'completed':
    case 'recorded': // archival of a finished task
      return 'completed';
    case 'failed':
      return 'failed';
    case 'outcome_unknown':
      return 'unknown';
    case 'queued':
    case 'running':
      return 'pending';
    default:
      return undefined; // cancelled / denied — never ran
  }
}

/**
 * Workflow task lifecycle as the UI sees it. Three terminal-ish
 * buckets so the chat-thread inline card can persist its resolved
 * label across re-renders and across surfaces — if the operator
 * approves on the Approvals tab and then comes back to the chat
 * thread, the bubble already shows the resolved state instead of
 * re-rendering the action buttons.
 *
 *   - `pending`  — still awaiting a decision
 *   - `approved` — owner approved (queued / running / completed)
 *   - `denied`   — owner denied OR task failed / expired
 *   - `unknown`  — terminal but UNCONFIRMED (`outcome_unknown`): the external
 *                  effect may already have happened, so it is NOT a denial
 *   - `missing`  — task vanished (TTL swept, never existed, unrecognized)
 */
export type ApprovalLifecycleState = 'pending' | 'approved' | 'denied' | 'unknown' | 'missing';

/**
 * Probe a workflow task's current lifecycle bucket. Used by the chat
 * card to detect cross-surface state changes (the Approvals tab may
 * have already resolved this approval) and to gracefully recover from
 * "already resolved" errors when the operator double-taps across
 * surfaces.
 */
export async function getApprovalLifecycle(taskId: string): Promise<ApprovalLifecycleState> {
  const c = requireClient();
  const task = await c.getWorkflowTask(taskId);
  if (task === null) return 'missing';
  switch (task.status) {
    case 'pending_approval':
      return 'pending';
    // PLG-31 #15: queued / running / completed / recorded are all owner-approved
    // buckets. `recorded` is a terminal ARCHIVED state — it must NOT fall through
    // to `default` and regain actionable Approve/Deny buttons (a tap then fails
    // Core's transition). It is a resolved approval.
    case 'queued':
    case 'running':
    case 'completed':
    case 'recorded':
      return 'approved';
    case 'cancelled':
    case 'canceled':
    case 'failed':
    case 'expired':
      return 'denied';
    // PLG-31 #14/#15 + PLG-32 #21: `outcome_unknown` is terminal + UNCONFIRMED —
    // its own lifecycle bucket, NOT 'missing' (which the chat card renders as
    // "Denied"). The external effect may already have happened, so it must never
    // read as a denial.
    case 'outcome_unknown':
      return 'unknown';
    default:
      // PLG-31 #15: an UNKNOWN state must be non-actionable ('missing'), NOT
      // 'pending' — otherwise a terminal task the UI doesn't recognize regains
      // Approve/Deny buttons that Core will reject.
      return 'missing';
  }
}

/**
 * Approve a pending workflow task. All approval kinds — including
 * `vault_read` — are backed by workflow tasks, so this always calls
 * `approveWorkflowTask`.
 *
 * `scope` is only meaningful for `intent_validation` tasks:
 *   'single'  — one-time approval (default).
 *   'session' — auto-approve the same action for the session (~30 min).
 */
export async function approvePending(
  taskId: string,
  kind: InboxEntryKind = 'service_query',
  scope?: 'single' | 'session',
  /**
   * PLUGIN_ARCHITECTURE §15.5 "Allow for 24 hours" — only a plugin invocation
   * takes it; Core mints the window grant beside the approval and refuses it
   * on any other task.
   */
  pluginGrant?: 'window_24h',
): Promise<WorkflowTask> {
  const c = requireClient();
  const opts = {
    ...(scope !== undefined ? { scope } : {}),
    ...(pluginGrant === 'window_24h' && kind === 'plugin_invocation'
      ? { pluginGrant: { type: 'window' as const, hours: 24 } }
      : {}),
  };
  const out = await c.approveWorkflowTask(taskId, Object.keys(opts).length > 0 ? opts : undefined);
  // The workflow approval inbox bridge writes a notification at task
  // CREATE with `id === task.id`. The bridge does not (yet) listen for
  // task RESOLUTION, so without this the tab-bar badge would still
  // count the resolved entry as unread — "All caught up" list with a
  // red `1` on the icon. Mark read on the same surface that resolved
  // the task so the badge clears. `markNotificationRead` is a no-op
  // when the id isn't found (e.g. ApprovalManager path, which uses a
  // different id space).
  markNotificationRead(taskId);
  return out;
}

/**
 * Deny a pending task with an optional reason.
 *
 * Two flavours, discriminated on the approval task's payload kind:
 *
 *   - `service_query` (bus-driver flow): mirror the chat
 *     `/service_deny` handler — send an `unavailable` D2D so the
 *     requester sees a real reason instead of TTL-timing out, then
 *     fall back to `cancelWorkflowTask` only if the respond failed
 *     (review #1: respond already terminates the task; double-cancel
 *     produces a spurious 409). Issue #5.
 *
 *   - `intent_validation` (`dina validate` flow): the requester is an
 *     OpenClaw agent polling `/v1/intent/:id/status`; there is no
 *     service.query waiting on a D2D response. Just cancel the task
 *     — the agent's next poll sees `cancelled → status='denied'`.
 *
 *   - `staging_persona_access`: this is a local `/remember` gate. Just
 *     cancel the workflow task; Core marks the staged row denied.
 *
 *   - `unknown`: fall back to the service_query path. Worst case the
 *     respond fails because the requester DID is missing/malformed
 *     and we cancel anyway.
 *
 * Caller passes the entry's `kind` so we don't have to re-fetch the
 * task to inspect the payload. When omitted, default to the service
 * query flow because it is the only variant with a D2D requester.
 */
export async function denyPending(
  taskId: string,
  reason = 'denied_by_operator',
  kind: InboxEntryKind = 'service_query',
): Promise<WorkflowTask> {
  const core = requireClient();
  const denyReason = reason.trim() === '' ? 'denied_by_operator' : reason.trim();

  if (
    kind === 'vault_read' ||
    kind === 'intent_validation' ||
    kind === 'remote_coding_gate' ||
    kind === 'staging_persona_access' ||
    // §15.5 — a denied plugin invocation is a cancelled task; Core records
    // the owner's decision and the runner simply never sees it.
    kind === 'plugin_invocation' ||
    // GROUP_COORDINATION §6 — a denied disclosure is a cancelled card; Core
    // releases the held reply WITHOUT the disclosure, so the requester still
    // hears the availability. No `unavailable` is sent.
    kind === 'disclosure_review'
  ) {
    // Plain cancel — no service.respond peer to notify. The agent
    // observes intent_validation through polling; staging approvals are
    // local and Core handles the pending_unlock denial.
    const result = await core.cancelWorkflowTask(taskId, denyReason);
    markNotificationRead(taskId); // see comment in approvePending
    return result;
  }

  try {
    await core.sendServiceRespond(taskId, {
      status: 'unavailable',
      error: denyReason,
    });
  } catch {
    const result = await core.cancelWorkflowTask(taskId, denyReason);
    markNotificationRead(taskId); // see comment in approvePending
    return result;
  }
  const fresh = await core.getWorkflowTask(taskId);
  markNotificationRead(taskId); // see comment in approvePending
  if (fresh === null) {
    // Task vanished — treat as canceled-equivalent so the UI can
    // drop it from the inbox.
    return {
      id: taskId,
      kind: 'approval',
      status: 'canceled',
      priority: 'normal',
      description: '',
      payload: '',
      result_summary: '',
      policy: '',
      created_at: 0,
      updated_at: 0,
    };
  }
  return fresh;
}

function requireClient(): InboxCoreClient {
  if (client === null) throw new InboxNotConfiguredError();
  return client;
}

function toEntry(task: WorkflowTask): InboxEntry {
  const parsed = safeParse(task.payload);
  const payloadType = typeof parsed.type === 'string' ? parsed.type : '';

  if (payloadType === 'plugin_invocation') {
    // Everything on this card is Dina-owned: the PINNED envelope (§9.1) gives
    // the exact params that will ship, the consented action class and the
    // install; Core's card facts (`policy`: the risk IT decided and why it
    // carded) give the level and the reason. Nothing the plugin wrote — not
    // its display names, not its rationale — reaches the chrome, and the
    // phone never re-derives a risk Core already decided.
    const capability = typeof parsed.capability_id === 'string' ? parsed.capability_id : '';
    const installId = typeof parsed.install_id === 'string' ? parsed.install_id : '';
    const actionClass = typeof parsed.action_class === 'string' ? parsed.action_class : 'unknown';
    const card = readCardPolicy(task.policy);
    return {
      id: task.id,
      kind: 'plugin_invocation',
      capability,
      serviceName: 'Plugin action',
      description: card?.reasons.join('; ') ?? '',
      requesterDID: '',
      paramsPreview: 'params' in parsed ? JSON.stringify(parsed.params, null, 2) : '',
      ...(card !== null ? { riskLevel: card.riskLevel, grantCanSilence: card.grantCanSilence } : {}),
      ...(card?.contextSummary !== undefined ? { contextSummary: card.contextSummary } : {}),
      effect: { actionClass, retryIdempotent: parsed.effects_idempotency === 'supported', installId },
      createdAt: task.created_at,
      ...(task.expires_at !== undefined ? { expiresAt: task.expires_at } : {}),
    };
  }
  if (payloadType === 'intent_validation') {
    const action = typeof parsed.action === 'string' ? parsed.action : '';
    const target = typeof parsed.target === 'string' ? parsed.target : '';
    const agentDID = typeof parsed.agent_did === 'string' ? parsed.agent_did : '';
    const riskLevel = normaliseRiskLevel(parsed.risk_level);
    return {
      id: task.id,
      kind: 'intent_validation',
      capability: action,
      serviceName: '',
      description: task.description ?? '',
      requesterDID: agentDID,
      paramsPreview: target,
      ...(riskLevel !== undefined ? { riskLevel } : {}),
      createdAt: task.created_at,
      ...(task.expires_at !== undefined ? { expiresAt: task.expires_at } : {}),
    };
  }

  if (payloadType === 'remote_coding_gate_v1') {
    const action = typeof parsed.action === 'string' ? parsed.action : '';
    const toolName = typeof parsed.tool_name === 'string' ? parsed.tool_name : '';
    const sourceDeviceDID =
      typeof parsed.source_device_did === 'string' ? parsed.source_device_did : '';
    return {
      id: task.id,
      kind: 'remote_coding_gate',
      capability: action,
      serviceName: 'Coding agent',
      description: task.description ?? '',
      // Trusted chrome identifies the authenticated paired device. `agent_did`
      // is proposal metadata supplied by that device and must not replace the
      // transport-authenticated principal in the approval card.
      requesterDID: sourceDeviceDID,
      paramsPreview: toolName,
      riskLevel: 'HIGH',
      createdAt: task.created_at,
      ...(task.expires_at !== undefined ? { expiresAt: task.expires_at } : {}),
    };
  }

  if (payloadType === 'agent_facade_action_v1' || payloadType === 'remote_facade_action_v1') {
    const action = parsed.action === 'talk' || parsed.action === 'delegate' ? parsed.action : '';
    const title =
      typeof parsed.display_title === 'string'
        ? parsed.display_title
        : action === 'talk'
          ? 'Send a message'
          : 'Delegate a task';
    const detail = typeof parsed.display_detail === 'string' ? parsed.display_detail : '';
    const requesterDID =
      payloadType === 'remote_facade_action_v1'
        ? typeof parsed.source_device_did === 'string'
          ? parsed.source_device_did
          : ''
        : typeof parsed.agent_did === 'string'
          ? parsed.agent_did
          : '';
    return {
      id: task.id,
      kind: 'agent_action',
      capability: action,
      serviceName: title,
      description: title,
      requesterDID,
      paramsPreview: detail,
      riskLevel: 'HIGH',
      createdAt: task.created_at,
      ...(task.expires_at !== undefined ? { expiresAt: task.expires_at } : {}),
    };
  }

  if (payloadType === 'disclosure_review') {
    // Core composed the description (who asks, which kinds); the lines are
    // the exact disclosures that would leave. Deny sends the reply without them.
    const context = parsed.context as { fromDID?: unknown; capability?: unknown } | undefined;
    const capability = typeof context?.capability === 'string' ? context.capability : '';
    const requesterDID = typeof context?.fromDID === 'string' ? context.fromDID : '';
    const disclosures: unknown[] = Array.isArray(parsed.disclosures) ? parsed.disclosures : [];
    const lines: string[] = [];
    for (const d of disclosures) {
      if (d === null || typeof d !== 'object') continue;
      const { kind, text } = d as { kind?: unknown; text?: unknown };
      if (typeof kind !== 'string' || typeof text !== 'string') continue;
      lines.push(`${oneLine(kind, 20)}: ${oneLine(text, MAX_RESULT_VALUE_CHARS)}`);
    }
    return {
      id: task.id,
      kind: 'disclosure_review',
      capability,
      serviceName: 'Household disclosure',
      description: task.description ?? '',
      requesterDID,
      paramsPreview: lines.join('\n'),
      createdAt: task.created_at,
      ...(task.expires_at !== undefined ? { expiresAt: task.expires_at } : {}),
    };
  }

  if (payloadType === 'vault_read_request') {
    const persona = typeof parsed.persona === 'string' ? parsed.persona : '';
    const requesterDID = typeof parsed.requester_did === 'string' ? parsed.requester_did : '';
    const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
    const preview = typeof parsed.preview === 'string' ? parsed.preview : '';
    return {
      id: task.id,
      kind: 'vault_read',
      capability: persona,
      serviceName: 'Vault access',
      description: reason,
      requesterDID,
      paramsPreview: preview,
      createdAt: task.created_at,
      ...(task.expires_at !== undefined ? { expiresAt: task.expires_at } : {}),
    };
  }

  if (payloadType === 'agent_persona_access') {
    const persona = typeof parsed.persona === 'string' ? parsed.persona : '';
    const agentDID = typeof parsed.agent_did === 'string' ? parsed.agent_did : '';
    const scope = typeof parsed.scope === 'string' ? parsed.scope : '';
    // PLG-29 #1: pin the exact mode into trusted approval chrome. Fail safe —
    // anything other than an explicit 'read' is shown as 'write', so a
    // missing/garbled mode never under-states the authority up for approval.
    const accessMode: 'read' | 'write' = parsed.mode === 'read' ? 'read' : 'write';
    return {
      id: task.id,
      kind: 'vault_read',
      capability: persona,
      serviceName: accessMode === 'write' ? 'Vault WRITE access' : 'Vault read access',
      description: scope || task.description || '',
      requesterDID: agentDID,
      paramsPreview: scope,
      accessMode,
      createdAt: task.created_at,
      ...(task.expires_at !== undefined ? { expiresAt: task.expires_at } : {}),
    };
  }

  if (payloadType === 'staging_persona_access') {
    const persona = typeof parsed.persona === 'string' ? parsed.persona : '';
    const source = typeof parsed.source === 'string' ? parsed.source : '';
    const sourceId = typeof parsed.source_id === 'string' ? parsed.source_id : '';
    const preview = typeof parsed.preview === 'string' ? parsed.preview : '';
    return {
      id: task.id,
      kind: 'staging_persona_access',
      capability: persona,
      serviceName: 'Memory access',
      description: task.description ?? '',
      requesterDID: source !== '' ? source : sourceId,
      paramsPreview: preview,
      createdAt: task.created_at,
      ...(task.expires_at !== undefined ? { expiresAt: task.expires_at } : {}),
    };
  }

  // Default — service_query (bus-driver) flow. Falls through to
  // 'unknown' when the payload is malformed enough that neither
  // capability nor type could be read.
  const capability = typeof parsed.capability === 'string' ? parsed.capability : '';
  const serviceName = typeof parsed.service_name === 'string' ? parsed.service_name : '';
  const requesterDID =
    typeof parsed.from_did === 'string'
      ? parsed.from_did
      : typeof parsed.requester_did === 'string'
        ? parsed.requester_did
        : '';
  const paramsPreview = summariseParams(parsed.params);
  const isServiceQuery =
    payloadType === 'service_query_execution' || (payloadType === '' && capability !== '');
  return {
    id: task.id,
    kind: isServiceQuery ? 'service_query' : 'unknown',
    capability,
    serviceName,
    description: task.description ?? '',
    requesterDID,
    paramsPreview,
    createdAt: task.created_at,
    ...(task.expires_at !== undefined ? { expiresAt: task.expires_at } : {}),
  };
}

function normaliseRiskLevel(raw: unknown): InboxEntry['riskLevel'] | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw === 'SAFE' || raw === 'MODERATE' || raw === 'HIGH' || raw === 'BLOCKED') return raw;
  return undefined;
}

/**
 * Core's card facts for a carded plugin invocation (`plugins/invoke.ts`,
 * `PLUGIN_INVOCATION_CARD_POLICY`): the risk level Core decided and the
 * reasons it carded. Absent on a task that ran silent, or on an older row.
 */
function readCardPolicy(raw: string): {
  riskLevel: InboxEntry['riskLevel'];
  reasons: string[];
  grantCanSilence: boolean;
  contextSummary?: { categories: string[]; itemCount: number };
} | null {
  const parsed = safeParse(raw);
  if (parsed.type !== 'plugin_invocation_card') return null;
  const riskLevel = normaliseRiskLevel(parsed.risk_level);
  const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.filter((r): r is string => typeof r === 'string') : [];
  if (riskLevel === undefined) return null;
  const context = readContextSummary(parsed.context);
  return {
    riskLevel,
    reasons,
    grantCanSilence: parsed.grant_can_silence === true,
    ...(context !== null ? { contextSummary: context } : {}),
  };
}

/**
 * §11's projection summary off the card facts. A task written before the
 * projector existed carries none, which is why absence reads as "not stated"
 * rather than as a proven zero.
 */
function readContextSummary(raw: unknown): { categories: string[]; itemCount: number } | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as { categories?: unknown; item_count?: unknown };
  if (!Array.isArray(value.categories) || !value.categories.every((c) => typeof c === 'string')) return null;
  if (typeof value.item_count !== 'number' || !Number.isInteger(value.item_count) || value.item_count < 0) {
    return null;
  }
  return { categories: value.categories as string[], itemCount: value.item_count };
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function summariseParams(params: unknown, max = 120): string {
  if (params === undefined || params === null) return '';
  try {
    const s = typeof params === 'string' ? params : JSON.stringify(params);
    return s.length <= max ? s : `${s.slice(0, max)}…`;
  } catch {
    return '';
  }
}
