/**
 * Persona classification — 100-scenario parity suite, real Gemini.
 *
 * Byte-for-byte port of `tests/prompt/test_persona_classification.py`
 * SCENARIOS + RELATIONSHIP_SCENARIOS. Same system prompt (now
 * `PERSONA_CLASSIFY`), same schema, same JSON user-message shape.
 * The Python run lands 100/100 on `gemini-3.1-flash-preview` /
 * `gemini-3.1-pro-preview`; this file pins the TS stack to the same
 * quality bar so drift between the two stacks becomes a test failure
 * rather than a silent mobile regression.
 *
 * Entry point exercised: `createGeminiClassifier(provider)(input,
 * availablePersonas)` — the same production factory the mobile boot
 * wires into `registerPersonaSelector` at startup. No wrapper, no
 * synthetic prompt, no fake LLM.
 *
 * Env gates:
 *   GEMINI_API_KEY | GOOGLE_API_KEY — required (test file is skipped
 *     when absent).
 *   GEMINI_CLASSIFY_MODEL — override. Defaults to
 *     `gemini-3.1-flash-preview` for cost/latency parity with the
 *     Python run (flash is the classifier's production model; pro is
 *     reserved for the agentic `/ask` loop).
 *   DINA_PROMPT_FULL_100 — set to any non-empty string to run all
 *     100+10 scenarios. By default only 15 scenarios run (2 per
 *     category × 5 + 5 relationship) so per-PR runs stay under a
 *     minute. The Python suite does the same category-sampling in
 *     day-to-day dev.
 */

import { GeminiGenaiAdapter } from '../../src/llm/adapters/gemini_genai';
import { LLMRouter, RoutedLLMProvider } from '../../src/llm/router_dispatch';
import {
  createGeminiClassifier,
  type InstalledPersona,
} from '../../src/routing/gemini_classify';
import type { ClassificationInput, MentionedContact } from '../../src/routing/domain';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
// No hardcoded classification model here. The production
// `createGeminiClassifier` auto-picks the `lite` tier via
// `getProviderTiers('gemini').lite` (currently
// `gemini-3.1-flash-lite-preview`) — the same path the mobile
// `/remember` drain hits at runtime. Overriding from this test would
// make the suite measure a different model than production ships.
// Set `GEMINI_CLASSIFY_MODEL` in the environment to pin a model
// for cost-tuning local runs; production is unaffected.
const GEMINI_CLASSIFY_MODEL_OVERRIDE = process.env.GEMINI_CLASSIFY_MODEL ?? '';
const RUN_ALL_100 =
  process.env.DINA_PROMPT_FULL_100 !== undefined && process.env.DINA_PROMPT_FULL_100 !== '';

// Same persona set Python test defines — name/tier/description triple
// matches PERSONA_DEFS in `tests/prompt/test_persona_classification.py`.
const INSTALLED_PERSONAS: InstalledPersona[] = [
  {
    name: 'general',
    tier: 'default',
    description:
      'General personal information, social contacts, hobbies, preferences, family, friends',
  },
  {
    name: 'health',
    tier: 'sensitive',
    description: 'Medical records, doctor visits, prescriptions, diagnoses, health conditions',
  },
  {
    name: 'work',
    tier: 'standard',
    description: 'Professional tasks, meetings, projects, colleagues, career',
  },
  {
    name: 'finance',
    tier: 'sensitive',
    description: 'Bank accounts, investments, taxes, insurance, bills, budgets, salaries',
  },
];
const AVAILABLE_PERSONAS = INSTALLED_PERSONAS.map((p) => p.name);

interface Scenario {
  text: string;
  expected: string;
  contacts?: MentionedContact[];
}

/** 100 persona-classification scenarios from
 *  `tests/prompt/test_persona_classification.py`. */
