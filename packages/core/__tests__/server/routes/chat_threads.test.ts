/**
 * REAL_LIFE_FIXES §1.4 — chat thread storage for a split-process Brain.
 */

import { isAuthorized } from '../../../src/auth/authz';
import { InMemoryChatMessageRepository, setChatMessageRepository } from '../../../src/chat/repository';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerChatThreadRoutes } from '../../../src/server/routes/chat_threads';

function req(method: CoreRequest['method'], path: string, body?: unknown, query: Record<string, string> = {}): CoreRequest {
  const params: Record<string, string> = {};
  const m = /\/v1\/chat\/threads\/([^/]+)/.exec(path);
  if (m) params.id = decodeURIComponent(m[1]!);
  return {
    method,
    path,
    query,
    headers: {},
    body,
    rawBody: new TextEncoder().encode(JSON.stringify(body ?? {})),
    params,
    trustedInProcess: true,
    callerType: 'brain',
  };
}

const msg = (id: string, ts: number, content: string) => ({
  id,
  type: 'user',
  content,
  metadata: {},
  sources: [],
  timestamp: ts,
});

let router: CoreRouter;
beforeEach(() => {
  setChatMessageRepository(new InMemoryChatMessageRepository());
  router = new CoreRouter();
  registerChatThreadRoutes(router);
});
afterEach(() => setChatMessageRepository(null));

describe('/v1/chat/threads', () => {
  it('lists the NEWEST messages of a thread, oldest first', async () => {
    for (let i = 0; i < 30; i++) {
      await router.handle(req('POST', '/v1/chat/threads/t1/messages', msg(`m${i}`, 1000 + i, `c${i}`)));
    }
    const res = await router.handle(req('GET', '/v1/chat/threads/t1/messages', undefined, { limit: '5' }));
    const ids = (res.body as { messages: { id: string }[] }).messages.map((m) => m.id);
    expect(ids).toEqual(['m25', 'm26', 'm27', 'm28', 'm29']);
  });

  it('a deleted thread stays deleted', async () => {
    await router.handle(req('POST', '/v1/chat/threads/t2/messages', msg('a', 1, 'x')));
    await router.handle(req('DELETE', '/v1/chat/threads/t2'));
    const res = await router.handle(req('GET', '/v1/chat/threads/t2/messages'));
    expect((res.body as { messages: unknown[] }).messages).toEqual([]);
    const ids = await router.handle(req('GET', '/v1/chat/threads'));
    expect((ids.body as { threads: string[] }).threads).not.toContain('t2');
  });

  it('refuses a malformed message', async () => {
    const res = await router.handle(req('POST', '/v1/chat/threads/t3/messages', { id: 'x' }));
    expect(res.status).toBe(400);
  });

  it('is Brain-only', () => {
    expect(isAuthorized('brain', 'GET', '/v1/chat/threads/t1/messages')).toBe(true);
    expect(isAuthorized('device', 'GET', '/v1/chat/threads/t1/messages')).toBe(false);
    expect(isAuthorized('agent', 'POST', '/v1/chat/reset')).toBe(false);
  });
});
