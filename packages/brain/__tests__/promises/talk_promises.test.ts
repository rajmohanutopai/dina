/**
 * docs/PROMISES_AND_WAITS.md §4: a promise found in a Talk message is offered
 * on a card, once per message, and only when the model's answer holds up.
 */

import { resetOwnerTurns, setCurrentOwnerTurn } from '../../src/chat/owner_turns';
import { addMessage, getThread, readLifecycle, resetThreads } from '../../src/chat/thread';
import { findPromise, parseLocalDue, readFoundPromise } from '../../src/promises/find_promise';
import { createListPromisesTool } from '../../src/promises/list_promises_tool';
import {
  noteTalkMessage,
  offerTalkPromise,
  promiseOfferText,
  setTalkPromiseRunner,
  type TalkPromiseInput,
} from '../../src/promises/offer';
import { createSendMessageTool } from '../../src/reasoning/send_message_tool';

import type { PlannerAsk } from '../../src/plan/day_planner';
import type { PromisesAndWaits } from '@dina/core';

// Sunday 8 November 2026, 10:00 local.
const NOW = new Date(2026, 10, 8, 10, 0).getTime();
const MIKE = 'did:plc:mike';

function answer(v: unknown): PlannerAsk {
  return async () => JSON.stringify(v);
}

beforeEach(() => {
  resetThreads();
  resetOwnerTurns();
  setTalkPromiseRunner(null);
});

describe('parseLocalDue', () => {
  it('reads local date and time, with 18:00 for a bare day', () => {
    expect(parseLocalDue('2026-11-13T09:30')).toBe(new Date(2026, 10, 13, 9, 30).getTime());
    expect(parseLocalDue('2026-11-13')).toBe(new Date(2026, 10, 13, 18, 0).getTime());
  });
  it('refuses dates that do not exist and other shapes', () => {
    expect(parseLocalDue('2026-02-30')).toBeNull();
    expect(parseLocalDue('2026-11-13T25:00')).toBeNull();
    expect(parseLocalDue('Friday')).toBeNull();
    expect(parseLocalDue(null)).toBeNull();
  });
});

describe('readFoundPromise', () => {
  const base = { promise: true, by: 'writer', what: 'Send the deck', due: '2026-11-13T18:00' };

  it('turns the writer and reader into who owes whom', () => {
    expect(readFoundPromise(JSON.stringify(base), { fromOwner: false, now: NOW })?.direction).toBe(
      'owed_to_me',
    );
    expect(readFoundPromise(JSON.stringify(base), { fromOwner: true, now: NOW })?.direction).toBe(
      'owed_by_me',
    );
    const reader = JSON.stringify({ ...base, by: 'reader' });
    expect(readFoundPromise(reader, { fromOwner: true, now: NOW })?.direction).toBe('owed_to_me');
  });

  it('drops a date already gone or more than a year away, and keeps the promise', () => {
    const past = readFoundPromise(JSON.stringify({ ...base, due: '2026-11-01T18:00' }), {
      fromOwner: false,
      now: NOW,
    });
    expect(past).toMatchObject({ what: 'Send the deck', dueAt: null });
    const far = readFoundPromise(JSON.stringify({ ...base, due: '2028-01-01' }), {
      fromOwner: false,
      now: NOW,
    });
    expect(far?.dueAt).toBeNull();
    const today = readFoundPromise(JSON.stringify({ ...base, due: '2026-11-08T08:00' }), {
      fromOwner: false,
      now: NOW,
    });
    expect(today?.dueAt).toBe(new Date(2026, 10, 8, 8, 0).getTime());
  });

  it('finds no promise in a muddled answer', () => {
    for (const raw of [
      'not json',
      JSON.stringify({ promise: false }),
      JSON.stringify({ ...base, by: 'someone' }),
      JSON.stringify({ ...base, what: '' }),
      JSON.stringify({ ...base, what: 'x'.repeat(200) }),
    ]) {
      expect(readFoundPromise(raw, { fromOwner: false, now: NOW })).toBeNull();
    }
  });
});

describe('findPromise', () => {
  it('finds nothing with no model or when the model fails', async () => {
    const input = { text: "I'll send it Friday", fromOwner: false, contactName: 'Mike', now: NOW };
    await expect(findPromise(null, input)).resolves.toBeNull();
    await expect(
      findPromise(async () => {
        throw new Error('down');
      }, input),
    ).resolves.toBeNull();
  });

  it('gives the model the date, who wrote it and the messages before it', async () => {
    let user = '';
    const ask: PlannerAsk = async (a) => {
      user = a.user;
      return JSON.stringify({
        promise: true,
        by: 'writer',
        what: 'Send the deck',
        due: '2026-11-13',
      });
    };
    await findPromise(ask, {
      text: 'Sure, Friday',
      fromOwner: false,
      contactName: 'Mike',
      now: NOW,
      earlier: [{ fromOwner: true, text: 'Can you send the deck?' }],
    });
    expect(user).toContain('Sunday 2026-11-08 10:00');
    expect(user).toContain('Writer: Mike');
    expect(user).toContain('The owner: Can you send the deck?');
    expect(user).toContain('Latest message:\nSure, Friday');
  });
});

