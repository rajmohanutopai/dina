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
