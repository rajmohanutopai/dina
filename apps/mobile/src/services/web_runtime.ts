/**
 * The page's way to Brain (WEB_OWNER_SURFACE_PLAN §3.4): every Brain call
 * goes cross-origin to the address the runtime config names, and carries
 * the owner device's signature (Brain serves no unsigned caller:
 * docs/A2A_GATEWAY_ARCHITECTURE.md §4.1, plan §3.18). Used by the browser
 * build only (`*.web.ts` modules).
 */

import { signRequestWith } from '@dina/core';

import { loadOwnerSigner, subscribeOwnerAccess } from './owner_device.web';
import { loadWebRuntimeConfig } from './web_runtime_config';

export {
  RUNTIME_CONFIG_PATH,
  loadWebRuntimeConfig,
  resetWebRuntimeConfig,
  type WebRuntimeConfig,
} from './web_runtime_config';

/** Brain's URL for an `/api/...` path, as this page must reach it. */
export async function brainUrl(path: string): Promise<string> {
  return `${(await loadWebRuntimeConfig()).brainUrl}${path}`;
}

/**
 * The path and query Brain will see for `url`, as the browser sends it: the
 * WHATWG serialisation (`'` in a query becomes `%27`, and so on), which is
 * what Brain checks the signature against. Signing the caller's raw string
 * would fail for any character the browser rewrites.
 */
function wireParts(url: string): { path: string; query: string } {
  const parsed = new URL(url, globalThis.location?.href ?? 'http://localhost/');
  return { path: parsed.pathname, query: parsed.search.slice(1) };
}

/** The bytes of a request body as sent. Brain's API takes JSON text only. */
function bodyBytes(body: RequestInit['body']): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array();
  if (typeof body === 'string') return new TextEncoder().encode(body);
  throw new TypeError('brainFetch: a Brain request body must be a string');
}

/** A caller's headers as a plain record (what every Brain caller passes). */
function headerRecord(headers: RequestInit['headers']): Record<string, string> {
  if (headers === undefined) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

/**
 * The owner device's signature headers for one Brain request, or none when
 * this browser is not connected as the owner's device (Brain then refuses
 * the call: the page asks the owner to connect it).
 */
async function signedHeaders(
  method: string,
  url: string,
  body: Uint8Array,
): Promise<Record<string, string>> {
  const signer = await loadOwnerSigner();
  if (signer === null) return {};
  const { path, query } = wireParts(url);
  return { ...(await signRequestWith(method, path, query, body, signer)) };
}

/** Sign and send one request to a Brain URL. */
async function signedFetch(url: string, init: RequestInit): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {
    ...headerRecord(init.headers),
    ...(await signedHeaders(method, url, bodyBytes(init.body))),
  };
  return fetch(url, { ...init, method, headers, credentials: 'omit' });
}

/**
 * `fetch` against Brain's API, signed by the owner device. Brain holds no
 * cookies or sessions, and a cross-origin call must not offer any, so
 * credentials are always omitted.
 */
export async function brainFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return signedFetch(await brainUrl(path), init);
}

/**
 * The same, for a module handed a full Brain URL rather than a path (the
 * PeerLens screens read through Brain's AppView proxy, `appViewBase()`).
 * Shaped as `fetch`, so it can be given to a client that takes one.
 */
export const brainUrlFetch: typeof fetch = (input, init) => {
  if (input instanceof Request) throw new TypeError('brainUrlFetch: pass a URL, not a Request');
  return signedFetch(String(input), init ?? {});
};

/** One event as a Brain stream delivers it; `data` is the event's text. */
export interface BrainStreamEvent {
  type: string;
  data: string;
}

/** The listener side of a Brain event stream, as `attach` sees it. */
export interface BrainEventSource {
  addEventListener(type: string, listener: (event: BrainStreamEvent) => void): void;
}

export interface BrainEventStream {
  close(): void;
}

/**
 * Every open stream's reaction to a change in this browser's owner access
 * (connected, disconnected, replaced): it drops its connection or ends its
 * wait and connects again, under the identity it now has.
 */
const accessListeners = new Set<() => void>();
let watchingOwnerAccess = false;

function watchOwnerAccess(): void {
  if (watchingOwnerAccess) return;
  watchingOwnerAccess = true;
  subscribeOwnerAccess(() => {
    for (const listener of [...accessListeners]) listener();
  });
}

/** Wait `ms`, or less when `signal` aborts or `wake` fires first; never leaves a timer behind. */
function pause(ms: number, signal: AbortSignal, wake: { now: (() => void) | null }): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      wake.now = null;
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
    wake.now = done;
  });
}

