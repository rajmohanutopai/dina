/**
 * PH-06: the chat row is durable, and the handler's memory of it is not. After a
 * lock or a kill a new handler must read each open row's ask from the durable
 * registry and show its true state.
 */

import {
  addDinaResponse,
  addLifecycleMessage,
  addMessage,
  addUserMessage,
  getThread,
  readLifecycle,
  resetThreads,
} from '../../src/chat/thread';
import { createCoordinatorAskHandler } from '../../src/composition/coordinator_ask_handler';

interface Ev {
  kind: string;
  id: string;
}

function fake(records: Record<string, unknown>) {
  const subs = new Set<(e: Ev) => void>();
  return {
    coordinator: {
      gateway: {},
      registry: { get: async (id: string) => records[id] ?? null },
      handleAsk: async () => {
        throw new Error('not used');
      },
      subscribe: (fn: (e: Ev) => void) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
    } as never,
    fire: (e: Ev) => {
      subs.forEach((f) => f(e));
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

function make(records: Record<string, unknown>) {
  const c = fake(records);
  const h = createCoordinatorAskHandler({ coordinator: c.coordinator, requesterDid: 'did:plc:x' });
  return { ...h, fire: c.fire };
}

function placeholder(askId: string): void {
  addUserMessage('main', 'a question');
  addLifecycleMessage('main', 'Working on it', { kind: 'ask_pending', status: 'pending', askId });
}

function approvalRow(askId: string): void {
  addUserMessage('main', 'a question');
  addMessage('main', 'approval', 'needs approval', {
    metadata: {
      kind: 'ask_approval',
      askId,
      approvalId: `appr-${askId}-health`,
      persona: 'health',
    },
  });
}

function askRow() {
  return getThread('main').find((m) => readLifecycle(m)?.kind === 'ask_pending');
}

function approvalMeta(): Record<string, unknown> {
  return getThread('main').find((m) => m.type === 'approval')?.metadata ?? {};
}

function dinaTexts(): string[] {
  return getThread('main')
    .filter((m) => m.type === 'dina')
    .map((m) => m.content);
}

beforeEach(() => resetThreads());

describe('placeholder rows', () => {
  it('a finished ask morphs the row to its answer', async () => {
    placeholder('ask-1');
    const h = make({
      'ask-1': { status: 'complete', answerJson: JSON.stringify({ text: 'the answer' }) },
    });
    await h.reconcile();
    expect(askRow()?.content).toBe('the answer');
    expect(readLifecycle(askRow()!)).toMatchObject({ status: 'complete' });
    h.dispose();
  });

  it('an expired ask ends the dots, in plain words', async () => {
    placeholder('ask-2');
    const h = make({ 'ask-2': { status: 'expired' } });
    await h.reconcile();
    expect(readLifecycle(askRow()!)).toMatchObject({ status: 'expired' });
    h.dispose();
  });

  it('a record that no longer exists ends the dots', async () => {
    placeholder('ask-3');
    const h = make({});
    await h.reconcile();
    expect(readLifecycle(askRow()!)).toMatchObject({ status: 'expired' });
    h.dispose();
  });

  it('an ask still running is adopted: its later event reaches the row', async () => {
    placeholder('ask-4');
    const records: Record<string, unknown> = { 'ask-4': { status: 'in_flight' } };
    const h = make(records);
    await h.reconcile();
    expect(readLifecycle(askRow()!)).toMatchObject({ status: 'pending' });
    records['ask-4'] = { status: 'complete', answerJson: JSON.stringify({ text: 'late answer' }) };
    h.fire({ kind: 'completed', id: 'ask-4' });
    await flush();
    expect(askRow()?.content).toBe('late answer');
    h.dispose();
  });
});

describe('approval rows', () => {
  it('approved after a restart: the answer reaches chat, once', async () => {
    approvalRow('ask-5');
    const records: Record<string, unknown> = { 'ask-5': { status: 'pending_approval' } };
    const h = make(records);
    await h.reconcile();
    records['ask-5'] = {
      status: 'complete',
      answerJson: JSON.stringify({ text: 'approved answer' }),
    };
    h.fire({ kind: 'completed', id: 'ask-5' });
    await flush();
    await h.reconcile();
    await h.reconcile();
    expect(dinaTexts()).toEqual(['approved answer']);
    expect(approvalMeta().askStatus).toBe('complete');
    h.dispose();
  });

  it('a run that died with the process: the owner is told, once', async () => {
    approvalRow('ask-6');
    const h = make({ 'ask-6': { status: 'expired' } });
    await h.reconcile();
    await h.reconcile();
    expect(dinaTexts()).toHaveLength(1);
    expect(approvalMeta().askStatus).toBe('expired');
    h.dispose();
  });

  it('a card approved earlier shows approved, so its buttons stay down after a remount', async () => {
    approvalRow('ask-7');
    const h = make({ 'ask-7': { status: 'in_flight' } });
    await h.reconcile();
    expect(approvalMeta().askStatus).toBe('in_flight');
    h.dispose();
  });

  it('a row answered before this code existed does not repeat its answer', async () => {
    approvalRow('ask-8');
    addDinaResponse('main', 'the answer delivered back then', []);
    const h = make({ 'ask-8': { status: 'complete', answerJson: JSON.stringify({ text: 'x' }) } });
    await h.reconcile();
    expect(dinaTexts()).toEqual(['the answer delivered back then']);
    expect(approvalMeta().askStatus).toBe('complete');
    h.dispose();
  });

  it('an unknown record closes the card', async () => {
    approvalRow('ask-9');
    const h = make({});
    await h.reconcile();
    expect(approvalMeta().askStatus).toBe('expired');
    h.dispose();
  });
});

it('after dispose, reconcile does nothing', async () => {
  placeholder('ask-10');
  const h = make({ 'ask-10': { status: 'expired' } });
  h.dispose();
  await h.reconcile();
  expect(readLifecycle(askRow()!)).toMatchObject({ status: 'pending' });
});

it('a live approval flow marks its row when it delivers', async () => {
  const records: Record<string, unknown> = { 'ask-11': { status: 'pending_approval' } };
  const subs = new Set<(e: Ev) => void>();
  const h = createCoordinatorAskHandler({
    coordinator: {
      gateway: {},
      registry: { get: async (id: string) => records[id] ?? null },
      handleAsk: async () => ({
        kind: 'fast_path',
        body: {
          status: 'pending_approval',
          approval_id: 'appr-ask-11-health',
          request_id: 'ask-11',
        },
      }),
      subscribe: (fn: (e: Ev) => void) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
    } as never,
    requesterDid: 'did:plc:x',
  });
  await h.handler('q', { threadId: 'main' } as never);
  records['ask-11'] = { status: 'complete', answerJson: JSON.stringify({ text: 'live answer' }) };
  subs.forEach((f) => f({ kind: 'completed', id: 'ask-11' }));
  await flush();
  expect(approvalMeta().askStatus).toBe('complete');
  await h.reconcile();
  expect(dinaTexts()).toEqual(['live answer']);
  h.dispose();
});