const SCENARIOS: Scenario[] = [
  // ── General: social facts ──
  { text: 'Alonso likes cold brew coffee extra strong', expected: 'general' },
  { text: 'My neighbor Sarah makes the best apple pie on the block', expected: 'general' },
  { text: "Sancho's favorite movie is The Shawshank Redemption", expected: 'general' },
  { text: 'We usually watch football together on Sunday afternoons', expected: 'general' },
  { text: 'My dog Max loves playing fetch at the park every morning', expected: 'general' },
  { text: "Emma's birthday is March 15 and she loves dinosaurs", expected: 'general' },
  { text: "The best pizza in town is at Joe's on 5th Avenue", expected: 'general' },
  { text: 'I promised to help Mike move apartments next Saturday', expected: 'general' },
  { text: "My mom's lasagna recipe uses three kinds of cheese", expected: 'general' },
  { text: 'I met Sancho at college in 2015, we were roommates', expected: 'general' },
  {
    text: 'My sister just got engaged to Tom, wedding is in October',
    expected: 'general',
  },
  { text: 'Dave prefers window seats on flights and always books aisle', expected: 'general' },
  { text: 'My kids love going to the aquarium on rainy weekends', expected: 'general' },
  { text: 'Sancho is vegetarian and allergic to tree nuts', expected: 'general' },
  { text: 'My favorite coffee shop is Blue Bottle on Market Street', expected: 'general' },
  { text: 'We adopted a cat named Luna from the shelter last month', expected: 'general' },
  {
    text: "My dad's 70th birthday party is at the Italian restaurant downtown",
    expected: 'general',
  },
  { text: 'I usually run 3 miles every morning before work', expected: 'general' },
  {
    text: "The book club meets every second Thursday at Maria's house",
    expected: 'general',
  },
  {
    text: 'When friends visit, I usually order from the Thai place nearby',
    expected: 'general',
  },
  { text: 'My niece is learning piano and has a recital on May 10', expected: 'general' },
  { text: 'I prefer to fly Delta when traveling to the East Coast', expected: 'general' },
  {
    text: 'Our anniversary is June 22, we always go to that French bistro',
    expected: 'general',
  },
  { text: 'Sancho brings banana bread whenever he visits', expected: 'general' },
  { text: 'My neighbor lent me their lawnmower, need to return it', expected: 'general' },
  // ── Health ──
  {
    text: 'I have chronic lower back pain and need lumbar support',
    expected: 'health',
  },
  { text: 'My blood pressure was 130/85 at last checkup', expected: 'health' },
  {
    text: 'I take 10mg of lisinopril every morning for hypertension',
    expected: 'health',
  },
  {
    text: 'Allergic to penicillin — discovered during surgery in 2019',
    expected: 'health',
  },
  { text: 'Dr. Martinez said my cholesterol is borderline high', expected: 'health' },
  { text: 'I need to schedule a dental cleaning before end of June', expected: 'health' },
  {
    text: 'My daughter has a peanut allergy — always carry an EpiPen',
    expected: 'health',
  },
  { text: 'MRI results show a herniated disc at L4-L5', expected: 'health' },
  { text: 'I was diagnosed with Type 2 diabetes last year', expected: 'health' },
  {
    text: 'My therapist recommended cognitive behavioral therapy sessions',
    expected: 'health',
  },
  {
    text: 'I get migraines about twice a month, usually triggered by stress',
    expected: 'health',
  },
  { text: 'Physical therapy appointment every Tuesday at 3pm', expected: 'health' },
  {
    text: 'My optometrist said I need new glasses, prescription changed',
    expected: 'health',
  },
  { text: 'I had my flu shot on October 15 at CVS', expected: 'health' },
  {
    text: 'My doctor recommended I reduce sodium intake to under 2000mg',
    expected: 'health',
  },
  { text: 'Annual physical is scheduled for November 3 with Dr. Chen', expected: 'health' },
  { text: "I'm on a waiting list for an orthopedic specialist", expected: 'health' },
  { text: 'My son has asthma and uses an albuterol inhaler', expected: 'health' },
  { text: 'Bloodwork came back normal except for low vitamin D', expected: 'health' },
  { text: 'I need to refill my Metformin prescription this week', expected: 'health' },
  // ── Work ──
  { text: 'Team standup is at 9am every Monday, Wednesday, Friday', expected: 'work' },
  {
    text: 'Q3 project deadline is September 30, need to finish the API migration',
    expected: 'work',
  },
  {
    text: 'My manager Dave wants the performance review draft by Friday',
    expected: 'work',
  },
  {
    text: 'The new intern starts on Monday, I need to prepare onboarding docs',
    expected: 'work',
  },
  {
    text: 'Client presentation for Acme Corp is next Thursday at 2pm',
    expected: 'work',
  },
  { text: 'Need to submit the quarterly expense report by end of month', expected: 'work' },
  { text: 'One-on-one with my skip-level manager is every other Friday', expected: 'work' },
  { text: 'The Jenkins pipeline has been failing on the staging branch', expected: 'work' },
  {
    text: 'Team offsite is planned for the third week of August in Denver',
    expected: 'work',
  },
  { text: "I'm mentoring two junior engineers this quarter", expected: 'work' },
  { text: 'Sprint retrospective is tomorrow at 4pm in Conference Room B', expected: 'work' },
  {
    text: 'The product launch is scheduled for Q4, marketing needs assets by Sept 15',
    expected: 'work',
  },
  { text: 'My work laptop is a 2024 MacBook Pro with 32GB RAM', expected: 'work' },
  { text: 'I need to complete the compliance training module before Friday', expected: 'work' },
  { text: 'My team lead Sarah is on parental leave until September', expected: 'work' },
  // ── Finance ──
  { text: 'My checking account at Chase ends in 4521', expected: 'finance' },
  {
    text: 'Car insurance renewal is due August 15, currently $180/month',
    expected: 'finance',
  },
  { text: 'I contributed $6500 to my Roth IRA this year', expected: 'finance' },
  { text: 'Property tax bill is $4200, due December 1', expected: 'finance' },
  { text: 'My monthly budget for groceries is around $600', expected: 'finance' },
  { text: 'Mortgage payment is $2100/month, 30-year fixed at 6.5%', expected: 'finance' },
  { text: 'I owe $3200 on my Visa credit card, due on the 15th', expected: 'finance' },
  { text: 'My 401k balance is around $180,000, mostly in index funds', expected: 'finance' },
  { text: 'Auto loan has 18 months remaining, $450/month payment', expected: 'finance' },
  { text: 'I need to file estimated taxes for Q2 by June 15', expected: 'finance' },
  {
    text: 'Home insurance covers up to $500,000 with a $1000 deductible',
    expected: 'finance',
  },
  { text: 'I transferred $5000 from savings to checking last week', expected: 'finance' },
  { text: 'My annual salary is $125,000 before taxes', expected: 'finance' },
  { text: 'Student loan balance is $28,000 at 4.5% interest', expected: 'finance' },
  {
    text: "I set aside $500/month for my kids' 529 college savings plan",
    expected: 'finance',
  },
  // ── Tricky edge cases ──
  {
    text: 'Meeting Dr. Williams for lunch at the Italian place on Tuesday',
    expected: 'general',
  },
  { text: 'I drink green smoothies every morning before my run', expected: 'general' },
  { text: 'My gym membership at Planet Fitness costs $25/month', expected: 'finance' },
  {
    text: 'The office holiday party is December 20, I signed up to bring dessert',
    expected: 'work',
  },
  {
    text: 'Max needs his rabies booster shot next month at the vet',
    expected: 'health',
  },
  {
    text: "Sancho's mom is recovering from hip surgery, doing much better",
    expected: 'general',
  },
  {
    text: "I'm trying the keto diet to lose some weight this summer",
    expected: 'health',
  },
  {
    text: 'My doctor put me on a low-sodium diet after the heart scare',
    expected: 'health',
  },
  { text: 'I spent $450 on the team dinner, need to expense it', expected: 'work' },
  { text: 'I want to buy a new standing desk for my home office', expected: 'work' },
  {
    text: "I've been learning to make sourdough bread, my starter is 3 weeks old",
    expected: 'general',
  },
  { text: "We're planning a road trip to Yellowstone in August", expected: 'general' },
  { text: 'My work email is john.smith@acme.com', expected: 'work' },
  {
    text: 'I need to compare health insurance plans during open enrollment',
    expected: 'finance',
  },
  {
    text: 'My grandmother passed away last March, I miss her a lot',
    expected: 'general',
  },
  {
    text: "My sleep tracker shows I'm only averaging 5.5 hours per night",
    expected: 'health',
  },
  {
    text: 'We need to repaint the living room, thinking about sage green',
    expected: 'general',
  },
  {
    text: 'The hospital bill for my ER visit was $4,800 after insurance',
    expected: 'finance',
  },
  {
    text: 'My fishing rod broke last weekend, need to get a new one',
    expected: 'general',
  },
  {
    text: 'I need to renew my AWS certification before it expires in November',
    expected: 'work',
  },
  {
    text: 'Netflix raised their price to $22.99/month, considering canceling',
    expected: 'finance',
  },
  {
    text: 'Sancho just got promoted to VP of Engineering at his company',
    expected: 'general',
  },
  {
    text: 'COVID booster appointment is scheduled for next Wednesday at 2pm',
    expected: 'health',
  },
  { text: 'I set a $200 budget for holiday gifts this year', expected: 'finance' },
  {
    text: 'I signed up to volunteer at the food bank every other Saturday',
    expected: 'general',
  },
];

