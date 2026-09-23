/**
 * Settings proposals from an integration (JIFFY_MERCHANT_INTEGRATION_PLAN
 * §3.2, B3).
 *
 * A connector never writes the supplier's terms. It PROPOSES a change to a
 * fixed set of controls against the revision it last read, and the proposal
 * becomes an ordinary owner approval task — the same card kind the disclosure
 * review uses, decided on the owner's own inbox, and refused to Brain by the
 * workflow routes. The owner's yes applies the change through the settings
 * store's own validation; a no or a lapse applies nothing. Between proposal
 * and approval the revision may move; the apply re-checks it and fails the
 * task rather than overwrite what the owner set in the meantime.
 *
 * IDEMPOTENT BY COMMAND. The task's idempotency key is the connector's
 * command id, and the payload carries a digest of the proposal's content.
 * The same command with the same content returns the recorded outcome; the
 * same command with different content is a conflict, never a second card.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { canonicalJson } from '@dina/protocol';

import { appendAudit } from '../audit/service';
import { WorkflowTaskKind, WorkflowTaskState, type WorkflowTask } from '../workflow/domain';
import { WorkflowConflictError } from '../workflow/repository';
import {
  getWorkflowService,
  type ApprovalDecisionHandler,
  type WorkflowHooks,
  type WorkflowService,
} from '../workflow/service';

import {
  validateSupplierSettings,
  type SettingsFinding,
  type SupplierSettings,
} from './commerce_settings';
import { settingsRevision } from './integration';
import { getCommerceRuntime, type CommerceRuntime } from './runtime';

const SHA256_HEX = /^[0-9a-f]{64}$/;

export const INTEGRATION_SETTINGS_PROPOSAL_TYPE = 'integration_settings_proposal';

/**
 * The supplier controls a proposal may name. Everything else on the record is
 * the node's identity or its connector wiring — `actingBusinessDid`,
 * `catalogSource`, `connectors`, `customerPricingSource` — and changing those
 * is a re-consent event (§6.5), never a proposal.
 */
export const SUPPLIER_PROPOSABLE_CONTROLS = [
  'publishIndicativePrice',
  'quoteAccess',
  'responsePolicy',
  'orderAcceptance',
  'acceptColdInvites',
  'listingState',
  'tradingCurrency',
  'catalogCategoryIds',
  'publicRegions',
] as const;
export type SupplierProposableControl = (typeof SUPPLIER_PROPOSABLE_CONTROLS)[number];

export interface SettingsProposalPayload {
  type: typeof INTEGRATION_SETTINGS_PROPOSAL_TYPE;
  command_id: string;
  kind: 'supplier';
  expected_revision: string;
  controls: Partial<Pick<SupplierSettings, SupplierProposableControl>>;
  /** sha256 of the canonical `{kind, expected_revision, controls}`. */
  content_digest: string;
  /** The device that proposed, or `owner` when the owner used the route. */
  proposed_by: string;
}

export type ProposalRefusal =
  | 'unsupported_control'
  | 'settings_absent'
  | 'revision_conflict'
  | 'command_conflict'
  | 'invalid_settings'
  | 'workflow_unavailable';

export type ProposeOutcome =
  | { kind: 'pending'; taskId: string }
  | { kind: 'applied'; taskId: string; revision: string | null }
  /** The owner said no, the card lapsed, or the apply failed; the detail says which. */
  | { kind: 'closed'; taskId: string; state: string; detail: string }
  | {
      kind: 'refused';
      refusal: ProposalRefusal;
      detail?: string;
      findings?: SettingsFinding[];
      currentRevision?: string;
    };

function hexDigest(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

export function proposalTaskId(commandId: string): string {
  return `integration-settings-${hexDigest(commandId).slice(0, 32)}`;
}

export function proposalIdempotencyKey(commandId: string): string {
  return `integration_settings:${commandId}`;
}

function contentDigest(expectedRevision: string, controls: Record<string, unknown>): string {
  return hexDigest(
    canonicalJson({ kind: 'supplier', expected_revision: expectedRevision, controls }),
  );
}

export function parseSettingsProposalPayload(text: string): SettingsProposalPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const p = value as Partial<SettingsProposalPayload>;
  if (p.type !== INTEGRATION_SETTINGS_PROPOSAL_TYPE || p.kind !== 'supplier') return null;
  if (typeof p.command_id !== 'string' || typeof p.expected_revision !== 'string') return null;
  if (typeof p.content_digest !== 'string' || typeof p.proposed_by !== 'string') return null;
  if (p.controls === null || typeof p.controls !== 'object' || Array.isArray(p.controls))
    return null;
  return p as SettingsProposalPayload;
}

