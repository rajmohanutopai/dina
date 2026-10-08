/**
 * M. Privacy (docs/REAL_LIFE_SCENARIOS.md). Alonso's Brain is restarted with
 * `DINA_OPENROUTER_BASE_URL` pointing at a local recorder that forwards to
 * OpenRouter and keeps every request body in memory (never on disk), so the
 * checks see exactly what left the node.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { NODE_NAMES, readState, startNode, stopNode } from '../fleet';

import type { Ctx, Scenario } from '../scenario';

const RECORDER_PORT = 18999;
const sent: string[] = [];
let server: http.Server | null = null;

function startRecorder(): Promise<void> {
  if (server !== null) return Promise.resolve();
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (b: Buffer) => chunks.push(b));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      sent.push(body.toString('utf8'));
      const target = `https://openrouter.ai/api/v1${(req.url ?? '').replace(/^\/api\/v1/, '')}`;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !['host', 'content-length', 'connection'].includes(k)) headers[k] = v;
      fetch(target, { method: req.method ?? 'POST', headers, ...(body.length > 0 ? { body } : {}) })
        .then(async (up) => {
          res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
          res.end(Buffer.from(await up.arrayBuffer()));
        })
        .catch(() => {
          res.writeHead(502);
          res.end();
        });
    });
  });
  return new Promise((resolve) => server?.listen(RECORDER_PORT, '127.0.0.1', () => resolve()));
}

let recording = false;

/** Restart Alonso with his model traffic going through the recorder. */
async function record(c: Ctx): Promise<void> {
  if (recording) return;
  await startRecorder();
  stopNode('alonso');
  await c.sleep(3_000);
  await startNode('alonso', { brain: { DINA_OPENROUTER_BASE_URL: `http://127.0.0.1:${RECORDER_PORT}/api/v1` } });
  recording = true;
}

/** Back to the direct path; called after area M. */
export async function stopRecording(): Promise<void> {
  if (!recording) return;
  stopNode('alonso');
  await new Promise((r) => setTimeout(r, 3_000));
  await startNode('alonso');
  recording = false;
  server?.close();
  server = null;
}

export const areaM: Scenario[] = [
  {
    id: 'M1',
    title: 'Known names never reach the model',
    async run(c) {
      await record(c);
      await c.say(c.alonso, '/remember Ottilie is allergic to hazelnuts');
      sent.length = 0;
      const q = 'What is Ottilie allergic to?';
      const r = await c.say(c.alonso, q, { thread: c.thread('m') });
      c.check('the model was called through the recorder', sent.length > 0, String(sent.length));
      c.check('"Ottilie" never left the node', !sent.some((b) => b.includes('Ottilie')));
      c.check('a person token went instead', sent.some((b) => b.includes('[PERSON_')));
      c.expectReply('the answer names Ottilie', r.reply, /Ottilie/);
      // Brain refreshes its names list every 30 s (NAME_LEXICON_REFRESH_MS); ask again after that.
      await new Promise((res) => setTimeout(res, 31_000));
      sent.length = 0;
      await c.say(c.alonso, 'Remind me, what is Ottilie allergic to?', { thread: c.thread('m') });
      await new Promise((res) => setTimeout(res, 1_000));
      sent.length = 0;
      await c.say(c.alonso, 'And is Ottilie allergic to anything else?', { thread: c.thread('m') });
      c.check('after the refresh, "Ottilie" stays on the node', sent.length > 0 && !sent.some((b) => b.includes('Ottilie')), String(sent.length));
    },
  },
  {
    id: 'M2',
    title: 'Email and phone never reach the model',
    async run(c) {
      await record(c);
      await c.say(c.alonso, '/remember the plumber is reachable at fixit.harbour@example.com or +44 7700 900456');
      sent.length = 0;
      const q = "What are the plumber's email and phone number?";
      const r = await c.say(c.alonso, q, { thread: c.thread('m') });
      c.check('the email never left the node', !sent.some((b) => b.includes('fixit.harbour@example.com')));
      c.check('the phone never left the node', !sent.some((b) => b.includes('900456')));
      c.check('the answer has the real email', r.reply.includes('fixit.harbour@example.com'), r.reply.slice(0, 160));
    },
  },
  {
    id: 'M3',
    title: 'No planted values in any log',
    async run(c) {
      const state = readState();
      if (state === null) throw new Error('no fleet');
      const planted = ['533812947', '900123', '900456', 'fixit.harbour@example.com', 'Fenwick', 'HbA1c came back 6.1', 'account ends 0102'];
      const logs = NODE_NAMES.flatMap((n) => ['core.log', 'brain.log'].map((f) => path.join(state.nodes[n].dir, f)))
        .filter((f) => fs.existsSync(f))
        .map((f) => fs.readFileSync(f, 'utf8'))
        .join('\n');
      for (const v of planted) c.check(`"${v}" not in the logs`, !logs.includes(v));
    },
  },
  {
    id: 'M4',
    title: 'A delegated task carries no raw values',
    mark: 'phone',
    reason: '/task → delegate_to_agent is wired only in the phone app (unit-tested in delegate_agent_tool.test.ts)',
    async run() {},
  },
  {
    id: 'M5',
    title: 'Two people, two emails',
    async run(c) {
      await record(c);
      await c.say(c.alonso, '/remember Bettina\'s email is bettina.k@example.org');
      await c.say(c.alonso, '/remember Corvin\'s email is corvin.r@example.net');
      sent.length = 0;
      const q = "What are Bettina's and Corvin's email addresses?";
      const r = await c.say(c.alonso, q, { thread: c.thread('m') });
      c.check('neither address left the node', !sent.some((b) => b.includes('bettina.k@') || b.includes('corvin.r@')));
      c.check("Bettina's address is given as hers", /Bettina[^.\n]*bettina\.k@example\.org/.test(r.reply) || /bettina\.k@example\.org[^.\n]*Bettina/.test(r.reply), r.reply.slice(0, 200));
      c.check("Corvin's address is given as his", /Corvin[^.\n]*corvin\.r@example\.net/.test(r.reply) || /corvin\.r@example\.net[^.\n]*Corvin/.test(r.reply), r.reply.slice(0, 200));
    },
  },
];
