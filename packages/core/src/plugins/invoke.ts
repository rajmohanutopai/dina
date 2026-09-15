/**
 * The tool-lane DISPATCH PRODUCER (PLUGIN_ARCHITECTURE.md §9.1, §15.5): the
 * owner's side of a plugin. Until this module existed a runner could only be
 * reached from a PEER (`provider_ingress.ts`: a buyer's query lands on the
 * supplier's plugin lane); nothing on the owner's own node could ask an
 * installed capability to do anything. An installed country pack was a granted
 * contract that no code ever called.
 *
 * ONE TASK, ONE LANE. An invocation is a single `delegation` task on
 * `plugin:<install_id>` carrying the pinned envelope (`buildPluginEnvelope`)
 * that the six claim-time checks verify against. The gate decides its FIRST
 * state:
 *
 *   silent  → `queued` under a consumed standing grant (`authorization: grant`);
 *   card    → `pending_approval` (`authorization: card`) — the owner's approval
 *             moves the SAME task to `queued` (`WorkflowService.approve`), so the
 *             envelope the owner saw is the envelope the runner claims; a denial
 *             cancels it;
 *   blocked → no task, a typed refusal.
 *
 * A card task is NEVER created `queued`: `pending_approval` cannot be claimed
 * (the claim SQL selects `queued` only), so the owner's decision is the one
 * thing standing between the envelope and the runner.
 *
 * THE GATE is the same one every other plugin effect meets — the deterministic
 * floor table (`evaluatePluginIntent`, §8) crossed with params-as-egress
 * (`assessParamsEgress`, §11.5) through `decideDispatch`. The policy inputs a
 * root may inject (`capabilityKind`, `publisherRing`, `priorInvocations`)
 * default to the STRICTEST reading, exactly as the host-operation lane does:
 * custom / unverified / zero — nothing above SAFE runs silent on a guess.
 *
 * A standing grant is CONSUMED only when the decision is silent, and only
 * then is the envelope pinned to it (grant id + invocation digest, which the
 * claim guard recomputes). A grant whose constraints refuse THIS invocation
 * (count exhausted, resource, value cap) does not fail the call — it cards it,
 * with the refusal as the reason, so the owner decides.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { pluginLane, type PluginCapabilityDecl } from '@dina/protocol';

import { appendAudit } from '../audit/service';
import { evaluatePluginIntent, type PluginPublisherRing, type RiskLevel } from '../gatekeeper/intent';
import { getPersona } from '../persona/service';
import { WorkflowTaskState, type WorkflowTask } from '../workflow/domain';
import {
  isBoundedIdentityString,
  PLUGIN_INVOCATION_PAYLOAD_TYPE,
  parsePluginEnvelope,
} from '../workflow/plugin_envelope';


import {
  projectInvocationContext,
  projectedCategories,
  projectionDigest,
  type ContextProjection,
} from './context_projection';
import { type InvocationSubject } from './context_sources';
import { CONTEXT_TEMPLATE_VERSION } from './context_templates';
import { getPluginDecisionRepository, recordDecisionSafe } from './decisions';
import { assessParamsEgress, buildPluginEnvelope, decideDispatch } from './dispatch';
import {
  getPluginGrantRepository,
  invocationDigest,
  parseConstraints,
  type GrantDenialReason,
  type PluginGrantConstraints,
} from './grants';
import { consentedCapability } from './host_operation_lane';
import { getPluginInstallRepository, type PluginInstall } from './registry';

import type { CreateWorkflowTaskInput } from '../workflow/service';

/** The slice of the workflow service the producer needs — easy to fake. */
export interface InvocationTaskCreator {
  create(input: CreateWorkflowTaskInput): WorkflowTask;
  store(): {
    /** Dedup: the live task already asked under this idempotency key, if any. */
    getActiveByIdempotencyKey(key: string): WorkflowTask | null;
    /** Did a failed `create` leave a row behind? Decides whether a charged use is released. */
    getById(id: string): WorkflowTask | null;
  };
}

