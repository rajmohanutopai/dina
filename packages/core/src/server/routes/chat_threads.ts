/**
 * Chat thread storage for a split-process Brain (REAL_LIFE_FIXES §1.4).
 *
 * The phone's Brain writes chat messages straight into Core's
 * `chat_messages` table (one VM). On the server, Brain is a separate
 * process that never opens SQLite, so it reaches the same table through
 * these brain-only routes. The routes implement the whole
 * `ChatMessageRepository` contract, so a cleared thread is deleted for good
 * and a restarted Brain reads its threads back.
 *
 *   POST   /v1/chat/threads/:id/messages          append (upsert on id)
 *   GET    /v1/chat/threads/:id/messages?limit=   newest `limit`, oldest first
 *   GET    /v1/chat/threads                       thread ids
 *   DELETE /v1/chat/threads/:id                   delete a thread
 *   POST   /v1/chat/reset                         delete everything
 */

import { getChatMessageRepository, type StoredChatMessage } from '../../chat/repository';

import type { CoreRouter } from '../router';

export const CHAT_THREADS = '/v1/chat/threads';
export const CHAT_RESET = '/v1/chat/reset';

const MAX_LIMIT = 500;
const MAX_CONTENT_CHARS = 200_000;

function readMessage(threadId: string, raw: unknown): StoredChatMessage | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || m.id === '' || m.id.length > 256) return null;
  if (typeof m.type !== 'string' || m.type === '' || m.type.length > 64) return null;
  if (typeof m.content !== 'string' || m.content.length > MAX_CONTENT_CHARS) return null;
  if (typeof m.timestamp !== 'number' || !Number.isFinite(m.timestamp)) return null;
  const metadata =
    m.metadata !== null && typeof m.metadata === 'object' && !Array.isArray(m.metadata)
      ? (m.metadata as Record<string, unknown>)
      : {};
  const sources = Array.isArray(m.sources)
    ? (m.sources as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  return { id: m.id, threadId, type: m.type, content: m.content, metadata, sources, timestamp: m.timestamp };
}

export function registerChatThreadRoutes(router: CoreRouter): void {
  router.post(`${CHAT_THREADS}/:id/messages`, async (req) => {
    const repo = getChatMessageRepository();
    if (repo === null) return { status: 503, body: { error: 'chat storage not wired' } };
    const threadId = req.params.id ?? '';
    if (threadId === '') return { status: 400, body: { error: 'thread id required' } };
    const msg = readMessage(threadId, req.body);
    if (msg === null) return { status: 400, body: { error: 'invalid chat message' } };
    await repo.append(msg);
    return { status: 200, body: { ok: true } };
  });

  router.get(`${CHAT_THREADS}/:id/messages`, async (req) => {
    const repo = getChatMessageRepository();
    if (repo === null) return { status: 503, body: { error: 'chat storage not wired' } };
    const threadId = req.params.id ?? '';
    if (threadId === '') return { status: 400, body: { error: 'thread id required' } };
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_LIMIT) : MAX_LIMIT;
    // The repository's own LIMIT keeps the OLDEST rows; history needs the
    // newest, so read the thread and keep its tail (oldest first).
    const all = await repo.listByThread(threadId);
    return { status: 200, body: { messages: all.slice(-limit) } };
  });

  router.get(CHAT_THREADS, async () => {
    const repo = getChatMessageRepository();
    if (repo === null) return { status: 503, body: { error: 'chat storage not wired' } };
    return { status: 200, body: { threads: await repo.listThreadIds() } };
  });

  router.delete(`${CHAT_THREADS}/:id`, async (req) => {
    const repo = getChatMessageRepository();
    if (repo === null) return { status: 503, body: { error: 'chat storage not wired' } };
    const threadId = req.params.id ?? '';
    if (threadId === '') return { status: 400, body: { error: 'thread id required' } };
    return { status: 200, body: { deleted: await repo.deleteThread(threadId) } };
  });

  router.post(CHAT_RESET, async () => {
    const repo = getChatMessageRepository();
    if (repo === null) return { status: 503, body: { error: 'chat storage not wired' } };
    await repo.reset();
    return { status: 200, body: { ok: true } };
  });
}
