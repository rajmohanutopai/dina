/**
 * T4.10 — Chat streaming: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 4.10
 */

import {
  startStream,
  feedChunk,
  processStream,
  abortStream,
  getStreamState,
  getStreamText,
  isStreaming,
  getStreamDuration,
  setGuardScanner,
  resetStreamState,
} from '../../src/hooks/useChatStreaming';
import type { StreamChunk } from '../../../brain/src/llm/adapters/provider';

/** Create an async iterable from an array of chunks. */
async function* toAsyncIterable(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe('Chat Streaming Hook (4.10)', () => {
  beforeEach(() => resetStreamState());

  describe('manual feed', () => {
    it('accumulates text tokens', () => {
      startStream();
      feedChunk({ type: 'text', text: 'Hello' });
      feedChunk({ type: 'text', text: ' world' });

      const state = getStreamState();
      expect(state.text).toBe('Hello world');
      expect(state.tokenCount).toBe(2);
      expect(state.tokens).toEqual(['Hello', ' world']);
    });

    it('captures tool use chunks', () => {
      startStream();
      feedChunk({ type: 'tool_use', toolCall: { name: 'search', arguments: { q: 'test' } } });

      expect(getStreamState().toolCalls).toHaveLength(1);
      expect(getStreamState().toolCalls[0].name).toBe('search');
    });

    it('completes on done chunk', () => {
      startStream();
      feedChunk({ type: 'text', text: 'Response' });
      feedChunk({ type: 'done' });

      const state = getStreamState();
      expect(state.status).toBe('complete');
      expect(state.completedAt).toBeTruthy();
    });

    it('handles error chunk', () => {
      startStream();
      feedChunk({ type: 'error', error: 'Rate limited' });

      expect(getStreamState().status).toBe('error');
      expect(getStreamState().error).toBe('Rate limited');
    });

    it('ignores chunks when not streaming', () => {
      // Not started — should ignore
      feedChunk({ type: 'text', text: 'Ignored' });
      expect(getStreamState().text).toBe('');
    });
  });

  describe('processStream', () => {
    it('processes async iterable to completion', async () => {
      const chunks: StreamChunk[] = [
        { type: 'text', text: 'The ' },
        { type: 'text', text: 'answer ' },
        { type: 'text', text: 'is 42.' },
        { type: 'done' },
      ];

      const state = await processStream(toAsyncIterable(chunks));

      expect(state.status).toBe('complete');
      expect(state.text).toBe('The answer is 42.');
      expect(state.tokenCount).toBe(3);
    });

    it('handles mixed text + tool chunks', async () => {
      const chunks: StreamChunk[] = [
        { type: 'text', text: 'Searching...' },
        { type: 'tool_use', toolCall: { name: 'vault_search', arguments: { q: 'birthday' } } },
        { type: 'text', text: ' Found it.' },
        { type: 'done' },
      ];

      const state = await processStream(toAsyncIterable(chunks));

      expect(state.text).toBe('Searching... Found it.');
      expect(state.toolCalls).toHaveLength(1);
    });

    it('handles stream error', async () => {
      async function* failingStream(): AsyncIterable<StreamChunk> {
        yield { type: 'text', text: 'Start' };
        throw new Error('Connection lost');
      }

      const state = await processStream(failingStream());

      expect(state.status).toBe('error');
      expect(state.error).toContain('Connection lost');
      expect(state.text).toBe('Start'); // partial text preserved
    });
  });

  describe('abort', () => {
    it('aborts an active stream', () => {
      startStream();
      feedChunk({ type: 'text', text: 'Partial' });
      abortStream();

      expect(getStreamState().status).toBe('aborted');
      expect(getStreamState().text).toBe('Partial');
    });

    it('abort is no-op when not streaming', () => {
      abortStream(); // idle — should not crash
      expect(getStreamState().status).toBe('idle');
    });

    it('processStream respects abort', async () => {
      let chunkCount = 0;
      async function* slowStream(): AsyncIterable<StreamChunk> {
        for (let i = 0; i < 100; i++) {
          chunkCount++;
          yield { type: 'text', text: `token-${i} ` };
          if (i === 2) abortStream(); // abort after 3 chunks
        }
        yield { type: 'done' };
      }

      await processStream(slowStream());

      // Should have stopped after abort (3 chunks + abort detection)
      expect(getStreamState().status).toBe('aborted');
      expect(getStreamState().tokenCount).toBeLessThanOrEqual(4);
    });
  });

  describe('guard scanner', () => {
    it('runs guard scan on complete', () => {
      setGuardScanner((text) => ({ passed: true, violations: [] }));

      startStream();
      feedChunk({ type: 'text', text: 'Safe response' });
      feedChunk({ type: 'done' });

      expect(getStreamState().guardPassed).toBe(true);
    });

    it('detects guard violations', () => {
      setGuardScanner((text) => ({
        passed: false,
        violations: ['anti_her_violation'],
      }));

      startStream();
      feedChunk({ type: 'text', text: 'Unsafe response' });
      feedChunk({ type: 'done' });

      expect(getStreamState().guardPassed).toBe(false);
    });

    it('skips guard when no scanner configured', () => {
      startStream();
      feedChunk({ type: 'text', text: 'Response' });
      feedChunk({ type: 'done' });

      expect(getStreamState().guardPassed).toBe(true); // default pass
    });
  });

  describe('utilities', () => {
    it('getStreamText returns accumulated text', () => {
      startStream();
      feedChunk({ type: 'text', text: 'Hello' });
      expect(getStreamText()).toBe('Hello');
    });

    it('isStreaming reflects active state', () => {
      expect(isStreaming()).toBe(false);
      startStream();
      expect(isStreaming()).toBe(true);
      feedChunk({ type: 'done' });
      expect(isStreaming()).toBe(false);
    });

    it('getStreamDuration tracks time', () => {
      expect(getStreamDuration()).toBeNull();
      startStream();
      expect(getStreamDuration()).toBeGreaterThanOrEqual(0);
    });

    it('state snapshots are immutable', () => {
      startStream();
      feedChunk({ type: 'text', text: 'A' });
      const s1 = getStreamState();
      feedChunk({ type: 'text', text: 'B' });
      const s2 = getStreamState();

      expect(s1.text).toBe('A');
      expect(s2.text).toBe('AB');
    });
  });
});
