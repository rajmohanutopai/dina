/**
 * A6 — the research loop weighs offers against the OWNER'S STATED
 * PREFERENCES (docs/RESEARCHER_KERNEL_ARCHITECTURE.md §5.A6), run against
 * the REAL model through the PRODUCTION composition.
 *
 * A6 was built as EMERGENT behaviour (implementation-notes Iter 5/7): no
 * per-scenario prompt rule says "if the owner said X, do Y". The loop has
 * `search_products` (offers ranked by price / lead time / seller trust),
 * the vault tools, `find_preferred_provider` and the pre-flight retrieval
 * planner; the diligence is what the model does with them. A scripted
 * provider would only pin the script, so this file asks the real model and
 * asserts the preference reached the answer.
 *
 * Composition — the same code both hosts boot:
 *   `buildBrainServerLLMRuntime` (this server's provider selection)
 *     → `buildHomeNodeAskRuntime` (shared: pipeline with every production
 *       tool, planner with the server's CoreClient fetchers, coordinator)
 *     → `coordinator.handleAsk` as the /api/v1/ask route calls it.
 *
 * Core is real and in-process (`InProcessTransport(createCoreRouter())`)
 * over SQLCipher files: per-persona vaults hold the preferences, one
 * identity store holds the people graph + contact directory. AppView is a
 * FIXTURE answering `searchCatalog` with one product across several sellers
 * and `getProfile` with each seller's trust. Supplier DIDs are opaque on
 * purpose: a DID that spelt a seller's name would let the model match
 * strings instead of using the owner's contacts.
 *
 * Each scenario is built so the ranker's #1 (price-weighted 60/25/15)
 * CONFLICTS with the stated preference — a model that parrots the ranking
 * fails; one that weighs the preference passes.
 *
 * Env: DINA_RUN_REAL_LLM=1, then the server's own LLM variables read by its
 * own config loader — DINA_BRAIN_LLM_PROVIDER (gemini | openai | openrouter)
 * and the matching *_API_KEY / DINA_*_MODEL. Unset, the provider is
 * OpenRouter (the production credits path; the owner's decision of
 * 2026-09-13 while the Gemini project is denied). ~4 multi-turn calls — cents.
 *
 * Every answer is printed (fixture data only — no owner PII) so a run is
 * evidence of what the model did with the preference, not only pass/fail.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AppViewClient,
  setAccessiblePersonas,
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type LLMProvider,
} from '@dina/brain';
import {
  addContact,
  applyMigrations,
  clearVaults,
  configureRateLimiter,
  createCoreRouter,
  createPersona,
  IDENTITY_MIGRATIONS,
  InProcessTransport,
  PERSONA_MIGRATIONS,
  resetContactDirectory,
  resetPersonaState,
  setPeopleRepository,
  setVaultRepository,
  SQLitePeopleRepository,
  SQLiteVaultRepository,
  storeItem,
  type PersonaTier,
} from '@dina/core';
import { setContactRepository, SQLiteContactRepository } from '@dina/core/storage';
import { buildHomeNodeAskRuntime, type HomeNodeAskRuntime } from '@dina/home-node/ask-runtime';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { loadLLMConfig, type BrainServerConfig } from '../src/config';
import { buildBrainServerLLMRuntime } from '../src/llm_provider';

// ---------------------------------------------------------------------------
// Gate + provider — the server's own selection, from its own variables.
// ---------------------------------------------------------------------------
/** The harness default when no provider is named: OpenRouter. */
const DEFAULT_REAL_LLM_PROVIDER = 'openrouter';

function realLLMConfig(env: NodeJS.ProcessEnv): Exclude<BrainServerConfig['llm'], { provider: 'none' | 'scripted' }> | null {
  if (env.DINA_RUN_REAL_LLM !== '1') return null;
  const provider = env.DINA_BRAIN_LLM_PROVIDER?.trim() ?? '';
  const llm = loadLLMConfig({ ...env, DINA_BRAIN_LLM_PROVIDER: provider === '' ? DEFAULT_REAL_LLM_PROVIDER : provider });
  return llm.provider === 'none' || llm.provider === 'scripted' ? null : llm;
}

