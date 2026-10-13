/** W. Work (docs/REAL_LIFE_SCENARIOS_2.md). */

import { personasHolding } from './a_remember';
import { ask, notHere, pairAgent, peerMessages, remember } from './part2_util';

import type { Scenario } from '../scenario';

export const areaW: Scenario[] = [
  {
    id: 'W1',
    title: 'Meeting prep from scattered notes',
    async run(c) {
      await remember(c, 'Brightwave client: their budget for the pilot is ₹18 lakh');
      await remember(c, 'Brightwave complained that the last report came two weeks late');
      await remember(c, "Brightwave's new CTO is Farah Siddiqui, she prefers short decks");
      await remember(c, 'my son Ishaan has a cough this week');
      c.check('the client notes are in work', (await personasHolding(c.alonso, 'Brightwave')).includes('work'), (await personasHolding(c.alonso, 'Brightwave')).join());
      const q = "Prepare me for Thursday's Brightwave meeting.";
      const r = await ask(c, q);
      await c.judge('a brief from the notes', q, r, 'The brief covers the ₹18 lakh pilot budget, the late-report complaint and Farah Siddiqui preferring short decks.');
      c.check('no family facts in the brief', !/Ishaan|cough/i.test(r), r.slice(0, 200));
    },
  },
  {
    id: 'W2',
    title: 'Dropped follow-ups',
    async run(c) {
      await remember(c, 'I promised Priya the Q3 deck by Friday');
      await remember(c, 'I promised Tom a call on Tuesday about the vendor contract');
      const q = 'What did I promise people this week?';
      const got = await peerMessages(c.sancho, 20_000, async () => {
        await c.judge('both promises', q, await ask(c, q), 'The reply lists the Q3 deck for Priya by Friday and the Tuesday call with Tom about the vendor contract; it may offer reminders but does not claim to have sent anything.');
      });
      c.check('nothing sent', got.length === 0);
    },
  },
  notHere('W3', 'Research handed to an agent', 'needs a real agent (OpenClaw or Hermes through dina-agent)'),
  {
    id: 'W4',
    title: 'An agent wants the work notes',
    async run(c) {
      await remember(c, 'Orion project: the launch slipped to 4 December because of the payments audit');
      const a = await pairAgent(c, 'w4-agent');
      const s = await a.startSession(`w4-${c.tag}`);
      const r = await a.ask('When is the Orion launch and why did it slip?', s, 60_000);
      c.check('the agent waits for the owner', r.status === 'pending_approval', `${r.status} ${JSON.stringify(r.body).slice(0, 1500)}`);
      c.check('no work content before approval', !/4 December|payments audit/i.test(JSON.stringify(r.body)));
      const pending = await c.alonso.tasks('approval', 'pending_approval');
      const id = String(r.body?.approval_id ?? pending[0]?.id ?? '');
      c.check('the card names the work persona', /work/i.test(JSON.stringify(pending.find((t) => t.id === id) ?? {})), id);
      await c.alonso.core('POST', `/v1/workflow/tasks/${id}/approve`, { body: { scope: 'single' } });
      const after = await a.waitAsk(String(r.body?.request_id ?? ''), s, 120_000);
      c.check('answered once approved', after.status === 'complete' && /december/i.test(JSON.stringify(after.body)), `${after.status} ${JSON.stringify(after.body).slice(0, 160)}`);
      const again = await a.ask('Remind me why Orion slipped?', s, 60_000);
      // Approve Once covers one ask: the next one either waits again or gets
      // nothing from the work vault.
      c.check(
        'the next ask waits again, or reads nothing from work',
        again.status === 'pending_approval' || !/payments audit|4 December/i.test(JSON.stringify(again.body)),
        `${again.status} ${JSON.stringify(again.body).slice(0, 300)}`,
      );
    },
  },
  {
    id: 'W5',
    title: 'Leaving a job',
    async run(c) {
      await remember(c, 'Lumen Labs: my manager Gita wrote that my migration work saved ₹40 lakh');
      await remember(c, 'Lumen Labs: the office access card number is 22817');
      const q = "I'm leaving Lumen Labs. Archive my work stuff, but keep what I need for references.";
      await c.judge('asks before deleting', q, await ask(c, q), "Dina proposes what to keep (Gita's note about the migration saving ₹40 lakh) and asks before deleting or archiving anything; she does not claim to have deleted items.");
      c.check('nothing deleted yet', (await c.alonso.vaultQuery('work', 'Gita')).length > 0);
    },
  },
  {
    id: 'W6',
    title: 'Out of office',
    async run(c) {
      const r = await ask(c, "I'm off next week. If Sancho's Dina asks about work, say I'm back on Monday.");
      await c.judge('a card names who, what and until when', "I'm off next week...", r, 'Dina says a card is waiting to confirm an automatic reply to Sancho, with the reply text and an end date; she may note it goes to any request from Sancho, not only work ones.');
      // The owner approves the card (REAL_LIFE_FIXES_2 §14).
      const card = (await c.alonso.tasks('approval', 'pending_approval')).find((x) => String(x.payload ?? '').includes('owner_standing_reply'));
      c.check('a standing-reply card waits', card !== undefined);
      if (card !== undefined) await c.alonso.core('POST', `/v1/workflow/tasks/${card.id}/approve`, { body: {} });
      const replies = await peerMessages(c.sancho, 60_000, () =>
        c.sancho.send(c.alonso.did, 'coordination.request', { text: `Can Alonso review the contract this week? (${c.tag})` }),
      );
      c.check("Sancho is told Alonso is back on Monday", replies.some((m) => /monday/i.test(m.content)), replies.map((m) => m.content).join(' | '));
    },
  },
];