/** Policy resolvers a composition root may inject; every default is the strictest reading. */
export interface InvokePolicy {
  capabilityKind?: (capability: PluginCapabilityDecl) => 'canonical' | 'custom';
  publisherRing?: (install: PluginInstall) => PluginPublisherRing;
  /** §8 first-N — defaults to the owner's recorded `invocation_approved` decisions for this capability. */
  priorInvocations?: (args: { install: PluginInstall; capability: PluginCapabilityDecl }) => number;
  /** data_scope intersects a sensitive-tier persona (§8 privacy clamp). */
  touchesSensitivePersona?: (install: PluginInstall, capability: PluginCapabilityDecl) => boolean;
  touchesLockedPersona?: (install: PluginInstall, capability: PluginCapabilityDecl) => boolean;
}

export interface InvokeToolCapabilityArgs {
  installId: string;
  capabilityId: string;
  params: unknown;
  /**
   * WHO and WHAT this task is about (§11). Identities only — Core projects
   * the facts itself. There is no caller-supplied context field on purpose:
   * §11 says context reaches an instance only inside a task payload assembled
   * per invocation, so a caller that could hand one over would be a second
   * projector, with the template table demoted to advice.
   */
  subject?: InvocationSubject;
  /** The caller's classification of the params (§11.5); unclassified non-empty params card. */
  paramCategories?: readonly string[];
  /** Dispatch metadata a grant's constraints match against. */
  resource?: string;
  value?: number;
  /**
   * Dedup key across re-invocations of the SAME logical ask (a re-delivered
   * khata document must not ask the rail twice). Defaults to the execution id.
   */
  idempotencyKey?: string;
  /** Ties the task to what it is about (a document digest, a query id). */
  correlationId?: string;
  /** Task origin (`AllowedOrigins`); the route passes `api`, the phone `dinamobile`, a hook `system`. */
  origin?: string;
  /** Seconds the task may wait: for the owner (card) or for a runner (silent). */
  ttlSeconds?: number;
  nowMs: number;
}

export interface InvokeToolCapabilityDeps {
  workflow: InvocationTaskCreator;
  policy?: InvokePolicy;
}

export type InvokeRefusalCode =
  | 'install_unknown'
  | 'install_not_active'
  | 'capability_not_consented'
  | 'not_a_tool'
  | 'blocked'
  | 'params_invalid'
  | 'registry_unavailable';

/**
 * What rides an invocation besides its params: the Dina-projected context
 * (§11), as METADATA. The owner is entitled to know that two business-registry
 * facts travel with a filing; the facts themselves are already on the card in
 * the params, and repeating a projection's contents there would make the card
 * the thing that leaks.
 */
export interface InvocationContextSummary {
  categories: string[];
  item_count: number;
}

/** Why the owner is being asked — rendered on the card, never an LLM summary. */
export interface InvocationCardFacts {
  riskLevel: RiskLevel;
  reasons: string[];
  /** The exact outbound params, WYSIWYG (§11.5). */
  paramsText: string;
  /** What Core's own projection added beyond the params. */
  context: InvocationContextSummary;
}

/**
 * The Core-owned facts a carded task carries in its `policy` field (§15.5:
 * "locally derived risk", "why the card appeared"). A surface renders THIS —
 * never the plugin's display names, which are the plugin's own words.
 */
export const PLUGIN_INVOCATION_CARD_POLICY = 'plugin_invocation_card';
export interface InvocationCardPolicy {
  type: typeof PLUGIN_INVOCATION_CARD_POLICY;
  risk_level: RiskLevel;
  reasons: string[];
  /**
   * Could a standing approval ever silence this capability (§8)? False for a
   * `sensitive`/`regulated` privacy class and for a sensitive-persona scope,
   * which card EVERY invocation whatever grant exists. A surface offers
   * "Allow for 24 hours" (§15.5) only when this is true — Core's word, so the
   * phone never promises a silence Core will not give.
   */
  grant_can_silence: boolean;
  /**
   * The projection that rides this invocation, as counts and category names.
   * Absent on a task written before the projector existed, which is why every
   * reader defaults it rather than treating its absence as zero-by-proof.
   */
  context?: InvocationContextSummary;
}

/** Read the Core-owned card facts off a task, or null when it carries none. */
export function readInvocationCardPolicy(task: Pick<WorkflowTask, 'policy'>): InvocationCardPolicy | null {
  try {
    const parsed = JSON.parse(task.policy) as Partial<InvocationCardPolicy> | null;
    if (
      parsed === null ||
      parsed.type !== PLUGIN_INVOCATION_CARD_POLICY ||
      typeof parsed.risk_level !== 'string' ||
      !Array.isArray(parsed.reasons) ||
      !parsed.reasons.every((r) => typeof r === 'string')
    ) {
      return null;
    }
    const context = readContextSummary(parsed.context);
    return {
      type: PLUGIN_INVOCATION_CARD_POLICY,
      risk_level: parsed.risk_level as RiskLevel,
      reasons: parsed.reasons,
      grant_can_silence: parsed.grant_can_silence === true,
      ...(context !== null ? { context } : {}),
    };
  } catch {
    return null;
  }
}

