/**
 * Guard-scan post-processor — sentence helpers, parser, full-scan
 * decisions, and the trust-tool branching logic.
 *
 * Real-LLM parity for the prompt itself is covered in
 * `persona_classification_real_llm_100.test.ts` patterns; this file
 * pins the deterministic plumbing around the LLM call.
 */

import {
  createGuardScanner,
  parseGuardScanResponse,
  removeSentences,
  splitSentences,
  ANTI_HER_REDIRECT_MESSAGE,
  NEUTRAL_EMPTY_MESSAGE,
} from '../../src/reasoning/guard_scanner';
import type { LLMProvider, ChatResponse } from '../../src/llm/adapters/provider';

function mockProvider(content: string): {
  provider: LLMProvider;
  lastPrompt: () => string | undefined;
} {
  let lastPrompt: string | undefined;
  const provider: LLMProvider = {
    name: 'mock',
    supportsStreaming: false,
    supportsToolCalling: false,
    supportsEmbedding: false,
    chat: jest.fn(async (messages): Promise<ChatResponse> => {
      lastPrompt = (messages[0] as { content: string }).content;
      return {
        content,
        toolCalls: [],
        model: 'mock',
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: 'end',
      };
    }),
    stream: jest.fn(),
    embed: jest.fn(),
  };
  return { provider, lastPrompt: () => lastPrompt };
}

describe('splitSentences', () => {
  it('splits on [.!?] followed by whitespace', () => {
    expect(splitSentences('Hello world. How are you? I am fine!')).toEqual([
      'Hello world.',
      'How are you?',
      'I am fine!',
    ]);
  });

  it('returns [] for empty or whitespace-only input', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   ')).toEqual([]);
  });

  it('keeps a single trailing sentence without punctuation', () => {
    expect(splitSentences('no punctuation')).toEqual(['no punctuation']);
  });
});

describe('removeSentences', () => {
  it('removes 1-indexed sentences + collapses whitespace', () => {
    const sentences = ['One.', 'Two.', 'Three.'];
    expect(removeSentences(sentences, new Set([2]))).toBe('One. Three.');
  });

  it('returns empty string when every sentence is removed', () => {
    const sentences = ['One.', 'Two.'];
    expect(removeSentences(sentences, new Set([1, 2]))).toBe('');
  });
});

describe('parseGuardScanResponse', () => {
  it('parses the full Python schema', () => {
    const json = JSON.stringify({
      entities: { did: null, name: 'Acme' },
      trust_relevant: true,
      anti_her_sentences: [1],
      unsolicited_sentences: [2, 3],
      fabricated_sentences: [],
      consensus_sentences: [],
    });
    const parsed = parseGuardScanResponse(json);
    expect(parsed).not.toBeNull();
    expect(parsed!.anti_her_sentences).toEqual([1]);
    expect(parsed!.unsolicited_sentences).toEqual([2, 3]);
    expect(parsed!.trust_relevant).toBe(true);
    expect(parsed!.entities?.name).toBe('Acme');
  });

  it('tolerates markdown code fences', () => {
    const json =
      '```json\n{"anti_her_sentences":[1],"unsolicited_sentences":[],"fabricated_sentences":[],"consensus_sentences":[]}\n```';
    const parsed = parseGuardScanResponse(json);
    expect(parsed?.anti_her_sentences).toEqual([1]);
  });

  it('filters non-integer / <1 values defensively', () => {
    const json = JSON.stringify({
      anti_her_sentences: ['1', 2, 0, 3.5, -1],
      unsolicited_sentences: [],
      fabricated_sentences: [],
      consensus_sentences: [],
    });
    expect(parseGuardScanResponse(json)?.anti_her_sentences).toEqual([2]);
  });

  it('returns null on malformed JSON', () => {
    expect(parseGuardScanResponse('not json')).toBeNull();
    expect(parseGuardScanResponse('')).toBeNull();
  });
});