/** 10 relationship-aware scenarios from Python. */
const RELATIONSHIP_SCENARIOS: Scenario[] = [
  {
    text: 'Sancho has a peanut allergy',
    contacts: [{ name: 'Sancho', relationship: 'friend', data_responsibility: 'external' }],
    expected: 'general',
  },
  {
    text: 'Emma has a peanut allergy',
    contacts: [{ name: 'Emma', relationship: 'child', data_responsibility: 'household' }],
    expected: 'health',
  },
  {
    text: 'Sancho likes cold brew coffee extra strong',
    contacts: [{ name: 'Sancho', relationship: 'friend', data_responsibility: 'external' }],
    expected: 'general',
  },
  {
    text: 'Sarah has high blood pressure',
    contacts: [{ name: 'Sarah', relationship: 'spouse', data_responsibility: 'household' }],
    expected: 'health',
  },
  {
    text: 'Dave got a big raise, now earning $150K',
    contacts: [{ name: 'Dave', relationship: 'colleague', data_responsibility: 'external' }],
    expected: 'general',
  },
  {
    text: 'Sancho was diagnosed with diabetes last month',
    contacts: [{ name: 'Sancho', relationship: 'friend', data_responsibility: 'external' }],
    expected: 'general',
  },
  {
    text: "Emma's school tuition is $15,000 this year",
    contacts: [{ name: 'Emma', relationship: 'child', data_responsibility: 'household' }],
    expected: 'finance',
  },
  {
    text: "Mom's blood pressure was 150/95 at her last checkup",
    contacts: [{ name: 'Mom', relationship: 'parent', data_responsibility: 'external' }],
    expected: 'general',
  },
  {
    text: "Mom's blood pressure was 150/95 at her last checkup",
    contacts: [{ name: 'Mom', relationship: 'parent', data_responsibility: 'care' }],
    expected: 'health',
  },
  {
    text: 'My blood pressure is 130/85',
    contacts: [],
    expected: 'health',
  },
];

