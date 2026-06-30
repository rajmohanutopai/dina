/**
 * Contact Services seam 3/4 — inbound `service.response` → PEER Talk thread,
 * exercised through the REAL boot `talkThreadResolver` (not a hand-copied
 * duplicate) driving the shared `createServiceQueryDeliverer`.
 *
 * Covers:
 *   - the resolver's pure DID-vs-non-DID decision;
 *   - a pending card patched to resolved in the peer thread (DID origin);
 *   - a FRESH terminal card posted to the peer thread when the event lands
 *     before any pending card (peer answered before the local dispatch wrote
 *     its card);
 *   - terminal/ERROR statuses (`error` → failed, `expired` → expired) routed to
 *     the peer thread, not 'main';
 *   - a §10 confused-deputy NEGATIVE assertion at the deliverer boundary: a
 *     response whose task.id does NOT match the pending card's id can NEVER
 *     patch that card (correlation is by the OUR-dispatch task id, so a peer
 *     cannot steer a patch onto an arbitrary card).
 */

import { createServiceQueryDeliverer } from '../../../brain/src/chat/service_query_deliverer';
import {
  addLifecycleMessage,
  getThread,
  hydrateThread,
  readLifecycle,
  resetThreads,
} from '../../../brain/src/chat/thread';
import { InMemoryChatMessageRepository, setChatMessageRepository } from '../../../core/src/index';
import { talkThreadResolver } from '../../src/services/talk_thread_routing';

import type { ServiceQueryEventDetails } from '../../../brain/src/service/result_formatter';
import type { WorkflowEvent, WorkflowTask } from '../../../core/src/index';

const PEER = 'did:plc:sancho';
const TASK_ID = 'sq-q1-aabbccdd';

function makeTask(originChannel: string, id = TASK_ID): WorkflowTask {
  return {
    id,
    kind: 'service_query',
    payload: JSON.stringify({
      query_id: 'q1',
      capability: 'availability_coordination',
      origin_channel: originChannel,
    }),
  } as unknown as WorkflowTask;
}

function makeEvent(taskId = TASK_ID): WorkflowEvent {
  return { task_id: taskId, event_kind: 'completed' } as unknown as WorkflowEvent;
}

function pendingCard(thread: string, taskId = TASK_ID): void {
  addLifecycleMessage(thread, 'Asking Sancho scheduling…', {
    kind: 'service_query',
    status: 'pending',
    taskId,
    queryId: 'q1',
    capability: 'availability_coordination',
    serviceName: 'Sancho scheduling',
    providerDid: PEER,
  });
}

function deliverer() {
  return createServiceQueryDeliverer({ threadId: 'main', threadResolver: talkThreadResolver });
}

beforeEach(() => {
  resetThreads();
});

describe('talkThreadResolver — pure decision', () => {
  it('returns the peer DID for a did:-shaped origin, null otherwise', () => {
    expect(talkThreadResolver({ originChannel: PEER, eventKind: 'completed', task: { id: TASK_ID, kind: 'service_query' } })).toBe(PEER);
    expect(talkThreadResolver({ originChannel: 'ask', eventKind: 'completed', task: { id: TASK_ID, kind: 'service_query' } })).toBeNull();
    expect(talkThreadResolver({ originChannel: '', eventKind: 'completed', task: { id: TASK_ID, kind: 'service_query' } })).toBeNull();
  });
});

