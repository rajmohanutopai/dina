/**
 * Task 5.15 — reason handler tests.
 */

import {
  REASON_DEFAULT_TIMEOUT_MS,
  createReasonHandler,
  type ReasonHandlerEvent,
  type ReasonFn,
  type ReasonRequest,
  type ReasonResult,
  type VaultItem,
  type VaultQueryFn,
} from '../src/brain/reason_handler';
import {
  IntentClassifier,
  type IntentClassification,
} from '../src/brain/intent_classifier';

function stubClassifier(
  result: Partial<IntentClassification> = {},
): IntentClassifier {
  return new IntentClassifier({
    llmCallFn: async () => ({
      content: JSON.stringify({
        sources: result.sources ?? ['vault'],
        relevant_personas: result.relevantPersonas ?? [],
        temporal: result.temporal ?? 'static',
        reasoning_hint: result.reasoningHint ?? 'hint',
      }),
    }),
  });
}

function baseReq(overrides: Partial<ReasonRequest> = {}): ReasonRequest {
  return {
    query: 'who is Dr Carl?',
    persona: 'health',
    ...overrides,
  };
}

describe('createReasonHandler (task 5.15)', () => {
  describe('construction', () => {
    it.each([
      'intentClassifier',
      'vaultQueryFn',
      'reasonFn',
    ] as const)('throws when %s is missing', (missing) => {
      const opts = {
        intentClassifier: stubClassifier(),
        vaultQueryFn: async () => [],
        reasonFn: async () => ({ answer: {} }),
      };
      delete (opts as Record<string, unknown>)[missing];
      expect(() => createReasonHandler(opts as Parameters<typeof createReasonHandler>[0])).toThrow(new RegExp(missing));
    });

    it('REASON_DEFAULT_TIMEOUT_MS is 15s', () => {
      expect(REASON_DEFAULT_TIMEOUT_MS).toBe(15_000);
    });
  });

  describe('happy path', () => {
    it('returns 200 + answer + intent + sources_used', async () => {
      const vault: VaultItem[] = [
        { id: 'v1', summary: 'Dr Carl is my dentist', score: 0.9 },
        { id: 'v2', summary: 'Last visit was March 15', score: 0.75 },
      ];
      const handler = createReasonHandler({
        intentClassifier: stubClassifier({ sources: ['vault'] }),
        vaultQueryFn: async () => vault,
        reasonFn: async ({ context }) => ({
          answer: { text: 'Dr Carl', itemsConsidered: context.length },
        }),
      });
      const res = (await handler(baseReq())) as Extract<ReasonResult, { status: 200 }>;
      expect(res.status).toBe(200);
      expect(res.body.answer.text).toBe('Dr Carl');
      expect(res.body.answer.itemsConsidered).toBe(2);
      expect(res.body.sources_used.vault_item_ids).toEqual(['v1', 'v2']);
      expect(res.body.intent.sources).toContain('vault');
      expect(res.body.elapsed_ms).toBeGreaterThanOrEqual(0);
    });

    it('does NOT call vaultQueryFn when classifier omits vault', async () => {
      let vaultCalls = 0;
      const handler = createReasonHandler({
        intentClassifier: stubClassifier({
          sources: ['trust_network'],
        }),
        vaultQueryFn: async () => {
          vaultCalls++;
          return [];
        },
        reasonFn: async () => ({ answer: { text: 'ok' } }),
      });
      const res = (await handler(baseReq())) as Extract<ReasonResult, { status: 200 }>;
      expect(vaultCalls).toBe(0);
      expect(res.body.sources_used.vault_item_ids).toEqual([]);
    });

    it('reasonFn receives classification', async () => {
      let seenClassification: IntentClassification | null = null;
      const handler = createReasonHandler({
        intentClassifier: stubClassifier({ sources: ['vault', 'provider_services'] }),
        vaultQueryFn: async () => [],
        reasonFn: async ({ classification }) => {
          seenClassification = classification;
          return { answer: {} };
        },
      });
      await handler(baseReq());
      expect(seenClassification!.sources).toEqual(['vault', 'provider_services']);
    });

    it('request_id: uses valid header when supplied', async () => {
      const handler = createReasonHandler({
        intentClassifier: stubClassifier(),
        vaultQueryFn: async () => [],
        reasonFn: async () => ({ answer: {} }),
      });
      const id = 'abcdef1234567890abcdef12';
      const res = await handler(baseReq({ requestIdHeader: id }));
      expect(res.body.request_id).toBe(id);
    });

    it('request_id: generates fresh when header absent / invalid', async () => {
      const handler = createReasonHandler({
        intentClassifier: stubClassifier(),
        vaultQueryFn: async () => [],
        reasonFn: async () => ({ answer: {} }),
      });
      const res1 = await handler(baseReq());
      const res2 = await handler(baseReq({ requestIdHeader: 'x' }));
      expect(res1.body.request_id).toMatch(/^[0-9a-f]{32}$/);
      expect(res2.body.request_id).toMatch(/^[0-9a-f]{32}$/);
    });

    it('events fire in expected order', async () => {
      const events: ReasonHandlerEvent[] = [];
      const handler = createReasonHandler({
        intentClassifier: stubClassifier({ sources: ['vault'] }),
        vaultQueryFn: async () => [],
        reasonFn: async () => ({ answer: {} }),
        onEvent: (e) => events.push(e),
      });
      await handler(baseReq());
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(['classified', 'vault_queried', 'reasoned']);
    });

    it('honours maxVaultItems hint', async () => {
      let seenMax: number | undefined = undefined;
      const handler = createReasonHandler({
        intentClassifier: stubClassifier({ sources: ['vault'] }),
        vaultQueryFn: async (input) => {
          seenMax = input.maxItems;
          return [];
        },
        reasonFn: async () => ({ answer: {} }),
      });
      await handler(baseReq({ maxVaultItems: 3 }));
      expect(seenMax).toBe(3);
    });

    it('default maxVaultItems is 10', async () => {
      let seenMax: number | undefined;
      const handler = createReasonHandler({
        intentClassifier: stubClassifier({ sources: ['vault'] }),
        vaultQueryFn: async (input) => {
          seenMax = input.maxItems;
          return [];
        },
        reasonFn: async () => ({ answer: {} }),
      });
      await handler(baseReq());
      expect(seenMax).toBe(10);
    });
  });

  describe('input validation', () => {
    it.each([
      ['empty query', { query: '' }],
      ['whitespace query', { query: '   ' }],
      ['empty persona', { persona: '' }],
    ])('400 on %s', async (_label, overrides) => {
      const handler = createReasonHandler({
        intentClassifier: stubClassifier(),
        vaultQueryFn: async () => [],
        reasonFn: async () => ({ answer: {} }),
      });
      const res = (await handler(baseReq(overrides))) as Extract<
        ReasonResult,
        { status: 400 }
      >;
      expect(res.status).toBe(400);
      expect(res.body.error.kind).toBe('invalid_input');
    });

    it('400 body still includes a request_id', async () => {
      const handler = createReasonHandler({
        intentClassifier: stubClassifier(),
        vaultQueryFn: async () => [],
        reasonFn: async () => ({ answer: {} }),
      });
      const res = await handler(baseReq({ query: '' }));
      expect(res.body.request_id).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('failures', () => {
    it('classifier throw → default classification (doesn\'t kill the request)', async () => {
      const failing: Pick<IntentClassifier, 'classify'> = {
        classify: async () => {
          throw new Error('classifier down');
        },
      };
      const handler = createReasonHandler({
        intentClassifier: failing,
        vaultQueryFn: async () => [],
        reasonFn: async () => ({ answer: { text: 'ok' } }),
      });
      const res = (await handler(baseReq())) as Extract<ReasonResult, { status: 200 }>;
      expect(res.status).toBe(200);
      expect(res.body.intent.sources).toContain('vault'); // default falls back to ['vault']
    });

    it('vault query throw → 500 with vault_query_failed', async () => {
      const handler = createReasonHandler({
        intentClassifier: stubClassifier({ sources: ['vault'] }),
        vaultQueryFn: async () => {
          throw new Error('vault offline');
        },
        reasonFn: async () => ({ answer: {} }),
      });
      const res = (await handler(baseReq())) as Extract<ReasonResult, { status: 500 }>;
      expect(res.status).toBe(500);
      expect(res.body.error.kind).toBe('vault_query_failed');
      expect(res.body.error.message).toMatch(/vault offline/);
      // intent still included
      expect(res.body.intent).toBeDefined();
    });

    it('reason fn throw → 500 with reason_failed', async () => {
      const handler = createReasonHandler({
        intentClassifier: stubClassifier({ sources: ['vault'] }),
        vaultQueryFn: async () => [],
        reasonFn: async () => {
          throw new Error('LLM rate-limited');
        },
      });
      const res = (await handler(baseReq())) as Extract<ReasonResult, { status: 500 }>;
      expect(res.status).toBe(500);
      expect(res.body.error.kind).toBe('reason_failed');
      expect(res.body.error.message).toMatch(/rate-limited/);
    });

    it('pipeline exceeding timeout → 504', async () => {
      const handler = createReasonHandler({
        intentClassifier: stubClassifier({ sources: [] }),
        vaultQueryFn: async () => [],
        reasonFn: (): Promise<{ answer: Record<string, unknown> }> =>
          new Promise(() => {}), // never resolves
        timeoutMs: 50,
      });
      const res = (await handler(baseReq())) as Extract<ReasonResult, { status: 504 }>;
      expect(res.status).toBe(504);
      expect(res.body.error.kind).toBe('timeout');
    });
  });
});
