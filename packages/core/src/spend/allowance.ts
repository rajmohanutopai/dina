/**
 * Agent spend allowance (REAL_LIFE_FIXES_2 §15; owner decision 2026-10-09).
 *
 * The owner pre-approves a budget for one agent ("let my shopping agent
 * spend up to ₹5,000 this month on household items"). Dina still never
 * holds or moves money: an auto-approval only answers the agent's question,
 * and the agent pays at the merchant in its own session (Cart Handover).
 *
 * - Only the owner sets one, from their own turn, on a Core-minted,
 *   presence-gated card. Agents and Brain cannot create, raise or approve one.
 * - The agent declares the amount, merchant and category: its claim, shown
 *   as such. Each request carries a key; the same key and payload return the
 *   recorded decision, a changed payload is a conflict, so a retry never
 *   counts twice.
 * - A purchase is auto-approved only when a live allowance covers it in full
 *   (currency, per-item cap, category, what is left this period). Anything
 *   else goes to the owner's card as before. `payment` and `transfer_money`
 *   are never covered.
 * - Periods are calendar weeks or months in the allowance's own pinned zone.
 * - Revoking the allowance, or the agent's device, ends it. Failed purchases
 *   stay counted: the agent's report of failure is a claim Dina cannot check.
 *
 * State lives in Core's key-value store; every check-and-record runs under
 * one lock, so concurrent requests cannot both pass the last of a budget.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { drawsOnlyFrom, verifySpanProof, type SpanProof } from '../a2a/span_proof';
import { appendAudit } from '../audit/service';
import { formatMoney } from '../commerce/money_display';
import { listActiveDevices, onAgentDeviceRevoked } from '../devices/registry';
import { kvGet, kvList, kvSet } from '../kv/store';
import { getOwnerTimeZone } from '../settings/owner_settings';
import { WorkflowTaskKind, WorkflowTaskState, type WorkflowTask } from '../workflow/domain';
import { getWorkflowService } from '../workflow/service';

export const OWNER_SPEND_ALLOWANCE_TYPE = 'owner_spend_allowance';

const NS_ALLOW = 'spend_allowances';
const NS_USE = 'spend_uses';
const MAX_MINOR = 1_000_000_000_000; // safe, far above any household budget
const MAX_DAYS = 366;

export interface SpendAllowance {
  id: string;
  state: 'proposed' | 'active' | 'revoked' | 'declined';
  agentDid: string;
  agentName: string;
  currency: string;
  amountMinor: number;
  period: 'week' | 'month';
  timezone: string;
  category: string;
  perItemCapMinor?: number;
  expiresAt: number;
  createdAt: number;
  revokedAt?: number;
}

/**
 * One record per (agent, request key): the agent's purchase and what came
 * of it. A purchase sent for review keeps its card id; the owner's approval
 * of that card turns the same record into 'approved' and counts it once.
 */
interface SpendUse {
  allowanceId: string;
  agentDid: string;
  requestKey: string;
  digest: string;
  decision: 'auto' | 'review' | 'approved';
  /** What counts against the allowance (0 while under review). */
  amountMinor: number;
  /** What the agent declared. */
  amountDeclared?: number;
  currency?: string;
  merchant: string;
  category?: string;
  periodKey: string;
  proposalId: string;
  at: number;
}

/** Minor units shown in the currency's own decimals (JPY none, KWD three). */
function money(currency: string, minor: number): string {
  return formatMoney({ currency, minor_units: String(minor) } as Parameters<typeof formatMoney>[0]);
}

// One lock for every check-and-record (and revocation).
let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

export function isValidMinor(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= MAX_MINOR;
}

function isCurrency(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Z]{3}$/.test(v);
}

async function loadAllowance(id: string): Promise<SpendAllowance | null> {
  const raw = await kvGet(id, NS_ALLOW);
  return raw === null ? null : (JSON.parse(raw) as SpendAllowance);
}

async function saveAllowance(a: SpendAllowance): Promise<void> {
  await kvSet(a.id, JSON.stringify(a), NS_ALLOW);
}

