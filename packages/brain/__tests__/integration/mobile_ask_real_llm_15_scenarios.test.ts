/**
 * 15 scenarios — mobile /remember → drain → /ask end-to-end against REAL
 * Gemini and REAL SQLite.
 *
 * The same question-and-answer pairs the Python persona-classification
 * suite pins (`tests/prompt/test_persona_classification.py`) —
 * re-framed as the TS mobile flow a user actually hits:
 *
 *   user: "/remember X"
 *     → `handleChat('/remember X')`
 *       → `ingest({ source: 'user_remember', … })`
 *   scheduler: drain tick
 *     → `BrainCoreClient.claimStagingItems`  → /v1/staging/claim
 *     → keyword `classifyPersonas` (production, not LLM)
 *     → `BrainCoreClient.resolveStagingItem` → /v1/staging/resolve
 *         → `storeItem(persona, …)` writes to the SQLite persona vault
 *   user: "/ask Y"
 *     → `handleChat('/ask Y')`
 *       → agentic `askHandler` (installed by `setAskCommandHandler`)
 *         → `runAgenticTurn` → `AISDKAdapter` → real Gemini
 *         → `vault_search` tool reads the SQLite rows
 *
 * The LLM call path is the PRODUCTION composition — the test wires
 * nothing new, it just calls `handleChat('/ask …')` the same way the
 * chat UI does. The vault it reads is a real SQLite DB per persona
 * stood up through `withSQLiteVault`/`openSQLiteVault`. No mocks, no
 * synthetic prompts.
 *
 * Env:
 *   GEMINI_API_KEY | GOOGLE_API_KEY — required. When absent the whole
 *     suite skips (agentic `/ask` needs a real LLM).
 *   GEMINI_ASK_MODEL — override. Defaults to `gemini-3.1-pro-preview`
 *     (the production target) but any /ask-capable Gemini 3.x model
 *     works.
 *
 * Cost: ~15 multi-turn Gemini calls (1 per scenario), each doing at
 * least one `vault_search` tool round-trip. Budget a few minutes +
 * a few cents.
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
import { InProcessTransport } from '../../../core/src/client/in-process-transport';

import { createCoreRouter } from '../../../core/src/server/core_server';
import { clearVaults } from '../../../core/src/vault/crud';
import { resetStagingState } from '../../../core/src/staging/service';
import {
  configureRateLimiter,
  registerPublicKeyResolver,
} from '../../../core/src/auth/middleware';

import {
  closeSQLiteVault,
  openSQLiteVault,
  type SQLiteVaultHandle,
} from './helpers/sqlite_vault_harness';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
// Production target — `gemini-3.1-pro-preview`. The `GeminiGenaiAdapter`
// round-trips `thoughtSignature` natively (it rides on the `Part`
// alongside the `functionCall`), so the second agentic turn no longer
// trips on "Function call is missing a thought_signature in
// functionCall parts". Override via `GEMINI_ASK_MODEL` to try other
// variants (`gemini-3.1-flash-preview`, `gemini-2.5-flash`, etc.).
const GEMINI_ASK_MODEL = process.env.GEMINI_ASK_MODEL ?? 'gemini-3.1-pro-preview';

/**
 * Every persona the keyword classifier can fan out to — each needs a
 * real SQLite vault BEFORE the drain runs so `getOrAutoProvisionRepo`
 * returns the SQLite repo instead of silently falling back to
 * `InMemoryVaultRepository`. Mirrors the `COVERED_PERSONAS` list in
 * `mobile_remember_ask_e2e.test.ts`.
 */
const COVERED_PERSONAS = [
  'general',
  'personal',
  'health',
  'family',
  'financial',
  'legal',
  'professional',
  'social',
  'consumer',
];

interface Scenario {
  /** Stable label — appears in Jest's test name. */
  label: string;
  /** Text the user types into /remember. Stored verbatim into a vault row. */
  remember: string;
  /** Question the user asks via /ask; drives the agentic loop + vault_search. */
  ask: string;
  /**
   * Case-insensitive substrings that MUST appear in the /ask answer.
   * Kept loose — the test asserts recall, not exact wording. The LLM
   * can phrase freely as long as the fact made it back.
   */
  mustContainAny: string[];
}

