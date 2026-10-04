/**
 * Direct coverage for the WEB reminder transport seam
 * (`reminder_transport.web.ts`) — the fetch/SSE layer the SPA actually
 * runs. The server route is covered elsewhere (brain-server tests via
 * MockCoreClient); this pins the *browser* side: URL shapes, body
 * encoding, error surfacing, SSE frame parsing, and disposal. The page is
 * Core-served, so every call goes to Brain's origin cross-origin, without
 * credentials.
 */

import {
  transportListPending,
  transportListByPersona,
  transportComplete,
  transportSnooze,
  transportDelete,
  watchFiredReminders,
} from '../../src/hooks/reminder_transport.web';
import {
  BRAIN,
  configLoaded,
  installBrainStreams,
  installCoreServedPage,
  streamDelivered,
} from '../setup/web_brain';

type FetchMock = jest.Mock<Promise<unknown>, [string, unknown?]>;

/** The one request the call under test made to Brain. */
function onlyCall(mock: FetchMock): [string, unknown] {
  expect(mock.mock.calls).toHaveLength(1);
  const [url, opts] = mock.mock.calls[0] ?? ['', undefined];
  return [url, opts];
}

function okRes(body: unknown): unknown {
  return { ok: true, status: 200, json: async () => body };
}
function errRes(status: number, body: unknown): unknown {
  return { ok: false, status, json: async () => body };
}

describe('reminder_transport.web — fetch surface', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = jest.fn() as unknown as FetchMock;
    installCoreServedPage(fetchMock);
  });
  afterEach(() => {
    delete (globalThis as unknown as { fetch?: unknown }).fetch;
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
  });

  it('listPending hits /pending with the now query, returns reminders', async () => {
    fetchMock.mockResolvedValue(okRes({ reminders: [{ id: 'r1' }] }));
    const out = await transportListPending(123);
    expect(fetchMock).toHaveBeenCalledWith(`${BRAIN}/api/v1/reminders/pending?now=123`, {
      method: 'GET',
      headers: {},
      credentials: 'omit',
    });
    expect(out).toEqual([{ id: 'r1' }]);
  });

  it('listPending omits now when undefined', async () => {
    fetchMock.mockResolvedValue(okRes({ reminders: [] }));
    await transportListPending();
    expect(fetchMock).toHaveBeenCalledWith(`${BRAIN}/api/v1/reminders/pending`, {
      method: 'GET',
      headers: {},
      credentials: 'omit',
    });
  });

  it('listByPersona URL-encodes the persona', async () => {
    fetchMock.mockResolvedValue(okRes({ reminders: [] }));
    await transportListByPersona('he/alth');
    expect(fetchMock).toHaveBeenCalledWith(`${BRAIN}/api/v1/reminders?persona=he%2Falth`, {
      method: 'GET',
      headers: {},
      credentials: 'omit',
    });
  });

  it('complete POSTs to /:id/complete and returns next', async () => {
    fetchMock.mockResolvedValue(okRes({ next: null }));
    const out = await transportComplete('rem 1');
    const [url, opts] = onlyCall(fetchMock);
    expect(url).toBe(`${BRAIN}/api/v1/reminders/rem%201/complete`);
    expect((opts as { method: string }).method).toBe('POST');
    expect(out).toBeNull();
  });

  it('snooze sends snooze_ms in the body', async () => {
    fetchMock.mockResolvedValue(okRes({ reminder: { id: 'r1' } }));
    await transportSnooze('r1', 60_000);
    const [url, opts] = onlyCall(fetchMock) as [string, { method: string; body: string }];
    expect(url).toBe(`${BRAIN}/api/v1/reminders/r1/snooze`);
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ snooze_ms: 60_000 });
  });

  it('delete issues DELETE and returns the deleted flag', async () => {
    fetchMock.mockResolvedValue(okRes({ deleted: true }));
    const out = await transportDelete('r1');
    const [url, opts] = onlyCall(fetchMock);
    expect(url).toBe(`${BRAIN}/api/v1/reminders/r1`);
    expect((opts as { method: string }).method).toBe('DELETE');
    expect(out).toBe(true);
  });

  it('surfaces a non-ok response as an error with status + detail', async () => {
    fetchMock.mockResolvedValue(errRes(502, { error: 'core down' }));
    await expect(transportListPending()).rejects.toThrow(/502.*core down/);
  });
});

describe('reminder_transport.web — fired event stream', () => {
  let streams: ReturnType<typeof installBrainStreams>;
  beforeEach(() => {
    installCoreServedPage(jest.fn());
    streams = installBrainStreams();
  });

  it('subscribes to /stream, parses fired frames, drops malformed, disposes', async () => {
    const fired: { id: string }[] = [];
    const dispose = watchFiredReminders((r) => fired.push(r as { id: string }));
    await streamDelivered();

    const stream = streams.latest();
    expect(stream?.url).toBe(`${BRAIN}/api/v1/reminders/stream`);
    stream?.send('fired', JSON.stringify({ id: 'r9', message: 'ring' }));
    await streamDelivered();
    expect(fired).toEqual([{ id: 'r9', message: 'ring' }]);

    // A malformed frame is dropped, not thrown.
    stream?.send('fired', 'not-json');
    await streamDelivered();
    expect(fired).toHaveLength(1);

    dispose();
    await streamDelivered();
    expect(stream?.closed).toBe(true);
  });

  it('disposed before Brain’s address is known: the stream never opens', async () => {
    const dispose = watchFiredReminders(jest.fn());
    dispose();
    await streamDelivered();
    expect(streams.opened).toHaveLength(0);
  });
});