export async function listAllowances(): Promise<SpendAllowance[]> {
  const out: SpendAllowance[] = [];
  for (const e of await kvList(NS_ALLOW)) {
    const a = await loadAllowance(e.key.replace(`${NS_ALLOW}:`, ''));
    if (a !== null) out.push(a);
  }
  return out;
}

async function listUses(): Promise<SpendUse[]> {
  const out: SpendUse[] = [];
  for (const e of await kvList(NS_USE)) out.push(JSON.parse(e.value) as SpendUse);
  return out;
}

/** The calendar week or month containing `at`, in `zone`: e.g. "2026-W41", "2026-10". */
export function periodKey(at: number, period: 'week' | 'month', zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(at))
    .reduce<Record<string, string>>((m, p) => ((m[p.type] = p.value), m), {});
  const y = Number(parts.year);
  const mo = Number(parts.month);
  const d = Number(parts.day);
  if (period === 'month') return `${y}-${String(mo).padStart(2, '0')}`;
  // ISO week of the local calendar date.
  const date = new Date(Date.UTC(y, mo - 1, d));
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Words people put around an agent's name: "my agent shopper", "the shopping bot". */
const NAME_FILLER = new Set(['my', 'the', 'a', 'an', 'agent', 'agents']);

/**
 * The paired agents a spoken name refers to: the device name contains the
 * whole name, or else every non-filler word of it. More than one match is
 * left to the caller to refuse as ambiguous.
 */
function matchAgents(name: string): ReturnType<typeof listActiveDevices> {
  const agents = listActiveDevices().filter((d) => d.role === 'agent');
  const whole = agents.filter((d) => name !== '' && d.deviceName.toLowerCase().includes(name));
  if (whole.length > 0) return whole;
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '' && !NAME_FILLER.has(w));
  if (parts.length === 0) return [];
  return agents.filter((d) => parts.every((w) => d.deviceName.toLowerCase().includes(w)));
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
}

