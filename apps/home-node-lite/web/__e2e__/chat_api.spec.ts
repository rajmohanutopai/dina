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
 * Covers the two orchestrator paths the chat tab actually exercises
 * end-to-end today:
 *   - `/help`     — static slash-command listing, no Core needed
 *   - `/remember` — writes to Core's staging table via the
 *                   chat-remember runtime (paired-stack wired by
 *                   `playwright.config.ts`)
 *
 * `/ask` involves an LLM provider key + tool-calling loop and lives
 * behind a separate test sweep (and behind whichever provider key
 * CI has access to). That's a follow-on.
 *
 * Source: docs/HOME_NODE_LITE_WEB_UI_TASKS.md Phase 4 "Chat tab".
 */

import { expect, test, type APIRequestContext } from '@playwright/test';

import { readOwnerCapability } from './fixtures/backstage';
import { pairOwnerSigner, type OwnerSigner } from './fixtures/owner_signer';

// The page is Core-served; Brain's API is its own origin (the stack publishes it).
const BRAIN = process.env.DINA_E2E_BRAIN_URL ?? 'http://127.0.0.1:18299';
const CORE = `http://127.0.0.1:${process.env.DINA_CORE_E2E_PORT ?? 18298}`;

// Brain serves signed callers only (A2A design §4.1): these calls come from an
// owner device, paired through Core's owner routes as the web app pairs one.
let owner: OwnerSigner;
test.beforeAll(async () => {
  owner = await pairOwnerSigner(CORE, readOwnerCapability(), process.env.DINA_E2E_OWNER_PASSPHRASE ?? '');
});

/** POST JSON to Brain, signed by the owner device. */
function ownerPost(request: APIRequestContext, path: string, data: unknown) {
  const body = JSON.stringify(data);
  return request.post(`${BRAIN}${path}`, {
    headers: { 'content-type': 'application/json', ...owner.headers('POST', `${BRAIN}${path}`, body) },
    data: body,
  });
}

test('Brain refuses an unsigned caller, even on loopback', async ({ request }) => {
  const resp = await request.post(`${BRAIN}/api/v1/chat`, { data: { text: '/help', threadId: 'unsigned' } });
  expect(resp.status()).toBe(401);
});

test('POST /api/v1/chat with /help returns a non-empty ChatResponse', async ({ request }) => {
  const resp = await ownerPost(request, '/api/v1/chat', { text: '/help', threadId: 'phase-4-smoke' });
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
  const resp = await ownerPost(request, '/api/v1/chat', { text: '' });
  expect(resp.status()).toBe(400);
  const body = (await resp.json()) as { error: string };
  expect(typeof body.error).toBe('string');
});

test('POST /api/v1/chat with /remember writes a memory record and acknowledges', async ({
  request,
}) => {
  // /remember stages a memory in Core's `staging` table via the
  // chat-remember runtime (the wire that `boot.ts` sets up via
  // `wireChatRememberRuntime`). On the paired-stack the request
  // walks: browser → brain-server's /api/v1/chat → handleChat →
  // /remember handler → Core. We assert the round-trip ack here;
  // verifying the record actually landed in Core is a Core-side
  // integration concern already covered by Core's own staging tests.
  const resp = await ownerPost(request, '/api/v1/chat', {
      text: '/remember Emma loves dinosaurs',
      threadId: 'phase-4-remember',
    });
  expect(resp.status()).toBe(200);
  const body = (await resp.json()) as {
    intent: string;
    response: string;
    sources?: string[];
  };
  expect(typeof body.intent).toBe('string');
  // The /remember handler returns a human-readable acknowledgement;
  // the exact wording evolves with copy tweaks but every variant
  // confirms the memory landed (or the user can decide whether to
  // park it via approvals). Pin on the stable-affirmation vocabulary.
  expect(body.response).toMatch(/saved|remember|parked|noted|stored|got it|approval/i);
});

test('POST /api/v1/chat/reset clears a thread', async ({ request }) => {
  // Seed a message first so the reset has something to wipe.
  await ownerPost(request, '/api/v1/chat', { text: '/help', threadId: 'phase-4-reset' });
  const resp = await ownerPost(request, '/api/v1/chat/reset', { threadId: 'phase-4-reset' });
  expect(resp.status()).toBe(200);
  const body = (await resp.json()) as { ok: boolean };
  expect(body.ok).toBe(true);
});
