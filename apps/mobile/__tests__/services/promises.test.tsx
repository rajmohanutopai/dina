/**
 * docs/PROMISES_AND_WAITS.md on the phone: the promise card tracks once and
 * says so, the list closes Talk promises and goal waits, and Talk messages in
 * and out reach the promise check.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { setTalkPromiseRunner, type TalkPromiseInput } from '@dina/brain';
import {
  addMessage,
  getMessage,
  getThread,
  readLifecycle,
  resetThreads,
  type ChatMessage,
  type PromiseOfferLifecycle,
} from '@dina/brain/chat';
import {
  IDENTITY_MIGRATIONS,
  PlanStore,
  applyMigrations,
  listPromisesAndWaits,
  setPlanStore,
} from '@dina/core';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { setD2DSender } from '../../../../packages/core/src/server/routes/d2d_msg';
import { toDisplayType } from '../../src/chat/message_display';
import { InlinePromiseOfferCard } from '../../src/components/InlinePromiseOfferCard';
import { fanOutStagedD2D } from '../../src/services/bootstrap';
import { sendChatMessage } from '../../src/services/chat_d2d';
import * as dailyPlan from '../../src/services/daily_plan';
import {
  closePromise,
  dismissPromiseOffer,
  installTalkPromises,
  promiseHref,
  trackPromiseOffer,
} from '../../src/services/promises';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const NOW = new Date(2026, 10, 8, 10, 0).getTime();
const MIKE = 'did:plc:mike';

let dir: string;
let db: NodeSQLiteAdapter;
let store: PlanStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promises-'));
  db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  store = new PlanStore(db);
  setPlanStore(store);
  resetThreads();
  setTalkPromiseRunner(null);
  mockPush.mockReset();
});

afterEach(() => {
  setTalkPromiseRunner(null);
  setD2DSender(null);
  setPlanStore(null);
  jest.restoreAllMocks();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function offer(over: Partial<PromiseOfferLifecycle> = {}): ChatMessage {
  const lifecycle: PromiseOfferLifecycle = {
    kind: 'promise_offer',
    status: 'open',
    talkMessageId: 'cm-talk-1',
    contactDid: MIKE,
    contactName: 'Mike',
    direction: 'owed_to_me',
    what: 'Send the deck',
    dueAt: NOW + 2 * 86_400_000,
    ...over,
  };
  return addMessage('main', 'dina', 'Mike said they would send the deck. Track it?', {
    metadata: { lifecycle },
    sources: [`promise:${lifecycle.talkMessageId}`],
  });
}

describe('the promise card', () => {
  it('renders in chat as its own card', () => {
    expect(toDisplayType(offer())).toBe('promise-offer');
  });

  it('tracks on Track it, then shows it is tracking, and a second answer changes nothing', async () => {
    const msg = offer();
    const screen = render(<InlinePromiseOfferCard message={msg} />);
    expect(screen.getByText('A promise to you')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('promise-offer-track-cm-talk-1'));
    });
    const after = getMessage(msg.id) as ChatMessage;
    const lc = readLifecycle(after) as PromiseOfferLifecycle;
    expect(lc.status).toBe('tracked');
    const task = store.getTask(lc.taskId ?? '');
    expect(task).toMatchObject({ title: 'Send the deck', waitingOn: 'Mike', source: 'talk' });

    screen.rerender(<InlinePromiseOfferCard message={after} />);
    expect(screen.queryByTestId('promise-offer-track-cm-talk-1')).toBeNull();
    fireEvent.press(screen.getByTestId('promise-offer-tracked-cm-talk-1'));
    expect(mockPush).toHaveBeenCalledWith('/promises');

    // Tapped again from a stale card: nothing new.
    await trackPromiseOffer(msg.id, NOW);
    expect(dismissPromiseOffer(msg.id).status).toBe('tracked');
    expect(store.listTasks({ statuses: ['open'] })).toHaveLength(1);
  });

  it('tracks nothing on Not now', async () => {
    const msg = offer();
    const screen = render(<InlinePromiseOfferCard message={msg} />);
    fireEvent.press(screen.getByTestId('promise-offer-dismiss-cm-talk-1'));
    const after = getMessage(msg.id) as ChatMessage;
    expect((readLifecycle(after) as PromiseOfferLifecycle).status).toBe('dismissed');
    screen.rerender(<InlinePromiseOfferCard message={after} />);
    expect(screen.getByText('Not tracked.')).toBeTruthy();
    expect(store.listTasks({ statuses: ['open'] })).toEqual([]);
  });

  it('keeps the answer on the message, so it shows after a restart', async () => {
    const msg = offer({ direction: 'owed_by_me', what: 'Confirm dinner' });
    await trackPromiseOffer(msg.id, NOW);
    const saved = getThread('main')[0];
    const screen = render(<InlinePromiseOfferCard message={saved} />);
    expect(screen.getByText('A promise you made')).toBeTruthy();
    expect(screen.getByTestId('promise-offer-tracked-cm-talk-1')).toBeTruthy();
  });
});

describe('closing from the list', () => {
  it('marks a Talk promise done and ends a goal wait with the task left open', async () => {
    const msg = offer();
    await trackPromiseOffer(msg.id, NOW);
    const goal = store.addGoal('House', '', NOW);
    const t = store.addOwnerTask({ title: 'Plumbing quote', goalId: goal.id }, NOW);
    store.updateTask(t.id, { waitingOn: 'Builder' }, NOW);

    const { items } = listPromisesAndWaits(NOW);
    expect(items.map((i) => i.source).sort()).toEqual(['plan', 'talk']);
    for (const item of items) await closePromise(item, NOW);

    expect(listPromisesAndWaits(NOW).items).toEqual([]);
    expect(store.getTask(t.id)).toMatchObject({ status: 'open', waitingOn: '' });
  });

  it('opens a Talk promise in the contact thread and a goal wait on its goal', async () => {
    await trackPromiseOffer(offer().id, NOW);
    const goal = store.addGoal('House', '', NOW);
    const t = store.addOwnerTask({ title: 'Plumbing quote', goalId: goal.id }, NOW);
    store.updateTask(t.id, { waitingOn: 'Builder' }, NOW);
    const hrefs = listPromisesAndWaits(NOW).items.map(promiseHref);
    expect(hrefs).toEqual(
      expect.arrayContaining([
        { pathname: `/chat/${MIKE}` },
        { pathname: '/goal', params: { id: goal.id } },
      ]),
    );
  });
});

describe('Talk messages reach the promise check', () => {
  it('sends what the owner typed in a Talk thread, after it is delivered', async () => {
    const seen: TalkPromiseInput[] = [];
    setTalkPromiseRunner(async (i) => {
      seen.push(i);
    });
    setD2DSender(async () => undefined);
    const sent = await sendChatMessage(MIKE, "I'll call you tomorrow");
    expect(seen).toEqual([
      expect.objectContaining({
        talkMessageId: sent.id,
        contactDid: MIKE,
        text: "I'll call you tomorrow",
        fromOwner: true,
      }),
    ]);
  });

  it('sends what a contact wrote, once it lands in their Talk thread', () => {
    const seen: TalkPromiseInput[] = [];
    setTalkPromiseRunner(async (i) => {
      seen.push(i);
    });
    fanOutStagedD2D({
      senderDID: MIKE,
      messageType: 'coordination.request',
      body: JSON.stringify({ text: "I'll send the deck Friday" }),
      senderCreatedTime: NOW,
    });
    const talk = getThread(MIKE);
    expect(talk).toHaveLength(1);
    expect(seen).toEqual([
      expect.objectContaining({
        talkMessageId: talk[0].id,
        contactDid: MIKE,
        text: "I'll send the deck Friday",
        fromOwner: false,
      }),
    ]);
  });

  it('checks nothing for a message type that is not conversation', () => {
    const seen: TalkPromiseInput[] = [];
    setTalkPromiseRunner(async (i) => {
      seen.push(i);
    });
    fanOutStagedD2D({ senderDID: MIKE, messageType: 'service.query', body: '{"text":"x"}' });
    expect(seen).toEqual([]);
  });

  it('checks nothing when the send fails', async () => {
    const seen: TalkPromiseInput[] = [];
    setTalkPromiseRunner(async (i) => {
      seen.push(i);
    });
    setD2DSender(async () => {
      throw new Error('offline');
    });
    await expect(sendChatMessage(MIKE, "I'll call you tomorrow")).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it('installs a runner that asks the model and posts the card in the owner chat', async () => {
    jest
      .spyOn(dailyPlan, 'routerAsk')
      .mockReturnValue(async () =>
        JSON.stringify({ promise: true, by: 'writer', what: 'Send the deck', due: null }),
      );
    installTalkPromises();
    const talk = addMessage(MIKE, 'dina', "I'll send the deck", { timestamp: NOW });
    const { noteTalkMessage } = jest.requireActual('@dina/brain') as typeof import('@dina/brain');
    noteTalkMessage({
      talkMessageId: talk.id,
      contactDid: MIKE,
      contactName: 'Mike',
      text: "I'll send the deck",
      fromOwner: false,
      now: NOW,
    });
    await waitFor(() => expect(getThread('main')).toHaveLength(1));
    expect(readLifecycle(getThread('main')[0])).toMatchObject({
      kind: 'promise_offer',
      talkMessageId: talk.id,
      direction: 'owed_to_me',
    });
  });
});