const LLM_CONFIG = realLLMConfig(process.env);

/** The gated suite only runs when a provider was resolved; this names it. */
function llmConfig(): NonNullable<typeof LLM_CONFIG> {
  if (LLM_CONFIG === null) throw new Error('A6: no real LLM provider resolved');
  return LLM_CONFIG;
}
const OWNER_DID = 'did:plc:a6owner00000000000000000';

// ---------------------------------------------------------------------------
// The phone's default personas, created the way `seedDefaultPersonas` does;
// descriptions are the planner menu both hosts feed (`PERSONA_DESCRIPTIONS`).
// ---------------------------------------------------------------------------
const PERSONAS: { name: string; tier: PersonaTier; description: string }[] = [
  { name: 'general', tier: 'default', description: "Everyday notes — anything that doesn't clearly fit a more specific vault." },
  { name: 'work', tier: 'standard', description: 'Job, projects, colleagues, work calendar items, professional context.' },
  { name: 'health', tier: 'sensitive', description: 'Medical, fitness, symptoms, medications, doctors, allergies.' },
  { name: 'finance', tier: 'sensitive', description: 'Money, budgets, spending, income, bills, debt, investments, taxes.' },
];

// ---------------------------------------------------------------------------
// Fixture sellers — opaque DIDs (see header). One product, several sellers.
// ---------------------------------------------------------------------------
const PRODUCT = { scheme: 'gtin', value: '08901234500017' };
const REGION = { scheme: 'iso-3166-2', value: 'IN-KA' };

interface Supplier {
  did: string;
  /** Indicative price in INR paise. */
  paise: string;
  /** PeerLens overall trust, 0..1. */
  trust: number;
}

const SUPPLIER = {
  cheapUnknown: { did: 'did:plc:q7f3k2m9x1p5w8n4r6t0v2z1', paise: '449900', trust: 0.28 },
  /** Cheapest, with a trust score a model would take on its own (S1): only the owner's rule tips the pick. */
  cheapFair: { did: 'did:plc:q7f3k2m9x1p5w8n4r6t0v2z2', paise: '449900', trust: 0.72 },
  steadyTrusted: { did: 'did:plc:h4d8s1l6b3n9c2v7x5z0m1k8', paise: '589900', trust: 0.94 },
  premium: { did: 'did:plc:t2r5y8u1i4o7p0a3s6d9f2g5', paise: '975000', trust: 0.97 },
  midUnknown: { did: 'did:plc:w9e2r5t8y1u4i7o0p3a6s9d2', paise: '499900', trust: 0.61 },
  chairMaker: { did: 'did:plc:z3x6c9v2b5n8m1q4w7e0r3t6', paise: '419900', trust: 0.83 },
  donAlonso: { did: 'did:plc:m5n8b1v4c7x0z3l6k9j2h5g8', paise: '619900', trust: 0.9 },
} satisfies Record<string, Supplier>;

/** One catalog row on the wire, snake_case as the AppView sends it. */
function wireCandidate(s: Supplier, index: number): Record<string, unknown> {
  return {
    supplier_did: s.did,
    service_uri: `at://${s.did}/com.dinakernel.service.profile/chairs`,
    service_rkey: 'chairs',
    product: PRODUCT,
    catalog_snapshot_ref: `bafy-a6-${String(index)}`,
    matched_fields: ['title'],
    indicative_price: { currency: 'INR', minor_units: s.paise },
    fulfilment_regions: [REGION],
    generated_at: '2026-09-13T00:00:00.000Z',
    retrieval_score_bp: 9000 - index,
  };
}

