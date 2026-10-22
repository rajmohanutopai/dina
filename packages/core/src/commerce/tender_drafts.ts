/**
 * Tender drafts from an outside agent (OPENAI_DOTS_INTEGRATION §6.3–§6.4).
 *
 * An agent the owner paired (an OpenAI dot through the Dina plugin, or any
 * `dina-agent`) may say WHAT the café needs: lines, a date. It never says who
 * is asked, never names a price, and never opens, counters, awards or sends.
 * Core fills the suppliers from the café's own trade history, so a bakery
 * named in text the agent read never reaches the owner's card; the owner adds
 * the target and the ceiling on a Core form that needs a person present, and
 * opens the tender.
 *
 * What the agent reads back is one draft's progress: ranks and supplier
 * names, the held order's state and the supplier's answer. Never a price, a
 * quote, or the owner's limits (TRADE_FIRST_STRATEGY §3.5, COMMITMENT_KERNEL §7).
 */

import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import { validateQuantity, type Quantity, type RegionRef } from '@dina/commerce-protocol';

import { appendAudit } from '../audit/service';
import { WorkflowTaskKind, WorkflowTaskState } from '../workflow/domain';
import { getWorkflowService } from '../workflow/service';

import { rankTender } from './buyer_negotiation';
import { getCommerceRuntime, type CommerceRuntime } from './runtime';
import { DEFAULT_TENDER_FANOUT } from './tender';


export const TENDER_DRAFT_TYPE = 'tender_draft';

/** How long a draft waits for the owner before it lapses. */
export const TENDER_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
/** Drafts one agent may have waiting at once. */
export const MAX_PENDING_DRAFTS_PER_AGENT = 5;
export const MAX_DRAFT_LINES = 20;
export const MAX_REQUIREMENT_TEXT = 200;

export type TenderDraftState = 'pending' | 'opened' | 'dismissed';

export interface TenderDraftLine {
  line_id: string;
  requirement: { text: string };
  quantity: Quantity;
}

export interface TenderDraftSupplier {
  supplier_did: string;
  service_rkey: string;
}

export interface TenderDraft {
  draftId: string;
  agentDid: string;
  lines: TenderDraftLine[];
  /** ISO date-time, or '' when the agent named none. */
  requiredBy: string;
  suppliers: TenderDraftSupplier[];
  /** The café's first delivery area from its buyer settings; null when none is set. */
  region: RegionRef | null;
  /** The buyer settings currency; '' when none is set. */
  currency: string;
  state: TenderDraftState;
  tenderId: string;
  createdAt: number;
  expiresAt: number;
}


/**
 * The café's suppliers: first the ones the owner listed (HOSTED_DINA §6), then
 * every supplier it has ordered from or asked in a tender, most recent first,
 * one listing each, never a blocked one. Core's own records only — nothing an
 * agent wrote.
 */
export function knownSuppliers(runtime: CommerceRuntime, limit: number): TenderDraftSupplier[] {
  const buyer = runtime.settings.readBuyer();
  const blocked = new Set(buyer.ok ? buyer.settings.blockedSuppliers : []);
  const seen = new Map<string, TenderDraftSupplier>();
  const add = (supplierDid: string, serviceRkey: string): void => {
    if (supplierDid === '' || serviceRkey === '' || blocked.has(supplierDid)) return;
    if (!seen.has(supplierDid)) {
      seen.set(supplierDid, { supplier_did: supplierDid, service_rkey: serviceRkey });
    }
  };
  for (const listed of runtime.ownerSuppliers.list()) {
    add(listed.supplierDid, listed.serviceRkey);
  }
  for (const { supplierDid, record } of runtime.buyerOrders.listRecent(100)) {
    add(supplierDid, record.serviceRkey);
  }
  const tenders = [...runtime.tenders.listTenders()].sort((a, b) => b.createdAt - a.createdAt);
  for (const tender of tenders) {
    for (const member of runtime.tenders.listMembers(tender.tenderId)) {
      add(member.supplierDid, member.serviceRkey);
    }
  }
  return [...seen.values()].slice(0, limit);
}

export type DraftLinesResult =
  | { ok: true; lines: TenderDraftLine[] }
  | { ok: false; detail: string };

