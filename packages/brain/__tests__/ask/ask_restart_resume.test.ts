/**
 * An ask paused for the owner's approval survives a restart (FIXES F11).
 *
 * Before, the record lived only in memory: after a restart the owner's yes
 * found nothing and the answer never came. Now the record is kept in Core
 * without its paused state (persona content), and the resumed ask runs the
 * question again.
 */

import { AskApprovalResumer } from '../../src/ask/ask_approval_resumer';
import { AskRegistry } from '../../src/ask/ask_registry';
import { CoreAskAdapter } from '../../src/ask/core_ask_adapter';

import type { AskExecuteFn } from '../../src/ask/ask_handler';
import type { StoredAskRecord } from '@dina/core';

/** Core's side, as both transports present it: only what the wire keeps. */
class FakeCoreStore {
  readonly rows = new Map<string, StoredAskRecord>();
  async askRecordPut(r: StoredAskRecord): Promise<void> {
    this.rows.set(r.id, JSON.parse(JSON.stringify(r)) as StoredAskRecord);
  }
  async askRecordList(): Promise<StoredAskRecord[]> {
    return [...this.rows.values()];
  }
  async askRecordDelete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}

describe('an ask waiting on approval, across a restart', () => {
  it('keeps the record in Core without its paused state, then reruns the question on approval', async () => {
    const core = new FakeCoreStore();

    // First run: the ask pauses for approval with Pattern A state.
    const before = new AskRegistry({ adapter: new CoreAskAdapter(core) });
    await before.enqueue({
      id: 'ask-1',
      question: 'What did the dentist say?',
      requesterDid: 'did:plc:owner',
      conversation: 'thread-1',
    });
    await before.markPendingApproval('ask-1', 'appr-1', '{"v":1,"messages":["health note"]}');

    const kept = core.rows.get('ask-1');
    expect(kept).toMatchObject({ status: 'pending_approval', approvalId: 'appr-1' });
    expect(JSON.stringify(kept)).not.toContain('health note');
    // This run still holds the paused state, for a resume with no new model call.
    expect((await before.get('ask-1'))?.pausedStateJson).toContain('health note');

    // Restart: a new registry over the same Core.
    const executed: string[] = [];
    const executeFn: AskExecuteFn = async (input) => {
      executed.push(input.question);
      return { kind: 'answer', answer: { text: 'Floss more.' } as never };
    };
    let resumer: AskApprovalResumer | null = null;
    const after = new AskRegistry({
      adapter: new CoreAskAdapter(core),
      onEvent: (e) => void resumer?.handle(e),
    });
    resumer = new AskApprovalResumer({ registry: after, executeFn });
    await after.restoreOnStartup();

    const restored = await after.get('ask-1');
    expect(restored).toMatchObject({ status: 'pending_approval', approvalId: 'appr-1', conversation: 'thread-1' });
    expect(restored?.pausedStateJson).toBeUndefined();

    // The owner says yes: the question runs again (Pattern B).
    await after.resumeAfterApproval('ask-1');
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(executed).toEqual(['What did the dentist say?']);
    expect((await after.get('ask-1'))?.status).toBe('complete');
    // An ask that ended leaves Core.
    expect(core.rows.has('ask-1')).toBe(false);
  });

  it('a failed write to Core does not fail the ask', async () => {
    const core = new FakeCoreStore();
    core.askRecordPut = async () => {
      throw new Error('askRecordPut failed: 503');
    };
    const registry = new AskRegistry({ adapter: new CoreAskAdapter(core) });
    await registry.enqueue({ id: 'ask-2', question: 'q', requesterDid: 'did:plc:owner' });
    expect((await registry.get('ask-2'))?.status).toBe('in_flight');
  });
});
