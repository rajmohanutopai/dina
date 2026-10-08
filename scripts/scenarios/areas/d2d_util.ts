/** Helpers for scenarios where one Dina messages another. */

import type { ChatMessage, Dina, ThreadWatch } from '../client';

/** A peer message bubble on `watch` whose text contains `marker`. */
export function bubbleWith(marker: string) {
  return (msgs: ChatMessage[]): ChatMessage | undefined =>
    msgs.find((m) => m.metadata?.source === 'd2d' && m.content.includes(marker));
}

/** Send a Talk message from `from` to `to` and wait for it in `to`'s main chat. */
export async function talk(
  from: Dina,
  to: Dina,
  text: string,
  opts: { watch?: ThreadWatch; ms?: number; type?: string } = {},
): Promise<ChatMessage | undefined> {
  const watch = opts.watch ?? to.watch('main');
  await watch.opened();
  try {
    await from.send(to.did, opts.type ?? 'coordination.request', { text });
    return await watch.waitFor(bubbleWith(text.slice(-12)), opts.ms ?? 90_000, `"${text.slice(0, 30)}" on ${to.name}`).catch(() => undefined);
  } finally {
    if (opts.watch === undefined) watch.close();
  }
}
