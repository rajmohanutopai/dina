/**
 * Mobile install-faithful E2E — only `general` registered, real
 * SQLCipher, real Gemini classifier (drain) + real Gemini agentic
 * /ask, **strict mode** (no in-memory fallback).
 *
 * Why this exists
 * ---------------
 * `mobile_ask_real_llm_15_scenarios.test.ts` pre-opens 9 personas and
 * sets `accessiblePersonas` to all of them. That sidesteps the latent
 * mobile-install bug class: at install only `general` exists, so when
 * the LLM persona selector picks `personal` / `health` / etc., the
 * drain has no SQLite repo for that persona, the old crud.ts silently
 * fell back to `InMemoryVaultRepository`, the row landed in volatile
 * RAM, and `/ask` (walking only `accessiblePersonas = ['general']`)
 * never saw it.
 *
 * The fallback was removed (`requireRepo` is strict — throws on miss)
 * so the bug now surfaces as a thrown error during drain. This test
 * pins the mobile-install scenario end-to-end:
 *   - Persona registry: `['general']` only — matches what
 *     `useUnlock.ts:141` / `provision.ts:160` create at first boot.
 *   - SQLite vault: only for `general` — matches what
 *     `useUnlock.ts:175` opens (`openPersonaDB(persona)` for each
 *     boot persona, and only `general` auto-opens).
 *   - LLM persona selector: real Gemini, registered the way
 *     `boot_capabilities.ts:225` does. The selector sees
 *     `availablePersonas = ['general']` and is constrained to that.
 *   - Agentic /ask: real Gemini, same composition mobile uses —
 *     `LLMRouter` → `RoutedLLMProvider` → `makeAgenticAskHandler` +
 *     `vault_search` tool.
 *
 * What this catches that the 15-scenarios test doesn't
 *   - The strict-mode contract (any production code path that hits a
 *     persona without a wired repo throws — would have caught the
 *     in-memory-fallback simulator bug).
 *   - LLM classifier behaviour on a single-persona registry (Gemini
 *     can't pick `personal`/`health` if only `general` is in the
 *     `availablePersonas` list it sees).
 *   - That `/ask` walking just `accessiblePersonas = ['general']` is
 *     enough for a mobile-install user — i.e. a fresh install can
 *     /remember + /ask without ever creating a second persona.
 *
 * What still needs the simulator
 *   - op-sqlite (mobile) vs better-sqlite3-multiple-ciphers (here):
 *     same SQLite/SQLCipher upstream, different native bindings.
 *     FTS5 tokenizer + trigger behaviour should match but isn't
 *     proven byte-equal across both.
 *
 * Env
 *   GEMINI_API_KEY | GOOGLE_API_KEY — required. Skipped without a key.
 *   GEMINI_ASK_MODEL — default `gemini-3.1-pro-preview` for the
 *     agentic path. The classifier auto-picks the provider's `lite`
 *     tier (matches Python's task-type=classify routing).
 *
 * Cost: ~3 Gemini round-trips per scenario (1 classifier on drain +
 * 1–2 agentic turns on /ask). 5 scenarios = ~15 calls, a few cents.
 */

import { GeminiGenaiAdapter } from '../../src/llm/adapters/gemini_genai';
import { LLMRouter, RoutedLLMProvider } from '../../src/llm/router_dispatch';
import { ToolRegistry } from '../../src/reasoning/tool_registry';
import { createVaultSearchTool } from '../../src/reasoning/vault_tool';
import { makeAgenticAskHandler } from '../../src/reasoning/ask_handler';
import {
  handleChat,
  resetAskCommandHandler,
  setAskCommandHandler,
} from '../../src/chat/orchestrator';
import {
  resetReasoningProvider,
  setAccessiblePersonas,
} from '../../src/vault_context/assembly';
import { StagingDrainScheduler } from '../../src/staging/scheduler';
import { createGeminiClassifier } from '../../src/routing/gemini_classify';
import {
  registerPersonaSelector,
  resetPersonaSelector,
} from '../../src/routing/persona_selector';
import { InProcessTransport } from '../../../core/src/client/in-process-transport';