if (SCENARIOS.length !== 100) {
  throw new Error(`Expected 100 scenarios, got ${SCENARIOS.length}`);
}
if (RELATIONSHIP_SCENARIOS.length !== 10) {
  throw new Error(
    `Expected 10 relationship scenarios, got ${RELATIONSHIP_SCENARIOS.length}`,
  );
}

/** 15-scenario smoke set — 2 per category + 5 relationship. Matches the
 *  cadence the Python run defaults to during day-to-day dev. */
const SMOKE_SCENARIOS: Scenario[] = [
  SCENARIOS[0]!,
  SCENARIOS[4]!,
  SCENARIOS[25]!,
  SCENARIOS[27]!,
  SCENARIOS[45]!,
  SCENARIOS[46]!,
  SCENARIOS[60]!,
  SCENARIOS[61]!,
  SCENARIOS[75]!,
  SCENARIOS[79]!,
  RELATIONSHIP_SCENARIOS[0]!,
  RELATIONSHIP_SCENARIOS[1]!,
  RELATIONSHIP_SCENARIOS[3]!,
  RELATIONSHIP_SCENARIOS[4]!,
  RELATIONSHIP_SCENARIOS[9]!,
];

const ALL_SCENARIOS: Scenario[] = RUN_ALL_100
  ? [...SCENARIOS, ...RELATIONSHIP_SCENARIOS]
  : SMOKE_SCENARIOS;