/** A stored context summary, or null when the row carries none it can trust. */
function readContextSummary(raw: unknown): InvocationContextSummary | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as { categories?: unknown; item_count?: unknown };
  if (!Array.isArray(value.categories) || !value.categories.every((c) => typeof c === 'string')) return null;
  if (typeof value.item_count !== 'number' || !Number.isInteger(value.item_count) || value.item_count < 0) {
    return null;
  }
  return { categories: value.categories as string[], item_count: value.item_count };
}

export type InvokeToolCapabilityResult =
  | {
      ok: true;
      mode: 'dispatched';
      taskId: string;
      executionId: string;
      /** The grant a grant-silenced run rides; absent for a SAFE floor (§8). */
      grantId?: string;
      /** True when a live task under the same idempotency key already asked this. */
      deduplicated?: true;
    }
  | {
      ok: true;
      mode: 'approval_required';
      taskId: string;
      executionId: string;
      card: InvocationCardFacts;
      deduplicated?: true;
    }
  | { ok: false; code: InvokeRefusalCode; message: string };

/** Pending approvals wait for a person; a queued task waits for a runner. */
export const DEFAULT_CARD_TTL_SECONDS = 24 * 3600;
export const DEFAULT_SILENT_TTL_SECONDS = 3600;

export function invokeToolCapability(
  args: InvokeToolCapabilityArgs,
  deps: InvokeToolCapabilityDeps,
): InvokeToolCapabilityResult {
  const installs = getPluginInstallRepository();
  if (installs === null) {
    return { ok: false, code: 'registry_unavailable', message: 'plugin registry not wired' };
  }
  const install = installs.getById(args.installId);
  if (install === null) {
    return { ok: false, code: 'install_unknown', message: `no install ${args.installId}` };
  }
  if (install.status !== 'active') {
    return {
      ok: false,
      code: 'install_not_active',
      message: `install ${args.installId} is ${install.status}, not active`,
    };
  }
  // The consented capability — from the pinned manifest AND the consent
  // record, never from the caller (host_operation_lane.ts explains why both).
  const capability = consentedCapability(install, args.capabilityId);
  if (capability === null) {
    return {
      ok: false,
      code: 'capability_not_consented',
      message: `capability ${args.capabilityId} is not consented on this install`,
    };
  }
  if (!(capability.kinds ?? []).includes('tool')) {
    return {
      ok: false,
      code: 'not_a_tool',
      message: `capability ${args.capabilityId} is not consented as a tool`,
    };
  }
  const approvedScopeHash = install.capabilityHashes[args.capabilityId] ?? '';

  // Identity fields the envelope parser would QUARANTINE at claim (bounded,
  // non-empty, spoof-free strings; a finite value) are refused here, before
  // any grant use is charged — a task terminalized `stale_authority` at claim
  // has nothing to give the use back.
  if (args.idempotencyKey !== undefined && !isBoundedIdentityString(args.idempotencyKey)) {
    return { ok: false, code: 'params_invalid', message: 'idempotency_key must be a bounded, non-empty, plain string' };
  }
  if (args.resource !== undefined && !isBoundedIdentityString(args.resource)) {
    return { ok: false, code: 'params_invalid', message: 'resource must be a bounded, non-empty, plain string' };
  }
  if (args.value !== undefined && !Number.isFinite(args.value)) {
    return { ok: false, code: 'params_invalid', message: 'value must be a finite number' };
  }
  // The subject is two identities, and they are held to the same bounded,
  // spoof-free shape as every other identity field on this call. A malformed
  // one is refused rather than silently ignored: a caller that meant to name a
  // counterparty and typo'd would otherwise get a projection about nobody and
  // no way to tell.
  const subject = args.subject ?? {};
  if (subject.contactDid !== undefined && !isBoundedIdentityString(subject.contactDid)) {
    return { ok: false, code: 'params_invalid', message: 'subject.contact_did must be a bounded, non-empty, plain string' };
  }
  if (subject.documentDigest !== undefined && !isBoundedIdentityString(subject.documentDigest)) {
    return { ok: false, code: 'params_invalid', message: 'subject.document_digest must be a bounded, non-empty, plain string' };
  }

  const executionId = `plgx_${bytesToHex(randomBytes(12))}`;
  const idempotencyKey = args.idempotencyKey ?? executionId;
  const nowSec = Math.floor(args.nowMs / 1000);
  const policy = deps.policy ?? {};

  // 1) Params as egress (§11.5): the exact object that ships, deep-scanned.
  const egress = assessParamsEgress({
    params: args.params,
    paramCategories: [...(args.paramCategories ?? [])],
    consentedCategories: capability.data_scope?.categories ?? [],
  });

  // 2) The floor (§8). A live grant is read WITHOUT consuming — it is only
  //    charged once the decision is actually silent.
  const grants = getPluginGrantRepository();
  const hasStandingApproval =
    grants?.hasLiveGrant(install.installId, capability.id, approvedScopeHash, nowSec) ?? false;
  // The persona ring the DECLARED scope reaches (§11 point 1). Derived here
  // rather than left to an injected policy: nothing in production ever passed
  // one, so the §8 privacy clamp and the locked-persona block were reading
  // `false` on every invocation — a gate wired to a constant. A root may still
  // override, but forgetting to now fails toward the clamp, not past it.
  const ring = declaredPersonaRing(capability);
  const touchesSensitivePersona = policy.touchesSensitivePersona?.(install, capability) ?? ring.sensitive;
  const touchesLockedPersona = policy.touchesLockedPersona?.(install, capability) ?? ring.locked;
  const intent = evaluatePluginIntent({
    actionClass: capability.action_class,
    capabilityId: capability.id,
    capabilityKind: policy.capabilityKind?.(capability) ?? 'custom',
    publisherRing: policy.publisherRing?.(install) ?? 'unverified',
    touchesSensitivePersona,
    touchesLockedPersona,
    priorInvocations:
      policy.priorInvocations?.({ install, capability }) ??
      approvedInvocationCount(install.installId, capability.id),
    hasStandingApproval,
    ...(capability.privacy_class !== undefined ? { privacyClass: capability.privacy_class } : {}),
  });
  const decision = decideDispatch(intent, egress);
  if (decision.mode === 'blocked') {
    return { ok: false, code: 'blocked', message: decision.reason };
  }

  // 2b) THE CONTEXT (§11). Projected here, AFTER the block check — a refused
  //     invocation never reads a store — and BEFORE the grant is charged, so
  //     the invocation digest a grant is pinned to covers exactly what ships.
  const projection = projectInvocationContext({ capability, subject, nowMs: args.nowMs });
  const context = projection.items;
  const contextSummary: InvocationContextSummary = {
    categories: projectedCategories(projection),
    item_count: projection.items.length,
  };

  // 3) Silent. A SAFE floor runs with no grant at all (§8: SAFE is silent if
  //    the params clear egress) and the envelope carries no provenance. A
  //    MODERATE/HIGH decision is silent only through a standing approval, which
  //    is CHARGED here; a constraint refusal cards instead of failing.
  let authorization: Parameters<typeof buildPluginEnvelope>[0]['authorization'];
  let cardReasons: string[] = [];
  if (decision.mode === 'silent' && intent.riskLevel === 'SAFE') {
    authorization = undefined;
  } else if (decision.mode === 'silent') {
    const charged = grants?.authorizeAndConsume({
      installId: install.installId,
      capability: capability.id,
      approvedScopeHash,
      executionId,
      ...(args.resource !== undefined ? { resource: args.resource } : {}),
      ...(args.value !== undefined ? { value: args.value } : {}),
      params: args.params,
      context,
      nowSec,
    }) ?? { allowed: false as const, reason: 'no_grant' as GrantDenialReason };
    if (charged.allowed) {
      authorization = {
        kind: 'grant',
        grantId: charged.grantId,
        invocationDigest: invocationDigest({
          ...(args.resource !== undefined ? { resource: args.resource } : {}),
          ...(args.value !== undefined ? { value: args.value } : {}),
          params: args.params,
          context,
        }),
        ...(args.resource !== undefined ? { resource: args.resource } : {}),
        ...(args.value !== undefined ? { value: args.value } : {}),
      };
    } else {
      authorization = { kind: 'card' };
      cardReasons = [`standing approval refused this invocation: ${charged.reason}`];
    }
  } else {
    // `decideDispatch` already folds the egress reasons into its reason.
    authorization = { kind: 'card' };
    cardReasons = [decision.reason];
  }

  // 4) The pinned envelope — validates params against the consented schema and
  //    bounds params/context; a violation is a typed refusal, never a throw.
  let envelope;
  try {
    envelope = buildPluginEnvelope({
      install,
      capabilityId: capability.id,
      params: args.params,
      context,
      executionId,
      idempotencyKey,
      authorization,
    });
  } catch (err) {
    // The use was reserved for an execution that will never exist.
    if (authorization?.kind === 'grant') grants?.releaseUse(authorization.grantId ?? '', executionId);
    return { ok: false, code: 'params_invalid', message: err instanceof Error ? err.message : String(err) };
  }

  const card = authorization?.kind === 'card';
  const ttl = args.ttlSeconds ?? (card ? DEFAULT_CARD_TTL_SECONDS : DEFAULT_SILENT_TTL_SECONDS);
  // The card facts are Core's own (§15.5): the decided risk and why. They ride
  // the task's `policy` field, and the description names the capability by
  // its ID — never by the plugin's display names, which are the plugin's words
  // and must not read as Dina's chrome on the owner's card.
  const cardsEveryInvocation =
    capability.privacy_class === 'sensitive' ||
    capability.privacy_class === 'regulated' ||
    touchesSensitivePersona;
  const cardPolicy: InvocationCardPolicy | null = card
    ? {
        type: PLUGIN_INVOCATION_CARD_POLICY,
        risk_level: intent.riskLevel,
        reasons: cardReasons,
        grant_can_silence: !cardsEveryInvocation,
        context: contextSummary,
      }
    : null;
  let task: WorkflowTask;
  try {
    task = deps.workflow.create({
      id: executionId,
      kind: 'delegation',
      description: `plugin invocation ${capability.id}`,
      payload: JSON.stringify(envelope),
      ...(cardPolicy !== null ? { policy: JSON.stringify(cardPolicy) } : {}),
      expiresAtSec: nowSec + ttl,
      ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
      origin: args.origin ?? 'api',
      idempotencyKey,
      // The owner's decision is the only thing between a carded envelope and
      // the lane: `pending_approval` is unclaimable until `approve` moves it.
      initialState: card ? WorkflowTaskState.PendingApproval : WorkflowTaskState.Queued,
      requestedRunner: pluginLane(install.installId),
    });
  } catch (err) {
    const releaseReservedUse = (): void => {
      if (authorization?.kind === 'grant') grants?.releaseUse(authorization.grantId ?? '', executionId);
    };
    // Anything but a dedup conflict is a fault. If the row never landed, the
    // use reserved for it is given back first; a row that did land (the
    // failure came after the insert) keeps its use.
    if (!(err instanceof Error && err.name === 'WorkflowConflictError')) {
      if (deps.workflow.store().getById(executionId) === null) releaseReservedUse();
      throw err;
    }
    // The same logical ask is already live (a re-delivered khata document, a
    // double tap): answer with THAT task and give back the use we reserved
    // for an execution that will never exist.
    releaseReservedUse();
    const existing = deps.workflow.store().getActiveByIdempotencyKey(idempotencyKey);
    if (existing === null) throw err;
    const existingExecution = parsePluginEnvelope(existing.payload)?.execution_id ?? existing.id;
    if (existing.status === WorkflowTaskState.PendingApproval) {
      return {
        ok: true,
        mode: 'approval_required',
        taskId: existing.id,
        executionId: existingExecution,
        // The LIVE task's projection, not the one just computed: the envelope
        // waiting for the owner is the one that will ship, and a fact stated
        // between the two asks must not make the answer describe a payload
        // nobody is being asked to approve.
        card: {
          riskLevel: intent.riskLevel,
          reasons: cardReasons,
          paramsText: egress.cardParamsText,
          context: readInvocationCardPolicy(existing)?.context ?? contextSummary,
        },
        deduplicated: true,
      };
    }
    return { ok: true, mode: 'dispatched', taskId: existing.id, executionId: existingExecution, deduplicated: true };
  }

  auditProjection(install, capability.id, executionId, projection);

  if (card) {
    return {
      ok: true,
      mode: 'approval_required',
      taskId: task.id,
      executionId,
      card: { riskLevel: intent.riskLevel, reasons: cardReasons, paramsText: egress.cardParamsText, context: contextSummary },
    };
  }
  return {
    ok: true,
    mode: 'dispatched',
    taskId: task.id,
    executionId,
    ...(authorization?.kind === 'grant' && authorization.grantId !== undefined
      ? { grantId: authorization.grantId }
      : {}),
  };
}

