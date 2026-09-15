/**
 * LIVE intent-classifier routing eval (costs money — gated OFF by default).
 *
 * Runs real-world queries through the REAL `IntentClassifier` against a LIVE
 * model and asserts each routes to the expected substrate. This is a
 * non-deterministic, paid eval — deliberately NOT part of the normal unit
 * suite (it `describe.skip`s itself unless explicitly enabled), so `npm test`
 * / CI stay free + deterministic.
 *
 * Run it on demand (OpenRouter is the default provider — the owner's decision
 * of 2026-09-13; Gemini when EVAL_PROVIDER=gemini and a Gemini key is set):
 *   RUN_INTENT_EVAL=1 OPENROUTER_API_KEY=… npx jest intent_classifier.eval --runInBand
 *   RUN_INTENT_EVAL=1 EVAL_PROVIDER=gemini GEMINI_API_KEY=… npx jest intent_classifier.eval --runInBand
 *   # optional: EVAL_MODEL=<model id> to eval a different model
 *
 * Why a live test (not a fixture): the thing under test is whether the prompt
 * makes a real model route correctly — a recorded fixture would only re-assert
 * a frozen answer, not the behaviour. Scenario set mirrors the four substrates
 * (vault / general_knowledge / peerlens / provider_services) plus the
 * established-relationship path. Temperature 0 + a small transient-error retry
 * keep it as stable as a live call gets; a genuine routing regression fails it.
 */
import { GoogleGenAI } from '@google/genai';

import { DEFAULT_OPENROUTER_LITE_MODEL } from '../../src/constants';
import { OpenRouterAdapter } from '../../src/llm/adapters/openrouter';
import { IntentClassifier, type IntentSource } from '../../src/reasoning/intent_classifier';

const PROVIDER = (process.env.EVAL_PROVIDER ?? 'openrouter').trim().toLowerCase();
const API_KEY =
  PROVIDER === 'gemini'
    ? (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '')
    : (process.env.DINA_OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY ?? '');
const ENABLED = process.env.RUN_INTENT_EVAL === '1' && API_KEY !== '';
// The production tier for `intent_classification` is the lite model.
const MODEL = process.env.EVAL_MODEL ?? (PROVIDER === 'gemini' ? 'gemini-2.5-flash' : DEFAULT_OPENROUTER_LITE_MODEL);

/** Skip the whole suite unless explicitly opted in with a key present. */
const suite = ENABLED ? describe : describe.skip;

interface EvalCase {
  kind: string;
  q: string;
  /** Source that MUST be present in the routing. */
  expect: IntentSource;
  /** Source that must NOT be present (e.g. a price query is not pure general knowledge). */
  notExpect?: IntentSource;
}

const CASES: readonly EvalCase[] = [
  // ── memory / vault recall ──
  { kind: 'memory', q: "When is Emma's birthday?", expect: 'vault' },
  { kind: 'memory', q: 'What did I note about my Barclays account?', expect: 'vault' },
  // ── general knowledge (must NOT escalate to service discovery) ──
  {
    kind: 'general',
    q: 'What is the capital of Turkey?',
    expect: 'general_knowledge',
    notExpect: 'provider_services',
  },
  {
    kind: 'general',
    q: 'How does a doner kebab differ from a shawarma?',
    expect: 'general_knowledge',
    notExpect: 'provider_services',
  },
  // ── peerlens (buying decision / product reputation) ──
  { kind: 'peerlens', q: 'Which ergonomic office chair should I buy?', expect: 'peerlens' },
  { kind: 'peerlens', q: 'Are the Sony WH-1000XM5 headphones worth it?', expect: 'peerlens' },
  { kind: 'peerlens', q: 'What do people think of the new Dyson vacuum?', expect: 'peerlens' },
  // ── products (offers across suppliers — the research loop, §5.A1). A product
  //    compared across suppliers is NOT a named store's live state; "where can I
  //    buy" may honestly carry both, so only the first two exclude the store path.
  { kind: 'products', q: 'best ergonomic office chair for me', expect: 'products', notExpect: 'provider_services' },
  { kind: 'products', q: 'compare prices for a 1TB NVMe SSD', expect: 'products', notExpect: 'provider_services' },
  { kind: 'products', q: 'where can I buy a Prestige 3-litre pressure cooker?', expect: 'products' },
  { kind: 'products', q: 'which running shoes should I get', expect: 'products' },
  // ── provider services (live / local / commercial state) ──
  {
    kind: 'service',
    q: 'What is the price of kebab at a Turkish restaurant?',
    expect: 'provider_services',
  },
  { kind: 'service', q: 'When does bus 42 reach Castro?', expect: 'provider_services' },
  {
    kind: 'service',
    q: 'Any dentist appointments open near me this week?',
    expect: 'provider_services',
  },
  {
    kind: 'service',
    q: 'Can I get a quote to fix my leaking kitchen tap?',
    expect: 'provider_services',
  },
  { kind: 'service', q: 'Is the corner bakery open right now?', expect: 'provider_services' },
  { kind: 'service', q: 'Book me a haircut at 4pm tomorrow', expect: 'provider_services' },
  { kind: 'service', q: 'Track parcel 1Z999AA10123456784', expect: 'provider_services' },
  // ── established relationship ("my X") → provider_services Path 1 ──
  {
    kind: 'relationship',
    q: 'When is my next appointment with my dentist?',
    expect: 'provider_services',
  },
];

suite(`IntentClassifier — live routing eval (${PROVIDER} ${MODEL})`, () => {
  let gemini: GoogleGenAI | null = null;
  let openrouter: OpenRouterAdapter | null = null;

  /** One live call, by provider. */
  const callOnce = async (system: string, prompt: string): Promise<string> => {
    if (PROVIDER === 'gemini') {
      if (gemini === null) gemini = new GoogleGenAI({ apiKey: API_KEY });
      const res = await gemini.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: { systemInstruction: system, temperature: 0 },
      });
      return res.text ?? '';
    }
    if (openrouter === null) openrouter = new OpenRouterAdapter({ apiKey: API_KEY, defaultModel: MODEL });
    // The production budget (`buildLightweightLLMCall`): a reasoning model
    // spends tokens thinking before the JSON, and 512 leaves it with none.
    const res = await openrouter.chat([{ role: 'user', content: prompt }], { systemPrompt: system, temperature: 0, maxTokens: 2048 });
    return res.content;
  };

  /** Live model call with a small retry on transient API errors (not on routing). */
  const llm = async (system: string, prompt: string): Promise<string> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await callOnce(system, prompt);
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw lastErr;
  };

  const classifier = new IntentClassifier({ llm, tocFetcher: async () => [] });

  it.each(CASES)(
    '[$kind] "$q" → $expect',
    async ({ q, expect: want, notExpect }) => {
      const out = await classifier.classify(q);
      console.log(
        `  ${q}\n    → sources=[${out.sources.join(',')}] temporal=${out.temporal || '-'}`,
      );
      expect(out.sources).toContain(want);
      if (notExpect !== undefined) expect(out.sources).not.toContain(notExpect);
    },
    // A reasoning model thinks before the JSON; one slow call must not read as a routing failure.
    90_000,
  );
});
