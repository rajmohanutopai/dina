/**
 * What the page learns from the host that served it (WEB_OWNER_SURFACE_PLAN
 * §3.2, §3.4). Used by the browser build only (`*.web.ts` modules).
 *
 * Core serves `/app/runtime-config.json` beside the app. Its presence says the
 * page came from CORE's origin, which is the only origin where the owner may
 * connect this browser as a device: a page Brain serves must never ask for the
 * owner key. It also names Brain's address, because the page reaches Brain
 * cross-origin, never through Core. A page with no such file (a static
 * server, a dev preview) is not Core-served: it offers no owner connection and
 * reaches Brain on its own origin.
 */

export interface WebRuntimeConfig {
  /** True only when Core served this page. */
  servedByCore: boolean;
  /** Prefix for Brain's HTTP API: an absolute origin, or `''` for the page's own origin. */
  brainUrl: string;
}

export const RUNTIME_CONFIG_PATH = '/app/runtime-config.json';

let loading: Promise<WebRuntimeConfig> | null = null;

export function loadWebRuntimeConfig(): Promise<WebRuntimeConfig> {
  loading ??= (async () => {
    try {
      const res = await fetch(RUNTIME_CONFIG_PATH, { credentials: 'omit', cache: 'no-store' });
      if (!res.ok) return { servedByCore: false, brainUrl: '' };
      const body = (await res.json()) as { served_by?: unknown; brain_url?: unknown };
      const brainUrl = typeof body.brain_url === 'string' ? body.brain_url.replace(/\/+$/, '') : '';
      return { servedByCore: body.served_by === 'core', brainUrl };
    } catch {
      return { servedByCore: false, brainUrl: '' };
    }
  })();
  return loading;
}

/** Brain's URL for an `/api/...` path, as this page must reach it. */
export async function brainUrl(path: string): Promise<string> {
  return `${(await loadWebRuntimeConfig()).brainUrl}${path}`;
}

/**
 * `fetch` against Brain's API. Brain holds no cookies or sessions, and a
 * cross-origin call must not offer any, so credentials are always omitted.
 */
export async function brainFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(await brainUrl(path), { ...init, credentials: 'omit' });
}

export interface BrainEventStream {
  close(): void;
}

/**
 * Open an event stream on Brain. Brain's address is known only once the
 * runtime config has loaded, so the stream opens a moment later; the handle
 * comes back at once and `close()` works before or after it opens (a stream
 * closed first never opens). `attach` adds the listeners when it does.
 */
export function brainEventStream(
  path: string,
  attach: (source: EventSource) => void,
): BrainEventStream {
  let closed = false;
  let source: EventSource | null = null;
  void brainUrl(path).then((url) => {
    if (closed) return;
    source = new EventSource(url);
    attach(source);
  });
  return {
    close: () => {
      closed = true;
      source?.close();
      source = null;
    },
  };
}

/** Tests only: forget the loaded config. */
export function resetWebRuntimeConfig(): void {
  loading = null;
}
