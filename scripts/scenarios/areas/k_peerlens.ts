/**
 * K. PeerLens and shopping (docs/REAL_LIFE_SCENARIOS.md). Sancho's agent
 * (coding scope) publishes a review through the real attest path: Sancho
 * approves the card, the status poll publishes it to his PDS, and
 * test-appview indexes it from Jetstream.
 */

import { Agent } from '../client';

import type { Scenario } from '../scenario';

let product = '';

export const areaK: Scenario[] = [
  {
    id: 'K1',
    title: 'No reviews yet',
    async run(c) {
      const r = await c.say(c.alonso, `/reviews Quokka Brand Folding Ladder ${c.tag}`, { thread: c.thread('k') });
      c.expectReply('says there are no network reviews', r.reply, /no network reviews|don't have any network reviews|no reviews/i);
    },
  },
  {
    id: 'K2',
    title: "A friend's review shows up",
    async run(c) {
      product = `Faroe Oak Stool ${c.tag}`;
      const agent = await Agent.pair(c.sancho, 'sancho-reviewer', 'coding');
      const session = await agent.startSession(`k2-${c.tag}`);
      const requestId = `k2${c.tag}review`;
      const att = await agent.call('POST', '/v1/agent/peerlens/attest', {
        body: {
          session_id: session,
          request_id: requestId,
          record: { subject: { type: 'product', name: product }, category: 'furniture', sentiment: 'positive', text: `Solid oak, sturdy and comfortable; I use the ${product} every day.` },
        },
      });
      c.check('the review is submitted for approval', att.status === 202, `${att.status} ${JSON.stringify(att.body).slice(0, 160)}`);
      const taskId = String(att.body?.task_id ?? '');
      if (taskId !== '') await c.sancho.core('POST', `/v1/workflow/tasks/${encodeURIComponent(taskId)}/approve`, { body: {} });
      const published = await c.eventually(async () => {
        const s = await agent.call('POST', '/v1/agent/peerlens/status', { body: { session_id: session, request_id: requestId } });
        return s.body?.publish_status === 'published' ? s.body : undefined;
      }, 120_000, 3_000);
      c.check('published to Sancho\'s PDS', published !== undefined);
      const found = await c.eventually(async () => {
        const res = await fetch(`https://test-appview.dinakernel.com/xrpc/com.dinakernel.peerlens.search?q=${encodeURIComponent(product)}`).catch(() => null);
        return res !== null && (await res.text()).includes(c.tag) ? true : undefined;
      }, 180_000, 5_000);
      c.check('test-appview indexed it', found === true);
      const q = `/reviews ${product}`;
      const r = await c.say(c.alonso, q, { thread: c.thread('k') });
      await c.judge('Alonso sees the review', q, r.reply, `The reply reports a positive review of the ${product} (sturdy, comfortable, solid oak).`);
    },
  },
  {
    id: 'K3',
    title: 'Drafting a review',
    mark: 'phone',
    reason: 'draft_review is wired only in the phone app',
    async run() {},
  },
  {
    id: 'K4',
    title: 'A shopping comparison',
    mark: 'harness',
    reason: 'needs catalogue offers on test-appview for a known product; none are seeded by this runner',
    async run() {},
  },
  {
    id: 'K5',
    title: 'A shop search with private context',
    mark: 'harness',
    reason: 'the fleet runs with UCP off (it needs the profile host); the UCP buyer has its own end-to-end suites',
    async run() {},
  },
  {
    id: 'K6',
    title: 'Checkout hand-off',
    mark: 'gap',
    async run(c) {
      c.check('a live UCP merchant on the test fleet', false, 'none exists yet (docs/TODO.md, UCP)');
    },
  },
];