import { createCoreRouter } from '../../../core/src/server/core_server';
import {
  clearVaults,
  DEFAULT_TEST_PERSONAS,
  queryVault,
} from '../../../core/src/vault/crud';
import { resetStagingState } from '../../../core/src/staging/service';
import {
  createPersona,
  openPersona,
  resetPersonaState,
} from '../../../core/src/persona/service';
import { configureRateLimiter } from '../../../core/src/auth/middleware';

import {
  closeSQLiteVault,
  openSQLiteVault,
  type SQLiteVaultHandle,
} from './helpers/sqlite_vault_harness';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
const GEMINI_ASK_MODEL = process.env.GEMINI_ASK_MODEL ?? 'gemini-3.1-pro-preview';

interface Scenario {
  label: string;
  /** Text the user types into /remember. */
  remember: string;
  /** Question for /ask. */
  ask: string;
  /** Case-insensitive substrings that must appear in the answer. */
  mustContainAny: string[];
}

/**
 * 5 scenarios covering the categories most likely to surface a
 * mobile-install bug: a benign `general` fact, a date-bearing fact
 * (drain's reminder pipeline cares), a relationship fact, and two
 * facts that would route to non-`general` personas if more were
 * registered (Gemini is constrained to `['general']` here so it must
 * fall back to that — the test pins that the LLM doesn't invent
 * unregistered personas).
 */
const SCENARIOS: Scenario[] = [
  {
    label: '01 benign general fact',
    remember: "Emma's birthday is March 15",
    ask: "When is Emma's birthday?",
    mustContainAny: ['march 15', 'mar 15', '3/15'],
  },
  {
    label: '02 contact preference',
    remember: 'Alonso likes cold brew coffee extra strong',
    ask: 'What kind of coffee does Alonso like?',
    mustContainAny: ['cold brew'],
  },
  {
    label: '03 medical (would be health if registered)',
    remember: 'I take 10mg of lisinopril every morning for hypertension',
    ask: 'What medication do I take for hypertension?',
    mustContainAny: ['lisinopril'],
  },
  {
    label: '04 financial (would be financial if registered)',
    remember: 'My checking account at Chase ends in 4521',
    ask: 'Which bank has my checking account?',
    mustContainAny: ['chase'],
  },
  {
    label: '05 work (would be professional if registered)',
    remember: 'Team standup is at 9am every Monday, Wednesday, Friday',
    ask: 'When is team standup?',
    mustContainAny: ['9', 'monday'],
  },
];

function buildCoreClient(): InProcessTransport {
  const router = createCoreRouter();
  return new InProcessTransport(router);
}

const describeReal = GEMINI_API_KEY ? describe : describe.skip;

