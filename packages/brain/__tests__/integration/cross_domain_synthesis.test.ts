/**
 * Cross-domain synthesis scenarios — REAL Gemini, REAL SQLite vault,
 * LIVE prompts.
 *
 * Purpose
 * -------
 * Empirically validate that the agentic /ask loop performs
 * cross-domain synthesis — pulling context from a persona the user's
 * question doesn't name. Concretely: when asked "what should I get
 * Emma for her birthday" with a `$25 toy budget` row sitting in the
 * finance vault, does the answer reference the budget? When asked
 * "should I take that 9am call" with a school-drop-off conflict in
 * general, does the answer flag the conflict?
 *
 * The bet is that good prompts + good tool descriptions are enough —
 * no pre-flight query expansion needed, no per-scenario "if X call Y"
 * rules. This test set is the empirical proof. Iterate
 * `VAULT_CONTEXT` (and the vault_search description) in
 * `packages/brain/src/llm/prompts.ts` and re-run; the test imports
 * those prompts live, so prompt edits show up immediately.
 *
 * Run
 * ---
 *   DINA_RUN_REAL_LLM=1 GEMINI_API_KEY=… \
 *     npx jest cross_domain_synthesis
 *
 * Without `DINA_RUN_REAL_LLM=1` the suite skips — saves CI time and
 * tokens. Each scenario costs ~5s + a few thousand Gemini tokens.
 *
 * Source
 * ------
 *   - Live prompt: `packages/brain/src/llm/prompts.ts` → `VAULT_CONTEXT`
 *     (exported as `DEFAULT_ASK_SYSTEM_PROMPT` from `ask_handler.ts`)
 *   - Tool surface: `packages/brain/src/composition/agentic_ask.ts`
 *     → `buildAgenticAskPipeline`
 *
 * Note: this is a SCENARIO test (per `feedback_test_strategy` — a
 * contract test would pin tool-call shape, not content). We're using
 * it as a tuning oracle, not a regression gate. Pass criteria are
 * loose substring matches; the LLM phrasing varies between runs.
 */

import { AppViewClient } from '@dina/brain';
import { getPeopleRepository, setVaultRepository } from '@dina/core';
import {
  clearVaults,
  configureRateLimiter,
  resetPersonaState,
  setPeopleRepository,
  storeItem,
  type Person,
  type PersonSurface,
  type ApplyExtractionResponse,
  type ExtractionResult,
  type PeopleRepository,
} from '@dina/core';

import {
  handleChat,
  resetAskCommandHandler,
  setAskCommandHandler,
} from '../../src/chat/orchestrator';
import { buildAgenticAskPipeline } from '../../src/composition/agentic_ask';
import {
  buildAskRetrievalPlannerCall,
  planAskRetrieval,
  runAskPreFlightRetrieval,
  type InstalledPersona,
} from '../../src/composition/ask_retrieval_planner';
import { GeminiGenaiAdapter } from '../../src/llm/adapters/gemini_genai';
import { LLMRouter, RoutedLLMProvider } from '../../src/llm/router_dispatch';
import { makeAgenticAskHandler } from '../../src/reasoning/ask_handler';
import {
  executeToolSearch,
  resetReasoningProvider,
  setAccessiblePersonas,
} from '../../src/vault_context/assembly';


import {
  closeSQLiteVault,
  openSQLiteVault,
  type SQLiteVaultHandle,
} from './helpers/sqlite_vault_harness';

// ---------------------------------------------------------------------------
// Gate — only run when explicitly opted in. The same env handshake the
// other real-LLM tests use.
// ---------------------------------------------------------------------------

const GEMINI_API_KEY =
  process.env.DINA_RUN_REAL_LLM === '1'
    ? (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '')
    : '';
const GEMINI_MODEL = process.env.GEMINI_ASK_MODEL ?? 'gemini-2.5-flash';

// ---------------------------------------------------------------------------
// Fixture personas — the four lite defaults.
// ---------------------------------------------------------------------------

const FIXTURE_PERSONAS = ['general', 'work', 'health', 'finance'];

// ---------------------------------------------------------------------------
// Fixture vault items — one per persona so cross-domain probes are
// meaningful. Each item carries the kind of fact a real user would
// type via /remember.
// ---------------------------------------------------------------------------

