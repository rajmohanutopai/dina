/**
 * Chat-row display wiring (extracted from app/index.tsx). Covers that a
 * `commerce_comparison` lifecycle message (§5.A4/A5) classifies to its own
 * render branch and row-contract kind — and, crucially, NOT to 'dina', so the
 * empty-content row survives renderMessage's empty-`dina`-row skip. Guards the
 * wiring a full-screen render would not exercise cheaply.
 */

import { addLifecycleMessage, resetThreads, getThread, type ChatMessage } from '@dina/brain/chat';

import { chatRowKind, toDisplayType } from '../../src/chat/message_display';

const THREAD = 'test-thread';

function lastMessage(): ChatMessage {
  const t = getThread(THREAD);
  const last = t[t.length - 1];
  if (last === undefined) throw new Error('thread is empty');
  return last;
}

function postCard(cardId: string): void {
  addLifecycleMessage(THREAD, '', {
    kind: 'commerce_comparison',
    status: 'ready',
    cardId,
    cardSpec: { version: 1, blocks: [{ kind: 'title', text: 'Where to buy' }] },
  });
}

describe('message_display — commerce_comparison wiring', () => {
  beforeEach(() => {
    resetThreads();
  });

  it('classifies a commerce_comparison lifecycle message to the commerce-comparison branch', () => {
    postCard('c1');
    expect(toDisplayType(lastMessage())).toBe('commerce-comparison');
  });

  it('does NOT classify the empty-content commerce card as "dina" (survives the empty-row skip)', () => {
    // renderMessage drops rows where displayType === 'dina' AND content is empty.
    // The commerce card is posted with empty content, so it MUST classify away
    // from 'dina' or it would be silently dropped.
    postCard('c2');
    const dt = toDisplayType(lastMessage());
    expect(dt).not.toBe('dina');
    expect(dt).toBe('commerce-comparison');
  });

  it('maps the commerce-comparison display type to its row-contract kind', () => {
    expect(chatRowKind('commerce-comparison')).toBe('commerce-comparison');
  });

  it('preserves the existing branches after extraction (regression guard)', () => {
    const dina: ChatMessage = {
      id: '1',
      threadId: THREAD,
      type: 'dina',
      content: 'hello',
      timestamp: 0,
    };
    expect(toDisplayType(dina)).toBe('dina');
    expect(chatRowKind('dina')).toBe('answer');
    expect(chatRowKind('service-query')).toBe('service-query');
  });
});

describe('message_display — group_plan wiring (GROUP_COORDINATION §9)', () => {
  beforeEach(() => resetThreads());

  it('classifies a group_plan lifecycle message to the group-plan branch and row kind', () => {
    addLifecycleMessage('t', '', { kind: 'group_plan', status: 'open', planId: 'gp_1', intent: "Emma's birthday" });
    const thread = getThread('t');
    const msg = thread[thread.length - 1] as ChatMessage;
    expect(toDisplayType(msg)).toBe('group-plan');
    expect(chatRowKind('group-plan')).toBe('group-plan');
  });
});
