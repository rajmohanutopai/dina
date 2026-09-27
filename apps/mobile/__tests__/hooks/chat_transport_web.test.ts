/**
 * Web chat-transport contract test.
 *
 * Pins the dual-channel contract of `chat_transport.web.ts`:
 *
 *   1. POST `/api/v1/chat` with `{ text, threadId }` — fire-and-forget
 *      kick to the orchestrator. Body returned for callers that want
 *      the orchestrator's ChatResponse programmatically; surface error
 *      envelopes as thrown errors.
 *   2. Open an EventSource on `/api/v1/chat/stream?threadId=X` — every
 *      ChatMessage the brain-side thread store emits is mirrored into
 *      the local browser-side store via `applyRemoteMessage`, which is
 *      what `useLiveThread` re-renders against.
 *
 * The two channels together replace the old "POST + local-mirror in
 * the response handler" path. Local rendering is now driven entirely
 * by SSE events, which mirrors mobile's in-process `subscribeToThread`
 * model — placeholder bubbles, late-arriving lifecycle patches, and
 * the synchronous fast-path response all flow through the same stream.
 *
 * The page is Core-served, so both channels go to Brain's origin
 * cross-origin (WEB_OWNER_SURFACE_PLAN §3.4).
 *
 * Source: docs/HOME_NODE_LITE_WEB_UI_TASKS.md — SSE chat delivery.
 */

import {
  applyRemoteMessage,
  getThread,
  resetThreads,
  type ChatMessage,
  type ChatResponse,
} from '@dina/brain/chat';

import {
  closeChatStream,
  openChatStream,
  runChatTurn,
} from '../../src/hooks/chat_transport.web';
import { BRAIN, configLoaded, installCoreServedPage } from '../setup/web_brain';

const ORIG_FETCH = globalThis.fetch;
let lastRequest: { url: string; init: RequestInit | undefined } | null = null;

// --- EventSource stub --------------------------------------------------------
// jsdom doesn't ship EventSource. We stub the smallest surface the
// transport touches and capture the open instance so each test can
// drive the "server" by hand.

interface StubEventSourceLike {
  url: string;
  close(): void;
  emitMessage(data: string): void;
  emitError(): void;
}

const openedSources: StubEventSourceLike[] = [];
/** The most recently opened stream, or null before any opened. */
function latest(): StubEventSourceLike | null {
  return openedSources[openedSources.length - 1] ?? null;
}
const ORIG_EVENT_SOURCE = (globalThis as { EventSource?: unknown }).EventSource;

class StubEventSource implements StubEventSourceLike {
  url: string;
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};
  private closed = false;

  constructor(url: string) {
    this.url = url;
    openedSources.push(this);
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    const arr = this.listeners[type];
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx !== -1) arr.splice(idx, 1);
  }

  close(): void {
    this.closed = true;
    this.listeners = {};
  }

  emitMessage(data: string): void {
    if (this.closed) return;
    const ev = { data } as unknown;
    for (const fn of this.listeners['message'] ?? []) fn(ev);
  }

  emitError(): void {
    if (this.closed) return;
    for (const fn of this.listeners['error'] ?? []) fn({});
  }
}

