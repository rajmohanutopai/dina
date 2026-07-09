/**
 * Web quarantine card sync — polls Core (via the brain proxy) on chat mount
 * and injects a review card into the thread for each pending unknown-sender
 * message not already shown. This is the F4/MRS-05 web-parity mechanism (the
 * thin-client has no in-process onQuarantinedD2D hook). Deterministic: mock
 * fetch + assert the injected chat message matches what InlineQuarantineCard
 * reads (metadata.lifecycle.kind === 'quarantine_request').
 */

import { getThread, addMessage, resetThreads, type ChatMessage } from '@dina/brain/chat';

import { syncQuarantineCards } from '../../src/hooks/quarantine_sync.web';

function lifecycleOf(m: ChatMessage): { kind?: string; quarantineId?: string; senderDID?: string } {
  return (m.metadata?.lifecycle as { kind?: string; quarantineId?: string; senderDID?: string }) ?? {};
}

function mockQuarantine(messages: unknown[]): void {
  (globalThis as unknown as { fetch: unknown }).fetch = jest
    .fn()
    .mockResolvedValue({ ok: true, text: async () => '', json: async () => ({ messages }) });
}

async function flush(): Promise<void> {
  // Let the fire-and-forget async IIFE in syncQuarantineCards resolve.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('quarantine_sync.web', () => {
  beforeEach(() => {
    resetThreads();
  });

  it('injects a quarantine_request card for each pending message', async () => {
    mockQuarantine([
      { id: 'q1', senderDID: 'did:plc:x', messageType: 'coordination.request', body: 'hi', receivedAt: 1 },
      { id: 'q2', senderDID: 'did:plc:y', messageType: 'social.update', body: 'yo', receivedAt: 2 },
    ]);
    syncQuarantineCards('main');
    await flush();

    const thread = getThread('main');
    expect(thread).toHaveLength(2);
    const lc0 = lifecycleOf(thread[0]!);
    expect(lc0.kind).toBe('quarantine_request');
    expect(lc0.quarantineId).toBe('q1');
    expect(lc0.senderDID).toBe('did:plc:x');
    expect(thread[0]?.type).toBe('dina');
    expect(lifecycleOf(thread[1]!).quarantineId).toBe('q2');
  });

  it('does NOT duplicate a card already shown in the thread', async () => {
    // A card for q1 is already in the thread (e.g. a prior mount).
    addMessage('main', 'dina', 'Someone who isn’t in your contacts wants to message you.', {
      metadata: {
        source: 'd2d',
        senderDID: 'did:plc:x',
        lifecycle: { kind: 'quarantine_request', quarantineId: 'q1', senderDID: 'did:plc:x' },
      },
    });
    mockQuarantine([
      { id: 'q1', senderDID: 'did:plc:x', messageType: 'coordination.request', body: 'hi', receivedAt: 1 },
      { id: 'q2', senderDID: 'did:plc:y', messageType: 'social.update', body: 'yo', receivedAt: 2 },
    ]);
    syncQuarantineCards('main');
    await flush();

    const ids = getThread('main').map((m) => lifecycleOf(m).quarantineId);
    expect(ids).toEqual(['q1', 'q2']); // q1 kept once, q2 added — no dupe
  });

  it('injects nothing on a fetch failure (transient blip — a later mount retries)', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn().mockResolvedValue({ ok: false, text: async () => 'err' });
    syncQuarantineCards('main');
    await flush();
    expect(getThread('main')).toHaveLength(0);
  });
});