describeReal(
  'mobile install-faithful /remember → drain → /ask (strict, only `general`)',
  () => {
    let scheduler: StagingDrainScheduler;
    let generalVault: SQLiteVaultHandle | null = null;

    beforeAll(() => {
      // Strict mobile-install state: only `general` registered + open.
      // No `clearVaults(DEFAULT_TEST_PERSONAS)` — that would seed 9
      // in-memory repos and defeat the strictness contract. Instead
      // start from `clearVaults([])` (empty registry) and explicitly
      // wire SQLite for `general` only.
      clearVaults([]);
      resetStagingState();
      resetPersonaState();
      resetReasoningProvider();
      resetPersonaSelector();
      configureRateLimiter({ maxRequests: 10_000, windowSeconds: 60 });

      // Mobile-install persona registry.
      createPersona('general', 'default', 'Default persona');
      openPersona('general');

      // SQLite vault for `general` ONLY. Any drain attempt to write
      // to another persona will hit the strict `requireRepo` throw —
      // that's intentional and the test pins behaviour against it.
      generalVault = openSQLiteVault('general');

      // Mobile-faithful accessible-persona list — only `general`.
      setAccessiblePersonas(['general']);

      // Real Gemini provider (raw adapter → router → routed wrappers).
      const rawProvider = new GeminiGenaiAdapter({
        apiKey: GEMINI_API_KEY,
        defaultModel: GEMINI_ASK_MODEL,
      });
      const router = new LLMRouter({
        providers: { gemini: rawProvider },
        config: {
          localAvailable: false,
          cloudProviders: ['gemini'],
          sensitivePersonas: ['health', 'financial'],
          cloudConsentGranted: true,
        },
      });

      // 1) Drain-side classifier — RoutedLLMProvider tagged `classify`
      //    auto-picks the lite tier. Same shape as
      //    `boot_capabilities.ts:220-225`.
      const classifierProvider = new RoutedLLMProvider({
        router,
        taskType: 'classify',
        label: 'routed:classify:strict-test',
      });
      registerPersonaSelector(createGeminiClassifier(classifierProvider));

      // 2) Agentic /ask — same composition as
      //    `mobile_ask_real_llm_15_scenarios.test.ts`.
      const askProvider = new RoutedLLMProvider({
        router,
        taskType: 'reason',
        label: 'routed:reason:strict-test',
      });
      const tools = new ToolRegistry();
      tools.register(createVaultSearchTool());
      const askHandler = makeAgenticAskHandler({ provider: askProvider, tools });
      setAskCommandHandler(askHandler);

      const core = buildCoreClient();
      scheduler = new StagingDrainScheduler({
        core,
        intervalMs: 10_000,
        setInterval: () => 1,
        clearInterval: () => {
          /* noop */
        },
      });
    });

    afterAll(() => {
      resetAskCommandHandler();
      resetReasoningProvider();
      resetPersonaSelector();
      scheduler?.stop();
      if (generalVault) {
        closeSQLiteVault(generalVault);
        generalVault = null;
      }
    });

    it.each(SCENARIOS)(
      '$label',
      async (scenario: Scenario) => {
        // 1) /remember through the chat orchestrator (real path).
        const rememberResp = await handleChat(`/remember ${scenario.remember}`);
        expect(rememberResp.intent).toBe('remember');

        // 2) Drain — real Gemini classifier picks the persona. With
        //    only `general` in `availablePersonas`, the LLM is
        //    constrained: `parseClassificationResponseRich` rejects
        //    any primary outside the registered list and falls back
        //    to `general`. Strict-mode `requireRepo` would throw on a
        //    write to any non-`general` persona, surfacing as
        //    `tick.failed > 0`.
        //
        //    NOTE: `result.persona` on `tick.results` is the *keyword
        //    classifier's domain output* (informational only — the
        //    actual write target comes from the LLM-constrained
        //    `personas` array). Don't assert against it; assert
        //    against where the row actually landed.
        const tick = await scheduler.runTick();
        expect(tick.failed).toBe(0);
        expect(tick.stored).toBeGreaterThanOrEqual(1);

        // Direct vault check — the row must be in the SQLite
        // `general` vault (the only persona we registered). If the
        // LLM hallucinated a different persona AND strict mode let
        // it through, this query would return 0 hits.
        const generalHits = queryVault('general', {
          mode: 'fts5',
          // Pull the first noun out of the remember text so FTS5 has
          // something concrete to match. Lower-case so the tokenizer
          // doesn't care.
          text: scenario.mustContainAny[0]!.toLowerCase().split(' ')[0]!,
          limit: 10,
        });
        expect(generalHits.length).toBeGreaterThanOrEqual(1);

        // 3) /ask through the chat orchestrator → real Gemini agentic
        //    loop → vault_search reads the SQLite `general` vault.
        const askResp = await handleChat(`/ask ${scenario.ask}`);
        expect(askResp.intent).toBe('ask');
        expect(askResp.response).not.toBe('');

        // 4) Recall check — case-insensitive substring match.
        const haystack = askResp.response.toLowerCase();
        const hit = scenario.mustContainAny.some((needle) =>
          haystack.includes(needle.toLowerCase()),
        );
        if (!hit) {
          // eslint-disable-next-line no-console
          console.log(
            `[${scenario.label}]\n  remember=${scenario.remember}\n  ask=${scenario.ask}\n  response=${askResp.response}\n  expectedAny=${JSON.stringify(scenario.mustContainAny)}`,
          );
        }
        expect(hit).toBe(true);
      },
      120_000,
    );
  },
);

if (!GEMINI_API_KEY) {
  describe('mobile install-faithful E2E (skipped)', () => {
    it('skipped: set GEMINI_API_KEY or GOOGLE_API_KEY to run', () => {
      expect(GEMINI_API_KEY).toBe('');
    });
  });
}
