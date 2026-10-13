/**
 * Standing replies (REAL_LIFE_FIXES_2 §14): "I'm off next week; if Sancho's
 * Dina asks, say I'm back on Monday."
 *
 * Only the owner sets one, from their own turn, and Core always raises a
 * Core-minted card naming every recipient, the exact text and the expiry.
 * Nothing is active until the owner approves. When a named contact's Dina
 * sends a coordination request while a rule is live, Core answers with the
 * owner's own words, at most once per contact per rule per day. No model is
 * involved and nothing is read from the vault. A condition such as "if they
 * ask about work" cannot be judged without a model, so a rule answers any
 * request from the named people, and the card says so.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { drawsOnlyFrom, verifySpanProof, type SpanProof } from '../a2a/span_proof';
import { appendAudit } from '../audit/service';
import { kvGet, kvList, kvSet } from '../kv/store';
import { getD2DSender } from '../server/routes/d2d_msg';
import { resolveContactRef } from '../talk/owner_send';
import { WorkflowTaskKind, WorkflowTaskState, type WorkflowTask } from '../workflow/domain';
import { getWorkflowService } from '../workflow/service';

export const OWNER_STANDING_REPLY_TYPE = 'owner_standing_reply';

const NS = 'standing_replies';
const MAX_DAYS = 30;
const ONCE_PER_MS = 24 * 3600 * 1000;
const REPLY_FAMILY = 'coordination.response';

export interface StandingReply {
  id: string;
  state: 'proposed' | 'active' | 'revoked' | 'declined';
  replyText: string;
  contacts: { did: string; name: string }[];
  startsAt: number;
  expiresAt: number;
  createdAt: number;
  revokedAt?: number;
  /** contact DID → last time a reply went to them under this rule. */
  lastSent: Record<string, number>;
}

async function save(rule: StandingReply): Promise<void> {
  await kvSet(rule.id, JSON.stringify(rule), NS);
}

async function load(id: string): Promise<StandingReply | null> {
  const raw = await kvGet(id, NS);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as StandingReply;
  } catch {
    return null;
  }
}

export async function listStandingReplies(): Promise<StandingReply[]> {
  const out: StandingReply[] = [];
  for (const e of await kvList(NS)) {
    const rule = await load(e.key.replace(`${NS}:`, ''));
    if (rule !== null) out.push(rule);
  }
  return out;
}

export type StandingProposeOutcome =
  | { status: 'confirm_pending'; task_id: string; summary: string }
  | { status: 'ambiguous'; name: string; candidates: string[] }
  | { status: 'refused'; reason: string };

/** Brain proposes from the owner's turn; Core checks and always raises a card. */
export async function proposeStandingReply(input: {
  proof: SpanProof;
  contacts: string[];
  replyText: string;
  until: string;
  now?: number;
}): Promise<StandingProposeOutcome> {
  const now = input.now ?? Date.now();
  const checked = verifySpanProof(input.proof, 'standing_reply', now);
  if (!checked.ok) return { status: 'refused', reason: `owner turn not proven (${checked.reason})` };
  const text = input.replyText.trim();
  if (text === '' || text.length > 500) return { status: 'refused', reason: 'the reply text must be 1 to 500 characters' };
  // The reply is the owner's own words from this turn, never a model's.
  if (!drawsOnlyFrom(text, checked.turnText)) return { status: 'refused', reason: "the reply must be the owner's own words" };
  if (input.contacts.length === 0) return { status: 'refused', reason: 'name at least one contact; there is no "all contacts" rule' };
  const contacts: { did: string; name: string }[] = [];
  for (const name of input.contacts) {
    const r = resolveContactRef(name);
    if (r.kind === 'ambiguous') return { status: 'ambiguous', name, candidates: r.names };
    if (r.kind === 'none') return { status: 'refused', reason: `"${name}" is not one of your contacts` };
    if (!contacts.some((c) => c.did === r.contact.did)) contacts.push({ did: r.contact.did, name: r.contact.displayName });
  }
  const expiresAt = Date.parse(input.until);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { status: 'refused', reason: 'give a date in the future for when the reply ends' };
  if (expiresAt - now > MAX_DAYS * 86_400_000) return { status: 'refused', reason: `a standing reply lasts at most ${MAX_DAYS} days` };
  const service = getWorkflowService();
  if (service === null) return { status: 'refused', reason: 'approvals are not available' };
  const id = `standing-${bytesToHex(randomBytes(8))}`;
  const rule: StandingReply = { id, state: 'proposed', replyText: text, contacts, startsAt: now, expiresAt, createdAt: now, lastSent: {} };
  await save(rule);
  const until = new Date(expiresAt).toUTCString().slice(0, 16);
  const summary = `Reply automatically to ${contacts.map((c) => c.name).join(', ')} with: "${text}" — sent in reply to any request from ${contacts.length === 1 ? 'them' : 'these people'} until ${until}.`;
  service.create({
    id,
    kind: WorkflowTaskKind.Approval,
    description: summary,
    payload: JSON.stringify({ type: OWNER_STANDING_REPLY_TYPE, rule_id: id }),
    expiresAtSec: Math.floor(now / 1000) + 24 * 3600,
    origin: 'system',
    initialState: WorkflowTaskState.PendingApproval,
  });
  return { status: 'confirm_pending', task_id: id, summary };
}