/**
 * Which rings the capability's DECLARED persona scope reaches (§11 point 1).
 *
 * A capability that names no personas reaches neither ring: it is asking for
 * data that belongs to no persona (the Tier-0 identity store), and the
 * categories on its consent card are what bound that. A persona this node
 * does not recognise counts as LOCKED — the strictest reading of a name we
 * cannot resolve, and the same direction the projector takes.
 */
function declaredPersonaRing(capability: PluginCapabilityDecl): { sensitive: boolean; locked: boolean } {
  const declared = capability.data_scope?.personas;
  if (declared === undefined) return { sensitive: false, locked: false };
  let sensitive = false;
  let locked = false;
  for (const name of declared) {
    const state = getPersona(name);
    if (state === null || state.tier === 'locked') locked = true;
    else if (state.tier === 'sensitive') sensitive = true;
  }
  return { sensitive, locked };
}

/**
 * §11 point 4: "payload hash + categories go to the audit log (metadata only,
 * never content)". Counts, category names and a digest — enough for an owner
 * to see that a filing carried two business-registry facts and to prove which
 * projection it was, and not one character of the facts themselves.
 *
 * An audit write must never sink an invocation the owner already made, so a
 * fault here is swallowed exactly as the decision log's is.
 */
function auditProjection(
  install: PluginInstall,
  capabilityId: string,
  executionId: string,
  projection: ContextProjection,
): void {
  if (
    projection.items.length === 0 &&
    projection.excluded.length === 0 &&
    projection.unsourced.length === 0
  ) {
    return;
  }
  try {
    appendAudit(
      `plugin:${install.installId}`,
      'plugin_context_projected',
      capabilityId,
      JSON.stringify({
        execution_id: executionId,
        template_version: CONTEXT_TEMPLATE_VERSION,
        categories: projectedCategories(projection),
        item_count: projection.items.length,
        payload_hash: projectionDigest(projection),
        dropped_fields: projection.droppedFields,
        unsourced: projection.unsourced,
        // Why things were held back, as a tally by reason — the owner's view
        // of a capability asking for more than its consent covers.
        excluded: tallyExclusions(projection),
      }),
    );
  } catch {
    // Metadata that failed to land is not worth failing a staged task over.
  }
}

