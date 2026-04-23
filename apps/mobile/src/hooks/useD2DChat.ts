/**
 * useD2DChat(peerDID) — live-subscribed per-peer chat thread.
 *
 * Returns the thread contents keyed by `peerDID` plus a `send`
 * function and some contact-status flags the screen uses to decide
 * which affordances to show ("Add to contacts", "Blocked", etc).
 *
 * Snapshot caching matters: `useSyncExternalStore` re-renders every
 * time the snapshot reference changes, so a hook that returned
 * `messages.slice()` on every read would loop forever. We invalidate
 * the cached snapshot inside the thread subscription callback and
 * return the SAME array reference on subsequent reads until the next
 * mutation — same pattern runtime_warnings had to adopt.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { getThread, subscribeToThread, type ChatMessage } from '@dina/brain/src/chat/thread';
import { getContact, getTrustLevel, type TrustLevel } from '@dina/core/src/contacts/directory';
import { sendChatMessage, ChatSendError } from '../services/chat_d2d';

export interface UseD2DChatResult {
  /** Frozen snapshot — stable reference until next mutation. */
  messages: readonly ChatMessage[];
  /** Contact entry for the peer, or null if not in the directory. */
  peerContact: ReturnType<typeof getContact>;
  peerTrust: TrustLevel | null;
  /** True when the peer is in the directory with trust ≠ 'blocked'. */
  isKnownContact: boolean;
  /** Send a message. Adds optimistic bubble + hits the wire. */
  send: (text: string) => Promise<void>;
}

/**
 * Per-process snapshot cache. Module-level so multiple mounted
 * chat screens for the same peer share the same frozen array
 * reference (cheaper re-renders, and survives a parent remount).
 */
const snapshotByThread = new Map<string, readonly ChatMessage[]>();

function readSnapshot(threadId: string): readonly ChatMessage[] {
  let snap = snapshotByThread.get(threadId);
  if (snap === undefined) {
    snap = Object.freeze([...getThread(threadId)]);
    snapshotByThread.set(threadId, snap);
  }
  return snap;
}

function invalidateSnapshot(threadId: string): void {
  snapshotByThread.delete(threadId);
}

/**
 * Test-only: drop every cached snapshot so a fresh read rebuilds
 * from the live thread. Ordinary app code never needs this.
 */
export function resetD2DChatSnapshotsForTest(): void {
  snapshotByThread.clear();
}

export function useD2DChat(peerDID: string): UseD2DChatResult {
  // `useSyncExternalStore` demands a referentially-stable snapshot —
  // see the module header. Subscriber below calls `invalidateSnapshot`
  // so the NEXT getSnapshot returns a new frozen array once a write
  // actually happened, and React re-renders.
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeToThread(peerDID, () => {
        invalidateSnapshot(peerDID);
        onStoreChange();
      }),
    [peerDID],
  );
  const getSnapshot = useCallback(() => readSnapshot(peerDID), [peerDID]);

  const messages = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Contact status is read once per render from the in-memory directory.
  // The directory has its own mutation surface; the chat screen calls
  // `addContact` directly and re-renders on completion, so we don't
  // subscribe here.
  const peerContact = getContact(peerDID);
  const peerTrust = getTrustLevel(peerDID);
  const isKnownContact = peerContact !== null && peerTrust !== 'blocked';

  // Keep the latest peerDID in a ref so `send` stays referentially
  // stable across renders (every re-render would otherwise mint a new
  // `send`, forcing children that memoise on it to re-render too).
  const peerRef = useRef(peerDID);
  peerRef.current = peerDID;

  const send = useCallback(async (text: string): Promise<void> => {
    try {
      await sendChatMessage(peerRef.current, text);
    } catch (err) {
      // `sendChatMessage` has already written an error row to the
      // thread; rethrow so the composer can decide how to surface
      // the failure (shake the input, disable retry, etc.).
      if (err instanceof ChatSendError) throw err;
      throw new ChatSendError(err instanceof Error ? err.message : String(err), err);
    }
  }, []);

  // Make sure a brand-new thread surfaces as the empty snapshot
  // consistently — without this, the first render sees whatever
  // addMessage races have cached. Harmless when the thread already
  // has entries.
  useEffect(() => {
    if (getThread(peerDID).length === 0) {
      invalidateSnapshot(peerDID);
    }
  }, [peerDID]);

  return { messages, peerContact, peerTrust, isKnownContact, send };
}
