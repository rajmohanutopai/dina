/**
 * The owner-only run/watch control client — WEB (round-A A-07, §12.5).
 *
 * In the web thin-client Core runs server-side, so the owner surface is
 * exercised over HTTP: this client calls the SAME-ORIGIN `/api/v1/run*` +
 * `/api/v1/watch*` routes (brain-server forwards them to Core as an opaque
 * byte-pipe) and presents the OWNER CAPABILITY the operator pasted in — the
 * credential CORE minted at boot (`owner_capability` in the vault dir, or
 * `DINA_OWNER_CAPABILITY`). Brain never holds it; Core validates every call
 * (timing-safe, run/watch surface only). Without a capability the surface
 * stays read-denied (Core answers 403) — fail closed.
 *
 * Storage: sessionStorage (per-tab, cleared on close) under
 * `dina.owner_capability`; a one-time prompt collects it lazily on the first
 * owner call. This is the lite DEV web surface — same trust posture as the
 * loopback-only `/api` gate it rides on.
 */

import type {
  OwnerRunClient,
  RunDecideRequest,
  RunListItem,
  RunStartRequest,
  RunStartResult,
  RunUpdateRequest,
  WatchCreateRequest,
  WatchCreateResult,
  WatchListItem,
} from '@dina/core';

const STORAGE_KEY = 'dina.owner_capability';

function resolveCapability(): string | null {
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (stored !== null && stored.trim() !== '') return stored.trim();
    const entered = window.prompt(
      'Owner capability (from core-server: vault dir owner_capability file or DINA_OWNER_CAPABILITY):',
    );
    if (entered !== null && entered.trim() !== '') {
      window.sessionStorage.setItem(STORAGE_KEY, entered.trim());
      return entered.trim();
    }
  } catch {
    /* no storage (SSR/test) → fall through to null */
  }
  return null;
}

let keySeq = 0;
function nextKey(): string {
  return `web-${Date.now().toString(36)}-${(++keySeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const capability = resolveCapability();
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(capability !== null ? { 'x-dina-owner-capability': capability } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    // A 403 usually means a wrong/stale capability — drop it so the next call
    // re-prompts instead of failing silently forever.
    if (res.status === 403) {
      try {
        window.sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
    }
    const detail = await res.text().catch(() => '');
    throw new Error(`owner ${method} ${path}: ${res.status} ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

const httpOwnerRunClient: OwnerRunClient = {
  runList: () => call<{ runs: RunListItem[] }>('GET', '/run/list'),
  runStart: (req: RunStartRequest) => call<RunStartResult>('POST', '/run/start', req),
  runPause: (runId) =>
    call<{ state: string }>('POST', `/run/${runId}/pause`, { idempotency_key: nextKey() }),
  runResume: (runId) =>
    call<{ state: string }>('POST', `/run/${runId}/resume`, { idempotency_key: nextKey() }),
  runStop: (runId, onStop) =>
    call<{ state: string }>('POST', `/run/${runId}/stop`, {
      idempotency_key: nextKey(),
      ...(onStop !== undefined ? { on_stop: onStop } : {}),
    }),
  runUpdate: (runId, req: RunUpdateRequest) =>
    call<{ config_version: number }>('POST', `/run/${runId}/update`, {
      idempotency_key: nextKey(),
      ...req,
    }),
  runDecide: (runId, req: RunDecideRequest) =>
    call<{ state: string; decision_revision: number }>('POST', `/run/${runId}/decide`, {
      idempotency_key: nextKey(),
      ...req,
    }),
  confirmRisk: (runId, messageId) =>
    call<{ state: string; authorized: boolean }>('POST', `/run/${runId}/confirm-risk`, {
      message_id: messageId,
      idempotency_key: nextKey(),
    }),
  skipLost: (runId, reservationId) =>
    call<{ reservation_id: string; state: string; fetch_resumed: boolean }>(
      'POST',
      `/run/${runId}/skip-lost`,
      { reservation_id: reservationId, idempotency_key: nextKey() },
    ),
  runStatus: (runId) => call<Record<string, unknown>>('GET', `/run/${runId}/status`),
  watchCreate: (req: WatchCreateRequest) => call<WatchCreateResult>('POST', '/watch/create', req),
  watchList: () => call<{ watches: WatchListItem[] }>('GET', '/watch/list'),
  watchPause: (watchId) => call<{ ok: boolean }>('POST', `/watch/${watchId}/pause`, {}),
  watchResume: (watchId) => call<{ ok: boolean }>('POST', `/watch/${watchId}/resume`, {}),
  watchCancel: (watchId) => call<{ ok: boolean }>('POST', `/watch/${watchId}/cancel`, {}),
};

let ownerRunClient: OwnerRunClient | null = null;

/** Boot MAY install an explicit client; the web default is the HTTP client. */
export function setOwnerRunClient(c: OwnerRunClient | null): void {
  ownerRunClient = c;
}

/** The owner UI hooks resolve it lazily — HTTP-backed by default on web. */
export function getOwnerRunClient(): OwnerRunClient | null {
  return ownerRunClient ?? httpOwnerRunClient;
}