describe('seam 3/4 — real resolver routes the response to the peer thread', () => {
  it('patches the pending card in the peer thread (DID origin)', async () => {
    pendingCard(PEER);
    const details: ServiceQueryEventDetails = {
      response_status: 'success',
      capability: 'availability_coordination',
      service_name: 'Sancho scheduling',
      result: { status: 'accepted', accepted_slots: [{ start: 'Tue 3pm' }] },
    };
    await deliverer()({ text: 'Tue 3pm works.', event: makeEvent(), task: makeTask(PEER), details });

    const peer = getThread(PEER);
    expect(peer).toHaveLength(1);
    const lc = readLifecycle(peer[0]);
    if (lc?.kind !== 'service_query') throw new Error('expected service_query');
    expect(lc.status).toBe('resolved');
    expect(getThread('main')).toHaveLength(0);
  });

  it('posts a FRESH terminal card in the peer thread when no pending card exists', async () => {
    // No pendingCard() — peer answered before the local dispatch wrote its card.
    const details: ServiceQueryEventDetails = {
      response_status: 'success',
      capability: 'availability_coordination',
      service_name: 'Sancho scheduling',
      result: { status: 'accepted' },
    };
    await deliverer()({ text: 'done', event: makeEvent(), task: makeTask(PEER), details });

    const peer = getThread(PEER);
    expect(peer).toHaveLength(1);
    const lc = readLifecycle(peer[0]);
    if (lc?.kind !== 'service_query') throw new Error('expected service_query');
    expect(lc.status).toBe('resolved');
    expect(lc.taskId).toBe(TASK_ID);
    expect(getThread('main')).toHaveLength(0);
  });

  it('routes a FAILED (error) response to the peer thread', async () => {
    pendingCard(PEER);
    const details: ServiceQueryEventDetails = {
      response_status: 'error',
      capability: 'availability_coordination',
      service_name: 'Sancho scheduling',
      error: 'capability errored',
    };
    await deliverer()({ text: 'failed', event: makeEvent(), task: makeTask(PEER), details });

    const lc = readLifecycle(getThread(PEER)[0]);
    if (lc?.kind !== 'service_query') throw new Error('expected service_query');
    expect(lc.status).toBe('failed');
    expect(lc.error).toBe('capability errored');
    expect(getThread('main')).toHaveLength(0);
  });

  it('routes an EXPIRED response to the peer thread', async () => {
    pendingCard(PEER);
    const details: ServiceQueryEventDetails = {
      response_status: 'expired',
      capability: 'availability_coordination',
      service_name: 'Sancho scheduling',
    };
    await deliverer()({ text: 'expired', event: makeEvent(), task: makeTask(PEER), details });

    const lc = readLifecycle(getThread(PEER)[0]);
    if (lc?.kind !== 'service_query') throw new Error('expected service_query');
    expect(lc.status).toBe('expired');
    expect(getThread('main')).toHaveLength(0);
  });

  it('a non-DID origin (main-tab query_service) stays on the default thread', async () => {
    pendingCard('main');
    const details: ServiceQueryEventDetails = {
      response_status: 'success',
      capability: 'availability_coordination',
      service_name: 'Sancho scheduling',
      result: { status: 'accepted' },
    };
    await deliverer()({ text: 'done', event: makeEvent(), task: makeTask('ask'), details });

    const main = getThread('main');
    expect(main).toHaveLength(1);
    expect(readLifecycle(main[0])?.status).toBe('resolved');
    expect(getThread(PEER)).toHaveLength(0);
  });

  it('§10 confused-deputy: a response whose task.id ≠ the pending card id never patches that card', async () => {
    // Our dispatch created the card under TASK_ID. A response arrives correlated
    // to a DIFFERENT task id (an attacker can't know/forge OUR task id; even a
    // collision in origin_channel can't redirect a patch onto an unrelated
    // card). The deliverer matches by task.id, so the original PENDING card is
    // untouched and a NEW terminal card is posted for the foreign task instead.
    pendingCard(PEER, TASK_ID);
    const foreign = 'sq-evil-99999999';
    const details: ServiceQueryEventDetails = {
      response_status: 'success',
      capability: 'availability_coordination',
      service_name: 'attacker',
      result: { status: 'accepted' },
    };
    await deliverer()({
      text: 'foreign',
      event: makeEvent(foreign),
      task: makeTask(PEER, foreign),
      details,
    });

    const cards = getThread(PEER);
    // Original pending card is STILL pending (never patched by the foreign id).
    const original = cards.find(
      (m) => readLifecycle(m)?.kind === 'service_query' && readLifecycle(m)?.taskId === TASK_ID,
    );
    if (original === undefined) throw new Error('expected the original pending card');
    expect(readLifecycle(original)?.status).toBe('pending');
    // The foreign response landed as its OWN separate card, not as a patch of ours.
    const foreignCard = cards.find((m) => readLifecycle(m)?.taskId === foreign);
    if (foreignCard === undefined) throw new Error('expected the foreign card');
    expect(readLifecycle(foreignCard)?.status).toBe('resolved');
  });
});

describe('seam 4 — lazy-hydration race (P2-3)', () => {
  let repo: InMemoryChatMessageRepository;

  beforeEach(() => {
    repo = new InMemoryChatMessageRepository();
    setChatMessageRepository(repo);
    resetThreads();
  });

  afterEach(() => {
    setChatMessageRepository(null);
  });

  it('patches the PERSISTED pending card when the peer thread is un-hydrated (no duplicate)', async () => {
    // A pending card was posted earlier and persisted to the repo...
    pendingCard(PEER);

    // ...then the peer chat is NEVER opened: clear the in-memory thread but keep
    // the repo (the lazy-hydration race). A naive in-memory scan would miss the
    // persisted card and post a DUPLICATE terminal card.
    await Promise.resolve(); // let the fire-and-forget persist settle
    setChatMessageRepository(null);
    resetThreads();
    setChatMessageRepository(repo);
    expect(getThread(PEER)).toHaveLength(0); // un-hydrated in memory

    const details: ServiceQueryEventDetails = {
      response_status: 'success',
      capability: 'availability_coordination',
      service_name: 'Sancho scheduling',
      result: { status: 'accepted', accepted_slots: [{ start: 'Tue 3pm' }] },
    };
    // The deliverer must hydrate the peer thread before the patch search.
    await deliverer()({ text: 'Tue 3pm works.', event: makeEvent(), task: makeTask(PEER), details });

    const cards = getThread(PEER).filter((m) => readLifecycle(m)?.kind === 'service_query');
    expect(cards).toHaveLength(1); // patched the persisted card — NOT a duplicate
    expect(readLifecycle(cards[0])?.status).toBe('resolved');
    expect(readLifecycle(cards[0])?.taskId).toBe(TASK_ID);
  });

  it('still posts exactly one fresh card when truly none exists (un-hydrated empty thread)', async () => {
    // No prior card anywhere — the response arrives first. Hydration finds
    // nothing, so a single fresh terminal card is the correct outcome.
    const details: ServiceQueryEventDetails = {
      response_status: 'success',
      capability: 'availability_coordination',
      service_name: 'Sancho scheduling',
      result: { status: 'accepted' },
    };
    await deliverer()({ text: 'done', event: makeEvent(), task: makeTask(PEER), details });
    // Re-open the chat (hydrate) — exactly one card, no phantom duplicate.
    await hydrateThread(PEER);
    const cards = getThread(PEER).filter((m) => readLifecycle(m)?.kind === 'service_query');
    expect(cards).toHaveLength(1);
    expect(readLifecycle(cards[0])?.status).toBe('resolved');
  });
});