/** Keys outside the allowlist, so a refusal can name them. */
export function unsupportedControls(controls: Record<string, unknown>): string[] {
  const allowed: readonly string[] = SUPPLIER_PROPOSABLE_CONTROLS;
  return Object.keys(controls).filter((key) => !allowed.includes(key));
}

/**
 * Merge a proposal onto the current record and validate the result. Null
 * when there is no current record — a proposal needs a base the owner set.
 */
export function mergedSupplierSettings(
  runtime: Pick<CommerceRuntime, 'settings'>,
  controls: SettingsProposalPayload['controls'],
):
  | { ok: true; settings: SupplierSettings; currentRevision: string }
  | { ok: false; refusal: 'settings_absent' | 'invalid_settings'; findings?: SettingsFinding[] } {
  const read = runtime.settings.readSupplier();
  if (!read.ok) return { ok: false, refusal: 'settings_absent' };
  const merged: SupplierSettings = { ...read.settings, ...controls };
  const verdict = validateSupplierSettings(merged);
  if (!verdict.ok) return { ok: false, refusal: 'invalid_settings', findings: verdict.findings };
  const currentRevision = settingsRevision(read);
  if (currentRevision === null) return { ok: false, refusal: 'settings_absent' };
  return { ok: true, settings: merged, currentRevision };
}

/**
 * The revision a completed card recorded, read TOWARD the empty answer: an
 * absent, unreadable or ill-shaped result reports no revision rather than
 * one nobody checked. The live revision is always on the status door.
 */