export function isStandingReplyApproval(task: WorkflowTask | null): boolean {
  if (task === null) return false;
  try {
    return (JSON.parse(task.payload) as { type?: unknown }).type === OWNER_STANDING_REPLY_TYPE;
  } catch {
    return false;
  }
}

function ruleIdOf(task: WorkflowTask): string {
  try {
    return String((JSON.parse(task.payload) as { rule_id?: unknown }).rule_id ?? '');
  } catch {
    return '';
  }
}

/** The owner approved the card: the rule goes live. */
/**
 * Every change to a rule (activate, decline, revoke, a send's timestamp)
 * runs one at a time: each reads the latest rule and writes it back, so a
 * send can never undo a revoke and two arrivals cannot both send.
 */
let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.catch(() => undefined).then(fn);
  chain = next;
  return next;
}

export async function activateStandingReply(task: WorkflowTask): Promise<boolean> {
  return locked(() => activateLocked(task));
}

async function activateLocked(task: WorkflowTask): Promise<boolean> {
  const rule = await load(ruleIdOf(task));
  if (rule === null || rule.state !== 'proposed') return false;
  rule.state = 'active';
  await save(rule);
  appendAudit('owner', 'standing_reply_active', rule.id, `contacts=${rule.contacts.length} expires=${rule.expiresAt}`);
  return true;
}

export async function declineStandingReply(task: WorkflowTask): Promise<void> {
  await locked(async () => {
    const rule = await load(ruleIdOf(task));
    if (rule !== null && rule.state === 'proposed') await save({ ...rule, state: 'declined' });
  });
}

/** Cancel a rule; effective before the next inbound message is handled. */
export async function revokeStandingReply(id: string, now: number = Date.now()): Promise<boolean> {
  return locked(async () => {
    const rule = await load(id);
    if (rule === null || rule.state === 'revoked' || rule.state === 'declined') return false;
    await save({ ...rule, state: 'revoked', revokedAt: now });
    appendAudit('owner', 'standing_reply_revoked', id, '');
    return true;
  });
}

/**
 * A contact's coordination request arrived (after the ingress gates; the
 * message is staged as usual). Answer with a live rule's text, once per
 * contact per rule per day. Returns whether a reply was sent.
 */
export async function answerWithStandingReply(senderDid: string, now: number = Date.now()): Promise<boolean> {
  const sender = getD2DSender();
  if (sender === null) return false;
  // Reserve under the lock: read the latest rule, check it is still live
  // and not answered today, record the send time. The send itself runs
  // after the lock, so a slow network never holds up a revoke.
  const reserved = await locked(async () => {
    for (const rule of await listStandingReplies()) {
      if (rule.state !== 'active' || now < rule.startsAt || now >= rule.expiresAt) continue;
      if (!rule.contacts.some((c) => c.did === senderDid)) continue;
      const last = rule.lastSent[senderDid] ?? 0;
      if (now - last < ONCE_PER_MS) continue;
      // Record before sending: a failed send is not retried within the day.
      rule.lastSent[senderDid] = now;
      await save(rule);
      return { id: rule.id, text: rule.replyText };
    }
    return null;
  });
  if (reserved === null) return false;
  try {
    await sender(senderDid, REPLY_FAMILY, { text: reserved.text, auto: true });
    appendAudit('owner', 'standing_reply_sent', reserved.id, `to=${senderDid}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Boot: a rule whose card was approved but a crash came before it went live
 * is turned on (and its card settled); one whose card expired or was
 * declined without reaching declineStandingReply is closed.
 */
export async function reconcileStandingReplies(): Promise<void> {
  const service = getWorkflowService();
  if (service === null) return;
  for (const rule of await listStandingReplies()) {
    if (rule.state !== 'proposed' && rule.state !== 'active') continue;
    const task = service.store().getById(rule.id);
    if (task !== null && (task.status === WorkflowTaskState.Queued || task.status === WorkflowTaskState.Running)) {
      // Approved: turn it on if a crash came first, and settle the card
      // either way (it may have gone live before the card was settled).
      await activateStandingReply(task);
      try {
        service.store().claimApprovalForExecution(rule.id, 60, Math.floor(Date.now() / 1000));
        service.complete(rule.id, JSON.stringify({ active: true }), 'standing reply on');
      } catch {
        /* already settled */
      }
    } else if (rule.state === 'proposed' && (task === null || task.status !== WorkflowTaskState.PendingApproval)) {
      await declineStandingReply({ payload: JSON.stringify({ rule_id: rule.id }) } as WorkflowTask);
    }
  }
}

