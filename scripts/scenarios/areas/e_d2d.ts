/** E. Dina-to-Dina messages (docs/REAL_LIFE_SCENARIOS.md). */

import fs from 'node:fs';
import path from 'node:path';

import { startNode, stopNode } from '../fleet';
import { dayAt, type Scenario } from '../scenario';

import { bubbleWith, talk } from './d2d_util';

export const areaE: Scenario[] = [
  {
    id: 'E1',
    title: '"I\'ll drop by tomorrow"',
    async run(c) {
      // dina_details.md 3.5: the reminder brings what the vault knows ("keep a cold brew handy").
      await c.say(c.alonso, '/remember Sancho loves cold brew coffee');
      const t0 = Date.now();
      const bubble = await talk(c.sancho, c.alonso, `I'll drop by tomorrow morning to return your drill (${c.tag})`);
      c.check('Alonso sees the message', bubble !== undefined);
      const rem = await c.eventually(async () => {
        const r = (await c.alonso.allReminders()).filter((x) => x.created_at >= t0);
        return r.length > 0 ? r : undefined;
      }, 90_000);
      c.check('a reminder was made', rem !== undefined);
      c.check('for tomorrow morning', (rem ?? []).some((x) => x.due_at >= dayAt(1, 5) && x.due_at <= dayAt(1, 12, 30)), (rem ?? []).map((x) => `${x.message} @${new Date(x.due_at).toString()}`).join(' | '));
      await c.judge('the reminder uses what Dina knows', 'Sancho: I will drop by tomorrow morning', (rem ?? []).map((x) => x.message).join('\n'), 'A reminder says Sancho is coming and suggests having cold brew coffee ready (he loves it).');
    },
  },
  {
    id: 'E2',
    title: 'Chit-chat makes no reminder',
    async run(c) {
      const t0 = Date.now();
      const bubble = await talk(c.sancho, c.alonso, `hey, how's it going? (${c.tag})`);
      c.check('Alonso sees the message', bubble !== undefined);
      await c.sleep(30_000);
      const made = (await c.alonso.allReminders()).filter((x) => x.created_at >= t0);
      c.check('no reminder', made.length === 0, made.map((x) => x.message).join(' | '));
    },
  },
  {
    id: 'E3',
    title: 'A question from a friend',
    mark: 'gap',
    async run(c) {
      const watch = c.alonso.watch('main');
      const bubble = await talk(c.sancho, c.alonso, `what's your view on the new Oreos? (${c.tag})`, { watch });
      c.check('Alonso sees the message', bubble !== undefined);
      const prep = await watch
        .waitFor((m) => m.find((x) => x.type !== 'user' && x.metadata?.source !== 'd2d' && x.timestamp > (bubble?.timestamp ?? 0)), 60_000, 'a prepared reply')
        .catch(() => undefined);
      watch.close();
      c.check('Dina prepares context or a draft reply', prep !== undefined);
    },
  },
  {
    id: 'E4',
    title: 'A conversation both ways',
    async run(c) {
      const lines: [typeof c.alonso, typeof c.alonso, string][] = [
        [c.sancho, c.alonso, `are we still on for Saturday? ${c.tag}-1`],
        [c.alonso, c.sancho, `yes, 7pm at the usual place ${c.tag}-2`],
        [c.sancho, c.alonso, `great, I'll bring Ines ${c.tag}-3`],
        [c.alonso, c.sancho, `perfect, see you both ${c.tag}-4`],
        [c.sancho, c.alonso, `see you! ${c.tag}-5`],
      ];
      const wa = c.alonso.watch('main');
      const ws = c.sancho.watch('main');
      await Promise.all([wa.opened(), ws.opened()]);
      for (const [from, to, text] of lines) await talk(from, to, text, { watch: to === c.alonso ? wa : ws });
      const order = (w: typeof wa, n: number[]) =>
        n.map((i) => [...w.messages.values()].find((m) => m.metadata?.source === 'd2d' && m.content.includes(`${c.tag}-${i}`))?.timestamp ?? -1);
      const a = order(wa, [1, 3, 5]);
      const s = order(ws, [2, 4]);
      c.check('Alonso got 1, 3, 5', a.every((t) => t > 0), a.join());
      c.check('Sancho got 2, 4', s.every((t) => t > 0), s.join());
      c.check('in order', a.every((t, i) => i === 0 || (a[i - 1] as number) < t) && s.every((t, i) => i === 0 || (s[i - 1] as number) < t));
      wa.close();
      ws.close();
    },
  },
  {
    id: 'E5',
    title: 'A friend who was offline',
    async run(c) {
      stopNode('sancho');
      await c.sleep(5_000);
      await c.alonso.send(c.sancho.did, 'coordination.request', { text: `sent while you were away ${c.tag}` });
      await c.sleep(20_000);
      await startNode('sancho');
      const watch = c.sancho.watch('main');
      const got = await watch.waitFor(bubbleWith(`away ${c.tag}`), 240_000, 'the late message').catch(() => undefined);
      watch.close();
      c.check('delivered after Sancho came back', got !== undefined);
    },
  },
  {
    id: 'E6',
    title: 'A friend offline for too long',
    mark: 'harness',
    reason: 'needs the outbox retry window (5 tries) to run out; ~6 minutes per run, and no route reports dead letters',
    async run() {},
  },
  {
    id: 'E7',
    title: 'Personal data in a message stays out of the logs',
    async run(c) {
      const bubble = await talk(c.sancho, c.alonso, `my new number is +44 7700 900123 and I moved to 12 Fenwick Road (${c.tag})`);
      c.check('delivered', bubble !== undefined);
      await c.sleep(15_000);
      const dir = c.alonso.node.dir;
      const logs = ['core.log', 'brain.log'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
      c.check('the phone number is not in the logs', !logs.includes('900123'));
      c.check('the street is not in the logs', !logs.includes('Fenwick'));
    },
  },
  {
    id: 'E8',
    title: 'Twenty messages in half a minute',
    async run(c) {
      const watch = c.alonso.watch('main');
      await watch.opened();
      for (let i = 1; i <= 20; i++) await c.sancho.send(c.alonso.did, 'coordination.request', { text: `burst ${c.tag} #${i}` });
      const all = await watch
        .waitFor((m) => {
          const n = m.filter((x) => x.metadata?.source === 'd2d' && x.content.includes(`burst ${c.tag}`));
          return n.length >= 20 ? n : undefined;
        }, 240_000, 'all 20')
        .catch(() => undefined);
      const got = [...watch.messages.values()].filter((x) => x.metadata?.source === 'd2d' && x.content.includes(`burst ${c.tag}`));
      watch.close();
      c.check('all twenty arrived', all !== undefined, `${got.length} of 20`);
      const nums = got.map((x) => /#(\d+)/.exec(x.content)?.[1]);
      c.check('none twice', new Set(nums).size === nums.length, nums.join(','));
    },
  },
  {
    id: 'E9',
    title: 'The same message delivered twice',
    mark: 'harness',
    reason: 'needs a raw envelope replay through MsgBox; the runner only sends through Core',
    async run() {},
  },
  {
    id: 'E10',
    title: 'A nudge about a coming visit',
    mark: 'gap',
    async run(c) {
      await c.say(c.alonso, '/remember Sancho loves cold brew coffee');
      const watch = c.alonso.watch('main');
      await talk(c.sancho, c.alonso, `coming over in an hour (${c.tag})`, { watch });
      const nudge = await watch.waitFor((m) => m.find((x) => x.type === 'nudge'), 60_000, 'a nudge').catch(() => undefined);
      watch.close();
      c.check('a nudge appears', nudge !== undefined);
    },
  },
  {
    id: 'E11',
    title: 'Unicode and emoji',
    async run(c) {
      const text = `Llegaré mañana 🎉 — हम कल मिलेंगे — 明天见 ${c.tag}`;
      const bubble = await talk(c.sancho, c.alonso, text);
      c.check('delivered', bubble !== undefined);
      c.check('exactly as sent', bubble !== undefined && bubble.content.includes(text), bubble?.content ?? '');
    },
  },
  {
    id: 'E12',
    // dina_details.md, local testing: "tell Sancho I'm coming tomorrow morning" → check sancho's tab.
    title: 'Talking to a friend from chat',
    async run(c) {
      const watch = c.sancho.watch('main');
      await watch.opened();
      await c.say(c.alonso, `tell Sancho I'm running late (${c.tag})`, { thread: c.thread('ask') });
      const got = await watch.waitFor(bubbleWith(c.tag), 90_000, 'the message on Sancho').catch(() => undefined);
      watch.close();
      c.check('Sancho receives it', got !== undefined);
    },
  },
];