/**
 * 10 persona-classification scenarios + 5 relationship-aware scenarios
 * from `tests/prompt/test_persona_classification.py`, re-cast as
 * /remember + /ask pairs. Order and wording kept faithful to the
 * Python source so drift between the two stacks is visible.
 */
const SCENARIOS: Scenario[] = [
  // ── General ──────────────────────────────────────────────
  {
    label: 'general-01 coffee preference',
    remember: 'Alonso likes cold brew coffee extra strong',
    ask: 'What kind of coffee does Alonso like?',
    mustContainAny: ['cold brew'],
  },
  {
    label: 'general-02 dog at park',
    remember: 'My dog Max loves playing fetch at the park every morning',
    ask: 'What does my dog Max love to play at the park?',
    mustContainAny: ['fetch'],
  },

  // ── Health ───────────────────────────────────────────────
  {
    label: 'health-01 back pain',
    remember: 'I have chronic lower back pain and need lumbar support',
    ask: 'Do I have any back pain?',
    mustContainAny: ['back', 'lumbar'],
  },
  {
    label: 'health-02 lisinopril',
    remember: 'I take 10mg of lisinopril every morning for hypertension',
    ask: 'What medication do I take for hypertension?',
    mustContainAny: ['lisinopril'],
  },

  // ── Work ─────────────────────────────────────────────────
  {
    label: 'work-01 team standup',
    remember: 'Team standup is at 9am every Monday, Wednesday, Friday',
    ask: 'When is team standup?',
    mustContainAny: ['9', 'monday'],
  },
  {
    label: 'work-02 Q3 deadline',
    remember: 'Q3 project deadline is September 30, need to finish the API migration',
    ask: 'When is the Q3 project deadline?',
    mustContainAny: ['september 30', 'sep 30'],
  },

  // ── Finance ──────────────────────────────────────────────
  {
    label: 'finance-01 checking account',
    remember: 'My checking account at Chase ends in 4521',
    ask: 'Which bank has my checking account?',
    mustContainAny: ['chase'],
  },
  {
    label: 'finance-02 car insurance',
    remember: 'Car insurance renewal is due August 15, currently $180/month',
    ask: 'When is my car insurance renewal due?',
    mustContainAny: ['august 15', 'aug 15'],
  },

  // ── Edge cases ───────────────────────────────────────────
  {
    label: 'edge-01 lunch with doctor',
    remember: 'Meeting Dr. Williams for lunch at the Italian place on Tuesday',
    ask: 'When am I meeting Dr. Williams for lunch?',
    mustContainAny: ['tuesday'],
  },
  {
    label: 'edge-02 pet vet',
    remember: "Max needs his rabies booster shot next month at the vet",
    ask: 'What shot does Max need at the vet?',
    mustContainAny: ['rabies'],
  },

  // ── Relationship-aware (5 from Python's 10) ──────────────
  {
    label: 'rel-01 friend allergy',
    remember: 'Sancho has a peanut allergy',
    ask: 'What is Sancho allergic to?',
    mustContainAny: ['peanut'],
  },
  {
    label: 'rel-02 child allergy',
    remember: 'Emma has a peanut allergy',
    ask: 'What is Emma allergic to?',
    mustContainAny: ['peanut'],
  },
  {
    label: 'rel-03 spouse blood pressure',
    remember: 'Sarah has high blood pressure',
    ask: 'Does Sarah have any medical conditions?',
    mustContainAny: ['blood pressure', 'hypertension'],
  },
  {
    label: 'rel-04 colleague salary',
    remember: 'Dave got a big raise, now earning $150K',
    ask: "What is Dave's current salary?",
    mustContainAny: ['150'],
  },
  {
    label: 'rel-05 self blood pressure',
    remember: 'My blood pressure is 130/85',
    ask: 'What is my blood pressure?',
    mustContainAny: ['130', '85'],
  },
];

/**
 * Build the in-process `BrainCoreClient` the mobile app's bootstrap
 * wires. Same pattern the existing `mobile_remember_ask_e2e.test.ts`
 * uses — a real Ed25519 keypair, `registerService(did, 'brain')`, and
 * the `in_process_dispatch` transport so `/v1/staging/*` calls flow
 * through the production Core router in-memory.
 */
function buildCoreClient(): InProcessTransport {
  const router = createCoreRouter();
  return new InProcessTransport(router);
}

