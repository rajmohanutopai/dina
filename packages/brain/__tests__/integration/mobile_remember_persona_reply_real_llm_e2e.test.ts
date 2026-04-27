/**
 * `/remember` reply pins — real Gemini classifier, real SQLCipher.
 *
 * Pins the docs/capabilities.md example flow:
 *
 *     You: /remember My friend James loves craft beer
 *     Dina: Stored in General vault.
 *
 *     You: /remember My bank account is in Barclay's and ends with 0102
 *     Dina: Stored in Financial vault.
 *
 *     You: /remember My HbA1c is 9%, very high
 *     Dina: Stored in Health vault.
 *
 * The reply text comes from `chat/orchestrator.ts::handleRemember` and
 * its inline `setRememberDrainHook` integration: when a drain hook is
 * wired, `/remember` waits for the staging row to reach `stored` and
 * reports the persona it landed in. Mobile bootstrap installs this
 * hook (see `apps/mobile/src/services/bootstrap.ts:815`).
 *
 * Why this test exists
 * --------------------
 * The orchestrator unit test `__tests__/chat/orchestrator.test.ts`
 * already pins the reply *string template* with a stubbed drain hook.
 * What this E2E adds: the persona name in the reply comes from a
 * REAL Gemini classification — i.e., it's not "Stored in general
 * vault." for everything because we hardcoded `general`, but a real
 * routing decision the LLM made. The docs-example flow only works
 * end-to-end when:
 *   1. The classifier picks the right persona for the input text.
 *   2. The drain runs that classified item into the corresponding
 *      SQLite vault.
 *   3. The orchestrator's drain hook reads back the persona name
 *      and embeds it in the reply.
 *
 * Env
 *   GEMINI_API_KEY | GOOGLE_API_KEY — required. Skipped without a key.
 */

import {
  handleChat,
  setRememberDrainHook,
  resetRememberDrainHook,
} from '../../src/chat/orchestrator';
import { GeminiGenaiAdapter } from '../../src/llm/adapters/gemini_genai';
import { LLMRouter, RoutedLLMProvider } from '../../src/llm/router_dispatch';
import { createGeminiClassifier } from '../../src/routing/gemini_classify';
import {
  registerPersonaSelector,
  resetPersonaSelector,
} from '../../src/routing/persona_selector';
import { StagingDrainScheduler } from '../../src/staging/scheduler';

import {
  clearVaults,
  DEFAULT_TEST_PERSONAS,
} from '../../../core/src/vault/crud';
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

interface Scenario {
  label: string;
  remember: string;
  /** Expected persona — Dina's reply must say `Stored in <expected> vault.` */
  expectedPersona: 'general' | 'financial' | 'health';
}

/**
 * Three scenarios from `docs/capabilities.md`. The classifier is
 * constrained to `['general', 'financial', 'health']` (the personas
 * we register here), so it must pick one of these — the test pins
 * which.
 */
const SCENARIOS: Scenario[] = [
  {
    label: 'general — friend liking craft beer',
    remember: 'My friend James loves craft beer',
    expectedPersona: 'general',
  },
  {
    label: 'financial — Barclays bank account',
    remember: "My bank account is in Barclay's and ends with 0102",
    expectedPersona: 'financial',
  },
  {
    label: 'health — HbA1c reading',
    remember: 'My HbA1c is 9%, very high',
    expectedPersona: 'health',
  },
];

const describeReal = GEMINI_API_KEY ? describe : describe.skip;