/** The agent's lines: needs in words with a quantity, never a product or a price. */
export function parseDraftLines(value: unknown): DraftLinesResult {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, detail: 'lines must be a non-empty array' };
  }
  if (value.length > MAX_DRAFT_LINES) {
    return { ok: false, detail: `at most ${String(MAX_DRAFT_LINES)} lines` };
  }
  const lines: TenderDraftLine[] = [];
  for (const [index, entry] of value.entries()) {
    const line = (entry ?? {}) as Record<string, unknown>;
    const text = typeof line.text === 'string' ? line.text.trim() : '';
    if (text === '' || text.length > MAX_REQUIREMENT_TEXT) {
      return {
        ok: false,
        detail: `lines[${String(index)}].text must be 1 to ${String(MAX_REQUIREMENT_TEXT)} characters`,
      };
    }
    const quantityError = validateQuantity(line.quantity, { require_positive: true });
    if (quantityError !== null) {
      return { ok: false, detail: `lines[${String(index)}].${quantityError}` };
    }
    const quantity = line.quantity as Quantity;
    lines.push({
      line_id: `l${String(index + 1)}`,
      requirement: { text },
      quantity: { value: quantity.value, unit_code: quantity.unit_code },
    });
  }
  return { ok: true, lines };
}

export type CreateDraftOutcome =
  | { ok: true; draft: TenderDraft }
  | {
      ok: false;
      refusal: 'commerce_unavailable' | 'no_known_suppliers' | 'too_many_pending_drafts';
    };

/** Store the draft and raise the owner's card. */
export function createTenderDraft(args: {
  agentDid: string;
  lines: TenderDraftLine[];
  requiredBy: string;
  nowMs: number;
}): CreateDraftOutcome {
  const runtime = getCommerceRuntime();
  if (runtime === null) return { ok: false, refusal: 'commerce_unavailable' };
  if (
    runtime.tenderDrafts.countPending(args.agentDid, args.nowMs) >= MAX_PENDING_DRAFTS_PER_AGENT
  ) {
    return { ok: false, refusal: 'too_many_pending_drafts' };
  }
  const suppliers = knownSuppliers(runtime, DEFAULT_TENDER_FANOUT);
  if (suppliers.length === 0) return { ok: false, refusal: 'no_known_suppliers' };
  const buyer = runtime.settings.readBuyer();
  const draft: TenderDraft = {
    draftId: `tdr_${bytesToHex(randomBytes(12))}`,
    agentDid: args.agentDid,
    lines: args.lines,
    requiredBy: args.requiredBy,
    suppliers,
    region: buyer.ok ? (buyer.settings.locations[0] ?? null) : null,
    currency: buyer.ok ? buyer.settings.currency : '',
    state: 'pending',
    tenderId: '',
    createdAt: args.nowMs,
    expiresAt: args.nowMs + TENDER_DRAFT_TTL_MS,
  };
  runtime.tenderDrafts.put(draft);
  appendAudit('negotiation', 'tender_draft', draft.draftId, `lines=${String(draft.lines.length)}`);
  raiseDraftCard(draft);
  return { ok: true, draft };
}

export interface TenderDraftCardPayload {
  type: typeof TENDER_DRAFT_TYPE;
  draft_id: string;
  agent_did: string;
  lines: number;
  suppliers: number;
}

function draftSubject(draft: TenderDraft): string {
  const first = draft.lines[0]?.requirement.text ?? 'items';
  const shown = first.length > 60 ? `${first.slice(0, 57)}…` : first;
  const more = draft.lines.length > 1 ? ` and ${String(draft.lines.length - 1)} more` : '';
  return `“${shown}”${more}`;
}

function raiseDraftCard(draft: TenderDraft): void {
  const workflow = getWorkflowService();
  if (workflow === null) return;
  const payload: TenderDraftCardPayload = {
    type: TENDER_DRAFT_TYPE,
    draft_id: draft.draftId,
    agent_did: draft.agentDid,
    lines: draft.lines.length,
    suppliers: draft.suppliers.length,
  };
  try {
    workflow.create({
      id: `tender-draft-${draft.draftId}`,
      kind: WorkflowTaskKind.Approval,
      description: `An agent drafted a tender for ${draftSubject(draft)} to ${String(draft.suppliers.length)} of your suppliers. Add your target and ceiling to open it.`,
      payload: JSON.stringify(payload),
      idempotencyKey: `tender_draft:${draft.draftId}`,
      correlationId: draft.draftId,
      origin: 'agent',
      initialState: WorkflowTaskState.PendingApproval,
      expiresAtSec: Math.floor(draft.expiresAt / 1000),
    });
  } catch {
    /* already raised */
  }
}

