/**
 * A promise from Talk the owner chose to track (docs/PROMISES_AND_WAITS.md §2.3):
 * an ordinary plan task, so the day plan, check-ins and chat see it.
 */

import { notifyPlanChanged, type PlanStore, type PlanTask } from '../plan/store';

import { talkSourceRef } from './view';

export interface TalkPromise {
  contactDid: string;
  /** The contact's name as the owner sees it. */
  contactName: string;
  /** The Talk message the promise was in; one task per message. */
  messageId: string;
  /** `owed_to_me`: the contact promised the owner. `owed_by_me`: the owner promised. */
  direction: 'owed_to_me' | 'owed_by_me';
  /** What was promised, one line. */
  what: string;
  dueAt: number | null;
}

const MAX_TITLE = 200;

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

/**
 * Add the task, or return the one already added for this message. A promise
 * owed to the owner is a wait on the contact; one the owner made is a task
 * due on its date.
 */
export function trackTalkPromise(store: PlanStore, p: TalkPromise, now: number): PlanTask {
  const sourceRef = talkSourceRef(p.contactDid, p.messageId);
  const existing = store.getOwnerTaskBySourceRef(sourceRef);
  if (existing !== null) return existing;
  const what = clean(p.what);
  if (what === '') throw new Error('A promise needs saying what it is.');
  const name = clean(p.contactName) || 'Someone';
  const task =
    p.direction === 'owed_to_me'
      ? store.addOwnerTask(
          {
            title: what,
            source: 'talk',
            sourceRef,
            waitingOn: name,
            waitingUntil: p.dueAt,
          },
          now,
        )
      : store.addOwnerTask({ title: what, source: 'talk', sourceRef, dueAt: p.dueAt }, now);
  notifyPlanChanged();
  return task;
}
