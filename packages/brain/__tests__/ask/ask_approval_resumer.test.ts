/**
 * Tests for `AskApprovalResumer`.
 *
 * Strategy: drive the registry through real state transitions
 * (enqueue → markPendingApproval → resumeAfterApproval) and assert
 * the resumer re-issues the executeFn with the original input + drives
 * the right terminal transition based on the outcome.
 */

import {
  AskApprovalResumer,
  type AskApprovalResumerEvent,
} from '../../src/ask/ask_approval_resumer';
import type { AskExecuteFn, ExecuteOutcome } from '../../src/ask/ask_handler';
import { AskRegistry, InMemoryAskAdapter, type AskEvent } from '../../src/ask/ask_registry';
import type {
  AgenticLoopResult,
  PausedAgenticState,
} from '../../src/reasoning/agentic_loop';

const REQUESTER_DID = 'did:key:z6MkAlonsoTester';
const FROZEN_NOW_MS = 1_750_000_000_000;

interface ExecuteCall {
  id: string;
  question: string;
  requesterDid: string;
}

interface Harness {
  registry: AskRegistry;
  resumer: AskApprovalResumer;
  executeCalls: ExecuteCall[];
  resumerEvents: AskApprovalResumerEvent[];
  scriptedOutcomes: ExecuteOutcome[];
}

function buildHarness(
  opts: {
    scriptedOutcomes?: ExecuteOutcome[];
    executeFn?: AskExecuteFn;
  } = {},
): Harness {
  const executeCalls: ExecuteCall[] = [];
  const resumerEvents: AskApprovalResumerEvent[] = [];
  const scriptedOutcomes = opts.scriptedOutcomes ?? [];

  const executeFn: AskExecuteFn =
    opts.executeFn ??
    (async (input) => {
      executeCalls.push({
        id: input.id,
        question: input.question,
        requesterDid: input.requesterDid,
      });
      const next = scriptedOutcomes.shift();
      if (!next) {
        throw new Error('test harness: no scripted outcome left for executeFn');
      }
      return next;
    });

  let resumer: AskApprovalResumer | null = null;
  const registry = new AskRegistry({
    adapter: new InMemoryAskAdapter(),
    nowMsFn: () => FROZEN_NOW_MS,
    onEvent: (event: AskEvent) => {
      resumer?.handle(event);
    },
  });

  resumer = new AskApprovalResumer({
    registry,
    executeFn,
    onEvent: (e) => resumerEvents.push(e),
  });

  return {
    registry,
    resumer,
    executeCalls,
    resumerEvents,
    scriptedOutcomes,
  };
}