/** The draft's card asks nothing once the owner opened or dismissed the draft. */
export function retireDraftCard(draftId: string, reason: 'draft_opened' | 'draft_dismissed'): void {
  const workflow = getWorkflowService();
  if (workflow === null) return;
  const id = `tender-draft-${draftId}`;
  const task = workflow.store().getById(id);
  if (task === null) return;
  try {
    if (task.status === WorkflowTaskState.PendingApproval) workflow.cancel(id, reason);
  } catch {
    /* the owner cleared it first */
  }
}

export type SupplierAnswer = 'none' | 'waiting' | 'accepted' | 'rejected' | 'countered' | 'unknown';

export interface AgentDraftStatus {
  draft_id: string;
  /** `lapsed`: still pending past its window. */
  draft_state: TenderDraftState | 'lapsed';
  suppliers: { name: string | null }[];
  tender?: {
    state: string;
    /** Best first; names only, never a price. */
    ranked: { rank: number; name: string | null }[];
    excluded: number;
    held_order?: 'held' | 'sent' | 'lapsed';
    supplier_answer: SupplierAnswer;
    awarded_to?: string | null;
  };
}

/**
 * What the agent may read about its own draft. Names come from the owner's
 * contacts; a supplier who is not a contact reads as null.
 */
export function agentDraftStatus(
  draft: TenderDraft,
  nowMs: number,
  nameFor: (did: string) => string | null,
): AgentDraftStatus {
  const runtime = getCommerceRuntime();
  const lapsed = draft.state === 'pending' && draft.expiresAt <= nowMs;
  const status: AgentDraftStatus = {
    draft_id: draft.draftId,
    draft_state: lapsed ? 'lapsed' : draft.state,
    suppliers: draft.suppliers.map((s) => ({ name: nameFor(s.supplier_did) })),
  };
  if (runtime === null || draft.state !== 'opened' || draft.tenderId === '') return status;
  const policy = runtime.buyerNegotiation.getTender(draft.tenderId);
  const ranking = rankTender({ tenderId: draft.tenderId, nowMs });
  const ranked = ranking.ok ? ranking.ranking.ranked : [];
  const bySupplier: string[] = [];
  for (const offer of ranked) {
    if (!bySupplier.includes(offer.supplier_did)) bySupplier.push(offer.supplier_did);
  }
  const tender: NonNullable<AgentDraftStatus['tender']> = {
    state: policy?.state ?? 'no_policy',
    ranked: bySupplier.map((did, index) => ({ rank: index + 1, name: nameFor(did) })),
    excluded: ranking.ok ? ranking.ranking.excluded.length : 0,
    supplier_answer: 'none',
  };
  if (policy !== null && policy.state === 'awarded' && policy.approvalId !== '') {
    tender.awarded_to = nameFor(policy.awardedSupplierDid);
    const approval = runtime.orderApprovals.get(policy.approvalId);
    if (approval === null) {
      tender.held_order = 'lapsed';
    } else if (approval.consumedAt !== null) {
      tender.held_order = 'sent';
      tender.supplier_answer = supplierAnswer(
        runtime,
        approval.order.supplier_did,
        approval.order.purchase_order_id,
      );
    } else {
      tender.held_order = approval.expiresAt <= nowMs ? 'lapsed' : 'held';
    }
  }
  status.tender = tender;
  return status;
}

function supplierAnswer(
  runtime: CommerceRuntime,
  supplierDid: string,
  purchaseOrderId: string,
): SupplierAnswer {
  const record = runtime.buyerOrders.get(supplierDid, purchaseOrderId);
  if (record === null) return 'waiting';
  switch (record.state) {
    case 'accepted':
      return 'accepted';
    case 'rejected':
      return 'rejected';
    case 'countered':
      return 'countered';
    case 'submitted_unconfirmed':
      return 'waiting';
    default:
      return 'unknown';
  }
}