describe('createGuardScanner', () => {
  const userPrompt = 'What does my doctor recommend?';
  const response =
    'Your doctor recommends 30 minutes of exercise daily. ' +
    "I'm here to talk whenever you need to. " +
    "Eight out of ten users also recommend this.";

  it('skips short-circuits when response is empty', async () => {
    const { provider } = mockProvider('');
    const scan = createGuardScanner(provider);
    const decision = await scan({ userPrompt: 'hi', response: '' });
    expect(decision.mutated).toBe(false);
    expect(decision.reason).toBe('no_scan');
  });

  it('strips Anti-Her sentences and returns the cleaned response', async () => {
    const { provider } = mockProvider(
      JSON.stringify({
        anti_her_sentences: [2],
        unsolicited_sentences: [],
        fabricated_sentences: [],
        consensus_sentences: [],
      }),
    );
    const scan = createGuardScanner(provider);
    const decision = await scan({ userPrompt, response });
    expect(decision.mutated).toBe(true);
    expect(decision.reason).toBe('sentences_removed');
    expect(decision.content).not.toContain('here to talk');
    expect(decision.content).toContain('30 minutes of exercise');
  });

  it('keeps fabricated/consensus intact when a trust tool was used', async () => {
    const { provider } = mockProvider(
      JSON.stringify({
        anti_her_sentences: [],
        unsolicited_sentences: [],
        fabricated_sentences: [3],
        consensus_sentences: [3],
      }),
    );
    const scan = createGuardScanner(provider);
    const decision = await scan({
      userPrompt,
      response,
      toolsCalled: ['search_trust_network'],
    });
    // Trust tool present → fabricated/consensus ignored → nothing stripped.
    expect(decision.mutated).toBe(false);
    expect(decision.reason).toBe('no_violations');
  });

  it('strips fabricated/consensus when no trust tool fired', async () => {
    const { provider } = mockProvider(
      JSON.stringify({
        anti_her_sentences: [],
        unsolicited_sentences: [],
        fabricated_sentences: [3],
        consensus_sentences: [],
      }),
    );
    const scan = createGuardScanner(provider);
    const decision = await scan({ userPrompt, response, toolsCalled: [] });
    expect(decision.mutated).toBe(true);
    expect(decision.reason).toBe('sentences_removed');
    expect(decision.content).not.toContain('out of ten');
  });

  it('substitutes the anti-Her redirect when everything is stripped for Anti-Her', async () => {
    const { provider } = mockProvider(
      JSON.stringify({
        anti_her_sentences: [1, 2, 3],
        unsolicited_sentences: [],
        fabricated_sentences: [],
        consensus_sentences: [],
      }),
    );
    const scan = createGuardScanner(provider);
    const decision = await scan({ userPrompt, response });
    expect(decision.reason).toBe('anti_her_redirect');
    expect(decision.content).toBe(ANTI_HER_REDIRECT_MESSAGE);
  });

  it('substitutes a neutral fallback when everything is stripped for unsolicited/fabricated only', async () => {
    const { provider } = mockProvider(
      JSON.stringify({
        anti_her_sentences: [],
        unsolicited_sentences: [1, 2, 3],
        fabricated_sentences: [],
        consensus_sentences: [],
      }),
    );
    const scan = createGuardScanner(provider);
    const decision = await scan({ userPrompt, response });
    expect(decision.reason).toBe('empty_after_scan');
    expect(decision.content).toBe(NEUTRAL_EMPTY_MESSAGE);
  });

  it('fails open on LLM error', async () => {
    const provider: LLMProvider = {
      name: 'mock',
      supportsStreaming: false,
      supportsToolCalling: false,
      supportsEmbedding: false,
      chat: jest.fn(async () => {
        throw new Error('upstream 500');
      }),
      stream: jest.fn(),
      embed: jest.fn(),
    };
    const scan = createGuardScanner(provider);
    const decision = await scan({ userPrompt, response });
    expect(decision.mutated).toBe(false);
    expect(decision.reason).toBe('scan_failed');
    expect(decision.content).toBe(response);
  });

  it('renders 1-indexed sentences into the prompt', async () => {
    const { provider, lastPrompt } = mockProvider(
      JSON.stringify({
        anti_her_sentences: [],
        unsolicited_sentences: [],
        fabricated_sentences: [],
        consensus_sentences: [],
      }),
    );
    const scan = createGuardScanner(provider);
    await scan({ userPrompt: 'hi', response: 'First sentence. Second one.' });
    expect(lastPrompt()).toContain('[1] First sentence.');
    expect(lastPrompt()).toContain('[2] Second one.');
  });
});