describeReal('/remember reply pins persona name (real Gemini + real SQLCipher)', () => {
  const handles: SQLiteVaultHandle[] = [];
  let scheduler: StagingDrainScheduler;

  beforeAll(() => {
    // Mobile-faithful initial state: only the personas we explicitly
    // create + open are available. Three SQLite vaults — `general`,
    // `financial`, `health` — match the docs-example scenario.
    clearVaults([]);
    resetStagingState();
    resetPersonaState();
    resetPersonaSelector();
    configureRateLimiter({ maxRequests: 10_000, windowSeconds: 60 });

    for (const p of ['general', 'financial', 'health'] as const) {
      const tier = p === 'health' ? 'sensitive' : 'default';
      createPersona(p, tier, `${p} persona`);
      openPersona(p, /* approved */ true);
      handles.push(openSQLiteVault(p));
    }

    // Real Gemini persona selector — same composition as
    // `boot_capabilities.ts:225` (RoutedLLMProvider tagged `classify`
    // → lite tier).
    const rawProvider = new GeminiGenaiAdapter({ apiKey: GEMINI_API_KEY });
    const router = new LLMRouter({
      providers: { gemini: rawProvider },
      config: {
        localAvailable: false,
        cloudProviders: ['gemini'],
        sensitivePersonas: ['health', 'financial'],
        cloudConsentGranted: true,
      },
    });
    const classifierProvider = new RoutedLLMProvider({
      router,
      taskType: 'classify',
      label: 'routed:classify:remember-reply-test',
    });
    registerPersonaSelector(createGeminiClassifier(classifierProvider));

    // Build the in-process Core client — same surface mobile uses.
    const core = new InProcessTransport(createCoreRouter());

    // Drain scheduler with a manual-tick configuration.
    scheduler = new StagingDrainScheduler({
      core,
      intervalMs: 10_000,
      setInterval: () => 1,
      clearInterval: () => {
        /* noop */
      },
    });

    // Production drain hook — same shape `bootstrap.ts:815-829`
    // installs. Drives `runTick()` up to a small retry budget until
    // the staging row reaches `stored`, then reports its persona so
    // `handleRemember` can write `Stored in <persona> vault.` into
    // the reply.
    setRememberDrainHook(async (stagingId) => {
      const MAX_ATTEMPTS = 5;
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await scheduler.runTick();
        const item = getStagingItem(stagingId);
        if (item !== null && item.status === 'stored' && item.persona) {
          return { persona: item.persona };
        }
      }
      return { persona: null };
    });
  });

  afterAll(() => {
    scheduler?.stop();
    resetRememberDrainHook();
    resetPersonaSelector();
    while (handles.length > 0) {
      closeSQLiteVault(handles.pop()!);
    }
  });

  it.each(SCENARIOS)(
    '$label — Dina replies "Stored in $expectedPersona vault."',
    async (scenario: Scenario) => {
      const resp = await handleChat(`/remember ${scenario.remember}`);

      expect(resp.intent).toBe('remember');

      // The exact docs-example sentence. If this fails the diagnostic
      // payload below shows what Dina actually said + which persona
      // the LLM picked, so the failure tells you whether the bug is
      // in classification (LLM picked the wrong persona) vs reply
      // formatting (string template drift).
      // Display-formatted persona name — `formatPersonaDisplayName` in
      // the orchestrator capitalises the first letter (and replaces
      // underscores with spaces). Internal storage keeps `general` /
      // `financial` / `health`; reply shows `General` / `Financial` /
      // `Health`.
      const displayPersona =
        scenario.expectedPersona[0]!.toUpperCase() + scenario.expectedPersona.slice(1);
      const expectedPhrase = `Stored in ${displayPersona} vault.`;
      if (!resp.response.includes(expectedPhrase)) {
        // eslint-disable-next-line no-console
        console.log(
          `[${scenario.label}] expected "${expectedPhrase}" in reply, got:\n  ${resp.response}`,
        );
      }
      expect(resp.response).toContain(expectedPhrase);
    },
    60_000,
  );
});

if (!GEMINI_API_KEY) {
  describe('/remember reply pins persona name (skipped)', () => {
    it('skipped: set GEMINI_API_KEY or GOOGLE_API_KEY to run', () => {
      expect(GEMINI_API_KEY).toBe('');
    });
  });
}
