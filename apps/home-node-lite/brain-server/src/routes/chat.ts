/**
 * `/api/v1/chat` route — wraps the same `handleChat` orchestrator the
 * mobile app uses (`packages/brain/src/chat/orchestrator.ts`). Mobile
 * calls it in-process; this server exposes it over HTTP so a
 * browser-based dev UI can drive `/remember` + `/ask` flows without
 * a mobile build. Zero code duplication: orchestrator owns the logic,
 * this file is a 30-line HTTP shim.
 *
 * Routes:
 *   POST /api/v1/chat               → { text, threadId? }   → ChatResponse
 *   POST /api/v1/chat/reset         → wipes a thread (dev convenience)
 *
 * Plus the dev UI itself at GET /dev — a single self-contained HTML
 * page that calls these endpoints. Lives behind a flag in `boot.ts`
 * so production deployments don't accidentally expose it.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md follow-up — Emma personalization
 * test loop without the mobile dev-client.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { handleChat, deleteThread } from '@dina/brain/chat';

export interface RegisterChatRoutesOptions {
  /** Route prefix override (defaults to `/api/v1`). */
  prefix?: string;
  /** When true, also exposes `GET /dev` serving the inline dev UI.
   *  Defaults to false — operators turn it on explicitly. */
  exposeDevUI?: boolean;
}

interface ChatBody {
  text?: unknown;
  threadId?: unknown;
}

interface ResetBody {
  threadId?: unknown;
}

export function registerChatRoutes(
  app: FastifyInstance,
  opts: RegisterChatRoutesOptions = {},
): void {
  const prefix = opts.prefix ?? '/api/v1';

  app.post(
    `${prefix}/chat`,
    async (req: FastifyRequest<{ Body: ChatBody }>, reply: FastifyReply) => {
      const body = req.body ?? {};
      if (typeof body.text !== 'string' || body.text.trim() === '') {
        return reply.status(400).send({ error: 'text must be a non-empty string' });
      }
      const threadId = typeof body.threadId === 'string' ? body.threadId : undefined;
      try {
        const resp = await handleChat(body.text, threadId);
        return reply.status(200).send(resp);
      } catch (err) {
        // Bubble the error message — this is a dev surface, not a
        // sensitive customer-facing API. Trace lives in the brain
        // logs; the dev UI shows the message verbatim so the
        // operator can iterate without tailing logs in another tab.
        return reply.status(500).send({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.post(
    `${prefix}/chat/reset`,
    async (req: FastifyRequest<{ Body: ResetBody }>, reply: FastifyReply) => {
      const body = req.body ?? {};
      const threadId = typeof body.threadId === 'string' ? body.threadId : 'main';
      const removed = deleteThread(threadId);
      return reply.status(200).send({ ok: true, removed });
    },
  );

  if (opts.exposeDevUI === true) {
    app.get('/dev', async (_req, reply) => {
      reply.header('content-type', 'text/html; charset=utf-8');
      return reply.send(DEV_UI_HTML);
    });
  }
}

const DEV_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dina — Dev Chat</title>
  <style>
    :root {
      --bg: #F9F2EC;
      --ink: #1f2933;
      --muted: #5c6773;
      --user: #dde7ee;
      --dina: #fff7ed;
      --accent: #3b82f6;
      --border: #d4c8b8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
      background: var(--bg);
      color: var(--ink);
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    header {
      padding: 12px 20px;
      border-bottom: 1px solid var(--border);
      background: rgba(255,255,255,0.6);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    header h1 { margin: 0; font-size: 16px; font-weight: 600; }
    header .meta { color: var(--muted); font-size: 12px; }
    .thread {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .msg {
      max-width: 70%;
      padding: 10px 14px;
      border-radius: 14px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .msg.user { align-self: flex-end; background: var(--user); }
    .msg.dina { align-self: flex-start; background: var(--dina); border: 1px solid var(--border); }
    .msg.error { align-self: stretch; background: #ffe5e5; color: #7c2d12; }
    .msg .role { font-size: 11px; color: var(--muted); margin-bottom: 4px; }
    footer {
      padding: 14px 20px;
      border-top: 1px solid var(--border);
      background: rgba(255,255,255,0.6);
      display: flex;
      gap: 8px;
    }
    footer input {
      flex: 1;
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: 20px;
      font: inherit;
      background: white;
    }
    footer button {
      padding: 10px 18px;
      border: none;
      background: var(--accent);
      color: white;
      border-radius: 20px;
      font: inherit;
      cursor: pointer;
    }
    footer button:disabled { background: #94a3b8; cursor: not-allowed; }
    .hint { font-size: 12px; color: var(--muted); margin-top: 6px; }
  </style>
</head>
<body>
  <header>
    <h1>Dina — Dev Chat</h1>
    <span class="meta">thread: <span id="thread-id">main</span></span>
  </header>
  <div id="thread" class="thread"></div>
  <footer>
    <input id="input" placeholder="/remember … or /ask …" autocomplete="off" autofocus />
    <button id="send">Send</button>
    <button id="reset" style="background:#94a3b8">Reset</button>
  </footer>
  <script>
    const threadEl = document.getElementById('thread');
    const inputEl = document.getElementById('input');
    const sendBtn = document.getElementById('send');
    const resetBtn = document.getElementById('reset');
    const threadId = 'main';
    document.getElementById('thread-id').textContent = threadId;

    function addMsg(role, text, klass) {
      const div = document.createElement('div');
      div.className = 'msg ' + (klass || role);
      const r = document.createElement('div');
      r.className = 'role';
      r.textContent = role;
      div.appendChild(r);
      const t = document.createElement('div');
      t.textContent = text;
      div.appendChild(t);
      threadEl.appendChild(div);
      threadEl.scrollTop = threadEl.scrollHeight;
    }

    async function send() {
      const text = inputEl.value.trim();
      if (text === '') return;
      inputEl.value = '';
      sendBtn.disabled = true;
      addMsg('you', text, 'user');
      try {
        const res = await fetch('/api/v1/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, threadId }),
        });
        const data = await res.json();
        if (!res.ok) {
          addMsg('error', data.error || 'request failed', 'error');
        } else {
          addMsg('dina', data.response || JSON.stringify(data));
        }
      } catch (err) {
        addMsg('error', String(err), 'error');
      } finally {
        sendBtn.disabled = false;
        inputEl.focus();
      }
    }

    async function reset() {
      threadEl.innerHTML = '';
      await fetch('/api/v1/chat/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId }),
      });
    }

    sendBtn.addEventListener('click', send);
    resetBtn.addEventListener('click', reset);
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  </script>
</body>
</html>`;
