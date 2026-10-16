/**
 * COMMITMENT_KERNEL §15 step 5 — Brain's tools for drawing out deal values:
 * the proposal proves the owner's turn and goes to Core as one card; nothing
 * is proposed without an owner turn on record, or for an unknown kind.
 */

import { resetOwnerTurns, setCurrentOwnerTurn } from '../../src/chat/owner_turns';
import {
  createProposeDealValuesTool,
  createReadDealValuesTool,
} from '../../src/reasoning/value_model_tools';

beforeEach(() => resetOwnerTurns());

const change = {
  action: 'put',
  entry: {
    body: {
      type: 'promise',
      part: 'stock_run',
      dimensions: { crates: '2', day: 'tue', every_days: '7' },
      rupees: '-300',
    },
  },
};

function propose() {
  const calls: unknown[] = [];
  const t = createProposeDealValuesTool({
    thread: 'main',
    core: {
      commitmentProposeChanges: async (input) => {
        calls.push(input);
        return { status: 'pending_owner', task_id: 'cmc-1' };
      },
    },
  });
  return { t, calls };
}

it('V-01: proposes with a proof of the owner’s turn', async () => {
  setCurrentOwnerTurn('main', {
    releaseSession: 'chat:main',
    turnId: 't1',
    text: 'a lorry run costs me 300 rupees',
    at: Date.now(),
  });
  const { t, calls } = propose();
  expect(await t.execute({ kind: 'shelf_space.vendor', changes: [change] })).toMatchObject({
    status: 'pending_owner',
  });
  expect(calls[0]).toMatchObject({
    kind: 'shelf_space.vendor',
    changes: [change],
    proof: { turnId: 't1' },
  });
});

it('V-02: no owner turn, an unknown kind, or too many changes: nothing proposed', async () => {
  const { t, calls } = propose();
  expect(await t.execute({ kind: 'shelf_space.vendor', changes: [change] })).toHaveProperty(
    'error',
  );
  setCurrentOwnerTurn('main', {
    releaseSession: 'chat:main',
    turnId: 't2',
    text: 'hello',
    at: Date.now(),
  });
  expect(await t.execute({ kind: 'groceries', changes: [change] })).toHaveProperty('error');
  expect(
    await t.execute({
      kind: 'shelf_space.vendor',
      changes: [change, change, change, change, change],
    }),
  ).toHaveProperty('error');
  expect(calls).toHaveLength(0);
});

it('V-03: reads Brain’s view for a known kind only', async () => {
  const seen: string[] = [];
  const t = createReadDealValuesTool({
    core: {
      commitmentBrainView: async (kind) => {
        seen.push(kind);
        return { kind, holder: 'buyer', vocabulary: {}, values_on: true, entries: [] };
      },
    },
  });
  expect(await t.execute({ kind: 'shelf_space.host' })).toMatchObject({ kind: 'shelf_space.host' });
  expect(await t.execute({ kind: 'x' })).toHaveProperty('error');
  expect(seen).toEqual(['shelf_space.host']);
});
