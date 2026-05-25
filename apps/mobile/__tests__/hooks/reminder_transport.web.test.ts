/**
 * Direct coverage for the WEB reminder transport seam
 * (`reminder_transport.web.ts`) — the fetch/SSE layer the SPA actually
 * runs. The server route is covered elsewhere (brain-server tests via
 * MockCoreClient); this pins the *browser* side: URL shapes, body
 * encoding, error surfacing, SSE frame parsing, and disposal.
 */

import {
  transportListPending,
  transportListByPersona,
  transportComplete,
  transportSnooze,
  transportDelete,
  watchFiredReminders,
} from '../../src/hooks/reminder_transport.web';

type FetchMock = jest.Mock<Promise<unknown>, [string, unknown?]>;

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
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  });
  afterEach(() => {
    delete (globalThis as unknown as { fetch?: unknown }).fetch;
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
  });

  it('listPending hits /pending with the now query, returns reminders', async () => {
    fetchMock.mockResolvedValue(okRes({ reminders: [{ id: 'r1' }] }));
    const out = await transportListPending(123);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/reminders/pending?now=123');
    expect(out).toEqual([{ id: 'r1' }]);
  });

  it('listPending omits now when undefined', async () => {
    fetchMock.mockResolvedValue(okRes({ reminders: [] }));
    await transportListPending();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/reminders/pending');
  });

  it('listByPersona URL-encodes the persona', async () => {
    fetchMock.mockResolvedValue(okRes({ reminders: [] }));
    await transportListByPersona('he/alth');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/reminders?persona=he%2Falth');
  });

  it('complete POSTs to /:id/complete and returns next', async () => {
    fetchMock.mockResolvedValue(okRes({ next: null }));
    const out = await transportComplete('rem 1');
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/reminders/rem%201/complete');
    expect((opts as { method: string }).method).toBe('POST');
    expect(out).toBeNull();
  });

  it('snooze sends snooze_ms in the body', async () => {
    fetchMock.mockResolvedValue(okRes({ reminder: { id: 'r1' } }));
    await transportSnooze('r1', 60_000);
    const [url, opts] = fetchMock.mock.calls[0]! as [string, { method: string; body: string }];
    expect(url).toBe('/api/v1/reminders/r1/snooze');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ snooze_ms: 60_000 });
  });

  it('delete issues DELETE and returns the deleted flag', async () => {
    fetchMock.mockResolvedValue(okRes({ deleted: true }));
    const out = await transportDelete('r1');
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/reminders/r1');
    expect((opts as { method: string }).method).toBe('DELETE');
    expect(out).toBe(true);
  });

  it('surfaces a non-ok response as an error with status + detail', async () => {
    fetchMock.mockResolvedValue(errRes(502, { error: 'core down' }));
    await expect(transportListPending()).rejects.toThrow(/502.*core down/);
  });
});

describe('reminder_transport.web — fired SSE stream', () => {
  afterEach(() => {
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
  });

  it('subscribes to /stream, parses fired frames, drops malformed, disposes', () => {
    const listeners: Record<string, (ev: { data: string }) => void> = {};
    const closeSpy = jest.fn();
    let openedUrl = '';
    class FakeEventSource {
      constructor(url: string) {
        openedUrl = url;
      }
      addEventListener(type: string, fn: (ev: { data: string }) => void): void {
        listeners[type] = fn;
      }
      close(): void {
        closeSpy();
      }
    }
    (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

    const fired: Array<{ id: string }> = [];
    const dispose = watchFiredReminders((r) => fired.push(r as { id: string }));

    expect(openedUrl).toBe('/api/v1/reminders/stream');

    listeners.fired!({ data: JSON.stringify({ id: 'r9', message: 'ring' }) });
    expect(fired).toEqual([{ id: 'r9', message: 'ring' }]);

    // Malformed frame is dropped, not thrown.
    expect(() => listeners.fired!({ data: 'not-json' })).not.toThrow();
    expect(fired).toHaveLength(1);

    dispose();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('is a no-op (no throw) when EventSource is unavailable (SSR/test env)', () => {
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
    const dispose = watchFiredReminders(() => {});
    expect(typeof dispose).toBe('function');
    expect(() => dispose()).not.toThrow();
  });
});
