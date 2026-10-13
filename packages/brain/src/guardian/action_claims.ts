/**
 * Say only what was done (REAL_LIFE_FIXES_2 §3).
 *
 * Every action tool leaves a receipt. A sentence in Dina's reply that claims
 * an action ("I've sent…", "I saved…", "I set a reminder…") is never judged
 * by its wording: matching words cannot tell "renew" from "cancel" when the
 * rest is the same. It is rewritten from the receipt it backs onto, in Core's
 * words, or replaced by "I haven't done that." when nothing backs it.
 *
 * Deterministic and Brain-side: it stops an honest model's slip, not a
 * compromised Brain (§0 rule 3). It runs in `report` mode (log only) until
 * the owner's guard-mode setting says `enforce`.
 */

import { splitSentences } from './guard_scan';

export type ReceiptAction = 'send' | 'save' | 'reminder' | 'forget' | 'stop';

export interface ActionReceipt {
  action: ReceiptAction;
  /** `done`: it happened. `waiting`: a card waits for the owner's OK. */
  status: 'done' | 'waiting';
  /** Who or where: the recipient, the vault, the reminder title. */
  targets: string[];
  /** What: the exact message text, the saved words, the reminder title. */
  object: string;
  /** For a reminder: when it fires (epoch ms). */
  dueAtMs?: number;
}