/** Wait this long before reconnecting, unless the stream names its own `retry:`. */
const DEFAULT_RETRY_MS = 2000;
/** The longest wait after Brain refuses the stream; it doubles up to this. */
const MAX_REFUSED_WAIT_MS = 60_000;

/**
 * Open a signed event stream on Brain (Server-Sent Events read through
 * `fetch`: a browser's `EventSource` cannot send the signature headers).
 * It behaves as `EventSource` does for Brain's streams: `open` on each
 * connect, named and `message` events as they arrive, `error` when the
 * connection drops, then a fresh signed reconnect after the stream's
 * `retry:` (2 s by default).
 *
 * One departure, on purpose: `EventSource` gives up after an HTTP refusal,
 * but here a refusal is often brief (a browser not yet connected as the
 * owner's device, a Brain that cannot reach Core for a moment). So a
 * refused stream tries again after a wait that doubles up to a minute, and
 * at once when this browser's owner access changes. An access change also
 * drops an open connection, so a browser that disconnects stops receiving
 * and one that connects reconnects as the owner's device. The handle comes back
 * at once; `close()` works before or after the stream opens, and a stream
 * closed first never opens.
 */
export function brainEventStream(
  path: string,
  attach: (source: BrainEventSource) => void,
): BrainEventStream {
  const listeners = new Map<string, Set<(event: BrainStreamEvent) => void>>();
  const emit = (type: string, data = ''): void => {
    for (const listener of listeners.get(type) ?? []) listener({ type, data });
  };
  attach({
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
  });
  const controller = new AbortController();
  let retryMs = DEFAULT_RETRY_MS;

  const readStream = async (body: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = '';
    let data: string[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.search(/\r\n|\n|\r/);
      // A lone \r at the end may be half of a \r\n split across chunks.
      while (nl !== -1 && !(buffer[nl] === '\r' && nl === buffer.length - 1)) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer.startsWith('\r\n', nl) ? 2 : 1));
        if (line === '') {
          if (data.length > 0) emit(event === '' ? 'message' : event, data.join('\n'));
          event = '';
          data = [];
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          let text = colon === -1 ? '' : line.slice(colon + 1);
          if (text.startsWith(' ')) text = text.slice(1);
          if (field === 'event') event = text;
          else if (field === 'data') data.push(text);
          else if (field === 'retry' && /^\d+$/.test(text)) retryMs = Number(text);
        }
        nl = buffer.search(/\r\n|\n|\r/);
      }
    }
  };

  let refusedWaitMs = 0;
  // The current attempt, from signing to the stream's end (aborted on close,
  // or by an access change so the next attempt signs as the new identity),
  // and the current wait's early-wake hook.
  let connection: AbortController | null = null;
  const wake: { now: (() => void) | null } = { now: null };
  // Set by an access change that cut an attempt short: try again without a wait.
  let reconnectNow = false;
  const onAccessChange = (): void => {
    refusedWaitMs = 0;
    if (connection !== null) {
      reconnectNow = true;
      connection.abort();
    }
    wake.now?.();
  };
  controller.signal.addEventListener('abort', () => {
    connection?.abort();
    accessListeners.delete(onAccessChange);
  });
  const run = async (): Promise<void> => {
    watchOwnerAccess();
    accessListeners.add(onAccessChange);
    while (!controller.signal.aborted) {
      let refused = false;
      connection = new AbortController();
      try {
        const url = await brainUrl(path);
        const headers = {
          accept: 'text/event-stream',
          ...(await signedHeaders('GET', url, new Uint8Array())),
        };
        // Closed while the address or the signature was on its way.
        if (controller.signal.aborted) return;
        // Signed before an access change: an aborted signal fails the fetch at once.
        const res = await fetch(url, { headers, credentials: 'omit', signal: connection.signal });
        if (!res.ok || res.body === null) {
          refused = true;
        } else {
          refusedWaitMs = 0;
          emit('open');
          await readStream(res.body);
        }
      } catch {
        /* the connection dropped or never opened: say so and try again */
      }
      connection = null;
      if (controller.signal.aborted) return;
      emit('error');
      if (reconnectNow) {
        reconnectNow = false;
      } else if (refused) {
        refusedWaitMs = Math.min(Math.max(retryMs, refusedWaitMs * 2), MAX_REFUSED_WAIT_MS);
        await pause(refusedWaitMs, controller.signal, wake);
      } else {
        await pause(retryMs, controller.signal, wake);
      }
    }
  };
  void run();
  return { close: () => controller.abort() };
}
