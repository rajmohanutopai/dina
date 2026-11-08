/**
 * Promises and waits on the phone (docs/PROMISES_AND_WAITS.md): the joined
 * list, the Talk promise check, and the owner's answer on a promise card.
 */

import { offerTalkPromise, setTalkPromiseRunner } from '@dina/brain';
import {
  getMessage,
  readLifecycle,
  updateMessageMetadataById,
  type PromiseOfferLifecycle,
} from '@dina/brain/chat';
import {
  getContact,
  getPlanStore,
  listPromisesAndWaits,
  trackTalkPromise,
  type PromiseItem,
  type PromisesAndWaits,
} from '@dina/core';

import { rescheduleCheckins, routerAsk } from './daily_plan';

/** The owner's chat, where promise cards go. */
export const PROMISE_CARD_THREAD = 'main';

/** A contact's name, or '' when unknown. */
export function contactNameFor(did: string): string {
  try {
    return getContact(did)?.displayName?.trim() ?? '';
  } catch {
    return '';
  }
}

/** Turn on the Talk promise check. Each message asks the model once, in the background. */
export function installTalkPromises(): void {
  setTalkPromiseRunner((input) =>
    offerTalkPromise(
      { ...input, contactName: input.contactName.trim() || contactNameFor(input.contactDid) },
      { ask: routerAsk(), threadId: PROMISE_CARD_THREAD },
    ),
  );
}

export function loadPromises(now: number = Date.now()): PromisesAndWaits {
  return listPromisesAndWaits(now);
}

function offerOn(messageId: string): PromiseOfferLifecycle {
  const msg = getMessage(messageId);
  const lc = msg === null ? null : readLifecycle(msg);
  if (lc === null || lc.kind !== 'promise_offer') throw new Error('That card is gone.');
  return lc;
}

/**
 * Track the promise on a card: a plan task, then the card says so. A card
 * already answered is left as it is, so a second tap does nothing.
 */
export async function trackPromiseOffer(
  messageId: string,
  now: number = Date.now(),
): Promise<PromiseOfferLifecycle> {
  const lc = offerOn(messageId);
  if (lc.status !== 'open') return lc;
  const store = getPlanStore();
  if (store === null) throw new Error('Your Dina is still starting. Try again in a moment.');
  const task = trackTalkPromise(
    store,
    {
      contactDid: lc.contactDid,
      contactName: lc.contactName || contactNameFor(lc.contactDid),
      messageId: lc.talkMessageId,
      direction: lc.direction,
      what: lc.what,
      dueAt: lc.dueAt,
    },
    now,
  );
  const next: PromiseOfferLifecycle = { ...lc, status: 'tracked', taskId: task.id };
  updateMessageMetadataById(PROMISE_CARD_THREAD, messageId, { lifecycle: next });
  await rescheduleCheckins(now);
  return next;
}

export function dismissPromiseOffer(messageId: string): PromiseOfferLifecycle {
  const lc = offerOn(messageId);
  if (lc.status !== 'open') return lc;
  const next: PromiseOfferLifecycle = { ...lc, status: 'dismissed' };
  updateMessageMetadataById(PROMISE_CARD_THREAD, messageId, { lifecycle: next });
  return next;
}

/** Whether the list can close this item itself; others open their own screen. */
export function closableHere(item: PromiseItem): boolean {
  return item.source === 'talk' || item.source === 'plan';
}

/**
 * Close a promise from the list. A Talk promise is done once kept. A goal
 * task's wait ends and the task stays open, as "Got it" does on the goal.
 */
export async function closePromise(item: PromiseItem, now: number = Date.now()): Promise<void> {
  const store = getPlanStore();
  if (store === null) throw new Error('Your Dina is still starting. Try again in a moment.');
  if (item.source === 'talk') store.updateTask(item.ref, { status: 'done' }, now);
  else if (item.source === 'plan') store.updateTask(item.ref, { waitingOn: '' }, now);
  else throw new Error('Open it to close it.');
  await rescheduleCheckins(now);
}

/** Where an item opens: its own screen, or the contact's Talk thread. */
export function promiseHref(
  item: PromiseItem,
): { pathname: string; params?: Record<string, string> } | null {
  switch (item.source) {
    case 'talk':
      return item.whoDid !== null ? { pathname: `/chat/${item.whoDid}` } : null;
    case 'plan': {
      const task = getPlanStore()?.getTask(item.ref);
      return task !== null && task !== undefined && task.goalId !== ''
        ? { pathname: '/goal', params: { id: task.goalId } }
        : { pathname: '/plan' };
    }
    case 'tender':
      return { pathname: '/tender', params: { tender_id: item.ref } };
    case 'order':
      return { pathname: '/orders' };
    case 'agreement':
      return { pathname: '/shelf-agreement', params: { digest: item.ref } };
    case 'group_plan':
      return null;
  }
}
