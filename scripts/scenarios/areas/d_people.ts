/** D. People and contacts (docs/REAL_LIFE_SCENARIOS.md). */

import { talk } from './d2d_util';

import type { Scenario } from '../scenario';

export const areaD: Scenario[] = [
  {
    id: 'D1',
    title: 'Sancho is a contact',
    async run(c) {
      const s = (await c.alonso.contacts()).find((x) => x.did === c.sancho.did);
      c.check('Sancho is in contacts', s !== undefined);
      c.check('trusted (verified)', s?.trustLevel === 'verified', s?.trustLevel ?? '');
    },
  },
  {
    id: 'D2',
    title: 'Renaming a contact',
    async run(c) {
      const did = encodeURIComponent(c.sancho.did);
      const r = await c.alonso.core('PUT', `/v1/contacts/${did}`, { body: { display_name: 'Sancho Panza' } });
      c.check('rename accepted', r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
      const s = (await c.alonso.contacts()).find((x) => x.did === c.sancho.did);
      c.check('contact shows the new name', s?.displayName === 'Sancho Panza', s?.displayName ?? '');
      const people = (await c.alonso.people()).map((p) => [p.canonicalName, ...(p.surfaces ?? []).map((x) => x.surface)].join('/'));
      c.check('the people graph knows the new name', people.some((p) => p.includes('Sancho Panza')), people.join(' | '));
      await c.alonso.core('PUT', `/v1/contacts/${did}`, { body: { display_name: 'Sancho' } });
    },
  },
  {
    id: 'D3',
    title: 'A nickname',
    async run(c) {
      const before = (await c.alonso.people()).length;
      await c.say(c.alonso, "/remember Sanch (that's Sancho) owes me a coffee");
      const people = await c.alonso.people();
      c.check('no separate person "Sanch"', !people.some((p) => /^sanch$/i.test(p.canonicalName)), people.map((p) => p.canonicalName).join());
      c.check('no new person at all', people.length === before, `${before} → ${people.length}`);
    },
  },
  {
    id: 'D4',
    title: 'My plumber',
    async run(c) {
      const did = encodeURIComponent(c.sancho.did);
      await c.alonso.core('PUT', `/v1/contacts/${did}`, { body: { preferred_for: ['plumber'] } });
      const pref = await c.alonso.core('GET', '/v1/contacts/by-preference', { query: { category: 'plumber' } });
      c.check('Sancho listed for "plumber"', JSON.stringify(pref.body).includes(c.sancho.did), JSON.stringify(pref.body).slice(0, 160));
      const q = "who's my plumber?";
      const r = await c.say(c.alonso, q, { thread: c.thread('ask') });
      await c.judge('names Sancho', q, r.reply, 'The reply says the plumber is Sancho.');
      await c.alonso.core('PUT', `/v1/contacts/${did}`, { body: { preferred_for: [] } });
    },
  },
  {
    id: 'D5',
    title: 'Blocking a contact',
    async run(c) {
      const did = encodeURIComponent(c.sancho.did);
      await c.alonso.core('PUT', `/v1/contacts/${did}`, { body: { trust_level: 'blocked' } });
      const quarantinedBefore = (await c.alonso.quarantine()).length;
      const marker = `blocked-check ${c.tag}`;
      const seen = await talk(c.sancho, c.alonso, `can you hear me? ${marker}`, { ms: 60_000 });
      c.check('no bubble from a blocked contact', seen === undefined);
      c.check('not quarantined either', (await c.alonso.quarantine()).length === quarantinedBefore);
      await c.alonso.core('PUT', `/v1/contacts/${did}`, { body: { trust_level: 'verified' } });
    },
  },
  {
    id: 'D6',
    title: 'Deleting a contact',
    async run(c) {
      const did = c.sancho.did;
      const del = await c.alonso.core('DELETE', `/v1/contacts/${encodeURIComponent(did)}`);
      c.check('delete accepted', del.status < 300, String(del.status));
      c.check('contact gone', !(await c.alonso.contacts()).some((x) => x.did === did));
      c.check('the person is kept', (await c.alonso.people()).some((p) => /sancho/i.test(p.canonicalName)));
      const marker = `after-delete ${c.tag}`;
      const seen = await talk(c.sancho, c.alonso, `still friends? ${marker}`, { ms: 60_000 });
      c.check('no bubble once deleted', seen === undefined);
      const q = await c.eventually(async () => (await c.alonso.quarantine()).some((m) => (m as { senderDID?: string }).senderDID === did), 30_000);
      c.check('the message waits in quarantine', q === true);
      // Back as it was: accepting re-adds Sancho and releases the held message.
      await c.alonso.core('POST', '/v1/d2d/quarantine/accept', { body: { sender_did: did, sender_label: 'Sancho' } });
    },
  },
  {
    id: 'D7',
    title: 'A relationship note from a friend',
    async run(c) {
      const watch = c.alonso.watch('main');
      await watch.opened();
      await c.sancho.send(c.alonso.did, 'social.update', { text: `Pia (my niece) turns 7 on Friday ${c.tag}` });
      const stored = await c.eventually(async () => {
        for (const p of ['general', 'health', 'finance', 'work']) if ((await c.alonso.vaultQuery(p, c.tag)).length > 0) return true;
        return undefined;
      }, 90_000);
      watch.close();
      c.check('the note is stored on Alonso', stored === true);
    },
  },
  {
    id: 'D8',
    title: 'No relationship words stored as names',
    async run(c) {
      await c.say(c.alonso, '/remember my mom called about Sunday lunch at her place');
      await c.say(c.alonso, '/remember my boss Dana approved my leave for the 20th');
      const names = (await c.alonso.people()).map((p) => p.canonicalName.toLowerCase());
      const bad = names.filter((n) => ['mom', 'mum', 'dad', 'my mom', 'my boss', 'boss', 'mother', 'father'].includes(n));
      c.check('no relationship word stored as a name', bad.length === 0, bad.join());
      c.check('Dana stored as a person', names.includes('dana'), names.join());
    },
  },
];
