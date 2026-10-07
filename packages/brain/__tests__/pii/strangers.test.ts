/**
 * Names Dina does not know (docs/PII_ARCHITECTURE_V2.md §7): what is kept of
 * a detector's candidates, the cache, the time budget, and the router.
 */

import { LLMRouter } from '../../src/llm/router_dispatch';
import { NameLexicon } from '../../src/pii/names';
import {
  keepCandidate,
  paragraphs,
  StrangerNames,
  type DetectedName,
  type NameDetector,
} from '../../src/pii/strangers';

import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  LLMProvider,
} from '../../src/llm/adapters/provider';

/** A detector that finds the listed names wherever they occur, and counts its calls. */
function fakeDetector(
  names: Record<string, number>,
  delayMs = 0,
): NameDetector & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async detect(text: string, _budgetMs: number): Promise<DetectedName[]> {
      calls.push(text);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return Object.entries(names)
        .filter(([n]) => text.includes(n))
        .map(([value, score]) => ({ value, score }));
    },
  };
}

describe('keepCandidate', () => {
  const text = 'We met Ravi Kumar and you, with Mom, near [PERSON_1].';
  it.each([
    [{ value: 'Ravi Kumar', score: 0.9 }, true],
    [{ value: ' Ravi Kumar ', score: 0.9 }, true],
    [{ value: 'We', score: 0.9 }, false],
    [{ value: 'you', score: 0.9 }, false],
    [{ value: 'Mom', score: 0.9 }, false],
    [{ value: 'Ravi Kumar', score: 0.39 }, false],
    [{ value: 'Ravi Kumar', score: Number.NaN }, false],
    [{ value: 'Priya', score: 0.9 }, false],
    [{ value: '[PERSON_1]', score: 0.9 }, false],
    [{ value: 'R', score: 0.9 }, false],
  ])('%j → %s', (candidate, kept) => {
    expect(keepCandidate(text, candidate)).toBe(kept);
  });
});

describe('paragraphs', () => {
  it('splits on blank lines and drops empty ones', () => {
    expect(paragraphs('one\n\n  two  \n \nthree\nstill three\n\n\n')).toEqual([
      'one',
      'two',
      'three\nstill three',
    ]);
  });
});

describe('StrangerNames', () => {
  it('finds names in every text and matches them anywhere after', async () => {
    const s = new StrangerNames({ detector: fakeDetector({ 'Ravi Kumar': 0.9, Priya: 0.9 }) });
    const m = await s.matcherFor(['Call Priya.', 'The plumber Ravi Kumar came.']);
    expect(m.find('ravi kumar and Priya').map((x) => x.value)).toEqual(['ravi kumar', 'Priya']);
  });

  it('asks the detector once per paragraph: history repeated on the next turn is not asked again', async () => {
    const detector = fakeDetector({ Priya: 0.9 });
    const s = new StrangerNames({ detector });
    await s.matcherFor(['Call Priya.\n\nAbout the lease.']);
    await s.matcherFor(['New message.', 'Call Priya.\n\nAbout the lease.']);
    expect(detector.calls).toEqual(['Call Priya.', 'About the lease.', 'New message.']);
  });

  it('stops asking once the time budget is spent, newest text first, and reports how much was left', async () => {
    let now = 0;
    const detector: NameDetector & { calls: string[] } = {
      calls: [],
      async detect(text) {
        this.calls.push(text);
        now += 1000;
        return text.includes('Priya') ? [{ value: 'Priya', score: 0.9 }] : [];
      },
    };
    const skipped: number[] = [];
    const s = new StrangerNames({
      detector,
      nowMs: () => now,
      budgetMs: 2000,
      onDegraded: (n) => skipped.push(n),
    });
    const m = await s.matcherFor(['newest: Priya', 'older', 'oldest', 'system prompt']);
    expect(detector.calls).toEqual(['newest: Priya', 'older']);
    expect(skipped).toEqual([2]);
    expect(m.find('Priya')).toHaveLength(1);
  });

  it('a detector that fails leaves that paragraph to known names and is reported', async () => {
    const skipped: number[] = [];
    const s = new StrangerNames({
      detector: {
        async detect() {
          throw new Error('model busy');
        },
      },
      onDegraded: (n) => skipped.push(n),
    });
    expect((await s.matcherFor(['Call Priya.'])).size).toBe(0);
    expect(skipped).toEqual([1]);
  });
});

