/**
 * N. Errors and resilience (docs/REAL_LIFE_SCENARIOS.md). Some scenarios
 * restart Alonso with one setting changed, then put him back.
 */

import { startNode, stopNode } from '../fleet';

import type { Ctx, Scenario } from '../scenario';

async function restartAlonso(c: Ctx, overrides: { core?: Record<string, string>; brain?: Record<string, string> } = {}): Promise<void> {
  stopNode('alonso');
  await c.sleep(3_000);
  await startNode('alonso', overrides);
}

export const areaN: Scenario[] = [
  {
    id: 'N1',
    title: 'No model configured',
    async run(c) {
      await restartAlonso(c, { brain: { DINA_BRAIN_LLM_PROVIDER: 'none' } });
      try {
        const r = await c.say(c.alonso, '/remember the spare key is under the blue pot', { timeoutMs: 60_000 });
        c.expectReply('/remember says it is still starting', r.reply, /still starting|try again/i);
        const a = await c.say(c.alonso, 'what do you know about the spare key?', { thread: c.thread('n'), timeoutMs: 60_000 });
        c.check('chat still answers', a.reply.trim().length > 0, a.reply.slice(0, 120));
      } finally {
        await restartAlonso(c);
      }
    },
  },
  {
    id: 'N2',
    title: 'The model cannot be reached',
    async run(c) {
      await restartAlonso(c, { brain: { DINA_OPENROUTER_BASE_URL: 'http://127.0.0.1:9/api/v1' } });
      try {
        const t0 = Date.now();
        const q = 'What is the capital of Norway?';
        const r = await c.say(c.alonso, q, { thread: c.thread('n'), timeoutMs: 200_000 });
        c.check('answers within three minutes, no hang', Date.now() - t0 < 180_000, `${Math.round((Date.now() - t0) / 1000)}s`);
        await c.judge('says something went wrong', q, r.reply, 'The reply says Dina could not reach its model or could not answer right now (a clear failure); it does not pretend to have answered.');
      } finally {
        await restartAlonso(c);
      }
    },
  },
  {
    id: 'N3',
    title: 'AppView is down',
    async run(c) {
      await restartAlonso(c, { core: { DINA_APPVIEW_URL: 'http://127.0.0.1:9' }, brain: { DINA_APPVIEW_URL: 'http://127.0.0.1:9' } });
      try {
        const q = '/reviews standing desks';
        const r = await c.say(c.alonso, q, { thread: c.thread('n') });
        await c.judge('says the network is unreachable, not "no reviews"', q, r.reply, 'The reply says the review network could not be reached right now; it does not say there are simply no reviews.');
      } finally {
        await restartAlonso(c);
      }
    },
  },
  {
    id: 'N4',
    title: 'A restart keeps memory',
    async run(c) {
      await c.say(c.alonso, '/remember the boiler service code is 7Q2-ALPHA');
      await restartAlonso(c);
      const q = 'What is the boiler service code?';
      const r = await c.say(c.alonso, q, { thread: c.thread('n') });
      c.expectReply('still knows it after a restart', r.reply, /7Q2-ALPHA/);
    },
  },
  {
    id: 'N5',
    title: 'Empty commands',
    async run(c) {
      const a = await c.say(c.alonso, '/remember');
      c.expectReply('/remember asks what to remember', a.reply, /what would you like me to remember/i);
      const b = await c.say(c.alonso, '/services');
      c.expectReply('/services asks what is needed', b.reply, /what service/i);
      const d = await c.say(c.alonso, '/reviews');
      c.check('/reviews answers with a prompt', d.reply.trim().length > 0 && d.reply.trim().length < 300, d.reply.slice(0, 120));
    },
  },
  {
    id: 'N6',
    title: 'A very long message',
    async run(c) {
      const text = `Here is a long note. ${'The quick brown fox jumps over the lazy dog. '.repeat(450)}`;
      let ok = true;
      try {
        await c.say(c.alonso, text, { thread: c.thread('n'), timeoutMs: 240_000 });
      } catch (err) {
        ok = /413|too large|400/.test(String(err));
      }
      c.check('handled or refused cleanly', ok);
      c.check('Brain is still healthy', (await fetch(`${c.alonso.node.brain}/healthz`)).ok);
    },
  },
];
