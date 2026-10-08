/**
 * F. Strangers and safety (docs/REAL_LIFE_SCENARIOS.md). ChairMaker starts as a
 * stranger to Alonso. Order matters here: the stranger cases run before
 * ChairMaker is accepted.
 */

import { bubbleWith, talk } from './d2d_util';

import type { Ctx, Scenario } from '../scenario';

async function quarantinedFrom(c: Ctx, did: string, marker?: string): Promise<boolean> {
  return (await c.alonso.quarantine()).some(
    (m) => (m as { senderDID?: string }).senderDID === did && (marker === undefined || JSON.stringify(m).includes(marker)),
  );
}

export const areaF: Scenario[] = [
  {
    id: 'F5',
    title: 'A safety alert from a stranger',
    async run(c) {
      await c.chairmaker.send(c.alonso.did, 'safety.alert', { text: `scam calls going round, pretending to be the bank (${c.tag})` });
      const held = await c.eventually(() => quarantinedFrom(c, c.chairmaker.did), 90_000);
      c.check('held in quarantine (current rule for strangers)', held === true);
    },
  },
  {
    id: 'F1',
    title: 'A message from a stranger',
    async run(c) {
      const marker = `stranger ${c.tag}`;
      const seen = await talk(c.chairmaker, c.alonso, `hello, I make chairs, want a quote? ${marker}`, { ms: 45_000 });
      c.check('not shown in chat', seen === undefined);
      c.check('held in quarantine', (await c.eventually(() => quarantinedFrom(c, c.chairmaker.did, marker), 45_000)) === true);
      const list = await c.alonso.brain('GET', '/api/v1/d2d/quarantine');
      c.check('the owner can list it', list.status === 200, String(list.status));
    },
  },
  {
    id: 'F2',
    title: 'Accepting the stranger',
    async run(c) {
      const watch = c.alonso.watch('main');
      await watch.opened();
      const r = await c.alonso.core('POST', '/v1/d2d/quarantine/accept', { body: { sender_did: c.chairmaker.did, sender_label: 'ChairMaker' } });
      c.check('accept succeeds', r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
      c.check('ChairMaker is now a contact', (await c.alonso.contacts()).some((x) => x.did === c.chairmaker.did));
      const shown = await watch.waitFor(bubbleWith('I make chairs'), 90_000, 'the released message').catch(() => undefined);
      watch.close();
      c.check('the held message now shows', shown !== undefined);
    },
  },
  {
    id: 'F3',
    title: 'Blocking a stranger',
    async run(c) {
      await c.alonso.core('DELETE', `/v1/contacts/${encodeURIComponent(c.chairmaker.did)}`);
      const m1 = `second try ${c.tag}`;
      await c.chairmaker.send(c.alonso.did, 'coordination.request', { text: `special offer this week ${m1}` });
      c.check('held again once no longer a contact', (await c.eventually(() => quarantinedFrom(c, c.chairmaker.did, m1), 90_000)) === true);
      const b = await c.alonso.core('POST', '/v1/d2d/quarantine/block', { body: { sender_did: c.chairmaker.did } });
      c.check('block succeeds', b.status < 300, String(b.status));
      const m2 = `third try ${c.tag}`;
      const seen = await talk(c.chairmaker, c.alonso, `last chance ${m2}`, { ms: 45_000 });
      c.check('a blocked stranger is not shown', seen === undefined);
      c.check('nor held again', !(await quarantinedFrom(c, c.chairmaker.did, m2)));
    },
  },
  {
    id: 'F4',
    title: 'A safety alert from a friend',
    async run(c) {
      const text = `careful: scam caller pretending to be your bank (${c.tag})`;
      await c.sancho.send(c.alonso.did, 'safety.alert', { text });
      const stored = await c.eventually(async () => {
        for (const p of ['general', 'health', 'finance', 'work']) if ((await c.alonso.vaultQuery(p, c.tag)).length > 0) return true;
        return undefined;
      }, 90_000);
      c.check('the alert reached Alonso and was kept', stored === true);
    },
  },
  {
    id: 'F6',
    title: 'A forged sender',
    mark: 'harness',
    reason: 'needs a hand-built envelope whose inner `from` differs from the sealing key; the runner only sends through Core',
    async run() {},
  },
];