interface VaultFixture {
  persona: string;
  summary: string;
  body: string;
  type?: string;
}

const FIXTURE_VAULT_ITEMS: VaultFixture[] = [
  {
    persona: 'general',
    summary: 'Emma loves dinosaurs',
    body: 'Emma loves dinosaurs',
  },
  {
    persona: 'general',
    summary: 'Emma is my daughter',
    body: 'Emma is my daughter',
  },
  {
    persona: 'finance',
    summary: 'Monthly toy budget: $25',
    body: 'My monthly toy budget for the kids is $25 — finances are tight this quarter',
  },
  {
    persona: 'health',
    summary: 'Allergic to soy lecithin',
    body: 'I am allergic to soy lecithin — gives me hives. Watch out for soy in supplements and protein bars.',
  },
  {
    persona: 'work',
    summary: 'Emma school drop-off Tuesday 8:30–9:15',
    body: 'Tuesday mornings I do Emma school drop-off from 8:30 to 9:15. Cannot take meetings in that window.',
  },
];

// ---------------------------------------------------------------------------
// Fixture people graph — Emma is a confirmed person with surfaces.
// ---------------------------------------------------------------------------

function surface(
  personId: string,
  surfaceText: string,
  overrides: Partial<PersonSurface> = {},
): PersonSurface {
  return {
    id: Math.floor(Math.random() * 1_000_000),
    personId,
    surface: surfaceText,
    normalizedSurface: surfaceText.toLowerCase(),
    surfaceType: 'name',
    status: 'confirmed',
    confidence: 'high',
    sourceItemId: '',
    sourceExcerpt: 'Emma is my daughter',
    extractorVersion: 'fixture-v1',
    createdFrom: 'manual',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function emmaPerson(): Person {
  return {
    personId: 'p-emma',
    canonicalName: 'Emma',
    contactDid: '',
    relationshipHint: 'daughter',
    status: 'confirmed',
    createdFrom: 'manual',
    createdAt: 0,
    updatedAt: 0,
    surfaces: [
      surface('p-emma', 'Emma'),
      surface('p-emma', 'my daughter', { surfaceType: 'role_phrase' }),
    ],
  };
}

class FixturePeopleRepository implements PeopleRepository {
  listPeople(): Person[] {
    return [emmaPerson()];
  }
  applyExtraction(_: ExtractionResult): ApplyExtractionResponse {
    return { created: 0, updated: 0, conflicts: [], skipped: false };
  }
  getPerson(id: string): Person | null {
    return id === 'p-emma' ? emmaPerson() : null;
  }
  findByContactDid(): Person | null {
    return null;
  }
  resolveByIdentity(): Person | null {
    return null;
  }
  upsertIdentity(): void {
    /* no-op */
  }
  listIdentities() {
    return [];
  }
  confirmPerson(): boolean {
    return false;
  }
  rejectPerson(): boolean {
    return false;
  }
  confirmSurface(): boolean {
    return false;
  }
  rejectSurface(): boolean {
    return false;
  }
  detachSurface(): boolean {
    return false;
  }
  mergePeople(): void {}
  deletePerson(): boolean {
    return false;
  }
  linkContact(): boolean {
    return false;
  }
  upsertContactPerson(): string {
    return '';
  }
  resolveConfirmedSurfaces(): Map<string, PersonSurface[]> {
    return new Map();
  }
  clearExcerptsForItem(): number {
    return 0;
  }
  garbageCollect(): number {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Scenarios — each is a question whose ideal answer requires the LLM
// to look in a persona the question doesn't name. `mustContainAny`
// is a loose substring match (case-insensitive); the LLM phrases
// freely, we only assert the cross-domain *fact* surfaced.
// ---------------------------------------------------------------------------

interface Scenario {
  label: string;
  ask: string;
  crossDomainHints: {
    persona: string;
    needsKeyword: string;
  };
  mustContainAny: string[];
}

const SCENARIOS: Scenario[] = [
  {
    label: 'gift question implies budget — finance cross-domain',
    ask: 'what should I get Emma for her birthday',
    crossDomainHints: { persona: 'finance', needsKeyword: 'budget' },
    mustContainAny: ['$25', '25', 'budget', 'tight'],
  },
  {
    label: 'expensive product implies budget check — finance cross-domain',
    ask: "I'm thinking of getting Emma the $150 LEGO Jurassic World set",
    crossDomainHints: { persona: 'finance', needsKeyword: 'budget' },
    mustContainAny: ['budget', '$25', '$150', 'over', 'beyond', 'exceed', 'tight'],
  },
  {
    label: 'morning meeting implies schedule check — work cross-domain',
    ask: 'can I take a 9am Tuesday call with a client',
    crossDomainHints: { persona: 'work', needsKeyword: 'Tuesday drop-off' },
    mustContainAny: ['emma', 'drop', 'school', '8:30', '9:15', 'conflict'],
  },
  {
    label: 'supplement implies allergy check — health cross-domain',
    ask: "I'm considering a new protein powder",
    crossDomainHints: { persona: 'health', needsKeyword: 'soy lecithin allergy' },
    mustContainAny: ['soy', 'allerg', 'lecithin'],
  },
];

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const describeReal = GEMINI_API_KEY !== '' ? describe : describe.skip;

describeReal(
  'cross-domain synthesis — REAL Gemini, LIVE prompts (tuning oracle)',
  () => {
    const openHandles: SQLiteVaultHandle[] = [];

    beforeAll(() => {
      clearVaults();
      resetPersonaState();
      resetReasoningProvider();
      configureRateLimiter({ maxRequests: 10_000, windowSeconds: 60 });

      for (const persona of FIXTURE_PERSONAS) {
        openHandles.push(openSQLiteVault(persona));
      }
      setAccessiblePersonas(FIXTURE_PERSONAS);

      // Wire the people graph so find_person resolves Emma to a
      // canonical record with relationshipHint='daughter'.
      setPeopleRepository(new FixturePeopleRepository());

      // Production composition — same path the lite brain-server's
      // boot wires for `/ask`. Uses VAULT_CONTEXT (the live prompt)
      // because `makeAgenticAskHandler` defaults to it.
      const rawProvider = new GeminiGenaiAdapter({
        apiKey: GEMINI_API_KEY,
        defaultModel: GEMINI_MODEL,
      });
      const router = new LLMRouter({
        providers: { gemini: rawProvider },
        config: {
          localAvailable: false,
          cloudProviders: ['gemini'],
          sensitivePersonas: ['health', 'finance'],
          cloudConsentGranted: true,
        },
      });
      const provider = new RoutedLLMProvider({
        router,
        taskType: 'reason',
        label: 'routed:reason:cross-domain-test',
      });

      // Full pipeline — vault_search, find_person, list_personas,
      // browse_vault, get_full_content, search_peerlens,
      // geocode, search_provider_services, query_service,
      // schedule_reminder, draft_review, classify_intent,
      // find_preferred_provider. We need this richness so the LLM
      // genuinely has the option to do cross-domain searches.
      // AppView is needed for `search_peerlens`. The fetch is
      // stubbed to return an empty body fast so PeerLens calls don't
      // hang or hit the network during prompt-tuning runs.
      const stubAppView = new AppViewClient({
        appViewURL: 'http://localhost:0',
        fetch: async () =>
          new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      });
      const pipeline = buildAgenticAskPipeline({
        llm: provider,
        providerName: 'gemini',
        appViewClient: stubAppView,
        orchestratorHandle: undefined as never, // service_query not exercised
        coreClient: undefined as never, // schedule_reminder not exercised
        cloudConsentGranted: true,
      });

      // Pre-flight retrieval planner — turns the question into a
      // structured plan and pre-fetches cross-domain context before
      // the agentic loop runs. The whole point of this test set is
      // to validate the planner's bridging effect; we wire the same
      // router the loop uses so the planner shares the cloud-consent
      // gate + PII scrub policy.
      const installedPersonas: InstalledPersona[] = [
        {
          name: 'general',
          description:
            "Everyday notes — anything that doesn't clearly fit a more specific vault. Family, friends, preferences, hobbies, social facts.",
        },
        {
          name: 'work',
          description:
            'Job, projects, colleagues, work calendar items, professional context, weekly commitments and meetings.',
        },
        {
          name: 'health',
          description:
            'Medical, fitness, symptoms, medications, doctors, allergies, supplements and dietary restrictions.',
        },
        {
          name: 'finance',
          description:
            'Money, budgets, spending, income, bills, debt, investments, taxes — anything that constrains a purchase.',
        },
      ];
      const plannerLlmCall = buildAskRetrievalPlannerCall(router);
      const preFlight = async (question: string) => {
        const plan = await planAskRetrieval(question, {
          llmCall: plannerLlmCall,
          personas: installedPersonas,
        });
        const result = await runAskPreFlightRetrieval(plan, {
          vaultSearch: async (persona, query) => {
            const items = await executeToolSearch(persona, query, 5);
            return items.map((i) => ({
              id: i.id,
              content_l0: i.content_l0,
              body: i.body,
              persona,
            }));
          },
          findPerson: async (name) => {
            const repo = getPeopleRepository();
            if (repo === null) return [];
            const needle = name.trim().toLowerCase();
            return repo
              .listPeople()
              .filter((p) =>
                (p.surfaces ?? []).some(
                  (s) =>
                    s.status !== 'rejected' &&
                    s.normalizedSurface === needle,
                ),
              )
              .map((p) => ({
                canonicalName: p.canonicalName,
                relationshipHint: p.relationshipHint,
                surfaceSummary: (p.surfaces ?? [])
                  .filter((s) => s.status !== 'rejected')
                  .map((s) => s.surface)
                  .slice(0, 3)
                  .join(', '),
              }));
          },
        });
        // Trace line every operator iterating on the prompt cares
        // about: what plan came out, how many hits per persona, did
        // the planner produce a non-empty block? Kept terse so it
        // doesn't drown out the answer print below.
         
        console.warn(
          `[planner] hits=${JSON.stringify(result.hits)} blockLen=${result.block.length} intent="${result.plan.intent}"`,
        );
        return result;
      };

      const askHandler = makeAgenticAskHandler({
        provider,
        tools: pipeline.tools,
        preFlight,
      });
      setAskCommandHandler(askHandler);
    });

    // The brain's global `beforeEach` (in `__tests__/setup.ts`) runs
    // `clearVaults(DEFAULT_TEST_PERSONAS)` before every test, which
    // wipes out our SQLite-backed repos and replaces them with empty
    // InMemory ones. Re-register the SQLite repos and re-seed the
    // fixture data before each scenario so the planner sees real
    // FTS5-indexed rows. The handles opened in `beforeAll` stay
    // alive — we just rebind the registry.
    beforeEach(() => {
      for (const handle of openHandles) {
        setVaultRepository(handle.persona, handle.repo);
      }
      setAccessiblePersonas(FIXTURE_PERSONAS);
      setPeopleRepository(new FixturePeopleRepository());

      for (const item of FIXTURE_VAULT_ITEMS) {
        storeItem(item.persona, {
          type: item.type ?? 'user_memory',
          summary: item.summary,
          body: item.body,
        });
      }
    });

    afterAll(() => {
      resetAskCommandHandler();
      resetReasoningProvider();
      setPeopleRepository(null);
      while (openHandles.length > 0) {
        closeSQLiteVault(openHandles.pop()!);
      }
    });

    it.each(SCENARIOS)(
      '$label',
      async (scenario: Scenario) => {
        const resp = await handleChat(`/ask ${scenario.ask}`);
        const answer = (resp.response ?? '').toLowerCase();

        // Loose substring assertion — at least one of the expected
        // cross-domain terms must appear. The LLM has flexibility in
        // wording but the fact must surface.
        const matched = scenario.mustContainAny.find((s) =>
          answer.includes(s.toLowerCase()),
        );

        // Always print the answer so an operator iterating on the
        // prompt can see what shifted. Compact one-liner — full
        // answer + the keywords we looked for + pass/fail.
         
        console.warn(
          `\n[cross-domain ${matched !== undefined ? 'PASS' : 'MISS'}] ${scenario.label}\n  ask: ${scenario.ask}\n  needed one of: ${JSON.stringify(scenario.mustContainAny)}\n  answer:\n    ${(resp.response ?? '').split('\n').join('\n    ')}\n`,
        );
        expect(matched).toBeDefined();
      },
      60_000,
    );
  },
);