/** Exclusion reasons and how many items each held back. Never the items. */
function tallyExclusions(projection: ContextProjection): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const refusal of projection.excluded) {
    tally[refusal.reason] = (tally[refusal.reason] ?? 0) + 1;
  }
  return tally;
}

/**
 * §8 first-N, from the owner's own decision log: how many invocations of this
 * capability the owner has approved. The decision repository is the one place
 * both hosts record approvals, so the counter cannot drift from the cards.
 */
export function approvedInvocationCount(installId: string, capabilityId: string): number {
  const decisions = getPluginDecisionRepository();
  if (decisions === null) return 0;
  return decisions
    .listByInstall(installId, 500)
    .filter((d) => d.capability === capabilityId && d.decision === 'invocation_approved').length;
}

/** Is this task a plugin invocation the owner is deciding on? */
export function isPluginInvocationTask(task: Pick<WorkflowTask, 'payload'>): boolean {
  try {
    return (JSON.parse(task.payload) as { type?: unknown }).type === PLUGIN_INVOCATION_PAYLOAD_TYPE;
  } catch {
    return false;
  }
}

// ── The owner's decision on a carded invocation (§15.5) ─────────────────────

/**
 * What the owner may attach to an approval beyond "once" (§15.5): a window
 * grant of at most 24 hours, or a standing grant. A standing grant MUST be
 * bounded (an expiry or a meaningful constraint) for any custom capability or
 * HIGH class — `PluginGrantRepository.create` refuses an unbounded one, and
 * since every installable plugin id is custom today, that is every rail.
 */