/** The declared category matches the owner's words: one shared word, case-folded. */
function categoryMatches(allowance: string, declared: string): boolean {
  const a = words(allowance);
  for (const w of words(declared)) if (a.has(w) || a.has(w.replace(/s$/, '')) || a.has(`${w}s`)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Owner sets one
// ---------------------------------------------------------------------------

export type AllowanceProposeOutcome =
  | { status: 'confirm_pending'; task_id: string; summary: string }
  | { status: 'refused'; reason: string };

export async function proposeAllowance(input: {
  proof: SpanProof;
  agent: string;
  amountMinor: number;
  currency: string;
  period: string;
  category: string;
  perItemCapMinor?: number;
  until?: string;
  now?: number;
}): Promise<AllowanceProposeOutcome> {
  const now = input.now ?? Date.now();
  const checked = verifySpanProof(input.proof, 'spend_allowance', now);
  if (!checked.ok) return { status: 'refused', reason: `owner turn not proven (${checked.reason})` };
  if (!isValidMinor(input.amountMinor)) return { status: 'refused', reason: 'the amount must be a positive whole number of the smallest unit' };
  if (input.perItemCapMinor !== undefined && !isValidMinor(input.perItemCapMinor)) return { status: 'refused', reason: 'the per-item cap is not valid' };
  if (!isCurrency(input.currency)) return { status: 'refused', reason: 'the currency must be a three-letter code' };
  if (input.period !== 'week' && input.period !== 'month') return { status: 'refused', reason: 'the period is a week or a month' };
  const category = input.category.trim();
  if (category === '' || !drawsOnlyFrom(category, checked.turnText)) return { status: 'refused', reason: "the category must be the owner's own words" };
  const name = input.agent.trim().toLowerCase();
  const agents = matchAgents(name);
  if (name === '' || agents.length !== 1) {
    return { status: 'refused', reason: agents.length > 1 ? `more than one agent matches "${input.agent}"` : `no paired agent is called "${input.agent}"` };
  }
  const expiresAt = input.until !== undefined ? Date.parse(input.until) : now + 90 * 86_400_000;
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt - now > MAX_DAYS * 86_400_000) {
    return { status: 'refused', reason: 'an allowance ends within a year' };
  }
  const service = getWorkflowService();
  if (service === null) return { status: 'refused', reason: 'approvals are not available' };
  const agent = agents[0]!;
  const id = `allow-${bytesToHex(randomBytes(8))}`;
  const allowance: SpendAllowance = {
    id,
    state: 'proposed',
    agentDid: agent.did,
    agentName: agent.deviceName,
    currency: input.currency,
    amountMinor: input.amountMinor,
    period: input.period,
    timezone: (await getOwnerTimeZone()).timezone,
    category,
    ...(input.perItemCapMinor !== undefined ? { perItemCapMinor: input.perItemCapMinor } : {}),
    expiresAt,
    createdAt: now,
  };
  await saveAllowance(allowance);
  const summary = `Let ${agent.deviceName} buy ${category} up to ${money(allowance.currency, allowance.amountMinor)} a ${allowance.period}${allowance.perItemCapMinor !== undefined ? `, at most ${money(allowance.currency, allowance.perItemCapMinor)} each` : ''}, until ${new Date(expiresAt).toUTCString().slice(0, 16)}. Dina never pays: the agent pays at the shop. Anything else still comes to you.`;
  service.create({
    id,
    kind: WorkflowTaskKind.Approval,
    description: summary,
    payload: JSON.stringify({ type: OWNER_SPEND_ALLOWANCE_TYPE, allowance_id: id }),
    expiresAtSec: Math.floor(now / 1000) + 24 * 3600,
    origin: 'system',
    initialState: WorkflowTaskState.PendingApproval,
  });
  return { status: 'confirm_pending', task_id: id, summary };
}

export function isSpendAllowanceApproval(task: WorkflowTask | null): boolean {
  if (task === null) return false;
  try {
    return (JSON.parse(task.payload) as { type?: unknown }).type === OWNER_SPEND_ALLOWANCE_TYPE;
  } catch {
    return false;
  }
}

function allowanceIdOf(task: WorkflowTask): string {
  try {
    return String((JSON.parse(task.payload) as { allowance_id?: unknown }).allowance_id ?? '');
  } catch {
    return '';
  }
}

export async function activateAllowance(task: WorkflowTask): Promise<boolean> {
  return locked(async () => {
    const a = await loadAllowance(allowanceIdOf(task));
    if (a === null || a.state !== 'proposed') return false;
    a.state = 'active';
    await saveAllowance(a);
    appendAudit('owner', 'spend_allowance_active', a.id, `agent=${a.agentDid} period=${a.period}`);
    return true;
  });
}

export async function declineAllowance(task: WorkflowTask): Promise<void> {
  await locked(async () => {
    const a = await loadAllowance(allowanceIdOf(task));
    if (a !== null && a.state === 'proposed') await saveAllowance({ ...a, state: 'declined' });
  });
}

/** Stop an allowance; final for every later request once it returns. */
export async function revokeAllowance(id: string, now: number = Date.now()): Promise<boolean> {
  return locked(async () => {
    const a = await loadAllowance(id);
    if (a === null || a.state === 'revoked' || a.state === 'declined') return false;
    await saveAllowance({ ...a, state: 'revoked', revokedAt: now });
    appendAudit('owner', 'spend_allowance_revoked', id, '');
    return true;
  });
}

async function revokeAllForAgent(agentDid: string): Promise<void> {
  for (const a of await listAllowances()) if (a.agentDid === agentDid && a.state !== 'revoked') await revokeAllowance(a.id);
}

// Revoking an agent's device ends its allowances; re-pairing does not restore them.
onAgentDeviceRevoked((did) => {
  void revokeAllForAgent(did);
});

// ---------------------------------------------------------------------------
// The agent's purchase
// ---------------------------------------------------------------------------

export type SpendDecision =
  | { kind: 'auto'; proposalId: string; allowanceId: string }
  /** `fresh`: a new card is needed; otherwise the retry reuses `proposalId`. */
  | { kind: 'review'; proposalId: string; fresh: boolean }
  | { kind: 'invalid'; error: string }
  | { kind: 'conflict' };

export interface SpendClaim {
  agentDid: string;
  amount: unknown;
  merchant: unknown;
  category: unknown;
  requestKey: unknown;
}

/** Decide one declared purchase; records exactly one use per request key. */
export async function evaluateSpend(claim: SpendClaim, now: number = Date.now()): Promise<SpendDecision> {
  const amount = claim.amount as { value_minor?: unknown; currency?: unknown } | null | undefined;
  if (amount === null || typeof amount !== 'object') return { kind: 'invalid', error: 'amount must be { value_minor, currency }' };
  if (!isValidMinor(amount.value_minor)) return { kind: 'invalid', error: 'amount.value_minor must be a positive whole number' };
  if (!isCurrency(amount.currency)) return { kind: 'invalid', error: 'amount.currency must be a three-letter code' };
  if (typeof claim.requestKey !== 'string' || claim.requestKey.trim() === '' || claim.requestKey.length > 128) {
    return { kind: 'invalid', error: 'request_key is required with an amount' };
  }
  const merchant = typeof claim.merchant === 'string' ? claim.merchant.trim().slice(0, 200) : '';
  const category = typeof claim.category === 'string' ? claim.category.trim().slice(0, 200) : '';
  const value = amount.value_minor;
  const currency = amount.currency;
  const requestKey = claim.requestKey.trim();
  const digest = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([value, currency, merchant, category]))));
  const useKey = `${claim.agentDid}|${requestKey}`;
  return locked(async () => {
    const prior = await kvGet(useKey, NS_USE);
    if (prior !== null) {
      const use = JSON.parse(prior) as SpendUse;
      if (use.digest !== digest) return { kind: 'conflict' as const };
      return use.decision === 'auto'
        ? { kind: 'auto' as const, proposalId: use.proposalId, allowanceId: use.allowanceId }
        : { kind: 'review' as const, proposalId: use.proposalId, fresh: false };
    }
    const uses = await listUses();
    let chosen: SpendAllowance | null = null;
    for (const a of await listAllowances()) {
      if (a.state !== 'active' || a.agentDid !== claim.agentDid || now >= a.expiresAt) continue;
      if (a.currency !== currency) continue;
      if (a.perItemCapMinor !== undefined && value > a.perItemCapMinor) continue;
      if (!categoryMatches(a.category, category)) continue;
      const key = periodKey(now, a.period, a.timezone);
      const spent = uses
        .filter((u) => u.allowanceId === a.id && u.periodKey === key)
        .reduce((sum, u) => sum + u.amountMinor, 0);
      if (!Number.isSafeInteger(spent + value) || spent + value > a.amountMinor) continue;
      chosen = a;
      break;
    }
    // A review is a normal intent card; its id is recorded so a retry
    // returns the same card instead of raising another.
    const proposalId = chosen !== null ? `spend-${bytesToHex(randomBytes(8))}` : `prop-intent-${bytesToHex(randomBytes(8))}`;
    const use: SpendUse = {
      allowanceId: chosen?.id ?? '',
      agentDid: claim.agentDid,
      requestKey,
      digest,
      decision: chosen !== null ? 'auto' : 'review',
      amountMinor: chosen !== null ? value : 0,
      amountDeclared: value,
      currency,
      merchant,
      category,
      periodKey: chosen !== null ? periodKey(now, chosen.period, chosen.timezone) : '',
      proposalId,
      at: now,
    };
    await kvSet(useKey, JSON.stringify(use), NS_USE);
    if (chosen === null) return { kind: 'review' as const, proposalId, fresh: true };
    appendAudit(claim.agentDid, 'spend_auto_approved', chosen.id, `minor=${value} currency=${currency}`);
    return { kind: 'auto' as const, proposalId, allowanceId: chosen.id };
  });
}

