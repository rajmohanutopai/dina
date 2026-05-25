/**
 * Reminder data transport — WEB peer (HTTP to the brain-server).
 *
 * In the browser the reminder store lives in core-server's process, not
 * the page, so the SPA can't read it in-process (that would hit an empty
 * browser-local store). Instead it calls the brain-server's
 * `/api/v1/reminders` API (same origin as the served bundle), which
 * proxies to core-server via its CoreClient. Same async surface as the
 * native peer (`reminder_transport.ts`) so `useReminders` is platform-
 * agnostic. Mirrors `chat_transport.web.ts`.
 */

import type { Reminder } from '@dina/core/reminders';

const BASE = '/api/v1/reminders';

async function parseError(res: Response): Promise<never> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: string };
    detail = typeof body.error === 'string' ? `: ${body.error}` : '';
  } catch {
    /* non-JSON body */
  }
  throw new Error(`reminders: ${res.status}${detail}`);
}

async function getReminders(url: string): Promise<Reminder[]> {
  const res = await fetch(url);
  if (!res.ok) return parseError(res);
  const body = (await res.json()) as { reminders?: Reminder[] };
  return Array.isArray(body.reminders) ? body.reminders : [];
}

export async function transportListPending(now?: number): Promise<Reminder[]> {
  const q = now !== undefined ? `/pending?now=${now}` : '/pending';
  return getReminders(`${BASE}${q}`);
}

export async function transportListByPersona(persona: string): Promise<Reminder[]> {
  return getReminders(`${BASE}?persona=${encodeURIComponent(persona)}`);
}

export async function transportComplete(id: string): Promise<Reminder | null> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) return parseError(res);
  const body = (await res.json()) as { next?: Reminder | null };
  return body.next ?? null;
}

// `now` is part of the shared signature for native test determinism; the
// server stamps its own clock, so the web peer ignores it.
export async function transportSnooze(
  id: string,
  snoozeMs: number,
  _now?: number,
): Promise<void> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}/snooze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ snooze_ms: snoozeMs }),
  });
  if (!res.ok) await parseError(res);
}

export async function transportDelete(id: string): Promise<boolean> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) return parseError(res);
  const body = (await res.json()) as { deleted?: boolean };
  return body.deleted === true;
}

/**
 * Watch for fired reminders — WEB peer. The server fires reminders and
 * pushes each as an SSE `fired` frame on `/api/v1/reminders/stream`; we
 * subscribe and invoke `onFired` per frame. (The browser must NOT fire
 * locally — its in-process store is empty and unreliable in the
 * background.) `tickMs` is ignored: cadence is the server's. Returns a
 * disposer that closes the stream.
 */
export function watchFiredReminders(
  onFired: (reminder: Reminder) => void,
  _tickMs?: number,
): () => void {
  // SSR/test-safe: EventSource only exists in the browser.
  if (typeof EventSource === 'undefined') return () => {};
  const es = new EventSource(`${BASE}/stream`);
  es.addEventListener('fired', (ev: MessageEvent<string>) => {
    try {
      onFired(JSON.parse(ev.data) as Reminder);
    } catch {
      /* drop a malformed frame */
    }
  });
  return () => es.close();
}

/** No-op on web — the in-process store the native peer resets doesn't
 *  exist in the browser. Present so the shared surface matches. */
export function transportReset(): void {
  /* no-op */
}