describe('offerTalkPromise', () => {
  const input: TalkPromiseInput = {
    talkMessageId: 'cm-1',
    contactDid: MIKE,
    contactName: 'Mike',
    text: "I'll send the deck by Friday",
    fromOwner: false,
    now: NOW,
  };

  it('posts an open card in the owner chat with what, who and when', async () => {
    const ask = answer({ promise: true, by: 'writer', what: 'Send the deck', due: '2026-11-13' });
    const card = await offerTalkPromise(input, { ask, threadId: 'main' });
    expect(card?.content).toBe('Mike said they would send the deck. Track it?');
    expect(readLifecycle(card as NonNullable<typeof card>)).toEqual({
      kind: 'promise_offer',
      status: 'open',
      talkMessageId: 'cm-1',
      contactDid: MIKE,
      contactName: 'Mike',
      direction: 'owed_to_me',
      what: 'Send the deck',
      dueAt: new Date(2026, 10, 13, 18, 0).getTime(),
    });
  });

  it('posts nothing when there is no promise', async () => {
    await offerTalkPromise(input, { ask: answer({ promise: false }), threadId: 'main' });
    expect(getThread('main')).toEqual([]);
  });

  it('offers one message once, even when asked twice at the same time', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const ask: PlannerAsk = async () => {
      await gate;
      return JSON.stringify({ promise: true, by: 'writer', what: 'Send the deck', due: null });
    };
    const a = offerTalkPromise(input, { ask, threadId: 'main' });
    const b = offerTalkPromise(input, { ask, threadId: 'main' });
    release();
    await Promise.all([a, b]);
    await offerTalkPromise(input, { ask, threadId: 'main' });
    expect(getThread('main')).toHaveLength(1);
  });

  it('reads the Talk thread before the message for context', async () => {
    addMessage(MIKE, 'user', 'Can you send the deck?', { timestamp: NOW - 60_000 });
    const msg = addMessage(MIKE, 'dina', 'Sure, Friday', { timestamp: NOW });
    let user = '';
    const ask: PlannerAsk = async (a) => {
      user = a.user;
      return JSON.stringify({ promise: false });
    };
    await offerTalkPromise(
      { ...input, talkMessageId: msg.id, text: 'Sure, Friday' },
      { ask, threadId: 'main' },
    );
    expect(user).toContain('The owner: Can you send the deck?');
    expect(user.match(/Sure, Friday/g)).toHaveLength(1);
  });

  it('words a promise the owner made from their side', () => {
    expect(
      promiseOfferText('Ana', { direction: 'owed_by_me', what: 'Confirm dinner.', dueAt: null }),
    ).toBe('You told Ana you would confirm dinner. Track it?');
  });
});

describe('noteTalkMessage', () => {
  it('does nothing with no runner, and a failing runner never throws', async () => {
    expect(() =>
      noteTalkMessage({
        talkMessageId: 'x',
        contactDid: MIKE,
        contactName: '',
        text: 'hi',
        fromOwner: true,
        now: NOW,
      }),
    ).not.toThrow();
    setTalkPromiseRunner(async () => {
      throw new Error('boom');
    });
    expect(() =>
      noteTalkMessage({
        talkMessageId: 'x',
        contactDid: MIKE,
        contactName: '',
        text: 'hi',
        fromOwner: true,
        now: NOW,
      }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('send_message notes what the owner sent', () => {
  it('passes the sent text, contact and its Talk message to the promise check', async () => {
    const seen: TalkPromiseInput[] = [];
    setTalkPromiseRunner(async (i) => {
      seen.push(i);
    });
    setCurrentOwnerTurn('main', {
      releaseSession: 'chat:main',
      turnId: 't1',
      text: "tell Mike I'll confirm by Friday",
      at: NOW,
    });
    const tool = createSendMessageTool({
      thread: 'main',
      core: {
        talkSend: async () => ({
          status: 'sent',
          recipient_did: MIKE,
          recipient_name: 'Mike',
          text: "I'll confirm by Friday",
        }),
      } as never,
    });
    await tool.execute({ contact: 'Mike', proposed_text: "I'll confirm by Friday" });
    const talk = getThread(MIKE);
    expect(talk).toHaveLength(1);
    expect(seen).toEqual([
      expect.objectContaining({
        talkMessageId: talk[0].id,
        contactDid: MIKE,
        contactName: 'Mike',
        text: "I'll confirm by Friday",
        fromOwner: true,
      }),
    ]);
  });
});

describe('list_promises', () => {
  const list: PromisesAndWaits = {
    items: [
      {
        id: 'a',
        direction: 'owed_to_me',
        source: 'talk',
        who: 'Mike',
        whoDid: MIKE,
        what: 'Send the deck',
        dueAt: new Date(2026, 10, 6).getTime(),
        late: true,
        ref: 't1',
      },
      {
        id: 'b',
        direction: 'owed_by_me',
        source: 'talk',
        who: 'Ana',
        whoDid: null,
        what: 'Confirm dinner',
        dueAt: null,
        late: false,
        ref: 't2',
      },
    ],
    missing: ['tender'],
  };
  const tool = createListPromisesTool({ core: { promisesList: async () => list }, now: () => NOW });

  it('splits what others owe from what the user promised, and names what it could not read', async () => {
    await expect(tool.execute({})).resolves.toEqual({
      waiting_on_others: [
        { who: 'Mike', what: 'Send the deck', due: '2026-11-06', late: true, from: 'talk' },
      ],
      you_promised: [{ who: 'Ana', what: 'Confirm dinner', from: 'talk' }],
      could_not_read: ['tender'],
    });
  });

  it('answers one side when asked', async () => {
    const out = (await tool.execute({ direction: 'owed_by_me' })) as Record<string, unknown>;
    expect(out.waiting_on_others).toBeUndefined();
    expect(out.you_promised).toHaveLength(1);
  });
});
