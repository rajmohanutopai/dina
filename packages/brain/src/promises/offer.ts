/**
 * Offer to track a promise found in a Talk message (docs/PROMISES_AND_WAITS.md
 * §4): a `promise_offer` card in the owner's chat. Nothing is tracked here;
 * the owner's yes on the card does that.
 */

import {
  addMessage,
  findMessageBySource,
  getRecentMessages,
  type ChatMessage,
  type PromiseOfferLifecycle,
} from '../chat/thread';

import { findPromise, type FoundPromise } from './find_promise';

import type { PlannerAsk } from '../plan/day_planner';

export interface TalkPromiseInput {
  /** The Talk message's own id; one offer per message. */
  talkMessageId: string;
  contactDid: string;
  contactName: string;
  text: string;
  fromOwner: boolean;
  now: number;
}

export interface OfferDeps {
  ask: PlannerAsk | null;
  /** The owner's chat, where the card goes. */
  threadId: string;
}

const SOURCE_PREFIX = 'promise:';

export function promiseOfferSource(talkMessageId: string): string {
  return `${SOURCE_PREFIX}${talkMessageId}`;
}

function lowerFirst(s: string): string {
  return s.length > 0 ? s[0].toLowerCase() + s.slice(1) : s;
}

/** The card's sentence, also its plain-text fallback. */
export function promiseOfferText(name: string, found: FoundPromise): string {
  const who = name.trim() === '' ? 'Your contact' : name.trim();
  const what = lowerFirst(found.what.replace(/[.!]+$/, ''));
  return found.direction === 'owed_to_me'
    ? `${who} said they would ${what}. Track it?`
    : `You told ${who === 'Your contact' ? 'your contact' : who} you would ${what}. Track it?`;
}

/**
 * Ask the model about one Talk message and, when it holds a promise, post the
 * card. Returns the card, or null when there was nothing to offer or it was
 * offered already.
 */
export async function offerTalkPromise(
  input: TalkPromiseInput,
  deps: OfferDeps,
): Promise<ChatMessage | null> {
  if (input.talkMessageId === '' || input.contactDid === '') return null;
  const source = promiseOfferSource(input.talkMessageId);
  if (findMessageBySource(deps.threadId, source) !== null) return null;
  // The Talk thread is keyed by the contact's DID; its last few messages
  // before this one let the model read a short reply.
  const earlier = getRecentMessages(input.contactDid, 6)
    .filter((m) => m.id !== input.talkMessageId && (m.type === 'user' || m.type === 'dina'))
    .filter((m) => m.timestamp <= input.now)
    .slice(-4)
    .map((m) => ({ fromOwner: m.type === 'user', text: m.content }));
  const found = await findPromise(deps.ask, {
    text: input.text,
    fromOwner: input.fromOwner,
    contactName: input.contactName,
    now: input.now,
    earlier,
  });
  if (found === null) return null;
  // The model call took time: the same message may have been offered meanwhile.
  if (findMessageBySource(deps.threadId, source) !== null) return null;
  const lifecycle: PromiseOfferLifecycle = {
    kind: 'promise_offer',
    status: 'open',
    talkMessageId: input.talkMessageId,
    contactDid: input.contactDid,
    contactName: input.contactName,
    direction: found.direction,
    what: found.what,
    dueAt: found.dueAt,
  };
  return addMessage(deps.threadId, 'dina', promiseOfferText(input.contactName, found), {
    metadata: { lifecycle },
    sources: [source],
  });
}

type Runner = (input: TalkPromiseInput) => Promise<unknown>;

let runner: Runner | null = null;

/** Install how a Talk message is checked for a promise; null turns it off. */
export function setTalkPromiseRunner(fn: Runner | null): void {
  runner = fn;
}

/**
 * A Talk message was sent or received. Fire and forget: the check runs in the
 * background and never holds up or breaks the send or the receive.
 */
export function noteTalkMessage(input: TalkPromiseInput): void {
  const run = runner;
  if (run === null) return;
  void run(input).catch(() => undefined);
}