/**
 * The owner approved a purchase card that carried an amount: the purchase's
 * own record (agent + request key, made when the card was raised) turns
 * 'approved' and counts against a live allowance for that agent, once.
 * Bound to the card the record names, so no other key can claim it.
 */
export async function recordApprovedSpend(input: { agentDid: string; requestKey: string; proposalId: string; now?: number }): Promise<void> {
  const now = input.now ?? Date.now();
  await locked(async () => {
    const key = `${input.agentDid}|${input.requestKey}`;
    const raw = await kvGet(key, NS_USE);
    if (raw === null) return;
    const use = JSON.parse(raw) as SpendUse;
    if (use.proposalId !== input.proposalId || use.decision !== 'review') return;
    const declared = use.amountDeclared ?? 0;
    const a = (await listAllowances()).find(
      (x) => x.state === 'active' && x.agentDid === input.agentDid && x.currency === use.currency && now < x.expiresAt,
    );
    const approved: SpendUse = {
      ...use,
      decision: 'approved',
      allowanceId: a?.id ?? '',
      amountMinor: a !== undefined ? declared : 0,
      periodKey: a !== undefined ? periodKey(now, a.period, a.timezone) : '',
      at: now,
    };
    await kvSet(key, JSON.stringify(approved), NS_USE);
  });
}