/** Rupees as digits, for matching after thousands separators are dropped. */
function rupees(paise: string): string {
  return String(Number(paise) / 100);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
interface Scenario {
  label: string;
  /** What the owner told Dina before — stored where the phone would store it. */
  memories: { persona: string; text: string }[];
  /** Contacts in the owner's directory, with any `preferred_for` binding. */
  contacts?: { did: string; name: string; preferredFor?: string[] }[];
  catalog: Supplier[];
  ask: string;
  /** The persona the planner or the loop must have READ for this preference to be the owner's, not the model's. */
  mustReadVault?: string;
  /** What a preference-weighing answer must say (case-insensitive, any). */
  mustContainAny: string[];
  /** A second, independent thing it must also say (any). */
  mustAlsoContainAny?: string[];
  /**
   * What the CARD posted beside the prose must recommend (§5.A6 — the two
   * must agree): any of these supplier DIDs, or `['none']` when the
   * preferences rule every offer out. `notRecommended` names the ranker's #1
   * the card must not carry.
   */
  card: { recommendedAny: string[]; notRecommended?: string };
}

const SCENARIOS: Scenario[] = [
  {
    label: 'reputation over price — ranker #1 is the cheapest seller, whose trust a model would accept on its own',
    memories: [
      {
        persona: 'general',
        text: 'For anything I buy for my home office I would rather pay more to a seller with a strong track record than save money with a merely decent one.',
      },
    ],
    // 72% trust at the lowest price: a fair seller, not a gamble. Without the
    // owner's rule it is the sensible pick; with it, the 94% seller is.
    catalog: [SUPPLIER.cheapFair, SUPPLIER.steadyTrusted, SUPPLIER.premium],
    ask: 'best ergonomic office chair for me',
    mustReadVault: 'general',
    // The answer must tie the pick to the OWNER's statement, not to a trust score alone.
    mustContainAny: ['your rule', 'you said', 'you prefer', 'you would rather', "you'd rather", 'rather pay', 'your home office', 'your note', 'your preference', 'track record'],
    // A trusted seller's price must be on the table, not only the cheapest.
    mustAlsoContainAny: [rupees(SUPPLIER.steadyTrusted.paise), rupees(SUPPLIER.premium.paise)],
    // Either trusted seller honours the stated rule; the cheapest breaks it.
    card: { recommendedAny: [SUPPLIER.steadyTrusted.did, SUPPLIER.premium.did], notRecommended: SUPPLIER.cheapFair.did },
  },
  {
    label: 'budget below every offer — the finance vault must reach a product answer',
    memories: [{ persona: 'finance', text: 'My budget for the new office chair is 4000 rupees and I will not go over it.' }],
    catalog: [SUPPLIER.midUnknown, SUPPLIER.steadyTrusted, SUPPLIER.premium],
    ask: 'best ergonomic office chair for me',
    mustReadVault: 'finance',
    mustContainAny: ['budget', '4000'],
    mustAlsoContainAny: ['over your', 'over budget', 'over the', 'exceed', 'above your', 'above the', 'more than your', 'beyond your', 'outside your', 'none of', 'no offer', 'nothing on the network', 'nothing fits', 'past your'],
    card: { recommendedAny: ['none'], notRecommended: SUPPLIER.midUnknown.did },
  },
  {
    label: 'avoid a seller the owner knows by name — ranker #1 is that seller',
    memories: [
      { persona: 'general', text: 'Never buy from ChairMaker again. The last chair they sent arrived with a cracked base.' },
    ],
    contacts: [{ did: SUPPLIER.chairMaker.did, name: 'ChairMaker' }],
    catalog: [SUPPLIER.chairMaker, SUPPLIER.steadyTrusted, SUPPLIER.midUnknown],
    ask: 'best ergonomic office chair for me',
    mustReadVault: 'general',
    mustContainAny: ['chairmaker'],
    mustAlsoContainAny: ['set aside', 'avoid', 'skip', 'exclud', 'rule', 'cracked', 'never again', 'never buy', 'sworn', 'swore', 'not recommend', "won't recommend", 'ruled out', 'non-starter', 'out of the running'],
    // Either remaining seller is defensible; the sworn-off one is not.
    card: { recommendedAny: [SUPPLIER.steadyTrusted.did, SUPPLIER.midUnknown.did], notRecommended: SUPPLIER.chairMaker.did },
  },
  {
    label: 'preferred seller — a contact bound preferred_for office furniture, not ranker #1',
    memories: [],
    contacts: [{ did: SUPPLIER.donAlonso.did, name: 'Don Alonso Furniture', preferredFor: ['office furniture', 'chairs'] }],
    catalog: [SUPPLIER.cheapUnknown, SUPPLIER.donAlonso, SUPPLIER.steadyTrusted],
    ask: 'best ergonomic office chair for me',
    mustContainAny: ['alonso'],
    card: { recommendedAny: [SUPPLIER.donAlonso.did], notRecommended: SUPPLIER.cheapUnknown.did },
  },
];

/** The card's "Recommended" line, read off the CardSpec the answer carries. */
function recommendedOnCard(answer: Record<string, unknown> | undefined): string {
  const spec = answer?.commerceCard as { blocks?: { kind: string; label?: string; value?: string }[] } | undefined;
  const line = spec?.blocks?.find((b) => b.kind === 'keyValue' && b.label === 'Recommended');
  return line?.value ?? '';
}

/** The ranker's own empty-result line — NOT the owner's decision of "none". */
const HARD_FILTER_NONE = 'none — no offer met the requirements';

/** Does the card carry the decision the scenario expects? */
function cardMatches(recommended: string, want: string): boolean {
  if (want === 'none') return recommended.startsWith('none — ') && recommended !== HARD_FILTER_NONE;
  return recommended.includes(want);
}

// ---------------------------------------------------------------------------
// Fixture AppView — routes on the xRPC method; everything else is empty.
// ---------------------------------------------------------------------------
interface Fixture {
  catalog: Supplier[];
  /** xRPC methods hit, in order — evidence of which tools ran. */
  hits: string[];
}

function fixtureAppView(fixture: Fixture): AppViewClient {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return new AppViewClient({
    appViewURL: 'http://appview.fixture.invalid',
    fetch: async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = url.pathname.replace('/xrpc/', '');
      fixture.hits.push(method);
      if (method === 'com.dinakernel.commerce.searchCatalog') {
        return json({ candidates: fixture.catalog.map(wireCandidate) });
      }
      if (method === 'com.dinakernel.peerlens.getProfile') {
        const did = url.searchParams.get('did');
        const supplier = fixture.catalog.find((s) => s.did === did);
        if (supplier === undefined) return json({ error: 'not_found' }, 404);
        return json({ did, overallTrustScore: supplier.trust });
      }
      return json({ results: [] });
    },
  });
}