/**
 * Wait for the fire-and-forget resume chain to settle. `setImmediate`
 * fires strictly after every microtask currently queued, so it
 * doesn't matter how many `await` boundaries the resumer's
 * `executeFn → markComplete/markFailed` chain crosses.
 */
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('AskApprovalResumer', () => {
  describe('construction', () => {
    it('rejects missing registry', () => {
      expect(
        () =>
          new AskApprovalResumer(
            // @ts-expect-error testing runtime validation
            { executeFn: async () => ({ kind: 'answer', answer: {} }) },
          ),
      ).toThrow('registry is required');
    });

    it('rejects when neither executeFn nor resumeFromPausedFn is supplied', () => {
      const registry = new AskRegistry({ adapter: new InMemoryAskAdapter() });
      expect(() => new AskApprovalResumer({ registry })).toThrow(
        'at least one of executeFn / resumeFromPausedFn must be provided',
      );
    });

    it('accepts when only executeFn is supplied (Pattern B only)', () => {
      const registry = new AskRegistry({ adapter: new InMemoryAskAdapter() });
      expect(
        () =>
          new AskApprovalResumer({
            registry,
            executeFn: async () => ({ kind: 'answer', answer: {} }),
          }),
      ).not.toThrow();
    });

    it('accepts when only resumeFromPausedFn is supplied (Pattern A only)', () => {
      const registry = new AskRegistry({ adapter: new InMemoryAskAdapter() });
      expect(
        () =>
          new AskApprovalResumer({
            registry,
            resumeFromPausedFn: async () => ({
              answer: '',
              toolCalls: [],
              finishReason: 'completed',
              usage: { inputTokens: 0, outputTokens: 0 },
              transcript: [],
            }),
          }),
      ).not.toThrow();
    });
  });

  describe('event filtering', () => {
    it('does NOT trigger executeFn on enqueue', async () => {
      const h = buildHarness({ scriptedOutcomes: [] });
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await flushAsync();
      expect(h.executeCalls).toHaveLength(0);
    });

    it('does NOT trigger on pending_approval', async () => {
      const h = buildHarness({ scriptedOutcomes: [] });
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-1', 'appr-1');
      await flushAsync();
      expect(h.executeCalls).toHaveLength(0);
    });

    it('does NOT trigger on completion', async () => {
      const h = buildHarness({ scriptedOutcomes: [] });
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markComplete('ask-1', '{"answer":"x"}');
      await flushAsync();
      expect(h.executeCalls).toHaveLength(0);
    });
  });

  describe('approval_resumed → answer (happy path)', () => {
    it('re-issues executeFn with original question + requester after resume', async () => {
      const h = buildHarness({
        scriptedOutcomes: [{ kind: 'answer', answer: { text: 'your balance is $42' } }],
      });
      await h.registry.enqueue({
        id: 'ask-1',
        question: "what's my balance?",
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-1', 'appr-1');
      await h.registry.resumeAfterApproval('ask-1');
      await flushAsync();

      expect(h.executeCalls).toEqual([
        {
          id: 'ask-1',
          question: "what's my balance?",
          requesterDid: REQUESTER_DID,
        },
      ]);
    });

    it('drives markComplete with the answer JSON', async () => {
      const h = buildHarness({
        scriptedOutcomes: [{ kind: 'answer', answer: { text: '$42' } }],
      });
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-1', 'appr-1');
      await h.registry.resumeAfterApproval('ask-1');
      await flushAsync();

      const final = await h.registry.get('ask-1');
      expect(final?.status).toBe('complete');
      expect(final?.answerJson).toBe('{"text":"$42"}');
    });

    it('emits a resumed_completed event', async () => {
      const h = buildHarness({
        scriptedOutcomes: [{ kind: 'answer', answer: { text: 'ok' } }],
      });
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-1', 'appr-1');
      await h.registry.resumeAfterApproval('ask-1');
      await flushAsync();

      expect(h.resumerEvents).toEqual([{ kind: 'resumed_completed', askId: 'ask-1' }]);
    });
  });

  describe('approval_resumed → failure', () => {
    it('drives markFailed with the failure JSON', async () => {
      const h = buildHarness({
        scriptedOutcomes: [
          {
            kind: 'failure',
            failure: { kind: 'provider_error', message: 'gemini 503' },
          },
        ],
      });
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-1', 'appr-1');
      await h.registry.resumeAfterApproval('ask-1');
      await flushAsync();

      const final = await h.registry.get('ask-1');
      expect(final?.status).toBe('failed');
      expect(final?.errorJson).toBe(
        JSON.stringify({ kind: 'provider_error', message: 'gemini 503' }),
      );
      expect(h.resumerEvents).toContainEqual({
        kind: 'resumed_failed',
        askId: 'ask-1',
        failureKind: 'provider_error',
      });
    });

    it('emits execute_crashed when executeFn throws', async () => {
      let resumer: AskApprovalResumer | null = null;
      const events: AskApprovalResumerEvent[] = [];
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        nowMsFn: () => FROZEN_NOW_MS,
        onEvent: (e) => resumer?.handle(e),
      });
      resumer = new AskApprovalResumer({
        registry: reg,
        executeFn: async () => {
          throw new Error('LLM exploded');
        },
        onEvent: (e) => events.push(e),
      });

      await reg.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await reg.markPendingApproval('ask-1', 'appr-1');
      await reg.resumeAfterApproval('ask-1');
      await flushAsync();

      const final = await reg.get('ask-1');
      expect(final?.status).toBe('failed');
      expect(final?.errorJson).toBe(
        JSON.stringify({ kind: 'execute_crashed', message: 'LLM exploded' }),
      );
      expect(events).toContainEqual({
        kind: 'execute_crashed',
        askId: 'ask-1',
        detail: 'LLM exploded',
      });
      expect(events).toContainEqual({
        kind: 'resumed_failed',
        askId: 'ask-1',
        failureKind: 'execute_crashed',
      });
    });
  });

  describe('approval_resumed → another approval (re-approval loop)', () => {
    it('transitions back to pending_approval with the new id', async () => {
      const h = buildHarness({
        scriptedOutcomes: [{ kind: 'approval', approvalId: 'appr-2' }],
      });
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-1', 'appr-1');
      await h.registry.resumeAfterApproval('ask-1');
      await flushAsync();

      const final = await h.registry.get('ask-1');
      expect(final?.status).toBe('pending_approval');
      expect(final?.approvalId).toBe('appr-2');
      expect(h.resumerEvents).toContainEqual({
        kind: 'resumed_re_approval',
        askId: 'ask-1',
        approvalId: 'appr-2',
      });
    });

    it('two-phase approval cycle terminates in complete', async () => {
      const h = buildHarness({
        scriptedOutcomes: [
          // First resume → another approval needed.
          { kind: 'approval', approvalId: 'appr-2' },
          // Second resume → final answer.
          { kind: 'answer', answer: { text: 'done' } },
        ],
      });
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-1', 'appr-1');
      await h.registry.resumeAfterApproval('ask-1'); // → re_approval (appr-2)
      await flushAsync();

      let mid = await h.registry.get('ask-1');
      expect(mid?.status).toBe('pending_approval');
      expect(mid?.approvalId).toBe('appr-2');

      await h.registry.resumeAfterApproval('ask-1'); // → answer
      await flushAsync();

      mid = await h.registry.get('ask-1');
      expect(mid?.status).toBe('complete');
      expect(mid?.answerJson).toBe('{"text":"done"}');
      expect(h.executeCalls).toHaveLength(2);
    });
  });

  describe('race / safety paths', () => {
    it('record_missing fires when registry was wiped between event + lookup', async () => {
      // We synthesise an approval_resumed event on a record that
      // doesn't exist by calling resumer.handle() directly.
      const events: AskApprovalResumerEvent[] = [];
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        nowMsFn: () => FROZEN_NOW_MS,
      });
      const resumer = new AskApprovalResumer({
        registry: reg,
        executeFn: async () => ({ kind: 'answer', answer: {} }),
        onEvent: (e) => events.push(e),
      });
      // handle() returns a Promise<void> so tests can await directly.
      await resumer.handle({ kind: 'approval_resumed', id: 'ask-ghost' });

      expect(events).toEqual([{ kind: 'record_missing', askId: 'ask-ghost' }]);
    });

    it('skipped_unexpected_status when the record is no longer in_flight', async () => {
      // Drive the resumer manually after the record has gone terminal.
      const events: AskApprovalResumerEvent[] = [];
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        nowMsFn: () => FROZEN_NOW_MS,
      });
      const resumer = new AskApprovalResumer({
        registry: reg,
        executeFn: async () => ({ kind: 'answer', answer: { text: 'x' } }),
        onEvent: (e) => events.push(e),
      });

      await reg.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await reg.markPendingApproval('ask-1', 'appr-1');
      await reg.resumeAfterApproval('ask-1');
      await reg.markComplete('ask-1', '{"answer":"prior"}');

      // Now synthetically replay the approval_resumed event.
      await resumer.handle({ kind: 'approval_resumed', id: 'ask-1' });

      expect(events).toEqual([
        {
          kind: 'skipped_unexpected_status',
          askId: 'ask-1',
          observed: 'complete',
        },
      ]);
    });

    it('apply_failed when the registry is already terminal mid-resume', async () => {
      // Simulate another writer racing the resume by completing the
      // record while executeFn is in flight.
      const events: AskApprovalResumerEvent[] = [];
      let resumer: AskApprovalResumer | null = null;
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        nowMsFn: () => FROZEN_NOW_MS,
        onEvent: (e) => resumer?.handle(e),
      });
      // executeFn that, while running, lets a concurrent writer
      // mark the record complete first.
      resumer = new AskApprovalResumer({
        registry: reg,
        executeFn: async (input) => {
          await reg.markComplete(input.id, '{"answer":"raced"}');
          return { kind: 'answer', answer: { text: 'late' } };
        },
        onEvent: (e) => events.push(e),
      });

      await reg.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await reg.markPendingApproval('ask-1', 'appr-1');
      await reg.resumeAfterApproval('ask-1');
      await flushAsync();

      const final = await reg.get('ask-1');
      expect(final?.status).toBe('complete');
      expect(final?.answerJson).toBe('{"answer":"raced"}'); // first writer wins
      // The resumer's own markComplete failed because the record
      // was already terminal — apply_failed surfaces.
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'apply_failed', askId: 'ask-1' }),
      );
    });
  });

  describe('integration with full ask cycle', () => {
    it('full cycle: pending_approval → resume → answer → complete (no manual reissue)', async () => {
      const h = buildHarness({
        scriptedOutcomes: [{ kind: 'answer', answer: { text: '$1234' } }],
      });
      // 1. Submit an ask, simulate the executeFn returning approval-required.
      await h.registry.enqueue({
        id: 'ask-real',
        question: 'show financial vault',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-real', 'appr-real');

      // 2. Operator approves: registry transitions back to in_flight,
      //    resumer fires, executeFn re-runs, markComplete lands.
      await h.registry.resumeAfterApproval('ask-real');
      await flushAsync();

      const final = await h.registry.get('ask-real');
      expect(final?.status).toBe('complete');
      expect(JSON.parse(final?.answerJson ?? '{}')).toEqual({ text: '$1234' });
      // Critical assertion: caller did NOT need to manually call
      // executeFn after approval — the resumer did it on the event.
      expect(h.executeCalls).toEqual([
        {
          id: 'ask-real',
          question: 'show financial vault',
          requesterDid: REQUESTER_DID,
        },
      ]);
    });
  });

  describe('Pattern A — paused state resume', () => {
    function makePausedState(
      overrides: Partial<PausedAgenticState> = {},
    ): PausedAgenticState {
      return {
        version: 1,
        transcript: [{ role: 'user', content: 'show me my balance' }],
        iteration: 1,
        toolCallCount: 1,
        pendingToolCall: {
          id: 'call-1',
          name: 'vault_search',
          arguments: { persona: 'financial', query: 'balance' },
        },
        remainingToolCalls: [],
        approvalId: 'appr-existing',
        persona: 'financial',
        usage: { inputTokens: 100, outputTokens: 50 },
        ...overrides,
      };
    }

    function makeAgenticResult(
      overrides: Partial<AgenticLoopResult> = {},
    ): AgenticLoopResult {
      return {
        answer: 'your balance is $42',
        toolCalls: [],
        finishReason: 'completed',
        usage: { inputTokens: 100, outputTokens: 50 },
        transcript: [],
        ...overrides,
      };
    }

    interface PatternAHarness {
      registry: AskRegistry;
      resumer: AskApprovalResumer;
      resumerEvents: AskApprovalResumerEvent[];
      pausedStateCalls: PausedAgenticState[];
    }

    function buildPatternAHarness(opts: {
      resumeFromPausedFn?: (
        s: PausedAgenticState,
      ) => Promise<AgenticLoopResult>;
      executeFn?: AskExecuteFn;
      scriptedResults?: AgenticLoopResult[];
    }): PatternAHarness {
      const resumerEvents: AskApprovalResumerEvent[] = [];
      const pausedStateCalls: PausedAgenticState[] = [];
      const scriptedResults = opts.scriptedResults ?? [];

      const resumeFromPausedFn =
        opts.resumeFromPausedFn ??
        (async (state: PausedAgenticState) => {
          pausedStateCalls.push(state);
          const next = scriptedResults.shift();
          if (!next) {
            throw new Error('test harness: no scripted result left for resumeFromPausedFn');
          }
          return next;
        });

      let resumer: AskApprovalResumer | null = null;
      const registry = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        nowMsFn: () => FROZEN_NOW_MS,
        onEvent: (event: AskEvent) => {
          resumer?.handle(event);
        },
      });

      const resumerOpts: ConstructorParameters<typeof AskApprovalResumer>[0] = {
        registry,
        resumeFromPausedFn,
        onEvent: (e) => resumerEvents.push(e),
      };
      if (opts.executeFn) resumerOpts.executeFn = opts.executeFn;
      resumer = new AskApprovalResumer(resumerOpts);

      return { registry, resumer, resumerEvents, pausedStateCalls };
    }

    it('dispatches to resumeFromPausedFn when record carries pausedStateJson', async () => {
      const paused = makePausedState();
      const h = buildPatternAHarness({
        scriptedResults: [makeAgenticResult({ answer: 'your balance is $42' })],
      });
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'show financial',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-1', 'appr-1', JSON.stringify(paused));
      await h.registry.resumeAfterApproval('ask-1');
      await flushAsync();

      expect(h.pausedStateCalls).toHaveLength(1);
      expect(h.pausedStateCalls[0]).toEqual(paused);
    });

    it('drives markComplete with the LLM answer text when finishReason=completed', async () => {
      const paused = makePausedState();
      const h = buildPatternAHarness({
        scriptedResults: [makeAgenticResult({ answer: 'your balance is $42' })],
      });
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-1', 'appr-1', JSON.stringify(paused));
      await h.registry.resumeAfterApproval('ask-1');
      await flushAsync();

      const final = await h.registry.get('ask-1');
      expect(final?.status).toBe('complete');
      expect(JSON.parse(final?.answerJson ?? '{}')).toEqual({
        text: 'your balance is $42',
      });
      expect(h.resumerEvents).toContainEqual({ kind: 'resumed_completed', askId: 'ask-1' });
    });

    it('re-parks with new approvalId AND new paused state when loop bails again', async () => {
      const firstPaused = makePausedState({ approvalId: 'appr-1' });
      const secondPaused = makePausedState({
        approvalId: 'appr-2',
        persona: 'health',
        iteration: 2,
        toolCallCount: 2,
        pendingToolCall: {
          id: 'call-2',
          name: 'vault_search',
          arguments: { persona: 'health', query: 'records' },
        },
      });

      const h = buildPatternAHarness({
        scriptedResults: [
          makeAgenticResult({
            answer: '',
            finishReason: 'approval_required',
            pausedState: secondPaused,
          }),
        ],
      });
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-1', 'appr-1', JSON.stringify(firstPaused));
      await h.registry.resumeAfterApproval('ask-1');
      await flushAsync();

      const final = await h.registry.get('ask-1');
      expect(final?.status).toBe('pending_approval');
      expect(final?.approvalId).toBe('appr-2');
      expect(final?.pausedStateJson).toBe(JSON.stringify(secondPaused));
      expect(h.resumerEvents).toContainEqual({
        kind: 'resumed_re_approval',
        askId: 'ask-1',
        approvalId: 'appr-2',
      });
    });

    it('two-phase Pattern A cycle terminates in complete', async () => {
      const firstPaused = makePausedState({ approvalId: 'appr-1' });
      const secondPaused = makePausedState({ approvalId: 'appr-2' });

      const h = buildPatternAHarness({
        scriptedResults: [
          // First resume → loop bails again with a new persona.
          makeAgenticResult({
            answer: '',
            finishReason: 'approval_required',
            pausedState: secondPaused,
          }),
          // Second resume → final answer.
          makeAgenticResult({ answer: 'all clear' }),
        ],
      });
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-1', 'appr-1', JSON.stringify(firstPaused));

      await h.registry.resumeAfterApproval('ask-1');
      await flushAsync();
      let mid = await h.registry.get('ask-1');
      expect(mid?.status).toBe('pending_approval');
      expect(mid?.approvalId).toBe('appr-2');

      await h.registry.resumeAfterApproval('ask-1');
      await flushAsync();
      mid = await h.registry.get('ask-1');
      expect(mid?.status).toBe('complete');
      expect(JSON.parse(mid?.answerJson ?? '{}')).toEqual({ text: 'all clear' });
      expect(h.pausedStateCalls).toHaveLength(2);
      expect(h.pausedStateCalls[0]?.approvalId).toBe('appr-1');
      expect(h.pausedStateCalls[1]?.approvalId).toBe('appr-2');
    });

    it.each([
      ['max_iterations' as const],
      ['max_tool_calls' as const],
      ['cancelled' as const],
      ['provider_error' as const],
    ])('translates finishReason=%s into markFailed', async (finishReason) => {
      const paused = makePausedState();
      const h = buildPatternAHarness({
        scriptedResults: [
          makeAgenticResult({ answer: '', finishReason, pausedState: undefined }),
        ],
      });
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-1', 'appr-1', JSON.stringify(paused));
      await h.registry.resumeAfterApproval('ask-1');
      await flushAsync();

      const final = await h.registry.get('ask-1');
      expect(final?.status).toBe('failed');
      const parsed = JSON.parse(final?.errorJson ?? '{}');
      expect(parsed.kind).toBe(finishReason);
      expect(h.resumerEvents).toContainEqual({
        kind: 'resumed_failed',
        askId: 'ask-1',
        failureKind: finishReason,
      });
    });

    it('emits paused_state_invalid + markFailed when JSON is malformed', async () => {
      const h = buildPatternAHarness({});
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-1', 'appr-1', '{not-json{');
      await h.registry.resumeAfterApproval('ask-1');
      await flushAsync();

      expect(h.resumerEvents).toContainEqual(
        expect.objectContaining({ kind: 'paused_state_invalid', askId: 'ask-1' }),
      );
      const final = await h.registry.get('ask-1');
      expect(final?.status).toBe('failed');
      expect(JSON.parse(final?.errorJson ?? '{}').kind).toBe('paused_state_invalid');
    });

    it('emits execute_crashed + markFailed when resumeFromPausedFn throws', async () => {
      const paused = makePausedState();
      const h = buildPatternAHarness({
        resumeFromPausedFn: async () => {
          throw new Error('LLM exploded mid-resume');
        },
      });
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-1', 'appr-1', JSON.stringify(paused));
      await h.registry.resumeAfterApproval('ask-1');
      await flushAsync();

      expect(h.resumerEvents).toContainEqual({
        kind: 'execute_crashed',
        askId: 'ask-1',
        detail: 'LLM exploded mid-resume',
      });
      const final = await h.registry.get('ask-1');
      expect(final?.status).toBe('failed');
      expect(JSON.parse(final?.errorJson ?? '{}').kind).toBe('execute_crashed');
    });

    it('falls back to Pattern B when record has no paused state but executeFn is wired', async () => {
      const executeCalls: { id: string }[] = [];
      const h = buildPatternAHarness({
        scriptedResults: [],
        executeFn: async (input) => {
          executeCalls.push({ id: input.id });
          return { kind: 'answer', answer: { text: 'pattern-b answer' } };
        },
      });
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      // Note: no pausedStateJson.
      await h.registry.markPendingApproval('ask-1', 'appr-1');
      await h.registry.resumeAfterApproval('ask-1');
      await flushAsync();

      expect(executeCalls).toEqual([{ id: 'ask-1' }]);
      expect(h.pausedStateCalls).toHaveLength(0);
      const final = await h.registry.get('ask-1');
      expect(final?.status).toBe('complete');
      expect(JSON.parse(final?.answerJson ?? '{}')).toEqual({ text: 'pattern-b answer' });
    });

    it('falls through to Pattern B when paused state is present but only executeFn is wired (composition fallback)', async () => {
      // Documents the dispatch precedence: Pattern A only fires when
      // BOTH the record carries paused state AND a `resumeFromPausedFn`
      // is configured. Wiring Pattern B alone is a valid degraded
      // mode — the executeFn still re-runs the question and the ask
      // resolves (paying re-LLM cost instead of resuming).
      const events: AskApprovalResumerEvent[] = [];
      const executeCalls: { id: string }[] = [];
      let resumer: AskApprovalResumer | null = null;
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        nowMsFn: () => FROZEN_NOW_MS,
        onEvent: (e) => resumer?.handle(e),
      });
      resumer = new AskApprovalResumer({
        registry: reg,
        executeFn: async (input) => {
          executeCalls.push({ id: input.id });
          return { kind: 'answer', answer: { text: 'fallback answer' } };
        },
        onEvent: (e) => events.push(e),
      });

      await reg.enqueue({ id: 'ask-1', question: 'q', requesterDid: REQUESTER_DID });
      await reg.markPendingApproval(
        'ask-1',
        'appr-1',
        JSON.stringify(makePausedState()),
      );
      await reg.resumeAfterApproval('ask-1');
      await flushAsync();

      expect(executeCalls).toEqual([{ id: 'ask-1' }]);
      const final = await reg.get('ask-1');
      expect(final?.status).toBe('complete');
      expect(JSON.parse(final?.answerJson ?? '{}')).toEqual({ text: 'fallback answer' });
    });

    it('emits no_resumer_configured when only resumeFromPausedFn wired but record has no paused state', async () => {
      const events: AskApprovalResumerEvent[] = [];
      let resumer: AskApprovalResumer | null = null;
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        nowMsFn: () => FROZEN_NOW_MS,
        onEvent: (e) => resumer?.handle(e),
      });
      // Pattern A only — no executeFn.
      resumer = new AskApprovalResumer({
        registry: reg,
        resumeFromPausedFn: async () => makeAgenticResult(),
        onEvent: (e) => events.push(e),
      });

      await reg.enqueue({ id: 'ask-1', question: 'q', requesterDid: REQUESTER_DID });
      // Park WITHOUT paused state.
      await reg.markPendingApproval('ask-1', 'appr-1');
      await reg.resumeAfterApproval('ask-1');
      await flushAsync();

      expect(events).toContainEqual({ kind: 'no_resumer_configured', askId: 'ask-1' });
      const final = await reg.get('ask-1');
      expect(final?.status).toBe('in_flight'); // Stuck — operator must manually intervene.
    });

    it('emits resumed_failed (paused_state_missing) if loop returns approval_required without pausedState', async () => {
      const paused = makePausedState();
      const h = buildPatternAHarness({
        scriptedResults: [
          makeAgenticResult({
            answer: '',
            finishReason: 'approval_required',
            pausedState: undefined, // contract violation
          }),
        ],
      });
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-1', 'appr-1', JSON.stringify(paused));
      await h.registry.resumeAfterApproval('ask-1');
      await flushAsync();

      const final = await h.registry.get('ask-1');
      expect(final?.status).toBe('failed');
      expect(JSON.parse(final?.errorJson ?? '{}').kind).toBe('paused_state_missing');
      expect(h.resumerEvents).toContainEqual({
        kind: 'resumed_failed',
        askId: 'ask-1',
        failureKind: 'paused_state_missing',
      });
    });
  });
});