/**
 * Boot: an approval a crash cut short. A purchase card approved but not
 * counted is counted; an allowance card approved but not turned on is turned
 * on (and its card settled); one that expired or was declined is closed.
 */
export async function reconcileSpend(): Promise<void> {
  const service = getWorkflowService();
  if (service === null) return;
  for (const use of await listUses()) {
    if (use.decision !== 'review') continue;
    const task = service.store().getById(use.proposalId);
    if (task !== null && (task.status === WorkflowTaskState.Queued || task.status === WorkflowTaskState.Running || task.status === WorkflowTaskState.Completed)) {
      await recordApprovedSpend({ agentDid: use.agentDid, requestKey: use.requestKey, proposalId: use.proposalId });
    }
  }
  for (const a of await listAllowances()) {
    if (a.state !== 'proposed' && a.state !== 'active') continue;
    const task = service.store().getById(a.id);
    if (task !== null && (task.status === WorkflowTaskState.Queued || task.status === WorkflowTaskState.Running)) {
      // Approved: turn it on if a crash came first, and settle the card.
      await activateAllowance(task);
      try {
        service.store().claimApprovalForExecution(a.id, 60, Math.floor(Date.now() / 1000));
        service.complete(a.id, JSON.stringify({ active: true }), 'allowance on');
      } catch {
        /* already settled */
      }
    } else if (a.state === 'proposed' && (task === null || task.status !== WorkflowTaskState.PendingApproval)) {
      await declineAllowance({ payload: JSON.stringify({ allowance_id: a.id }) } as WorkflowTask);
    }
  }
}

/** This period's purchases under each allowance, one by one (owner view). */
export async function listSpendUses(now: number = Date.now()): Promise<
  { allowanceId: string; decision: SpendUse['decision']; amountMinor: number; currency: string; merchant: string; category: string; at: number; proposalId: string }[]
> {
  const allowances = new Map((await listAllowances()).map((a) => [a.id, a]));
  return (await listUses())
    .filter((u) => {
      const a = allowances.get(u.allowanceId);
      return a !== undefined && u.periodKey === periodKey(now, a.period, a.timezone);
    })
    .sort((x, y) => y.at - x.at)
    .map((u) => ({
      allowanceId: u.allowanceId,
      decision: u.decision,
      amountMinor: u.amountMinor,
      currency: u.currency ?? '',
      merchant: u.merchant,
      category: u.category ?? '',
      at: u.at,
      proposalId: u.proposalId,
    }));
}

/** What each allowance has used this period (owner view). */
export async function allowanceStatus(now: number = Date.now()): Promise<{ allowance: SpendAllowance; spentMinor: number; period: string }[]> {
  const uses = await listUses();
  return (await listAllowances()).map((a) => {
    const key = periodKey(now, a.period, a.timezone);
    return {
      allowance: a,
      period: key,
      spentMinor: uses.filter((u) => u.allowanceId === a.id && u.periodKey === key).reduce((s, u) => s + u.amountMinor, 0),
    };
  });
}