/** One tool call as the agentic loop logs it. */
interface LoggedCall {
  name: string;
  arguments: Record<string, unknown>;
  outcome: { success: boolean; result?: unknown };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The receipts a turn's tool calls left. Unknown tools leave none. */
export function receiptsFromToolCalls(calls: readonly LoggedCall[]): ActionReceipt[] {
  const out: ActionReceipt[] = [];
  for (const call of calls) {
    if (call.outcome.success !== true) continue;
    const r = (call.outcome.result ?? {}) as Record<string, unknown>;
    switch (call.name) {
      case 'send_message': {
        if (r.status === 'sent') {
          out.push({ action: 'send', status: 'done', targets: [str(r.recipient_name)].filter((t) => t !== ''), object: str(r.text) });
        } else if (r.status === 'confirm_pending') {
          out.push({ action: 'send', status: 'waiting', targets: [str(r.to)].filter((t) => t !== ''), object: str(r.text) });
        }
        break;
      }
      case 'remember': {
        const personas = Array.isArray(r.personas) ? r.personas.map(str).filter((p) => p !== '') : [];
        const words = str(call.arguments.words);
        if (r.status === 'stored' || r.status === 'duplicate') {
          out.push({ action: 'save', status: 'done', targets: personas, object: words });
        } else if (r.status === 'pending_approval' || r.status === 'pending_unlock' || r.status === 'parked') {
          out.push({ action: 'save', status: 'waiting', targets: personas, object: words });
        }
        break;
      }
      case 'schedule_reminder': {
        const list = Array.isArray(r.reminders) ? (r.reminders as Record<string, unknown>[]) : [r];
        for (const one of list) {
          if (one.status !== 'scheduled' && one.status !== 'duplicate') continue;
          out.push({
            action: 'reminder',
            status: 'done',
            targets: [],
            object: str(one.message),
            ...(typeof one.due_at_ms === 'number' ? { dueAtMs: one.due_at_ms } : {}),
          });
        }
        break;
      }
      case 'forget': {
        if (r.status === 'confirm_pending') {
          out.push({ action: 'forget', status: 'waiting', targets: [], object: str(r.summary) });
        }
        break;
      }
      // Stopping a standing reply or an agent's budget (§14, §15).
      case 'standing_reply':
      case 'spend_allowance': {
        if (call.arguments.action === 'cancel' && r.revoked === true) {
          // Targets are the words a claim uses for each, so two stops in
          // one turn are told apart ("stopped your away reply").
          out.push({
            action: 'stop',
            status: 'done',
            targets: call.name === 'standing_reply' ? ['reply'] : ['budget', 'allowance'],
            object: call.name === 'standing_reply' ? 'the automatic reply' : "the agent's spending budget",
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** First person, a completed action: "I've sent", "I have saved", "I already set". */
const SUBJECT = String.raw`\bI(?:'ve|’ve| have)?(?:\s+(?:just|already|now|also|then|gone ahead and|went ahead and|quickly))*\s+`;

const VERBS: readonly { action: ReceiptAction | 'never'; re: RegExp }[] = [
  { action: 'send', re: new RegExp(`${SUBJECT}(?:sent|messaged|texted|emailed|told|passed (?:it|this|that) on to)\\b`, 'i') },
  { action: 'save', re: new RegExp(`${SUBJECT}(?:saved|stored|noted down|remembered that|filed)\\b`, 'i') },
  { action: 'reminder', re: new RegExp(`${SUBJECT}(?:set|scheduled|added|created)\\s+(?:a|the|your|two|both)?\\s*reminders?\\b`, 'i') },
  { action: 'forget', re: new RegExp(`${SUBJECT}(?:deleted|erased|forgotten|forgot|archived|cleared out)\\b`, 'i') },
  // Dina can stop her own standing replies and agents' budgets: a stop receipt backs these.
  { action: 'stop', re: new RegExp(`${SUBJECT}(?:cancelled|canceled|stopped|turned off|revoked|ended)\\b`, 'i') },
  // No tool of Dina's can make these true (Cart Handover; bookings and subscriptions are the provider's).
  { action: 'never', re: new RegExp(`${SUBJECT}(?:paid|transferred|ordered|bought|purchased|unsubscribed|booked)\\b`, 'i') },
];

/** Not a claim about the world: the reply describing itself, a negation, a quote. */
function notAClaim(sentence: string): boolean {
  if (/\b(haven't|have not|didn't|did not|not yet|never|can't|cannot|couldn't|won't)\b/i.test(sentence)) return true;
  // "I've ordered the list by date", "I've removed the duplicates from this answer".
  if (/\b(ordered|sorted|grouped|arranged)\b[^.]*\bby\b/i.test(sentence)) return true;
  if (/\bfrom (this|the) (list|answer|reply|summary)\b/i.test(sentence)) return true;
  // Text inside quotes is the draft or someone else's words, not Dina's claim.
  const unquoted = sentence.replace(/["“][^"”]*["”]/g, '');
  return !VERBS.some((v) => v.re.test(unquoted));
}

const REFERS_BACK = /\b(already|earlier|before|yesterday|last time|previously|last week)\b/i;

export interface ClaimCheckResult {
  /** The reply with every claim rewritten from its receipt (enforce mode). */
  text: string;
  /** How many claim sentences were rewritten, and how many had no receipt. */
  rewritten: number;
  unbacked: number;
}

const quote = (s: string): string => `"${s.trim().replace(/\s+/g, ' ').slice(0, 300)}"`;
const title = (s: string): string => (s === '' ? s : s[0]!.toUpperCase() + s.slice(1));

function formatDue(ms: number, timeZone: string | undefined): string {
  try {
    return new Date(ms).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      ...(timeZone !== undefined ? { timeZone } : {}),
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

/** Core's own words for what a receipt records. */
export function receiptLine(r: ActionReceipt, earlier: boolean, timeZone?: string): string {
  const to = r.targets[0] ?? '';
  switch (r.action) {
    case 'send':
      if (r.status === 'waiting') return `Waiting for your OK: a message to ${to || 'your contact'}: ${quote(r.object)}`;
      return earlier ? `Already sent to ${to || 'them'} earlier: ${quote(r.object)}` : `Sent to ${to || 'them'}: ${quote(r.object)}`;
    case 'save':
      if (r.status === 'waiting') return `Waiting for your OK before saving: ${quote(r.object)}`;
      return earlier ? `Already saved earlier: ${quote(r.object)}` : `Saved to ${title(to) || 'your vault'}: ${quote(r.object)}`;
    case 'reminder':
      return `Reminder set: ${r.object}${r.dueAtMs !== undefined ? `, ${formatDue(r.dueAtMs, timeZone)}` : ''}`;
    case 'forget':
      return `Waiting for your OK on the card: forget ${r.object || 'the items it lists'}`;
    case 'stop':
      return earlier ? `Already stopped earlier: ${r.object}` : `Stopped: ${r.object}`;
  }
}

function pick(sentence: string, candidates: ActionReceipt[]): ActionReceipt | undefined {
  if (candidates.length === 0) return undefined;
  const named = candidates.filter((r) => r.targets.some((t) => t !== '' && new RegExp(`\\b${escapeRe(t)}\\b`, 'i').test(sentence)));
  if (named.length > 0) return named[named.length - 1];
  // A claim that names a recipient no receipt has is unbacked ("sent Omar"
  // when only Priya got a message); with no name, a single receipt fits.
  if (/\bto\s+[A-Z][a-z]+/.test(sentence) || candidates.length > 1) return undefined;
  return candidates[0];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite every action claim in `reply` from the receipts: this turn's back
 * any claim; earlier turns' back only a claim that refers back to them.
 */
export function checkActionClaims(
  reply: string,
  receipts: { thisTurn: readonly ActionReceipt[]; earlier: readonly ActionReceipt[] },
  timeZone?: string,
): ClaimCheckResult {
  let text = reply;
  let rewritten = 0;
  let unbacked = 0;
  for (const sentence of splitSentences(reply)) {
    if (notAClaim(sentence)) continue;
    const unquoted = sentence.replace(/["“][^"”]*["”]/g, '');
    const verb = VERBS.find((v) => v.re.test(unquoted));
    if (verb === undefined) continue;
    let line = "I haven't done that.";
    if (verb.action !== 'never') {
      const earlier = REFERS_BACK.test(sentence);
      const pool = (earlier ? [...receipts.earlier, ...receipts.thisTurn] : receipts.thisTurn).filter((r) => r.action === verb.action);
      const backing = pick(sentence, pool);
      if (backing !== undefined) line = receiptLine(backing, earlier && !receipts.thisTurn.includes(backing), timeZone);
    }
    if (line === "I haven't done that.") unbacked++;
    rewritten++;
    const at = text.indexOf(sentence);
    if (at >= 0) text = text.slice(0, at) + line + text.slice(at + sentence.length);
  }
  return { text, rewritten, unbacked };
}