export type ApprovalGrantRequest =
  | { type: 'window'; hours?: number }
  | { type: 'standing'; constraints?: PluginGrantConstraints; expires_in_hours?: number };

export const MAX_APPROVAL_WINDOW_HOURS = 24;

/** Parse the `plugin_grant` block of an approve body; a malformed one is a refusal, not a guess. */
export function parseApprovalGrantRequest(raw: unknown): ApprovalGrantRequest | null | 'invalid' {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') return 'invalid';
  const r = raw as { type?: unknown; hours?: unknown; constraints?: unknown; expires_in_hours?: unknown };
  if (r.type === 'window') {
    if (r.hours === undefined) return { type: 'window' };
    if (typeof r.hours !== 'number' || !Number.isFinite(r.hours) || r.hours <= 0 || r.hours > MAX_APPROVAL_WINDOW_HOURS) {
      return 'invalid';
    }
    return { type: 'window', hours: r.hours };
  }
  if (r.type === 'standing') {
    const constraints = r.constraints === undefined ? null : parseConstraints(r.constraints);
    if (r.constraints !== undefined && constraints === null) return 'invalid';
    if (
      r.expires_in_hours !== undefined &&
      (typeof r.expires_in_hours !== 'number' || !Number.isFinite(r.expires_in_hours) || r.expires_in_hours <= 0)
    ) {
      return 'invalid';
    }
    return {
      type: 'standing',
      ...(constraints !== null ? { constraints } : {}),
      ...(typeof r.expires_in_hours === 'number' ? { expires_in_hours: r.expires_in_hours } : {}),
    };
  }
  return 'invalid';
}

