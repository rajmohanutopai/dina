/**
 * The page as Core serves it (WEB_OWNER_SURFACE_PLAN §3.4): the first request
 * reads `/app/runtime-config.json`, which names Brain's origin, and every Brain
 * call then goes there cross-origin. Tests of the web transports install this
 * so they assert the real URLs rather than whatever a first mocked answer
 * happened to cache as the config.
 */

import { resetWebRuntimeConfig } from '../../src/services/web_runtime';

export const BRAIN = 'http://127.0.0.1:8200';

type Fetch = (url: string, init?: RequestInit) => Promise<unknown>;

/**
 * Install `fetch` answering the runtime config itself and passing every other
 * request to `brain` (a jest mock the test asserts on). Resets the page's
 * cached config so each test reads it afresh.
 */
export function installCoreServedPage(brain: Fetch): void {
  resetWebRuntimeConfig();
  (globalThis as unknown as { fetch: Fetch }).fetch = async (url, init) =>
    url === '/app/runtime-config.json'
      ? { ok: true, status: 200, json: async () => ({ served_by: 'core', brain_url: BRAIN }) }
      : brain(url, init);
}

/** Let the config promise settle (an event stream opens after it). */
export function configLoaded(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** One open Brain event stream, as the fake server holds it. */
export interface FakeBrainStream {
  url: string;
  headers: Record<string, string>;
  /** True once the page closed it (its request was aborted). */
  readonly closed: boolean;
  /** Send one event; `event` null sends a plain `message`. */
  send(event: string | null, data: string): void;
  /** Send raw stream text, exactly. */
  write(text: string): void;
  /** End the stream from the server side (the page then reconnects). */
  end(): void;
}

/**
 * Serve Brain's event streams (requests asking for `text/event-stream`) from
 * fakes the test drives, and pass every other request on to the fetch
 * installed before. Install after `installCoreServedPage`.
 */
export function installBrainStreams(): {
  opened: FakeBrainStream[];
  latest(): FakeBrainStream | null;
} {
  const opened: FakeBrainStream[] = [];
  const before = globalThis.fetch;
  const encoder = new TextEncoder();
  (globalThis as unknown as { fetch: Fetch }).fetch = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers.accept !== 'text/event-stream') return before(url, init);
    // As a real fetch: a signal already aborted fails the call at once.
    if (init?.signal?.aborted === true) throw new DOMException('aborted', 'AbortError');
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    let ended = false;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });
    const stop = (): void => {
      if (ended) return;
      ended = true;
      controller.close();
    };
    init?.signal?.addEventListener('abort', () => {
      closed = true;
      stop();
    });
    opened.push({
      url,
      headers,
      get closed() {
        return closed;
      },
      send: (event, data) => {
        if (!ended)
          controller.enqueue(
            encoder.encode(`${event === null ? '' : `event: ${event}\n`}data: ${data}\n\n`),
          );
      },
      write: (text) => {
        if (!ended) controller.enqueue(encoder.encode(text));
      },
      end: stop,
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { opened, latest: () => opened[opened.length - 1] ?? null };
}

/** Let a stream's reader take what the fake server sent. */
export async function streamDelivered(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
