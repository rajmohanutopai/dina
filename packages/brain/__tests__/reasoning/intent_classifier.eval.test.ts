/**
 * LIVE intent-classifier routing eval (costs money — gated OFF by default).
 *
 * Runs real-world queries through the REAL `IntentClassifier` against a LIVE
 * Gemini model and asserts each routes to the expected substrate. This is a
 * non-deterministic, paid eval — deliberately NOT part of the normal unit
 * suite (it `describe.skip`s itself unless explicitly enabled), so `npm test`
 * / CI stay free + deterministic.
 *
 * Run it on demand:
 *   RUN_INTENT_EVAL=1 GEMINI_API_KEY=… npx jest intent_classifier.eval --runInBand
 *   # optional: EVAL_MODEL=gemini-2.5-pro to eval a different model
 *
 * Why a live test (not a fixture): the thing under test is whether the prompt
 * makes a real model route correctly — a recorded fixture would only re-assert
 * a frozen answer, not the behaviour. Scenario set mirrors the four substrates
 * (vault / general_knowledge / peerlens / provider_services) plus the
 * established-relationship path. Temperature 0 + a small transient-error retry
 * keep it as stable as a live call gets; a genuine routing regression fails it.
 */
import { GoogleGenAI } from '@google/genai';

import { IntentClassifier, type IntentSource } from '../../src/reasoning/intent_classifier';

const API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
const ENABLED = process.env.RUN_INTENT_EVAL === '1' && API_KEY !== '';
const MODEL = process.env.EVAL_MODEL ?? 'gemini-2.5-flash';

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

suite('IntentClassifier — live routing eval', () => {
  let client: GoogleGenAI | null = null;
  const getClient = (): GoogleGenAI => {
    if (client === null) client = new GoogleGenAI({ apiKey: API_KEY });
    return client;
  };

  /** Live model call with a small retry on transient API errors (not on routing). */
  const llm = async (system: string, prompt: string): Promise<string> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await getClient().models.generateContent({
          model: MODEL,
          contents: prompt,
          config: { systemInstruction: system, temperature: 0 },
        });
        return res.text ?? '';
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
    30_000,
  );
});
