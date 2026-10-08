/**
 * REAL_LIFE_FIXES §2.5 — the owner's chat can save the owner's own words.
 * Brain proves the quote against the recorded turn; words that are not the
 * owner's cannot be saved; the result names where the memory went.
 */

import {
  handleChat,
  resetRememberCoreClient,
  resetRememberDrainHook,
  setOwnerTurnRecorder,
  setRememberCoreClient,
  setRememberDrainHook,
} from '../../src/chat/orchestrator';
import { getOwnerWordsRememberer, proveOwnerWords, resetOwnerTurns } from '../../src/chat/owner_turns';
import { resetThreads } from '../../src/chat/thread';
import { createRememberChatTool } from '../../src/reasoning/remember_chat_tool';

import type { OwnerWordsProof } from '@dina/core';

const proofs: OwnerWordsProof[] = [];

beforeEach(() => {
  resetThreads();
  resetOwnerTurns();
  proofs.length = 0;
  setOwnerTurnRecorder(async () => true);
  setRememberCoreClient({
    stagingIngest: async () => ({ itemId: 'x', duplicate: false, status: 'received' }),
    stagingIngestOwnerWords: async (p: OwnerWordsProof) => {
      proofs.push(p);
      return { itemId: 'stg-chat-1', duplicate: false, status: 'received', source: 'chat_auto' };
    },
  });
  setRememberDrainHook(async () => ({ persona: 'general' }));
});

afterEach(() => {
  setOwnerTurnRecorder(null);
  resetRememberCoreClient();
  resetRememberDrainHook();
  resetOwnerTurns();
  resetThreads();
});

describe('remembering from chat', () => {
  it("proves the owner's quoted words and reports where they went", async () => {
    await handleChat('btw my locker code at the gym is 4471', 'main');
    const tool = createRememberChatTool({ thread: 'main' });
    const out = await tool.execute({ words: 'my locker code at the gym is 4471' });
    expect(out).toEqual({ status: 'stored', personas: ['general'] });
    expect(proofs).toHaveLength(1);
    expect(proofs[0]!.turnText).toBe('btw my locker code at the gym is 4471');
    expect(proofs[0]!.releaseSession).toBe('chat:main');
  });

  it('refuses words that are not in the owner message (e.g. from a contact)', async () => {
    await handleChat('what did Juno say?', 'main');
    const out = await createRememberChatTool({ thread: 'main' }).execute({
      words: 'my home address is 1 Harbour Road',
    });
    expect(out).toMatchObject({ error: expect.stringContaining('not in the owner') });
    expect(proofs).toHaveLength(0);
  });

  it('a repeated memory says it is already known', async () => {
    setRememberDrainHook(async () => ({ persona: null, duplicate: true }));
    await handleChat('remember the gate code is 4471', 'main');
    const out = await getOwnerWordsRememberer()!('main', 'the gate code is 4471');
    expect(out.status).toBe('duplicate');
  });

  it('a quote is matched case-insensitively but proven at the right offsets', async () => {
    await handleChat('Emma Loves Dinosaurs', 'main');
    const p = proveOwnerWords('main', 'emma loves dinosaurs');
    expect(p.ok && p.span).toBe('Emma Loves Dinosaurs');
  });
});
