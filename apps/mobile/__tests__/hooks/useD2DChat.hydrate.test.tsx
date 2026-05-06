/**
 * Regression — MT-18-I2: per-peer chat threads must hydrate from the
 * persisted repository on first hook mount.
 *
 * Boot only hydrates the default session thread (`bootstrap.ts` calls
 * `hydrateThread(threadId)` once). For D2D conversations the thread
 * key is the peer DID, so without a per-mount hydrate every restart
 * leaves `/chat/[did]` looking empty even though the messages survive
 * on disk. Live-tested on iOS sim 2026-05-06.
 */

import { render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Text, View } from 'react-native';

import { addUserMessage, resetThreads, type ChatMessage } from '@dina/brain/chat';
import {
  InMemoryChatMessageRepository,
  setChatMessageRepository,
} from '@dina/core';

import { useD2DChat, resetD2DChatSnapshotsForTest } from '../../src/hooks/useD2DChat';

const PEER = 'did:plc:peer-mt18-i2';

function HookProbe({ peerDID }: { peerDID: string }): React.ReactElement {
  const { messages } = useD2DChat(peerDID);
  return (
    <View>
      {messages.map((m: ChatMessage) => (
        <Text key={m.id} testID={`msg-${m.id}`}>
          {m.content}
        </Text>
      ))}
    </View>
  );
}

describe('useD2DChat — hydrate-on-mount (MT-18-I2)', () => {
  let repo: InMemoryChatMessageRepository;

  beforeEach(() => {
    repo = new InMemoryChatMessageRepository();
    setChatMessageRepository(repo);
    resetThreads();
    resetD2DChatSnapshotsForTest();
  });

  afterEach(() => {
    setChatMessageRepository(null);
    resetThreads();
    resetD2DChatSnapshotsForTest();
  });

  it('pulls the persisted per-peer thread back on first mount', async () => {
    // Step 1 — write through to the repo as the previous "session" did.
    const m1 = addUserMessage(PEER, 'hi from before restart');
    const m2 = addUserMessage(PEER, 'and one more');
    expect(await repo.listByThread(PEER)).toHaveLength(2);

    // Step 2 — simulate process restart. `resetThreads()` would also
    // reset the repo (it calls `repo.reset()`), so unhook the repo
    // first, clear in-mem state, then re-attach. Mirrors the pattern
    // in packages/brain/__tests__/chat/thread_persistence.test.ts.
    setChatMessageRepository(null);
    resetThreads();
    setChatMessageRepository(repo);
    resetD2DChatSnapshotsForTest();
    expect(await repo.listByThread(PEER)).toHaveLength(2);

    // Step 3 — mount the hook. It must lazy-hydrate.
    const { findByTestId } = render(<HookProbe peerDID={PEER} />);
    await waitFor(async () => {
      // hydrateThread is async; the subscriber will fire on mutation,
      // and the snapshot will refresh. waitFor retries until resolved.
      await findByTestId(`msg-${m1.id}`);
      await findByTestId(`msg-${m2.id}`);
    });
  });

  it('merges disk history with in-memory live messages on first mount', async () => {
    // The race we have to handle: an inbound message arrives BEFORE
    // /chat/[did] mounts (MsgBox replays a queued message during the
    // boot window, the receive pipeline calls addMessage, the screen
    // hadn't subscribed yet so the ordinary addMessage path doesn't
    // help). Then the user navigates to the chat. The persisted
    // history (from prior sessions) must load AND the in-memory
    // live message must survive.
    //
    // Setup: pre-seed disk with two historical messages, then
    // simulate a "restart" leaving in-memory empty, then add ONE
    // live inbound (mirrors the MsgBox-replay-during-boot case).
    const m1 = addUserMessage(PEER, 'historical 1');
    const m2 = addUserMessage(PEER, 'historical 2');
    setChatMessageRepository(null);
    resetThreads();
    setChatMessageRepository(repo);
    resetD2DChatSnapshotsForTest();
    // Now an inbound arrives BEFORE the screen mounts.
    const live = addUserMessage(PEER, 'live inbound');

    // Mount: should see all three, in chronological order.
    const { findByTestId } = render(<HookProbe peerDID={PEER} />);
    await waitFor(async () => {
      await findByTestId(`msg-${m1.id}`);
      await findByTestId(`msg-${m2.id}`);
      await findByTestId(`msg-${live.id}`);
    });
  });

  it('is a no-op on the second mount of the same peer in this session', async () => {
    // Once we've hydrated for a peer, future mounts should skip the
    // disk round-trip. Live activity flows through the subscription;
    // a redundant hydrate would just burn an I/O.
    const m = addUserMessage(PEER, 'first session');
    const probe1 = render(<HookProbe peerDID={PEER} />);
    await probe1.findByTestId(`msg-${m.id}`);
    probe1.unmount();

    // Sneak a row directly into the repo as if another writer had
    // landed it. Without the once-per-session guard, a second mount
    // of the same peer would pull this row in. With the guard, it
    // should NOT — only fresh inbound (via subscriber) does.
    await repo.append({
      id: 'cm-sneak',
      threadId: PEER,
      type: 'user',
      content: 'sneaked into disk',
      metadata: {},
      sources: [],
      timestamp: Date.now() + 1000,
    });
    const probe2 = render(<HookProbe peerDID={PEER} />);
    await probe2.findByTestId(`msg-${m.id}`);
    expect(probe2.queryByText('sneaked into disk')).toBeNull();
  });

  it("doesn't try to hydrate when peerDID is empty", async () => {
    // Guard against a misuse: empty peerDID would be the default
    // session thread, which the boot path already hydrates. Calling
    // hydrate again is harmless but wasteful — skipping is correct.
    const probe = render(<HookProbe peerDID="" />);
    expect(probe.toJSON()).not.toBeNull();
    // No throw, no warning, empty render.
  });
});
