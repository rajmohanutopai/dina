/**
 * OpenClaw capabilities E2E — pins the CAPABILITIES.md scenarios for
 * `dina validate` (intent gate) and `dina ask` (vault recall).
 *
 * Source contracts (CAPABILITIES.md, “She Guards Your Agents” + “She
 * Recalls Your Memory”):
 *
 *   $ dina validate --session $S search "best ergonomic chair"
 *   status: approved   risk: SAFE
 *
 *   $ dina validate --session $S send_email "draft resignation letter to HR"
 *   status: pending_approval   risk: MODERATE
 *
 *   $ dina validate --session $S transfer_money "500 to vendor account"
 *   status: pending_approval   risk: HIGH
 *
 *   $ dina validate --session $S read_vault "health records"
 *   status: denied   risk: BLOCKED
 *
 *   # earlier:
 *   /remember My bank account is in Barclay's and ends with 0102
 *   # then:
 *   $ dina ask --session $S "Which bank has my account"
 *   → "Your account is with Barclay's (ending in 0102)."
 *
 * What this test exercises end-to-end
 * -----------------------------------
 * - `evaluateIntent` (TS Lite Core gatekeeper) returns the docs-spec'd
 *   `riskLevel` + `allowed` + `requiresApproval` for each of the four
 *   action names main Dina's CLI passes over MCP.
 * - The `/remember → drain → /ask` round-trip surfaces the bank fact
 *   in the answer. Real Gemini classifier + agentic /ask, real
 *   SQLCipher vault — same composition mobile uses.
 *
 * The validate scenarios run unconditionally (pure-function intent
 * eval). The ask scenario gates on `GEMINI_API_KEY` because the real
 * agentic loop needs an LLM round-trip.
 */

import { evaluateIntent } from '../../../core/src/gatekeeper/intent';

import {
  handleChat,
  setRememberDrainHook,
  resetRememberDrainHook,
  resetAskCommandHandler,
  setAskCommandHandler,
} from '../../src/chat/orchestrator';
import { GeminiGenaiAdapter } from '../../src/llm/adapters/gemini_genai';
import { LLMRouter, RoutedLLMProvider } from '../../src/llm/router_dispatch';
import { createGeminiClassifier } from '../../src/routing/gemini_classify';
import {
  registerPersonaSelector,
  resetPersonaSelector,
} from '../../src/routing/persona_selector';
import { ToolRegistry } from '../../src/reasoning/tool_registry';
import { createVaultSearchTool } from '../../src/reasoning/vault_tool';
import { makeAgenticAskHandler } from '../../src/reasoning/ask_handler';
import { StagingDrainScheduler } from '../../src/staging/scheduler';
import {
  resetReasoningProvider,
  setAccessiblePersonas,
} from '../../src/vault_context/assembly';

import { clearVaults } from '../../../core/src/vault/crud';
import {
  resetStagingState,
  getItem as getStagingItem,
} from '../../../core/src/staging/service';
import {
  createPersona,
  openPersona,
  resetPersonaState,
} from '../../../core/src/persona/service';
import { configureRateLimiter } from '../../../core/src/auth/middleware';
import { createCoreRouter } from '../../../core/src/server/core_server';
import { InProcessTransport } from '../../../core/src/client/in-process-transport';

import {
  closeSQLiteVault,
  openSQLiteVault,
  type SQLiteVaultHandle,
} from './helpers/sqlite_vault_harness';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';

// ─────────────────────────────────────────────────────────────────────
// Part 1 — `dina validate` scenarios (pure intent eval, no LLM)
// ─────────────────────────────────────────────────────────────────────

