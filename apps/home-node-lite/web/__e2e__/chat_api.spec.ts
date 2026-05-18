/**
 * Phase 4 chat-API smoke — proves the brain-server's chat orchestrator
 * is reachable through the live HTTP surface (not just via Fastify's
 * `inject`, which the unit tests in `brain-server/__tests__` already
 * cover).
 *
 * Why a Playwright test for an HTTP-only check? Because the same
 * test runner already boots brain-server via the `webServer` block
 * — adding the API smoke here costs us nothing and proves the
 * surface mobile chat hooks would call (`useChatThread.ts` POSTs to
 * `/api/v1/chat`) actually responds.
 *
 * Scope deliberately stops at the `/help` command — that's the
 * orchestrator path that does NOT need Core wired in. /remember and
 * /ask hit the vault + LLM and need core-server next to brain-server;
 * a future CI matrix can layer those on once we ship a paired-stack
 * webServer config.
 *
 * Source: docs/HOME_NODE_LITE_WEB_UI_TASKS.md Phase 4 "Chat tab".
 */

import { expect, test } from '@playwright/test';

test('POST /api/v1/chat with /help returns a non-empty ChatResponse', async ({ request }) => {
  const resp = await request.post('/api/v1/chat', {
    data: { text: '/help', threadId: 'phase-4-smoke' },
  });
  expect(resp.status()).toBe(200);
  const body = (await resp.json()) as { intent: string; response: string };
  expect(typeof body.intent).toBe('string');
  expect(typeof body.response).toBe('string');
  expect(body.response.length).toBeGreaterThan(0);
  // The /help reply is a static slash-command listing — pin the
  // first command we expect to see so a future intent-classifier
  // change can't silently swap the help page for something else.
  expect(body.response).toMatch(/remember|ask|help/i);
});

test('POST /api/v1/chat rejects empty text with 400 (input validation)', async ({ request }) => {
  const resp = await request.post('/api/v1/chat', {
    data: { text: '' },
  });
  expect(resp.status()).toBe(400);
  const body = (await resp.json()) as { error: string };
  expect(typeof body.error).toBe('string');
});

test('POST /api/v1/chat/reset clears a thread', async ({ request }) => {
  // Seed a message first so the reset has something to wipe.
  await request.post('/api/v1/chat', {
    data: { text: '/help', threadId: 'phase-4-reset' },
  });
  const resp = await request.post('/api/v1/chat/reset', {
    data: { threadId: 'phase-4-reset' },
  });
  expect(resp.status()).toBe(200);
  const body = (await resp.json()) as { ok: boolean };
  expect(body.ok).toBe(true);
});