describe('the router with a stranger detector', () => {
  function recorder(reply: Partial<ChatResponse>): LLMProvider & { sent: () => string } {
    let last = '';
    return {
      name: 'rec',
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsEmbedding: false,
      async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
        last = JSON.stringify([messages, opts?.systemPrompt ?? '']);
        return {
          content: '',
          toolCalls: [],
          model: 'rec',
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: 'end',
          ...reply,
        };
      },
      stream: jest.fn(),
      embed: jest.fn(),
      sent: () => last,
    };
  }

  const router = (llm: LLMProvider, strangers: StrangerNames, names?: NameLexicon) =>
    new LLMRouter({
      providers: { gemini: llm },
      config: {
        localAvailable: false,
        cloudProviders: ['gemini'],
        sensitivePersonas: [],
        cloudConsentGranted: true,
      },
      strangers,
      ...(names !== undefined ? { names } : {}),
    });

  it('hides a stranger the detector found, in every message, and restores the reply', async () => {
    const llm = recorder({ content: 'I will remind you to pay [PERSON_1].' });
    const strangers = new StrangerNames({ detector: fakeDetector({ 'Ravi Kumar': 0.99 }) });
    const res = await router(llm, strangers).chat({
      taskType: 'reason',
      systemPrompt: 'Be brief.',
      messages: [
        { role: 'user', content: 'The plumber is Ravi Kumar.' },
        { role: 'user', content: 'Remind me to pay ravi kumar on Friday.' },
      ],
    });
    expect(llm.sent()).not.toMatch(/ravi/i);
    expect(res.content).toBe('I will remind you to pay Ravi Kumar.');
  });

  it('a known name keeps its token; a stranger gets the next number', async () => {
    const llm = recorder({ content: '[PERSON_1] and [PERSON_2]' });
    const names = new NameLexicon({ fetch: async () => [{ group: 7, names: ['Sancho'] }] });
    const strangers = new StrangerNames({ detector: fakeDetector({ Sancho: 0.9, Priya: 0.9 }) });
    const res = await router(llm, strangers, names).chat({
      taskType: 'reason',
      messages: [{ role: 'user', content: 'Sancho and Priya are coming' }],
    });
    expect(llm.sent()).toContain('[PERSON_1] and [PERSON_2] are coming');
    expect(res.content).toBe('Sancho and Priya');
  });

  it('a pronoun or relationship word the detector wrongly names stays visible', async () => {
    const llm = recorder({});
    const strangers = new StrangerNames({ detector: fakeDetector({ we: 0.9, Mom: 0.9 }) });
    await router(llm, strangers).chat({
      taskType: 'reason',
      messages: [{ role: 'user', content: 'we told Mom' }],
    });
    expect(llm.sent()).toContain('we told Mom');
  });
});

describe('dual review round 1', () => {
  it('F3: one slow detector call is cut off at the budget, and its paragraph is not cached', async () => {
    const budgets: number[] = [];
    const skipped: number[] = [];
    let slow = true;
    const s = new StrangerNames({
      detector: {
        async detect(text, budgetMs) {
          budgets.push(budgetMs);
          if (slow) await new Promise((r) => setTimeout(r, 2_000));
          return text.includes('Priya') ? [{ value: 'Priya', score: 0.9 }] : [];
        },
      },
      budgetMs: 50,
      onDegraded: (n) => skipped.push(n),
    });
    const started = Date.now();
    const m = await s.matcherFor(['Call Priya.']);
    expect(Date.now() - started).toBeLessThan(500);
    expect(m.size).toBe(0);
    expect(skipped).toEqual([1]);
    expect(budgets[0]).toBeGreaterThan(0);
    expect(budgets[0]).toBeLessThanOrEqual(50);
    // Not cached as "no names": asked again next time, and found.
    slow = false;
    expect((await s.matcherFor(['Call Priya.'])).find('Priya')).toHaveLength(1);
  });

  it('R2-1: a detector that answers a little after the time it was given is still heard, and cached', async () => {
    let calls = 0;
    const s = new StrangerNames({
      detector: {
        async detect(text, budgetMs) {
          calls++;
          // Runs out its time, then answers from a fast fallback.
          await new Promise((r) => setTimeout(r, budgetMs + 20));
          return text.includes('Priya') ? [{ value: 'Priya', score: 0.9 }] : [];
        },
      },
      budgetMs: 400,
    });
    expect((await s.matcherFor(['Call Priya.'])).find('Priya')).toHaveLength(1);
    await s.matcherFor(['Call Priya.']);
    expect(calls).toBe(1);
  });

  it('F7: the cache holds no text: no name and no paragraph survives in it', async () => {
    const s = new StrangerNames({ detector: fakeDetector({ 'Ravi Kumar': 0.9 }) });
    await s.matcherFor(['The plumber Ravi Kumar came.']);
    const cache = (s as unknown as { cache: Map<string, unknown> }).cache;
    const dump = JSON.stringify([...cache.entries()]);
    expect(dump).not.toMatch(/ravi|kumar|plumber/i);
    // A hit rebuilds the name from the text given now.
    expect((await s.matcherFor(['The plumber Ravi Kumar came.'])).find('Ravi Kumar')).toHaveLength(
      1,
    );
    s.clear();
    expect(cache.size).toBe(0);
  });
});
