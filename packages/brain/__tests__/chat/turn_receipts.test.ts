/** REAL_LIFE_FIXES_2 §3 — a turn's receipts stay on its own message and back later claims. */

import { earlierReceipts, storeTurnReceipts } from '../../src/chat/turn_receipts';
import { addDinaResponse, addUserMessage, getThread, resetThreads } from '../../src/chat/thread';

import type { ActionReceipt } from '../../src/guardian/action_claims';

const sent: ActionReceipt = { action: 'send', status: 'done', targets: ['Wen'], object: 'running ten minutes late' };

beforeEach(() => resetThreads());

it("stores a turn's receipts on the owner's message and reads them next turn", () => {
  addUserMessage('t1', 'tell Wen running ten minutes late');
  storeTurnReceipts('t1', 'tell Wen running ten minutes late', [sent]);
  addDinaResponse('t1', 'Done.');
  addUserMessage('t1', 'did you send it?');
  expect(earlierReceipts('t1', 'did you send it?')).toEqual([sent]);
  expect(getThread('t1')[0]?.metadata?.receipts).toEqual([sent]);
});

it("the current turn's own receipts are not counted as earlier", () => {
  addUserMessage('t2', 'tell Wen hi');
  storeTurnReceipts('t2', 'tell Wen hi', [sent]);
  expect(earlierReceipts('t2', 'tell Wen hi')).toEqual([]);
});

it('only the last ten turns count', () => {
  addUserMessage('t3', 'old turn');
  storeTurnReceipts('t3', 'old turn', [sent]);
  for (let i = 0; i < 10; i++) addUserMessage('t3', `turn ${i}`);
  addUserMessage('t3', 'now');
  expect(earlierReceipts('t3', 'now')).toEqual([]);
});
