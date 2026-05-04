/**
 * useLiveThread — the hook that the Chat tab uses to bridge Brain's
 * thread store to React state.
 *
 * This suite covers the runtime bridge: proof that (a) the user's
 * `send()` routes through Brain's handleChat, (b) thread-store
 * subscribers see every write, including async ones
 * (workflow-event replies via `addDinaResponse`).
 *
 * Test strategy: we can't render React here (jest-expo config runs
 * plain-Node). We exercise the hook's module-level contract: the
 * orchestrator receives what the user typed, and a subscription fires
 * on every thread write. This is what the rendered component
 * depends on — if these invariants hold, the screen updates.
 */

import {
  resetAskCommandHandler,
  resetServiceCommandHandler,
  resetServiceApproveCommandHandler,
  resetServiceDenyCommandHandler,
  setAskCommandHandler,
} from '../../../brain/src/chat/orchestrator';
import {
  resetThreads,
  subscribeToThread,
  addDinaResponse,
  getThread,
} from '../../../brain/src/chat/thread';
import { sendMessage } from '../../src/hooks/useChatThread';

const THREAD = 'main';

beforeEach(() => {
  resetThreads();
  resetAskCommandHandler();
  resetServiceCommandHandler();
  resetServiceApproveCommandHandler();
  resetServiceDenyCommandHandler();
});

describe('useLiveThread bridge — sendMessage routes through Brain', () => {
  it('calls handleChat and persists user + Dina messages to the thread', async () => {
    // A live /ask handler lets handleChat produce a real reply.
    setAskCommandHandler(async (question) => ({
      response: `answer to: ${question}`,
      sources: [],
    }));
    await sendMessage('/ask what is the capital of France?', THREAD);
    const messages = getThread(THREAD);
    // Thread must carry BOTH the user's message and Dina's synchronous
    // reply — this is what the Chat screen renders.
    const types = messages.map((m) => m.type);
    expect(types).toContain('user');
    expect(types).toContain('dina');
    const userMsg = messages.find((m) => m.type === 'user');
    const dinaMsg = messages.find((m) => m.type === 'dina');
    expect(userMsg?.content).toBe('/ask what is the capital of France?');
    expect(dinaMsg?.content).toBe('answer to: what is the capital of France?');
  });
});

describe('thread-store subscription — async arrivals surface on-screen', () => {
  it('fires subscribers on addDinaResponse (WorkflowEventConsumer delivery path)', () => {
    // This is the seam the bus-driver async reply flows through:
    // WorkflowEventConsumer.deliver → addDinaResponse → our subscriber
    // → React setState → re-render. Without the subscription API, the
    // async reply sat in the thread store and was never visible.
    const observed: string[] = [];
    const unsubscribe = subscribeToThread(THREAD, (msg) => {
      observed.push(`${msg.type}:${msg.content}`);
    });
    addDinaResponse(THREAD, 'Bus 42 — 45 min to Castro', ['task-1']);
    addDinaResponse(THREAD, 'Another async update', ['task-2']);
    expect(observed).toEqual(['dina:Bus 42 — 45 min to Castro', 'dina:Another async update']);
    unsubscribe();
    addDinaResponse(THREAD, 'After unsubscribe', []);
    expect(observed).toHaveLength(2); // unsubscribe works
  });

  it('isolates subscriber errors — a throwing listener does not break other subscribers or writes', () => {
    const observed: string[] = [];
    subscribeToThread(THREAD, () => {
      throw new Error('broken');
    });
    subscribeToThread(THREAD, (msg) => observed.push(msg.content));
    // The write itself must still complete, and the non-throwing
    // subscriber must still be called.
    addDinaResponse(THREAD, 'survive the throw', []);
    expect(observed).toEqual(['survive the throw']);
  });
});
