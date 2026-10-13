/**
 * Helpers for part 2 of the real-life scenarios (docs/REAL_LIFE_SCENARIOS_2.md).
 */

import { Agent, type ChatMessage, type Dina } from '../client';

import type { Ctx, Scenario } from '../scenario';

/** Store a fact the way the owner does. */
export async function remember(c: Ctx, text: string): Promise<string> {
  return (await c.say(c.alonso, `/remember ${text}`)).reply;
}

/** Ask in a thread of its own (a fresh conversation) unless one is named. */
export async function ask(c: Ctx, text: string, thread = 'ask', timeoutMs?: number): Promise<string> {
  return (await c.say(c.alonso, text, { thread: c.thread(thread), ...(timeoutMs !== undefined ? { timeoutMs } : {}) })).reply;
}

/** Peer messages `to` receives in `ms` from now (main thread). */
export async function peerMessages(to: Dina, ms: number, run: () => Promise<unknown> = async () => undefined): Promise<ChatMessage[]> {
  const watch = to.watch('main');
  await watch.opened();
  const before = new Set(watch.messages.keys());
  try {
    await run();
    await new Promise((r) => setTimeout(r, ms));
    return [...watch.messages.values()].filter((m) => !before.has(m.id) && m.metadata?.source === 'd2d');
  } finally {
    watch.close();
  }
}

/** Wait until `to` receives a peer message matching `pattern`. */
export async function peerMessage(to: Dina, pattern: RegExp, ms: number, run: () => Promise<unknown>): Promise<ChatMessage | undefined> {
  const watch = to.watch('main');
  await watch.opened();
  const before = new Set(watch.messages.keys());
  try {
    await run();
    return await watch
      .waitFor((msgs) => msgs.find((m) => !before.has(m.id) && m.metadata?.source === 'd2d' && pattern.test(m.content)), ms, `a message matching ${pattern}`)
      .catch(() => undefined);
  } finally {
    watch.close();
  }
}

/**
 * Ask Dina to message `to`, then confirm the draft the way the owner would
 * (a message Dina words herself waits in Approvals). Returns Dina's reply and
 * whether a draft was confirmed.
 */
export async function askAndConfirm(c: Ctx, text: string, to: Dina): Promise<{ reply: string; confirmed: boolean }> {
  const reply = await ask(c, text);
  const card = (await c.alonso.tasks('approval', 'pending_approval')).find((t) => String(t.payload ?? '').includes(to.did));
  if (card !== undefined) await c.alonso.core('POST', `/v1/workflow/tasks/${card.id}/approve`, { body: {} });
  return { reply, confirmed: card !== undefined };
}

/** Make a contact, optionally the preferred one for some roles. */
export async function contact(d: Dina, did: string, name: string, preferredFor?: string[]): Promise<void> {
  await d.addContact(did, name);
  // One Dina may play several people across stories: rename it each time.
  const r = await d.core('PUT', `/v1/contacts/${encodeURIComponent(did)}`, { body: { display_name: name, ...(preferredFor !== undefined ? { preferred_for: preferredFor } : {}) } });
  if (r.status >= 300) throw new Error(`${d.name}: update contact ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
}

/** Remove a contact if present (strangers must stay strangers). */
export async function unContact(d: Dina, did: string): Promise<void> {
  await d.core('DELETE', `/v1/contacts/${encodeURIComponent(did)}`).catch(() => undefined);
}

export async function pendingApprovals(d: Dina): Promise<{ id: string; payload?: string }[]> {
  return d.tasks('approval', 'pending_approval');
}

/** A fresh agent paired to Alonso. */
export async function pairAgent(c: Ctx, name: string): Promise<Agent> {
  return Agent.pair(c.alonso, `${name}-${c.tag}`);
}

/** A story the server fleet cannot drive yet; the reason is printed. */
export function notHere(id: string, title: string, reason: string, mark: 'harness' | 'phone' = 'harness'): Scenario {
  return { id, title, mark, reason, async run() {} };
}

/** A fake DID for a contact who has no node in the fleet. */
export function fakeDid(seed: string): string {
  return `did:plc:${(seed.toLowerCase().replace(/[^a-z2-7]/g, '') + 'aaaaaaaaaaaaaaaaaaaaaaaa').slice(0, 24)}`;
}

/** Epoch ms → the weekday name, local. */
export function weekday(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { weekday: 'long' });
}
