/**
 * Brain's event streams are read through `fetch`, so they can carry the
 * owner device's signature (docs/A2A_GATEWAY_ARCHITECTURE.md §4.1). The
 * reader must parse Server-Sent Events as a browser's `EventSource` does
 * for Brain's streams, reconnect after a dropped connection, and stop after
 * an HTTP refusal.
 */

// The owner device: unsigned here (no key in a test), with its access-change
// subscription captured so a test can say "this browser just connected".
const ownerAccessListeners: (() => void)[] = [];
jest.mock('../../src/services/owner_device.web', () => ({
  loadOwnerSigner: async () => null,
  subscribeOwnerAccess: (listener: () => void) => {
    ownerAccessListeners.push(listener);
    return () => undefined;
  },
}));

import { brainEventStream, type BrainStreamEvent } from '../../src/services/web_runtime';
import { installBrainStreams, installCoreServedPage, streamDelivered } from '../setup/web_brain';

const ORIG_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

function listen(path = '/api/v1/notifications/stream') {
  const events: BrainStreamEvent[] = [];
  const stream = brainEventStream(path, (source) => {
    for (const type of ['message', 'appended', 'open', 'error'])
      source.addEventListener(type, (e) => events.push(e));
  });
  return { events, stream };
}

it('parses events split across chunks, CRLF lines, comments and multi-line data', async () => {
  installCoreServedPage(jest.fn());
  const streams = installBrainStreams();
  const { events, stream } = listen();
  await streamDelivered();
  const server = streams.latest();
  server?.write(': a comment\r\nevent: appe');
  server?.write('nded\r\ndata: line one\r\ndata: line two\r');
  server?.write('\n\r\ndata: plain\n\n');
  await streamDelivered();
  expect(events.map((e) => [e.type, e.data])).toEqual([
    ['open', ''],
    ['appended', 'line one\nline two'],
    ['message', 'plain'],
  ]);
  stream.close();
});

it('reconnects after a dropped connection, at the stream’s own retry', async () => {
  installCoreServedPage(jest.fn());
  const streams = installBrainStreams();
  const { events, stream } = listen();
  await streamDelivered();
  streams.latest()?.write('retry: 5\n\n');
  streams.latest()?.end();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(streams.opened).toHaveLength(2);
  expect(events.map((e) => e.type)).toEqual(['open', 'error', 'open']);
  stream.close();
  await streamDelivered();
  expect(streams.latest()?.closed).toBe(true);
});

it('after a refusal it waits, then tries again at once when this browser connects as the owner', async () => {
  installCoreServedPage(jest.fn());
  const streams = installBrainStreams();
  const served = globalThis.fetch;
  let refusals = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const accept = (init?.headers as Record<string, string> | undefined)?.accept;
    if (accept === 'text/event-stream' && refusals === 0) {
      refusals += 1;
      return new Response('{"error":"unauthenticated"}', { status: 401 });
    }
    return served(url, init);
  }) as typeof fetch;
  const { events, stream } = listen();
  await streamDelivered();
  // Refused: one error, no stream, and it has not given up (unlike EventSource).
  expect(events.map((e) => e.type)).toEqual(['error']);
  expect(streams.opened).toHaveLength(0);
  // The owner connects this browser: the stream tries again without waiting out the 2 s.
  for (const listener of ownerAccessListeners) listener();
  await streamDelivered();
  expect(streams.opened).toHaveLength(1);
  expect(events.map((e) => e.type)).toEqual(['error', 'open']);
  stream.close();
});

it('drops an open connection when owner access changes, and reconnects under the new identity', async () => {
  installCoreServedPage(jest.fn());
  const streams = installBrainStreams();
  const { events, stream } = listen();
  await streamDelivered();
  expect(streams.opened).toHaveLength(1);
  // This browser was disconnected (or connected anew) elsewhere in the tab.
  for (const listener of ownerAccessListeners) listener();
  await streamDelivered();
  expect(streams.opened[0]?.closed).toBe(true);
  expect(streams.opened).toHaveLength(2);
  expect(events.map((e) => e.type)).toEqual(['open', 'error', 'open']);
  stream.close();
  await streamDelivered();
  expect(streams.latest()?.closed).toBe(true);
});

it('a closed stream no longer reacts to owner access changes', async () => {
  installCoreServedPage(jest.fn());
  const streams = installBrainStreams();
  const { stream } = listen();
  await streamDelivered();
  stream.close();
  await streamDelivered();
  for (const listener of ownerAccessListeners) listener();
  await streamDelivered();
  expect(streams.opened).toHaveLength(1);
});

it('an access change while the request is being signed makes it sign again', async () => {
  installCoreServedPage(jest.fn());
  const streams = installBrainStreams();
  const { events, stream } = listen();
  // Fires before the first attempt reaches fetch (it awaits the address and the signer).
  for (const listener of ownerAccessListeners) listener();
  await streamDelivered();
  expect(streams.opened).toHaveLength(1);
  expect(events.map((e) => e.type)).toEqual(['error', 'open']);
  stream.close();
});