function mockFetch(response: { status: number; body: unknown }): void {
  installCoreServedPage(async (url, init) => {
    lastRequest = { url, init };
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function plainChatResponse(text: string, intent = 'PLAIN'): ChatResponse {
  return {
    intent: intent as ChatResponse['intent'],
    response: text,
    sources: [],
    messageId: 'srv-msg-1',
    typed: { kind: 'plain', text },
  } as ChatResponse;
}

function serverChatMessage(
  threadId: string,
  type: ChatMessage['type'],
  content: string,
  opts?: Partial<ChatMessage>,
): ChatMessage {
  return {
    id: `srv-${type}-${Math.random().toString(36).slice(2, 8)}`,
    threadId,
    type,
    content,
    timestamp: Date.now(),
    ...opts,
  };
}

beforeEach(() => {
  resetThreads();
  lastRequest = null;
  openedSources.length = 0;
  (globalThis as { EventSource?: unknown }).EventSource = StubEventSource;
  mockFetch({ status: 200, body: {} });
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  if (ORIG_EVENT_SOURCE === undefined) {
    delete (globalThis as { EventSource?: unknown }).EventSource;
  } else {
    (globalThis as { EventSource?: unknown }).EventSource = ORIG_EVENT_SOURCE;
  }
  closeChatStream('thread-x');
  closeChatStream('main');
  closeChatStream('thread-stream');
});

describe('chat_transport.web — POST contract', () => {
  it('POSTs text + threadId to /api/v1/chat as JSON', async () => {
    mockFetch({ status: 200, body: plainChatResponse('ok') });
    await runChatTurn('hello', 'thread-x');
    expect(lastRequest).not.toBeNull();
    expect(lastRequest?.url).toBe(`${BRAIN}/api/v1/chat`);
    expect(lastRequest?.init?.method).toBe('POST');
    expect(lastRequest?.init?.credentials).toBe('omit');
    expect((lastRequest?.init?.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
    expect(JSON.parse(lastRequest?.init?.body as string)).toEqual({
      text: 'hello',
      threadId: 'thread-x',
    });
  });

  it('returns the orchestrator ChatResponse verbatim', async () => {
    const body = plainChatResponse('roger', 'PLAIN');
    mockFetch({ status: 200, body });
    const result = await runChatTurn('hi', 'main');
    expect(result).toEqual(body);
  });

  it('throws with the server error message when /api/v1/chat returns 4xx', async () => {
    mockFetch({ status: 400, body: { error: 'text must be a non-empty string' } });
    await expect(runChatTurn('', 'main')).rejects.toThrow('text must be a non-empty string');
  });

  it('throws a status-based message when the error body isnt JSON', async () => {
    installCoreServedPage(async () => new Response('Internal Server Error', { status: 500 }));
    await expect(runChatTurn('hi', 'main')).rejects.toThrow(/HTTP 500/);
  });
});

describe('chat_transport.web — SSE contract', () => {
  it('opens an EventSource on /api/v1/chat/stream with the threadId', async () => {
    mockFetch({ status: 200, body: plainChatResponse('ok') });
    await runChatTurn('hello', 'thread-stream');
    expect(latest()).not.toBeNull();
    expect(latest()?.url).toBe(`${BRAIN}/api/v1/chat/stream?threadId=thread-stream`);
  });

  it('reuses the same EventSource across calls on the same thread', async () => {
    mockFetch({ status: 200, body: plainChatResponse('ok') });
    await runChatTurn('one', 'thread-x');
    const first = latest();
    await runChatTurn('two', 'thread-x');
    // No new EventSource was constructed for the second call.
    expect(latest()).toBe(first);
  });

  it('ref-counts open/close: a second consumer unmounting does NOT tear down the stream', async () => {
    // Two mounted consumers (e.g. a duplicate/hidden route) open the same thread.
    openChatStream('thread-x');
    openChatStream('thread-x');
    await configLoaded();
    const es = latest();
    expect(es).not.toBeNull();

    // One unmounts — the stream MUST stay open for the still-active view: a
    // pushed message is still mirrored (the stub no-ops emit once closed).
    closeChatStream('thread-x');
    es?.emitMessage(JSON.stringify(serverChatMessage('thread-x', 'dina', 'still live')));
    expect(getThread('thread-x')).toHaveLength(1);

    // The LAST consumer unmounts — now the stream is torn down; a further push
    // is ignored (proves it actually closed at ref-count 0).
    closeChatStream('thread-x');
    es?.emitMessage(JSON.stringify(serverChatMessage('thread-x', 'dina', 'after close')));
    expect(getThread('thread-x')).toHaveLength(1);
  });

  it('a view that unmounts before Brain’s address is known opens no stream', async () => {
    openChatStream('thread-x');
    closeChatStream('thread-x');
    await configLoaded();
    expect(latest()).toBeNull();
  });

  it('mirrors server-pushed user + dina messages into the local thread store', async () => {
    mockFetch({ status: 200, body: plainChatResponse('ack', 'REMEMBER') });
    await runChatTurn('/remember Emma loves dinosaurs', 'main');

    // Server emits the two messages handleChat would have written. The user
    // message is the CLEAN payload + the mode in metadata (no slash prefix) —
    // docs/COMPOSER_MODES_DESIGN.md section 7.1. Mirroring must preserve both,
    // so the web SPA renders the clean bubble + a mode chip, just like mobile.
    latest()?.emitMessage(
      JSON.stringify(
        serverChatMessage('main', 'user', 'Emma loves dinosaurs', { metadata: { mode: 'remember' } }),
      ),
    );
    latest()?.emitMessage(
      JSON.stringify(serverChatMessage('main', 'dina', 'Got it — saved to your vault.')),
    );

    const msgs = getThread('main');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({
      type: 'user',
      content: 'Emma loves dinosaurs',
      metadata: { mode: 'remember' },
    });
    expect(msgs[1]).toMatchObject({ type: 'dina', content: 'Got it — saved to your vault.' });
  });

  it('preserves server-assigned message IDs (lifecycle patches need them)', async () => {
    mockFetch({ status: 200, body: plainChatResponse('ok') });
    await runChatTurn('hi', 'thread-x');

    const srvMsg = serverChatMessage('thread-x', 'dina', 'first version', {
      id: 'srv-fixed-id',
    });
    latest()?.emitMessage(JSON.stringify(srvMsg));

    const after = getThread('thread-x');
    expect(after.find((m) => m.id === 'srv-fixed-id')).toBeDefined();
  });

  it('replaces existing messages when the server re-emits with the same id', async () => {
    mockFetch({ status: 200, body: plainChatResponse('ok') });
    await runChatTurn('hi', 'thread-x');

    const placeholder = serverChatMessage('thread-x', 'dina', "Working on it…", {
      id: 'srv-ask-1',
    });
    latest()?.emitMessage(JSON.stringify(placeholder));
    const patched = serverChatMessage('thread-x', 'dina', 'Final answer.', {
      id: 'srv-ask-1',
    });
    latest()?.emitMessage(JSON.stringify(patched));

    const msgs = getThread('thread-x');
    expect(msgs.filter((m) => m.id === 'srv-ask-1')).toHaveLength(1);
    expect(msgs.find((m) => m.id === 'srv-ask-1')?.content).toBe('Final answer.');
  });

  it('ignores messages whose threadId does not match the subscribed thread', async () => {
    mockFetch({ status: 200, body: plainChatResponse('ok') });
    await runChatTurn('hi', 'thread-x');

    latest()?.emitMessage(
      JSON.stringify(serverChatMessage('OTHER-THREAD', 'user', 'foo')),
    );
    expect(getThread('thread-x')).toHaveLength(0);
    expect(getThread('OTHER-THREAD')).toHaveLength(0);
  });

  it('silently drops malformed SSE frames', async () => {
    mockFetch({ status: 200, body: plainChatResponse('ok') });
    await runChatTurn('hi', 'thread-x');

    latest()?.emitMessage('not-json');
    latest()?.emitError(); // also tolerated

    expect(getThread('thread-x')).toHaveLength(0);
  });
});

describe('applyRemoteMessage (thread-store primitive)', () => {
  // Sanity: the thread-store helper itself behaves the same on web as
  // in mobile tests. Lite's SPA leans on these semantics for every
  // SSE frame, so a regression here would silently break delivery.

  it('inserts a new message at the tail when timestamps are monotonic', () => {
    applyRemoteMessage(serverChatMessage('t', 'user', 'a', { id: 'm1', timestamp: 1 }));
    applyRemoteMessage(serverChatMessage('t', 'dina', 'b', { id: 'm2', timestamp: 2 }));
    expect(getThread('t').map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('inserts an out-of-order message in timestamp position', () => {
    applyRemoteMessage(serverChatMessage('t', 'user', 'a', { id: 'm1', timestamp: 10 }));
    applyRemoteMessage(serverChatMessage('t', 'dina', 'c', { id: 'm3', timestamp: 30 }));
    applyRemoteMessage(serverChatMessage('t', 'system', 'b', { id: 'm2', timestamp: 20 }));
    expect(getThread('t').map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('replaces in place when id collides', () => {
    applyRemoteMessage(serverChatMessage('t', 'dina', 'first', { id: 'fixed' }));
    applyRemoteMessage(serverChatMessage('t', 'dina', 'second', { id: 'fixed' }));
    const msgs = getThread('t');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('second');
  });
});
