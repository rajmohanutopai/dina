/**
 * Task 5.39 — NudgeAssembler tests.
 */

import {
  DEFAULT_MAX_MESSAGE_LENGTH,
  DEFAULT_MAX_SNIPPETS,
  NudgeAssembler,
  type ContextGatherFn,
  type ContextSnippet,
  type LlmSummariseFn,
  type NudgeAssemblerEvent,
} from '../src/brain/nudge_assembler';

function stubSummariser(content: string): LlmSummariseFn {
  return async () => ({ content });
}

const DID = 'did:plc:alice';

describe('NudgeAssembler (task 5.39)', () => {
  describe('construction', () => {
    it('throws on missing contextGatherFn', () => {
      expect(
        () =>
          new NudgeAssembler({
            contextGatherFn: undefined as unknown as ContextGatherFn,
            llmSummariseFn: async () => ({ content: '' }),
          }),
      ).toThrow(/contextGatherFn/);
    });

    it('throws on missing llmSummariseFn', () => {
      expect(
        () =>
          new NudgeAssembler({
            contextGatherFn: async () => [],
            llmSummariseFn: undefined as unknown as LlmSummariseFn,
          }),
      ).toThrow(/llmSummariseFn/);
    });
  });

  describe('silence-first (no context → null)', () => {
    it('empty snippet list → null + fires no_context event', async () => {
      const events: NudgeAssemblerEvent[] = [];
      const a = new NudgeAssembler({
        contextGatherFn: async () => [],
        llmSummariseFn: async () => ({ content: 'should not be called' }),
        onEvent: (e) => events.push(e),
      });
      const r = await a.assemble(DID);
      expect(r).toBeNull();
      expect(events.some((e) => e.kind === 'no_context')).toBe(true);
    });

    it('snippets filtered to empty → null', async () => {
      const a = new NudgeAssembler({
        contextGatherFn: async () => [
          { text: '' },
          { text: '   ' },
          null as unknown as ContextSnippet,
        ],
        llmSummariseFn: async () => ({ content: 'x' }),
      });
      expect(await a.assemble(DID)).toBeNull();
    });

    it('empty DID → null', async () => {
      const a = new NudgeAssembler({
        contextGatherFn: async () => [{ text: 'x' }],
        llmSummariseFn: async () => ({ content: 'x' }),
      });
      expect(await a.assemble('')).toBeNull();
    });
  });

  describe('gather failure', () => {
    it('gatherer throws → null + fires gather_failed', async () => {
      const events: NudgeAssemblerEvent[] = [];
      const a = new NudgeAssembler({
        contextGatherFn: async () => {
          throw new Error('vault offline');
        },
        llmSummariseFn: async () => ({ content: 'x' }),
        onEvent: (e) => events.push(e),
      });
      const r = await a.assemble(DID);
      expect(r).toBeNull();
      const ev = events.find((e) => e.kind === 'gather_failed') as Extract<
        NudgeAssemblerEvent,
        { kind: 'gather_failed' }
      >;
      expect(ev.error).toMatch(/vault offline/);
    });
  });

  describe('LLM failure', () => {
    it('LLM throws → null + fires llm_failed', async () => {
      const events: NudgeAssemblerEvent[] = [];
      const a = new NudgeAssembler({
        contextGatherFn: async () => [{ text: 'hello' }],
        llmSummariseFn: async () => {
          throw new Error('rate limit');
        },
        onEvent: (e) => events.push(e),
      });
      const r = await a.assemble(DID);
      expect(r).toBeNull();
      expect(events.some((e) => e.kind === 'llm_failed')).toBe(true);
    });

    it('LLM returns empty content → null + fires summary_empty', async () => {
      const events: NudgeAssemblerEvent[] = [];
      const a = new NudgeAssembler({
        contextGatherFn: async () => [{ text: 'hello' }],
        llmSummariseFn: async () => ({ content: '   ' }),
        onEvent: (e) => events.push(e),
      });
      const r = await a.assemble(DID);
      expect(r).toBeNull();
      expect(events.some((e) => e.kind === 'summary_empty')).toBe(true);
    });
  });

  describe('happy path — recent_chat', () => {
    it('builds a solicited nudge with message + source item ids', async () => {
      const a = new NudgeAssembler({
        contextGatherFn: async () => [
          { text: 'Last chat: discussed project timeline', itemId: 'item-1' },
          { text: 'Note: birthday next week', itemId: 'item-2' },
        ],
        llmSummariseFn: stubSummariser('Project timeline + birthday next week'),
      });
      const r = await a.assemble(DID);
      expect(r).not.toBeNull();
      expect(r!.message).toBe('Project timeline + birthday next week');
      expect(r!.kind).toBe('recent_chat');
      expect(r!.priority).toBe('solicited');
      expect(r!.sourceItemIds).toEqual(['item-1', 'item-2']);
      expect(r!.hasPendingPromise).toBe(false);
    });

    it('fires assembled event', async () => {
      const events: NudgeAssemblerEvent[] = [];
      const a = new NudgeAssembler({
        contextGatherFn: async () => [{ text: 'hi', itemId: 'x' }],
        llmSummariseFn: stubSummariser('summary'),
        onEvent: (e) => events.push(e),
      });
      await a.assemble(DID);
      const assembled = events.find((e) => e.kind === 'assembled') as Extract<
        NudgeAssemblerEvent,
        { kind: 'assembled' }
      >;
      expect(assembled.priority).toBe('solicited');
      expect(assembled.snippetCount).toBe(1);
    });

    it('DEFAULT_MAX_SNIPPETS is 8', () => {
      expect(DEFAULT_MAX_SNIPPETS).toBe(8);
    });

    it('DEFAULT_MAX_MESSAGE_LENGTH is 280', () => {
      expect(DEFAULT_MAX_MESSAGE_LENGTH).toBe(280);
    });
  });

  describe('pending-promise detection', () => {
    it('detects "I\'ll send the PDF"', async () => {
      const a = new NudgeAssembler({
        contextGatherFn: async () => [
          { text: "I'll send the PDF when I get home", itemId: 'x' },
        ],
        llmSummariseFn: stubSummariser('Pending: send PDF'),
      });
      const r = await a.assemble(DID);
      expect(r!.hasPendingPromise).toBe(true);
      expect(r!.kind).toBe('pending_promise');
      // No deadline detected → solicited (not fiduciary).
      expect(r!.priority).toBe('solicited');
    });

    it('detects "I will share"', async () => {
      const a = new NudgeAssembler({
        contextGatherFn: async () => [{ text: 'I will share the deck', itemId: 'x' }],
        llmSummariseFn: stubSummariser('Share deck'),
      });
      const r = await a.assemble(DID);
      expect(r!.hasPendingPromise).toBe(true);
    });

    it('detects "let me forward"', async () => {
      const a = new NudgeAssembler({
        contextGatherFn: async () => [
          { text: 'let me forward you the link', itemId: 'x' },
        ],
        llmSummariseFn: stubSummariser('Forward link'),
      });
      const r = await a.assemble(DID);
      expect(r!.hasPendingPromise).toBe(true);
    });

    it('promise WITH deadline → fiduciary priority', async () => {
      const a = new NudgeAssembler({
        contextGatherFn: async () => [
          {
            text: "I'll send the PDF tomorrow by end of day",
            itemId: 'x',
          },
        ],
        llmSummariseFn: stubSummariser('Promise: PDF tomorrow'),
      });
      const r = await a.assemble(DID);
      expect(r!.priority).toBe('fiduciary');
      expect(r!.hasPendingPromise).toBe(true);
    });

    it('promise WITHOUT deadline → solicited', async () => {
      const a = new NudgeAssembler({
        contextGatherFn: async () => [
          { text: "I'll send the PDF when I find it", itemId: 'x' },
        ],
        llmSummariseFn: stubSummariser('Promise: PDF'),
      });
      const r = await a.assemble(DID);
      expect(r!.priority).toBe('solicited');
    });

    it('text without promise keywords is NOT flagged', async () => {
      const a = new NudgeAssembler({
        contextGatherFn: async () => [
          { text: 'They mentioned a new project idea', itemId: 'x' },
        ],
        llmSummariseFn: stubSummariser('New project'),
      });
      const r = await a.assemble(DID);
      expect(r!.hasPendingPromise).toBe(false);
      expect(r!.kind).toBe('recent_chat');
    });
  });

  describe('upcoming events', () => {
    it('category=event snippet → kind=upcoming_event', async () => {
      const a = new NudgeAssembler({
        contextGatherFn: async () => [
          { text: 'Lunch Tuesday 1pm', category: 'event', itemId: 'x' },
        ],
        llmSummariseFn: stubSummariser('Lunch Tuesday'),
      });
      const r = await a.assemble(DID);
      expect(r!.kind).toBe('upcoming_event');
    });

    it('pending promise wins over upcoming event for kind', async () => {
      const a = new NudgeAssembler({
        contextGatherFn: async () => [
          { text: "I'll send the slides tomorrow", itemId: 'p' },
          { text: 'Lunch Tuesday', category: 'event', itemId: 'e' },
        ],
        llmSummariseFn: stubSummariser('Slides + lunch'),
      });
      const r = await a.assemble(DID);
      expect(r!.kind).toBe('pending_promise');
    });
  });

  describe('snippet cap', () => {
    it('caps to maxSnippets', async () => {
      const many: ContextSnippet[] = [];
      for (let i = 0; i < 20; i++) many.push({ text: `m${i}`, itemId: `id${i}` });
      const a = new NudgeAssembler({
        contextGatherFn: async () => many,
        llmSummariseFn: stubSummariser('summary'),
        maxSnippets: 3,
      });
      const r = await a.assemble(DID);
      expect(r!.sourceItemIds).toHaveLength(3);
    });
  });

  describe('message length cap', () => {
    it('truncates LLM output to maxMessageLength', async () => {
      const a = new NudgeAssembler({
        contextGatherFn: async () => [{ text: 'hi' }],
        llmSummariseFn: stubSummariser('x'.repeat(500)),
        maxMessageLength: 100,
      });
      const r = await a.assemble(DID);
      expect(r!.message.length).toBe(100);
    });
  });

  describe('prompt contents', () => {
    it('passes category + truncated text into the prompt', async () => {
      let capturedPrompt = '';
      // Use a character that never appears in the prompt template
      // (numbers + "Q" are both safe) so we can count only the
      // snippet's characters after truncation.
      const marker = 'Q'.repeat(500);
      const a = new NudgeAssembler({
        contextGatherFn: async () => [
          { text: marker, category: 'event', itemId: 'x' },
        ],
        llmSummariseFn: async (p) => {
          capturedPrompt = p;
          return { content: 'summary' };
        },
      });
      await a.assemble(DID);
      expect(capturedPrompt).toContain('[event]');
      // Snippet text truncated to 200 in the prompt.
      const markerCount = (capturedPrompt.match(/Q/g) ?? []).length;
      expect(markerCount).toBe(200);
    });

    it('includes contactDid', async () => {
      let capturedPrompt = '';
      const a = new NudgeAssembler({
        contextGatherFn: async () => [{ text: 'hi' }],
        llmSummariseFn: async (p) => {
          capturedPrompt = p;
          return { content: 'x' };
        },
      });
      await a.assemble('did:plc:bob');
      expect(capturedPrompt).toContain('did:plc:bob');
    });
  });

  describe('source item ids', () => {
    it('only includes snippets with a non-empty itemId', async () => {
      const a = new NudgeAssembler({
        contextGatherFn: async () => [
          { text: 'a', itemId: 'id-1' },
          { text: 'b' }, // no id
          { text: 'c', itemId: '' },
          { text: 'd', itemId: 'id-2' },
        ],
        llmSummariseFn: stubSummariser('summary'),
      });
      const r = await a.assemble(DID);
      expect(r!.sourceItemIds).toEqual(['id-1', 'id-2']);
    });
  });
});
