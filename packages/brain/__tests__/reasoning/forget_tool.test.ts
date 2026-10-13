/** REAL_LIFE_FIXES_2 §4 — the forget tool proves the owner's turn and asks Core for a card. */

import { resetOwnerTurns, setCurrentOwnerTurn } from '../../src/chat/owner_turns';
import { createForgetTool } from '../../src/reasoning/forget_tool';

beforeEach(() => resetOwnerTurns());

function tool() {
  const calls: unknown[] = [];
  const t = createForgetTool({
    thread: 'main',
    core: {
      forgetPropose: async (input) => {
        calls.push(input);
        return { status: 'confirm_pending', task_id: 'forget-9', summary: 'Forget everything about Ines' };
      },
    },
  });
  return { t, calls };
}

it('asks Core with a proof of the whole owner turn and one request', async () => {
  setCurrentOwnerTurn('main', { releaseSession: 'chat:main', turnId: 't1', text: 'forget everything about Ines', at: Date.now() });
  const { t, calls } = tool();
  const out = await t.execute({ person: 'Ines' });
  expect(out).toMatchObject({ status: 'confirm_pending', task_id: 'forget-9' });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ request: { person: 'Ines' }, proof: { turnId: 't1', turnText: 'forget everything about Ines' } });
});

it('needs exactly one of person, persona or item ids', async () => {
  setCurrentOwnerTurn('main', { releaseSession: 'chat:main', turnId: 't2', text: 'forget it all', at: Date.now() });
  const { t, calls } = tool();
  expect(await t.execute({})).toHaveProperty('error');
  expect(await t.execute({ person: 'Ines', persona: 'work' })).toHaveProperty('error');
  expect(calls).toHaveLength(0);
});

it('needs an owner turn on record', async () => {
  const { t } = tool();
  expect(await t.execute({ person: 'Ines' })).toHaveProperty('error');
});
