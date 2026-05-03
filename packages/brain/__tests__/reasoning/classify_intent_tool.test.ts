/**
 * Unit tests for the `classify_intent` tool factory — the
 * LLM-callable wrapper around `IntentClassifier` so the agentic loop
 * can re-evaluate routing mid-loop.
 *
 * These specs pin:
 *   - tool exposes the right name / description / schema.
 *   - empty query short-circuits to a conservative default (no LLM
 *     call), matching `IntentClassifier.classify('')`.
 *   - non-empty query delegates to the supplied classifier and
 *     surfaces its result verbatim.
 */

import { describe, expect, it } from '@jest/globals';

import { createClassifyIntentTool } from '../../src/reasoning/classify_intent_tool';
import type { IntentClassification, IntentClassifier } from '../../src/reasoning/intent_classifier';

function fakeClassifier(result: IntentClassification): IntentClassifier {
  return {
    classify: async () => result,
  } as unknown as IntentClassifier;
}

const DEFAULT_OUTPUT: IntentClassification = {
  sources: ['vault', 'trust_network'],
  relevant_personas: ['general'],
  toc_evidence: { entity_matches: ['Aeron Chair'] },
  temporal: 'static',
  reasoning_hint: 'User asked about a known product.',
};

describe('createClassifyIntentTool', () => {
  it('exposes the LLM-facing name + description + JSON Schema', () => {
    const tool = createClassifyIntentTool({ classifier: fakeClassifier(DEFAULT_OUTPUT) });
    expect(tool.name).toBe('classify_intent');
    expect(typeof tool.description).toBe('string');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });
  });

  it('empty query → conservative default (no classifier call)', async () => {
    let called = 0;
    const classifier = {
      classify: async (..._args: unknown[]) => {
        called++;
        return DEFAULT_OUTPUT;
      },
    } as unknown as IntentClassifier;
    const tool = createClassifyIntentTool({ classifier });
    const out = (await tool.execute({ query: '' })) as IntentClassification;
    expect(out.sources).toEqual(['vault']);
    expect(out.relevant_personas).toEqual([]);
    expect(out.temporal).toBe('');
    expect(out.reasoning_hint).toMatch(/empty/i);
    expect(called).toBe(0);
  });

  it('whitespace-only query → conservative default (no classifier call)', async () => {
    let called = 0;
    const classifier = {
      classify: async () => {
        called++;
        return DEFAULT_OUTPUT;
      },
    } as unknown as IntentClassifier;
    const tool = createClassifyIntentTool({ classifier });
    const out = (await tool.execute({ query: '   ' })) as IntentClassification;
    expect(out.sources).toEqual(['vault']);
    expect(called).toBe(0);
  });

  it('delegates to classifier on a real query and returns its result verbatim', async () => {
    const tool = createClassifyIntentTool({ classifier: fakeClassifier(DEFAULT_OUTPUT) });
    const out = (await tool.execute({ query: 'Where is my Aeron chair used?' })) as IntentClassification;
    expect(out).toEqual(DEFAULT_OUTPUT);
  });
});