// Top-level gate — without a Gemini key the agentic path can't run,
// and there's nothing useful to assert (the fallback `reason()`
// single-shot path is tested elsewhere).
const describeReal = GEMINI_API_KEY ? describe : describe.skip;

describeReal(
  'mobile /remember → drain → /ask end-to-end (real SQLite + real Gemini, 15 scenarios)',
  () => {
    const openHandles: SQLiteVaultHandle[] = [];
    let scheduler: StagingDrainScheduler;

    beforeAll(() => {
      resetStagingState();
      clearVaults();
      resetReasoningProvider();
      // Tight drain loop — every claim/resolve runs through the auth
      // pipeline and would otherwise trip the default 60/min budget on
      // a 15-scenario burst.
      configureRateLimiter({ maxRequests: 10_000, windowSeconds: 60 });

      // Real SQLite for every persona the keyword classifier might
      // flag. Registry is global so this works across all scenarios.
      for (const persona of COVERED_PERSONAS) {
        openHandles.push(openSQLiteVault(persona));
      }
      setAccessiblePersonas(COVERED_PERSONAS);

      // Full production composition — GeminiGenaiAdapter ← LLMRouter
      // ← RoutedLLMProvider(taskType='reason') ← makeAgenticAskHandler.
      // This is exactly what mobile's `boot_capabilities.ts::tryBuildAgenticAsk`
      // builds at app start, just without the tool set for provider
      // discovery (only `vault_search` is exercised here). Keeping the
      // router in the path means PII scrub + cloud-consent gate run
      // on every turn, same as production.
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
      const provider = new RoutedLLMProvider({
        router,
        taskType: 'reason',
        label: 'routed:reason:test',
      });
      const tools = new ToolRegistry();
      tools.register(createVaultSearchTool());
      const askHandler = makeAgenticAskHandler({ provider, tools });
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
      scheduler?.stop();
      while (openHandles.length > 0) {
        closeSQLiteVault(openHandles.pop()!);
      }
    });

    it.each(SCENARIOS)(
      '$label',
      async (scenario: Scenario) => {
        // 1. /remember via the real chat orchestrator. Exercises
        //    parseCommand → intent=remember → handleRemember → ingest.
        const rememberResp = await handleChat(`/remember ${scenario.remember}`);
        expect(rememberResp.intent).toBe('remember');

        // 2. Drain tick — keyword classify + resolve to the SQLite
        //    vault. Enough for the vault_search tool to find the row.
        const tick = await scheduler.runTick();
        expect(tick.stored).toBeGreaterThanOrEqual(1);

        // 3. /ask via the real chat orchestrator — routes through the
        //    installed agentic handler → real Gemini → vault_search.
        const askResp = await handleChat(`/ask ${scenario.ask}`);
        expect(askResp.intent).toBe('ask');
        expect(askResp.response).not.toBe('');

        // 4. Recall check — the answer must reference the stored fact
        //    under at least one of the accepted phrasings. Case-
        //    insensitive so "Chase" / "chase" / "CHASE" all match.
        //
        //    When the assertion fails, the full Gemini answer + the
        //    accepted needles are dumped to stderr so the failure
        //    message alone tells you whether the issue is "LLM didn't
        //    recall" (narrow persona scope, no vault hit) vs "LLM
        //    recalled but phrased differently" (needle list needs an
        //    alternate). Covers the most common failure mode this
        //    file surfaces: drain stored the row under `general`,
        //    Gemini searched only `health`/`financial`, came up empty.
        const haystack = askResp.response.toLowerCase();
        const hit = scenario.mustContainAny.some((needle) =>
          haystack.includes(needle.toLowerCase()),
        );
        if (!hit) {
          // eslint-disable-next-line no-console
          console.log(
            `[${scenario.label}] remember="${scenario.remember}"\n  ask=${scenario.ask}\n  response=${askResp.response}\n  expectedAny=${JSON.stringify(scenario.mustContainAny)}`,
          );
        }
        expect(hit).toBe(true);
      },
      120_000,
    );
  },
);

if (!GEMINI_API_KEY) {
  describe('mobile /remember → /ask end-to-end (skipped)', () => {
    it('skipped: set GEMINI_API_KEY or GOOGLE_API_KEY to run 15 scenarios', () => {
      expect(GEMINI_API_KEY).toBe('');
    });
  });
}