export function appliedRevisionOf(task: WorkflowTask): string | null {
  if (task.status !== WorkflowTaskState.Completed || task.result === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(task.result);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const revision = (value as { applied_revision?: unknown }).applied_revision;
  return typeof revision === 'string' && SHA256_HEX.test(revision) ? revision : null;
}

function outcomeOfExisting(task: WorkflowTask, digest: string): ProposeOutcome {
  const payload = parseSettingsProposalPayload(task.payload);
  if (payload === null || payload.content_digest !== digest) {
    return {
      kind: 'refused',
      refusal: 'command_conflict',
      detail: 'this command id was used with different content',
    };
  }
  // Mid-apply (the CAS approve moved it to queued, the handler is running)
  // is still pending from the caller's side: nothing has been refused.
  if (
    task.status === WorkflowTaskState.PendingApproval ||
    task.status === WorkflowTaskState.Queued ||
    task.status === WorkflowTaskState.Running
  ) {
    return { kind: 'pending', taskId: task.id };
  }
  if (task.status === WorkflowTaskState.Completed) {
    return { kind: 'applied', taskId: task.id, revision: appliedRevisionOf(task) };
  }
  return {
    kind: 'closed',
    taskId: task.id,
    state: task.status,
    detail: task.error ?? 'the owner did not apply this proposal',
  };
}

/**
 * Propose. Refuses what can be refused before a card exists — controls off
 * the allowlist, no base record, a stale revision, a merge that does not
 * validate — so the owner is asked only about a change that could apply.
 */
export function proposeSupplierSettings(
  runtime: Pick<CommerceRuntime, 'settings'>,
  workflow: WorkflowService | null,
  args: {
    commandId: string;
    expectedRevision: string;
    controls: Record<string, unknown>;
    proposedBy: string;
  },
): ProposeOutcome {
  const unsupported = unsupportedControls(args.controls);
  if (unsupported.length > 0) {
    return {
      kind: 'refused',
      refusal: 'unsupported_control',
      detail: unsupported.sort().join(', '),
    };
  }
  if (workflow === null) return { kind: 'refused', refusal: 'workflow_unavailable' };
  const digest = contentDigest(args.expectedRevision, args.controls);
  const existing = workflow.store().getByIdempotencyKey(proposalIdempotencyKey(args.commandId));
  if (existing !== null) return outcomeOfExisting(existing, digest);
  const merged = mergedSupplierSettings(
    runtime,
    args.controls as SettingsProposalPayload['controls'],
  );
  if (!merged.ok)
    return {
      kind: 'refused',
      refusal: merged.refusal,
      ...(merged.findings !== undefined ? { findings: merged.findings } : {}),
    };
  if (merged.currentRevision !== args.expectedRevision) {
    return {
      kind: 'refused',
      refusal: 'revision_conflict',
      currentRevision: merged.currentRevision,
    };
  }
  const payload: SettingsProposalPayload = {
    type: INTEGRATION_SETTINGS_PROPOSAL_TYPE,
    command_id: args.commandId,
    kind: 'supplier',
    expected_revision: args.expectedRevision,
    controls: args.controls as SettingsProposalPayload['controls'],
    content_digest: digest,
    proposed_by: args.proposedBy,
  };
  const taskId = proposalTaskId(args.commandId);
  try {
    workflow.create({
      id: taskId,
      kind: WorkflowTaskKind.Approval,
      description: `Apply ${Object.keys(args.controls).length} supplier setting change(s) proposed by ${args.proposedBy}?`,
      payload: JSON.stringify(payload),
      idempotencyKey: proposalIdempotencyKey(args.commandId),
      // The family key: every proposal card, whatever its state, is listed by it.
      correlationId: INTEGRATION_SETTINGS_PROPOSAL_TYPE,
      origin: 'cli',
      initialState: WorkflowTaskState.PendingApproval,
    });
  } catch (error) {
    if (error instanceof WorkflowConflictError) {
      const raced = workflow.store().getByIdempotencyKey(proposalIdempotencyKey(args.commandId));
      if (raced !== null) return outcomeOfExisting(raced, digest);
    }
    throw error;
  }
  appendAudit(
    'integration',
    'settings_proposal_carded',
    taskId,
    `controls=${Object.keys(args.controls).length} by=${args.proposedBy}`,
  );
  return { kind: 'pending', taskId };
}

/**
 * Every proposal on the node, newest first, as `(task, payload)` — read by
 * the family's correlation key, so a node busy with other approvals never
 * pushes a proposal off the page, and a card in any state is listed.
 */
export function listSettingsProposals(
  workflow: WorkflowService,
  limit = 50,
): { task: WorkflowTask; payload: SettingsProposalPayload }[] {
  const out: { task: WorkflowTask; payload: SettingsProposalPayload }[] = [];
  for (const task of workflow.store().getByCorrelationId(INTEGRATION_SETTINGS_PROPOSAL_TYPE)) {
    const payload = parseSettingsProposalPayload(task.payload);
    if (payload !== null) out.push({ task, payload });
  }
  return out.sort((a, b) => b.task.created_at - a.task.created_at).slice(0, limit);
}

/**
 * The owner decided. A yes applies the merge — re-validated against the
 * record as it stands NOW, and refused if the revision moved since the
 * proposal — then completes the card with the applied revision, or fails it
 * with the reason. A no or a lapse applies nothing; the store already closed
 * the card.
 */
export function makeSettingsProposalDecisionHandler(deps: {
  runtime: () => Pick<CommerceRuntime, 'settings'> | null;
  workflow: () => WorkflowService | null;
  nowMs: () => number;
}): ApprovalDecisionHandler {
  return ({ task, decision }) => {
    const payload = parseSettingsProposalPayload(task.payload);
    if (payload === null) return;
    appendAudit(
      'integration',
      `settings_proposal_${decision}`,
      task.id,
      `by=${payload.proposed_by}`,
    );
    if (decision !== 'approved') return;
    const workflow = deps.workflow();
    if (workflow === null) return;
    const runtime = deps.runtime();
    const settle = (
      result: { ok: true; revision: string } | { ok: false; reason: string },
    ): void => {
      try {
        workflow
          .store()
          .transition(task.id, WorkflowTaskState.Queued, WorkflowTaskState.Running, deps.nowMs());
        if (result.ok) {
          workflow.complete(
            task.id,
            JSON.stringify({ applied_revision: result.revision }),
            'settings applied',
          );
        } else {
          workflow.fail(task.id, result.reason);
        }
      } catch {
        /* a raced transition changes nothing the owner decided */
      }
    };
    if (runtime === null) return settle({ ok: false, reason: 'commerce_unavailable' });
    const merged = mergedSupplierSettings(runtime, payload.controls);
    if (!merged.ok) return settle({ ok: false, reason: merged.refusal });
    if (merged.currentRevision !== payload.expected_revision) {
      return settle({
        ok: false,
        reason: 'revision_conflict: the settings changed after this was proposed',
      });
    }
    const written = runtime.settings.writeSupplier(merged.settings);
    if (!written.ok) return settle({ ok: false, reason: 'invalid_settings' });
    // The revision of the bytes just written — the same derivation the status
    // door runs over a read, applied to the record this handler holds.
    settle({ ok: true, revision: settingsRevision({ ok: true, settings: merged.settings }) ?? '' });
  };
}

/**
 * The integration's contribution to the workflow service: no egress gate (a
 * settings proposal carries no provider answer), and the decision handler
 * above. Composed with the coordination hooks at every host through
 * `composeWorkflowHooks`.
 */
export function integrationWorkflowHooks(over: { nowMs?: () => number } = {}): WorkflowHooks {
  return {
    responseEgressGate: () => ({ kind: 'passthrough' }),
    approvalDecisionHandler: makeSettingsProposalDecisionHandler({
      runtime: getCommerceRuntime,
      workflow: getWorkflowService,
      nowMs: over.nowMs ?? Date.now,
    }),
  };
}