const describeReal = GEMINI_API_KEY ? describe : describe.skip;

describeReal(
  `Persona classification — real Gemini (${ALL_SCENARIOS.length} scenarios, lite tier${GEMINI_CLASSIFY_MODEL_OVERRIDE !== '' ? ` [override: ${GEMINI_CLASSIFY_MODEL_OVERRIDE}]` : ''})`,
  () => {
    let classifier: ReturnType<typeof createGeminiClassifier>;

    beforeAll(() => {
      // Full production composition, same wiring mobile's
      // `boot_capabilities.ts::tryBuildAgenticAsk` builds at app start:
      //   1. Raw GeminiGenaiAdapter (Google SDK, thoughtSignature
      //      round-trip, native responseSchema).
      //   2. LLMRouter wrapping it — PII scrub + cloud-consent gate +
      //      task_type → tier mapping.
      //   3. RoutedLLMProvider bound to `taskType: 'classify'` — the
      //      router picks `gemini-3.1-flash-lite-preview` per call.
      //   4. createGeminiClassifier on top.
      // Nothing in the test path is synthetic; a regression in any
      // layer surfaces here.
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
      const classifyProvider = new RoutedLLMProvider({
        router,
        taskType: 'classify',
        label: 'routed:classify:test',
      });
      classifier = createGeminiClassifier(classifyProvider, {
        // Inline resolver — test doesn't depend on Core's persona
        // service being populated. Production wires this via the
        // default resolver which reads `getPersona(name)`.
        resolveInstalledPersonas: (names) =>
          names
            .map((name) => INSTALLED_PERSONAS.find((p) => p.name === name) ?? { name })
            .filter((p): p is InstalledPersona => p !== undefined),
        // Explicit override applies only when the env var is set —
        // lets dev runs A/B a specific model without editing this
        // file. Default path hits the router's tier auto-pick.
        ...(GEMINI_CLASSIFY_MODEL_OVERRIDE !== ''
          ? { model: GEMINI_CLASSIFY_MODEL_OVERRIDE }
          : {}),
      });
    });

    it.each(ALL_SCENARIOS.map((s, idx) => [idx, s] as const))(
      'scenario %02d → %s',
      async (_idx: number, scenario: Scenario) => {
        const input: ClassificationInput = {
          type: 'note',
          source: 'telegram',
          sender: 'owner',
          subject: scenario.text.slice(0, 200),
          body: scenario.text.slice(0, 300),
          ...(scenario.contacts && scenario.contacts.length > 0
            ? { mentionedContacts: scenario.contacts }
            : {}),
        };
        const result = await classifier(input, AVAILABLE_PERSONAS);
        if (result.persona !== scenario.expected) {
          // eslint-disable-next-line no-console
          console.log(
            `[scenario] text=${JSON.stringify(scenario.text)} expected=${scenario.expected} got=${result.persona} reason=${result.reason}`,
          );
        }
        expect(result.persona).toBe(scenario.expected);
      },
      60_000,
    );
  },
);

if (!GEMINI_API_KEY) {
  describe('Persona classification — skipped', () => {
    it('set GEMINI_API_KEY or GOOGLE_API_KEY to run', () => {
      expect(GEMINI_API_KEY).toBe('');
    });
  });
}