// ---------------------------------------------------------------------------
// Provider tap — records the model's tool calls per turn. Evidence only.
// ---------------------------------------------------------------------------
function tapProvider(inner: LLMProvider, turns: string[][]): LLMProvider {
  return {
    name: inner.name,
    supportsStreaming: inner.supportsStreaming,
    supportsToolCalling: inner.supportsToolCalling,
    supportsEmbedding: inner.supportsEmbedding,
    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
      const response = await inner.chat(messages, options);
      turns.push(response.toolCalls.map((c) => c.name));
      return response;
    },
    stream: (messages, options) => inner.stream(messages, options),
    embed: (text, options) => inner.embed(text, options),
  };
}

// ---------------------------------------------------------------------------
// SQLCipher stores — the persona vaults and the identity file, as on a node.
// ---------------------------------------------------------------------------
function openStore(dir: string, file: string): NodeSQLiteAdapter {
  return new NodeSQLiteAdapter({
    path: path.join(dir, file),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
}

const describeReal = LLM_CONFIG !== null ? describe : describe.skip;

describeReal('A6 — offers weighed against the owner’s stated preferences (real model, production composition)', () => {
  let dir = '';
  const stores: NodeSQLiteAdapter[] = [];
  const vaults: { persona: string; adapter: NodeSQLiteAdapter; repo: SQLiteVaultRepository }[] = [];
  let identity: NodeSQLiteAdapter;
  let core: InProcessTransport;
  let runtime: HomeNodeAskRuntime;
  const fixture: Fixture = { catalog: [], hits: [] };
  const turns: string[][] = [];
  /** Personas the planner's pre-flight fetch READ and got rows from — evidence the preference came from the owner. */
  const fetched: string[] = [];

  beforeAll(() => {
    clearVaults([]);
    resetPersonaState();
    configureRateLimiter({ maxRequests: 10_000, windowSeconds: 60 });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-a6-'));

    for (const p of PERSONAS) {
      createPersona(p.name, p.tier, p.description);
      const adapter = openStore(dir, `${p.name}.sqlite`);
      applyMigrations(adapter, PERSONA_MIGRATIONS);
      const repo = new SQLiteVaultRepository(adapter);
      setVaultRepository(p.name, repo);
      stores.push(adapter);
      vaults.push({ persona: p.name, adapter, repo });
    }
    // As the server publishes them at boot (boot.ts): every persona Core lists
    // is one Brain's own vault tools may read. Without this Brain's default
    // (`general` only) would show three vaults as locked to the loop.
    setAccessiblePersonas(PERSONAS.map((p) => p.name));

    identity = openStore(dir, 'identity.sqlite');
    applyMigrations(identity, IDENTITY_MIGRATIONS);
    stores.push(identity);
    setPeopleRepository(new SQLitePeopleRepository(identity));
    setContactRepository(new SQLiteContactRepository(identity));
    resetContactDirectory();

    core = new InProcessTransport(createCoreRouter());

    const llm = buildBrainServerLLMRuntime(llmConfig());
    if (llm === undefined) throw new Error('A6: the LLM runtime did not build');

    // The server's boot wiring (boot.ts): planner fetchers through the
    // CoreClient, the persona menu with the shared descriptions, the owner
    // shortcut, and a fast path long enough to hold the multi-turn loop
    // inline (the SPA delivers overflow over SSE; a test has no stream).
    runtime = buildHomeNodeAskRuntime({
      llm: tapProvider(llm.llm, turns),
      providerName: llm.providerName,
      core,
      appView: fixtureAppView(fixture),
      sensitivePersonas: ['health', 'finance'],
      cloudConsentGranted: true,
      installedPersonas: () => PERSONAS.map((p) => ({ name: p.name, description: p.description })),
      retrievalFetchers: {
        async vaultSearch(persona, query) {
          const result = await core.vaultQuery(persona, { mode: 'fts5', text: query, limit: 5 });
          if (result.items.length > 0) fetched.push(persona);
          return result.items.map((item) => ({
            id: String(item.id ?? ''),
            content_l0: String(item.content_l0 ?? item.summary ?? ''),
            ...(typeof item.body === 'string' ? { body: item.body } : {}),
            persona,
          }));
        },
        async findPerson(name) {
          const matches = await core.peopleFindByName(name);
          return matches.map((p) => ({
            canonicalName: p.canonicalName,
            ...(p.relationshipHint !== '' ? { relationshipHint: p.relationshipHint } : {}),
            surfaceSummary: (p.surfaces ?? [])
              .filter((s) => s.status !== 'rejected')
              .map((s) => s.surface)
              .slice(0, 3)
              .join(', '),
          }));
        },
      },
      ownerDid: OWNER_DID,
      fastPathMs: 170_000,
    });
  });

  beforeEach(() => {
    for (const v of vaults) {
      setVaultRepository(v.persona, v.repo);
      v.adapter.execute('DELETE FROM vault_items');
    }
    resetContactDirectory();
    for (const t of ['contact_aliases', 'contacts', 'person_surfaces', 'person_identities', 'person_extraction_log', 'people']) {
      identity.execute(`DELETE FROM ${t}`);
    }
    fixture.hits.length = 0;
    turns.length = 0;
    fetched.length = 0;
  });

  afterAll(() => {
    setAccessiblePersonas(['general']);
    resetContactDirectory();
    setContactRepository(null);
    setPeopleRepository(null);
    for (const v of vaults) setVaultRepository(v.persona, null);
    for (const s of stores) {
      try {
        s.close();
      } catch {
        /* idempotent */
      }
    }
    if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
    resetPersonaState();
  });

  it.each(SCENARIOS)(
    '$label',
    async (scenario: Scenario) => {
      for (const m of scenario.memories) storeItem(m.persona, { type: 'user_memory', summary: m.text, body: m.text });
      for (const c of scenario.contacts ?? []) {
        addContact(c.did, c.name, 'verified');
        if (c.preferredFor !== undefined) await core.updateContact(c.did, { preferredFor: c.preferredFor });
      }
      fixture.catalog = scenario.catalog;

      const result = await runtime.coordinator.handleAsk({
        question: scenario.ask,
        requesterDid: OWNER_DID,
        requestIdHeader: `a6-${String(SCENARIOS.indexOf(scenario))}`,
      });
      expect(result.kind).toBe('fast_path');
      if (result.kind !== 'fast_path') return;
      expect(result.body.status).toBe('complete');
      const text = result.body.answer?.text;
      const answer = typeof text === 'string' ? text : '';
      // Drop thousands separators so "₹5,899" and "5899" match one needle.
      const haystack = answer.toLowerCase().replace(/(\d),(\d)/g, '$1$2');

      const primary = scenario.mustContainAny.find((n) => haystack.includes(n.toLowerCase()));
      const secondary = scenario.mustAlsoContainAny?.find((n) => haystack.includes(n.toLowerCase()));
      const recommended = recommendedOnCard(result.body.answer);
      const cardAgrees =
        scenario.card.recommendedAny.some((want) => cardMatches(recommended, want)) &&
        (scenario.card.notRecommended === undefined || !recommended.includes(scenario.card.notRecommended));
      // The preference reached the loop from the OWNER's vault: the planner
      // fetched rows from that persona, or the loop's own vault_search ran.
      const readVault =
        scenario.mustReadVault === undefined ||
        fetched.includes(scenario.mustReadVault) ||
        turns.some((t) => t.includes('vault_search'));
      const pass =
        primary !== undefined &&
        (scenario.mustAlsoContainAny === undefined || secondary !== undefined) &&
        cardAgrees &&
        readVault;

      // Evidence for the notes: tool sequence per turn, AppView methods hit,
      // the answer. Fixture data only.
      console.warn(
        `\n[A6 ${pass ? 'PASS' : 'MISS'}] ${scenario.label}` +
          `\n  provider: ${llmConfig().provider}${llmConfig().model !== undefined ? ` ${llmConfig().model}` : ''}` +
          `\n  ask: ${scenario.ask}` +
          `\n  tools by turn: ${JSON.stringify(turns)}` +
          `\n  appview: ${JSON.stringify(fixture.hits)}` +
          `\n  needed: ${JSON.stringify(scenario.mustContainAny)}${scenario.mustAlsoContainAny !== undefined ? ` AND ${JSON.stringify(scenario.mustAlsoContainAny)}` : ''}` +
          `\n  planner fetched from: ${JSON.stringify(fetched)}` +
          `\n  card recommends: ${recommended === '' ? '(no card)' : recommended}` +
          `\n  answer:\n    ${answer.split('\n').join('\n    ')}\n`,
      );

      // The loop researched: the fixture catalog was asked.
      expect(fixture.hits).toContain('com.dinakernel.commerce.searchCatalog');
      expect(primary).toBeDefined();
      if (scenario.mustAlsoContainAny !== undefined) expect(secondary).toBeDefined();
      // The card posted beside the prose carries the same decision.
      expect(cardAgrees).toBe(true);
      // The preference came from the owner's vault, not the model's own bias.
      expect(readVault).toBe(true);
    },
    180_000,
  );
});

if (LLM_CONFIG === null) {
  describe('A6 preference diligence (skipped)', () => {
    it('skipped: set DINA_RUN_REAL_LLM=1 and DINA_BRAIN_LLM_PROVIDER (+ its key) to run', () => {
      expect(LLM_CONFIG).toBeNull();
    });
  });
}
