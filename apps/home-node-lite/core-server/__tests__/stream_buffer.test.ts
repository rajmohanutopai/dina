/**
 * Task 5.27 — StreamBuffer tests.
 */

import {
  StreamBuffer,
  type StreamEvent,
} from '../src/brain/stream_buffer';

describe('StreamBuffer (task 5.27)', () => {
  describe('text delta streaming', () => {
    it('accumulates text across deltas + emits events', () => {
      const events: StreamEvent[] = [];
      const buf = new StreamBuffer({ onEvent: (e) => events.push(e) });
      buf.pushTextDelta('Hello');
      buf.pushTextDelta(', ');
      buf.pushTextDelta('world!');
      expect(buf.getText()).toBe('Hello, world!');
      const textEvents = events.filter((e) => e.kind === 'text_delta');
      expect(textEvents).toHaveLength(3);
      expect((textEvents[2] as Extract<StreamEvent, { kind: 'text_delta' }>).total).toBe(
        'Hello, world!'.length,
      );
    });

    it('rejects non-string delta', () => {
      const buf = new StreamBuffer();
      expect(() => buf.pushTextDelta(42 as unknown as string)).toThrow(
        /delta must be a string/,
      );
    });

    it('empty string is a valid delta (keepalive)', () => {
      const buf = new StreamBuffer();
      buf.pushTextDelta('');
      expect(buf.getText()).toBe('');
    });
  });

  describe('state transitions', () => {
    it('streaming → complete emits complete event', () => {
      const events: StreamEvent[] = [];
      const buf = new StreamBuffer({ onEvent: (e) => events.push(e) });
      buf.pushTextDelta('hi');
      buf.markComplete({ tokens: 2 });
      expect(buf.getState()).toBe('complete');
      const complete = events.find((e) => e.kind === 'complete') as Extract<
        StreamEvent,
        { kind: 'complete' }
      >;
      expect(complete.text).toBe('hi');
      expect(complete.meta).toEqual({ tokens: 2 });
    });

    it('streaming → failed with reason', () => {
      const events: StreamEvent[] = [];
      const buf = new StreamBuffer({ onEvent: (e) => events.push(e) });
      buf.markFailed('provider 503');
      expect(buf.getState()).toBe('failed');
      const fail = events.find((e) => e.kind === 'failed') as Extract<
        StreamEvent,
        { kind: 'failed' }
      >;
      expect(fail.error).toBe('provider 503');
    });

    it('streaming → aborted', () => {
      const events: StreamEvent[] = [];
      const buf = new StreamBuffer({ onEvent: (e) => events.push(e) });
      buf.markAborted();
      expect(buf.getState()).toBe('aborted');
      expect(events.some((e) => e.kind === 'aborted')).toBe(true);
    });

    it.each([
      ['markComplete after complete', 'complete'],
      ['markComplete after failed', 'failed'],
      ['markFailed after complete', 'complete'],
      ['markAborted after complete', 'complete'],
    ] as const)('%s throws', (label, prior) => {
      const buf = new StreamBuffer();
      if (prior === 'complete') buf.markComplete();
      else if (prior === 'failed') buf.markFailed('x');
      if (label.startsWith('markComplete')) {
        expect(() => buf.markComplete()).toThrow(/need streaming/);
      } else if (label.startsWith('markFailed')) {
        expect(() => buf.markFailed('x')).toThrow(/need streaming/);
      } else {
        expect(() => buf.markAborted()).toThrow(/need streaming/);
      }
    });

    it('markFailed rejects empty reason', () => {
      const buf = new StreamBuffer();
      expect(() => buf.markFailed('')).toThrow(/non-empty string/);
    });
  });

  describe('late deltas after terminal', () => {
    it('text delta after complete is dropped + emits late_delta', () => {
      const events: StreamEvent[] = [];
      const buf = new StreamBuffer({ onEvent: (e) => events.push(e) });
      buf.markComplete();
      events.length = 0;
      buf.pushTextDelta('ignored');
      expect(buf.getText()).toBe('');
      expect(events.some((e) => e.kind === 'late_delta' && e.stage === 'text')).toBe(
        true,
      );
    });

    it('tool_use delta after failed is dropped + emits late_delta', () => {
      const events: StreamEvent[] = [];
      const buf = new StreamBuffer({ onEvent: (e) => events.push(e) });
      buf.startToolUse('call-1');
      buf.markFailed('x');
      events.length = 0;
      buf.pushToolUseDelta('call-1', '{"a":1}');
      expect(events.some((e) => e.kind === 'late_delta' && e.stage === 'tool_use')).toBe(
        true,
      );
    });
  });

  describe('tool-use buffers', () => {
    it('start → deltas → end produces parsed JSON', () => {
      const events: StreamEvent[] = [];
      const buf = new StreamBuffer({ onEvent: (e) => events.push(e) });
      buf.startToolUse('call-1');
      buf.pushToolUseDelta('call-1', '{"na');
      buf.pushToolUseDelta('call-1', 'me":"alice"}');
      buf.endToolUse('call-1');
      const snap = buf.snapshot();
      const call = snap.toolCalls[0]!;
      expect(call.state.status).toBe('complete');
      if (call.state.status === 'complete') {
        expect(call.state.parsed).toEqual({ name: 'alice' });
      }
      const endEv = events.find((e) => e.kind === 'tool_use_end') as Extract<
        StreamEvent,
        { kind: 'tool_use_end' }
      >;
      expect(endEv.ok).toBe(true);
    });

    it('malformed JSON fails the tool call but NOT the stream', () => {
      const buf = new StreamBuffer();
      buf.pushTextDelta('pre');
      buf.startToolUse('call-1');
      buf.pushToolUseDelta('call-1', '{not json');
      buf.endToolUse('call-1');
      buf.pushTextDelta('post'); // text still flows
      expect(buf.getState()).toBe('streaming');
      expect(buf.getText()).toBe('prepost');
      const snap = buf.snapshot();
      expect(snap.toolCalls[0]!.state.status).toBe('failed');
    });

    it('non-object JSON also fails (tool_use must be object)', () => {
      const buf = new StreamBuffer();
      buf.startToolUse('call-1');
      buf.pushToolUseDelta('call-1', '[1,2,3]');
      buf.endToolUse('call-1');
      const snap = buf.snapshot();
      expect(snap.toolCalls[0]!.state.status).toBe('failed');
    });

    it('duplicate startToolUse throws', () => {
      const buf = new StreamBuffer();
      buf.startToolUse('call-1');
      expect(() => buf.startToolUse('call-1')).toThrow(/duplicate toolCallId/);
    });

    it('pushToolUseDelta without startToolUse throws', () => {
      const buf = new StreamBuffer();
      expect(() => buf.pushToolUseDelta('call-1', '{}')).toThrow(/not started/);
    });

    it('endToolUse on already-ended call throws', () => {
      const buf = new StreamBuffer();
      buf.startToolUse('call-1');
      buf.pushToolUseDelta('call-1', '{}');
      buf.endToolUse('call-1');
      expect(() => buf.endToolUse('call-1')).toThrow(/is complete/);
    });

    it('startToolUse / endToolUse reject empty id', () => {
      const buf = new StreamBuffer();
      expect(() => buf.startToolUse('')).toThrow(/toolCallId is required/);
    });

    it('markComplete while tool_use is in_progress flips that call to failed', () => {
      const events: StreamEvent[] = [];
      const buf = new StreamBuffer({ onEvent: (e) => events.push(e) });
      buf.startToolUse('call-1');
      buf.pushToolUseDelta('call-1', '{"partial":');
      buf.markComplete();
      const snap = buf.snapshot();
      expect(snap.state).toBe('complete');
      expect(snap.toolCalls[0]!.state.status).toBe('failed');
      // event stream: tool_use_end fires with ok=false as part of the markComplete flow
      const endEv = events.find((e) => e.kind === 'tool_use_end');
      expect(endEv).toBeDefined();
      if (endEv && endEv.kind === 'tool_use_end') {
        expect(endEv.ok).toBe(false);
      }
    });

    it('multiple tool calls interleaved with text', () => {
      const buf = new StreamBuffer();
      buf.pushTextDelta('Looking up... ');
      buf.startToolUse('t1');
      buf.pushToolUseDelta('t1', '{"q":"');
      buf.startToolUse('t2');
      buf.pushToolUseDelta('t2', '{"n":1}');
      buf.endToolUse('t2');
      buf.pushToolUseDelta('t1', 'x"}');
      buf.endToolUse('t1');
      buf.pushTextDelta('done.');
      const snap = buf.snapshot();
      expect(snap.toolCalls).toHaveLength(2);
      const t1 = snap.toolCalls.find((c) => c.id === 't1')!;
      const t2 = snap.toolCalls.find((c) => c.id === 't2')!;
      if (t1.state.status === 'complete') expect(t1.state.parsed).toEqual({ q: 'x' });
      if (t2.state.status === 'complete') expect(t2.state.parsed).toEqual({ n: 1 });
      expect(buf.getText()).toBe('Looking up... done.');
    });
  });

  describe('snapshot + introspectors', () => {
    it('snapshot renders all fields', () => {
      const buf = new StreamBuffer();
      buf.pushTextDelta('hi');
      buf.startToolUse('t1');
      buf.pushToolUseDelta('t1', '{}');
      buf.endToolUse('t1');
      buf.markComplete({ provider: 'anthropic' });
      const snap = buf.snapshot();
      expect(snap.state).toBe('complete');
      expect(snap.text).toBe('hi');
      expect(snap.meta).toEqual({ provider: 'anthropic' });
      expect(snap.toolCalls[0]!.state.status).toBe('complete');
    });

    it('isTerminal reflects state', () => {
      const buf = new StreamBuffer();
      expect(buf.isTerminal()).toBe(false);
      buf.markComplete();
      expect(buf.isTerminal()).toBe(true);
    });

    it('failed snapshot has error field; complete has meta', () => {
      const buf = new StreamBuffer();
      buf.markFailed('oops');
      const snap = buf.snapshot();
      expect(snap.error).toBe('oops');
      expect('meta' in snap).toBe(false);
    });
  });
});