/** The envelope's identity fields, or null when the task is not a plugin invocation. */
export function invocationIdentity(
  task: Pick<WorkflowTask, 'payload'>,
): { installId: string; capabilityId: string; approvedScopeHash: string; actionClass: string } | null {
  const envelope = parsePluginEnvelope(task.payload);
  if (envelope === null) return null;
  return {
    installId: envelope.install_id,
    capabilityId: envelope.capability_id,
    approvedScopeHash: envelope.approved_scope_hash,
    actionClass: envelope.action_class,
  };
}

/**
 * Create the grant an approval asked for. Called BEFORE the approve CAS so a
 * failed transition can revoke it (the agent-grant precedent); a create that
 * the repository refuses (unbounded standing on HIGH) throws and nothing is
 * approved.
 */
export function createApprovalGrant(
  identity: NonNullable<ReturnType<typeof invocationIdentity>>,
  request: ApprovalGrantRequest,
  nowMs: number,
): string {
  const grants = getPluginGrantRepository();
  if (grants === null) throw new Error('plugin grant repository unavailable');
  const nowSec = Math.floor(nowMs / 1000);
  const base = {
    installId: identity.installId,
    capability: identity.capabilityId,
    approvedScopeHash: identity.approvedScopeHash,
  };
  if (request.type === 'window') {
    const hours = request.hours ?? MAX_APPROVAL_WINDOW_HOURS;
    return grants.create(
      { ...base, grantType: 'window', expiresAt: nowSec + Math.round(hours * 3600) },
      identity.actionClass,
      nowMs,
    );
  }
  return grants.create(
    {
      ...base,
      grantType: 'standing',
      ...(request.constraints !== undefined ? { constraints: request.constraints } : {}),
      ...(request.expires_in_hours !== undefined
        ? { expiresAt: nowSec + Math.round(request.expires_in_hours * 3600) }
        : {}),
    },
    identity.actionClass,
    nowMs,
  );
}

/** The decision log takes short, single-line, non-PII policy tags. */
const MAX_DECISION_REASON = 200;

/**
 * Land the owner's decision in the decision log (the §8 first-N counter reads
 * it). The reason is bounded to one clean line — the log's contract — and an
 * audit write that fails must never fail a transition that already committed.
 */
export function recordInvocationDecision(
  identity: NonNullable<ReturnType<typeof invocationIdentity>>,
  decision: 'invocation_approved' | 'invocation_denied' | 'grant_created',
  reason: string,
  nowMs: number,
): void {
  const oneLine = reason.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  recordDecisionSafe({
    installId: identity.installId,
    capability: identity.capabilityId,
    decision,
    reason: oneLine.length > MAX_DECISION_REASON ? `${oneLine.slice(0, MAX_DECISION_REASON - 1)}…` : oneLine,
    nowSec: Math.floor(nowMs / 1000),
  });
}