describe('OpenClaw `dina validate` (CAPABILITIES.md “She Guards Your Agents”)', () => {
  it('search → SAFE / approved (no approval needed)', () => {
    const d = evaluateIntent('search');
    expect(d.riskLevel).toBe('SAFE');
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(false);
  });

  it('send_email → MODERATE / pending_approval', () => {
    const d = evaluateIntent('send_email');
    expect(d.riskLevel).toBe('MODERATE');
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(true);
  });

  it('transfer_money → HIGH / pending_approval', () => {
    const d = evaluateIntent('transfer_money');
    expect(d.riskLevel).toBe('HIGH');
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(true);
  });

  it('read_vault → BLOCKED / denied', () => {
    const d = evaluateIntent('read_vault');
    expect(d.riskLevel).toBe('BLOCKED');
    expect(d.allowed).toBe(false);
    // BLOCKED actions do not surface as `requiresApproval` — they're
    // denied outright; no user interaction will flip the answer.
    expect(d.requiresApproval).toBe(false);
  });

  it('every non-SAFE decision is auditable', () => {
    expect(evaluateIntent('search').audit).toBe(false);
    for (const action of ['send_email', 'transfer_money', 'read_vault']) {
      expect(evaluateIntent(action).audit).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Part 2 — `dina ask` scenario (real LLM round-trip)
// ─────────────────────────────────────────────────────────────────────

const describeReal = GEMINI_API_KEY ? describe : describe.skip;

describeReal('OpenClaw `dina ask` (CAPABILITIES.md bank-account recall)', () => {
  const handles: SQLiteVaultHandle[] = [];
  let scheduler: StagingDrainScheduler;

  // The brain `__tests__/setup.ts` runs `clearVaults(DEFAULT_TEST_PERSONAS)`
  // before EVERY test. That re-seeds in-memory repos for the 9 default
  // personas — overwriting whatever we wired in `beforeAll`. So we
  // re-pin SQLite for `general` + `finance` in `beforeEach` AFTER
  // setup.ts runs.
  beforeAll(() => {
    resetStagingState();
    resetPersonaState();
    resetPersonaSelector();
    configureRateLimiter({ maxRequests: 10_000, windowSeconds: 60 });

    for (const p of ['general', 'finance'] as const) {
      const tier = p === 'finance' ? 'sensitive' : 'default';
      createPersona(p, tier, `${p} persona`);
      openPersona(p, /* approved */ true);
    }
    setAccessiblePersonas(['general', 'finance']);

    // Real Gemini — classifier (drain) + agentic /ask handler.
    const rawProvider = new GeminiGenaiAdapter({ apiKey: GEMINI_API_KEY });
    const router = new LLMRouter({
      providers: { gemini: rawProvider },
      config: {
        localAvailable: false,
        cloudProviders: ['gemini'],
        sensitivePersonas: ['health', 'financial', 'finance'],
        cloudConsentGranted: true,
      },
    });
    const classifierProvider = new RoutedLLMProvider({
      router,
      taskType: 'classify',
      label: 'routed:classify:openclaw-ask-test',
    });
    registerPersonaSelector(createGeminiClassifier(classifierProvider));

    const askProvider = new RoutedLLMProvider({
      router,
      taskType: 'reason',
      label: 'routed:reason:openclaw-ask-test',
    });
    const tools = new ToolRegistry();
    tools.register(createVaultSearchTool());
    setAskCommandHandler(makeAgenticAskHandler({ provider: askProvider, tools }));

    // Production drain hook — drives runTick until OUR row reaches
    // `stored`, identical shape to bootstrap.ts:815.
    const core = new InProcessTransport(createCoreRouter());
    scheduler = new StagingDrainScheduler({
      core,
      intervalMs: 10_000,
      setInterval: () => 1,
      clearInterval: () => {
        /* noop */
      },
    });
    setRememberDrainHook(async (stagingId) => {
      for (let i = 0; i < 5; i++) {
        await scheduler.runTick();
        const item = getStagingItem(stagingId);
        if (item !== null && item.status === 'stored' && item.persona) {
          return { persona: item.persona };
        }
      }
      return { persona: null };
    });
  });

  beforeEach(() => {
    // Re-pin SQLite vaults AFTER `setup.ts` has run its global
    // `clearVaults(DEFAULT_TEST_PERSONAS)` beforeEach hook. Without
    // this, every test in this block starts with in-memory repos
    // and the drain row vanishes between describes.
    while (handles.length > 0) {
      closeSQLiteVault(handles.pop()!);
    }
    for (const p of ['general', 'finance'] as const) {
      handles.push(openSQLiteVault(p));
    }
  });

  afterAll(() => {
    scheduler?.stop();
    resetRememberDrainHook();
    resetAskCommandHandler();
    resetReasoningProvider();
    resetPersonaSelector();
    while (handles.length > 0) {
      closeSQLiteVault(handles.pop()!);
    }
  });

  it(
    "/remember bank account → /ask 'which bank' surfaces Barclay's",
    async () => {
      const remember = await handleChat(
        "/remember My bank account is in Barclay's and ends with 0102",
      );
      expect(remember.intent).toBe('remember');
      expect(remember.response).toMatch(/Stored in (Finance|General) vault\./i);

      const ask = await handleChat('/ask Which bank has my account');
      expect(ask.intent).toBe('ask');
      expect(ask.response).not.toBe('');
      // Recall — case-insensitive substring. Either the bank name or
      // the last-4 of the account number is sufficient evidence the
      // LLM read the row out of the SQLite vault.
      const haystack = ask.response.toLowerCase();
      const recalled = haystack.includes('barclay') || haystack.includes('0102');
      if (!recalled) {
        // eslint-disable-next-line no-console
        console.log(`[openclaw-ask] response did not recall bank fact:\n  ${ask.response}`);
      }
      expect(recalled).toBe(true);
    },
    60_000,
  );
});

if (!GEMINI_API_KEY) {
  describe('OpenClaw `dina ask` (skipped)', () => {
    it('skipped: set GEMINI_API_KEY or GOOGLE_API_KEY to run', () => {
      expect(GEMINI_API_KEY).toBe('');
    });
  });
}
