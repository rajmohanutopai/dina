/**
 * Tasks 5.47 + 5.49 — NotifyDispatcher tests.
 */

import type { NotifyPriority } from '@dina/protocol';
import {
  ENGAGEMENT_PRIORITY,
  FIDUCIARY_PRIORITY,
  NotifyDispatcher,
  SOLICITED_PRIORITY,
  type NotifyEvent,
  type NotifyFn,
  type NotifyPayload,
  type SolicitedPolicyFn,
} from '../src/brain/notify_dispatcher';

function recordingFn(): {
  fn: NotifyFn;
  calls: Array<{ priority: NotifyPriority; payload: NotifyPayload }>;
} {
  const calls: Array<{ priority: NotifyPriority; payload: NotifyPayload }> = [];
  return {
    fn: async (priority, payload) => {
      calls.push({ priority, payload });
    },
    calls,
  };
}

describe('NotifyDispatcher (tasks 5.47 + 5.49)', () => {
  describe('constants', () => {
    it('exports the 3 priority constants re-wrapped for direct use', () => {
      expect(FIDUCIARY_PRIORITY).toBe('fiduciary');
      expect(SOLICITED_PRIORITY).toBe('solicited');
      expect(ENGAGEMENT_PRIORITY).toBe('engagement');
    });
  });

  describe('construction validation', () => {
    it('rejects missing notifyFn', () => {
      expect(
        () =>
          new NotifyDispatcher({
            notifyFn: undefined as unknown as NotifyFn,
          }),
      ).toThrow(/notifyFn is required/);
    });
  });

  describe('notifyFiduciary (urgent-path — task 5.49)', () => {
    it('sends immediately via notifyFn with priority=fiduciary', async () => {
      const { fn, calls } = recordingFn();
      const d = new NotifyDispatcher({ notifyFn: fn });
      await d.notifyFiduciary({ message: 'bus 42 in 2 min' });
      expect(calls).toEqual([
        { priority: 'fiduciary', payload: { message: 'bus 42 in 2 min' } },
      ]);
      expect(d.pending()).toBe(0); // no buffering
    });

    it('bypasses the buffer even when solicited + engagement are queued', async () => {
      const { fn, calls } = recordingFn();
      const d = new NotifyDispatcher({
        notifyFn: fn,
        solicitedPolicy: () => 'defer', // force solicited to buffer
      });
      await d.notifySolicited({ message: 'deferred-1' });
      await d.notifyEngagement({ message: 'engage-1' });
      expect(d.pending()).toBe(2);
      await d.notifyFiduciary({ message: 'URGENT' });
      // Fiduciary went direct — appears in calls, NOT in buffer.
      expect(calls).toEqual([
        { priority: 'fiduciary', payload: { message: 'URGENT' } },
      ]);
      expect(d.pending()).toBe(2);
    });

    it('fires sent event with latency', async () => {
      const events: NotifyEvent[] = [];
      const d = new NotifyDispatcher({
        notifyFn: async () => undefined,
        onEvent: (e) => events.push(e),
      });
      await d.notifyFiduciary({ message: 'x' });
      const sent = events.find((e) => e.kind === 'sent') as Extract<
        NotifyEvent,
        { kind: 'sent' }
      >;
      expect(sent).toBeDefined();
      expect(sent.priority).toBe('fiduciary');
      expect(sent.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('propagates notifyFn error + fires send_failed event', async () => {
      const events: NotifyEvent[] = [];
      const d = new NotifyDispatcher({
        notifyFn: async () => {
          throw new Error('wire down');
        },
        onEvent: (e) => events.push(e),
      });
      await expect(d.notifyFiduciary({ message: 'x' })).rejects.toThrow(/wire down/);
      const fail = events.find((e) => e.kind === 'send_failed') as Extract<
        NotifyEvent,
        { kind: 'send_failed' }
      >;
      expect(fail.priority).toBe('fiduciary');
      expect(fail.willRetry).toBe(false);
    });
  });

  describe('notifySolicited', () => {
    it('send policy → direct send', async () => {
      const { fn, calls } = recordingFn();
      const d = new NotifyDispatcher({
        notifyFn: fn,
        solicitedPolicy: () => 'send',
      });
      await d.notifySolicited({ message: 'search result' });
      expect(calls[0]!.priority).toBe('solicited');
      expect(d.pending()).toBe(0);
    });

    it('defer policy → buffered, fires buffered event', async () => {
      const events: NotifyEvent[] = [];
      const { fn, calls } = recordingFn();
      const d = new NotifyDispatcher({
        notifyFn: fn,
        solicitedPolicy: () => 'defer',
        onEvent: (e) => events.push(e),
      });
      await d.notifySolicited({ message: 'search result' });
      expect(calls).toEqual([]);
      expect(d.pending()).toBe(1);
      const buf = events.find((e) => e.kind === 'buffered') as Extract<
        NotifyEvent,
        { kind: 'buffered' }
      >;
      expect(buf.priority).toBe('solicited');
      expect(buf.pendingCount).toBe(1);
    });

    it('solicitedPolicy is called per notification (can change across calls)', async () => {
      const { fn } = recordingFn();
      let mode: 'send' | 'defer' = 'defer';
      const d = new NotifyDispatcher({
        notifyFn: fn,
        solicitedPolicy: () => mode,
      });
      await d.notifySolicited({ message: 'a' });
      expect(d.pending()).toBe(1);
      mode = 'send';
      await d.notifySolicited({ message: 'b' });
      expect(d.pending()).toBe(1); // first still buffered, second went direct
    });
  });

  describe('notifyEngagement', () => {
    it('always buffers + never sends directly', async () => {
      const { fn, calls } = recordingFn();
      const d = new NotifyDispatcher({ notifyFn: fn });
      await d.notifyEngagement({ message: 'briefing item' });
      await d.notifyEngagement({ message: 'another' });
      expect(calls).toEqual([]);
      expect(d.pending()).toBe(2);
    });

    it('preserves buffering order for the briefing narrative', async () => {
      const { fn, calls } = recordingFn();
      const d = new NotifyDispatcher({ notifyFn: fn });
      await d.notifyEngagement({ message: 'first' });
      await d.notifyEngagement({ message: 'second' });
      await d.notifyEngagement({ message: 'third' });
      await d.flush();
      expect(calls.map((c) => c.payload.message)).toEqual([
        'first',
        'second',
        'third',
      ]);
    });
  });

  describe('notify (generic priority)', () => {
    it('routes each priority to the matching method', async () => {
      const { fn, calls } = recordingFn();
      const d = new NotifyDispatcher({
        notifyFn: fn,
        solicitedPolicy: () => 'send',
      });
      await d.notify('fiduciary', { message: 'f' });
      await d.notify('solicited', { message: 's' });
      await d.notify('engagement', { message: 'e' });
      // fiduciary + solicited went direct; engagement buffered.
      expect(calls.map((c) => c.priority)).toEqual(['fiduciary', 'solicited']);
      expect(d.pending()).toBe(1);
    });

    it('throws on unknown priority', async () => {
      const d = new NotifyDispatcher({ notifyFn: async () => undefined });
      await expect(
        d.notify(
          'admin' as unknown as NotifyPriority,
          { message: 'x' },
        ),
      ).rejects.toThrow(/unknown priority/);
    });
  });

  describe('flush', () => {
    it('drains buffer + preserves order', async () => {
      const { fn, calls } = recordingFn();
      const d = new NotifyDispatcher({
        notifyFn: fn,
        solicitedPolicy: () => 'defer',
      });
      await d.notifySolicited({ message: 'a' });
      await d.notifyEngagement({ message: 'b' });
      await d.notifySolicited({ message: 'c' });

      const sent = await d.flush();
      expect(sent).toBe(3);
      expect(d.pending()).toBe(0);
      expect(calls.map((c) => ({ priority: c.priority, msg: c.payload.message }))).toEqual([
        { priority: 'solicited', msg: 'a' },
        { priority: 'engagement', msg: 'b' },
        { priority: 'solicited', msg: 'c' },
      ]);
    });

    it('empty buffer → returns 0', async () => {
      const d = new NotifyDispatcher({ notifyFn: async () => undefined });
      expect(await d.flush()).toBe(0);
    });

    it('partial failure re-queues failed items at the head', async () => {
      let callCount = 0;
      const d = new NotifyDispatcher({
        notifyFn: async (_priority, payload) => {
          callCount++;
          if (payload.message === 'FAIL') {
            throw new Error('transient');
          }
        },
      });
      await d.notifyEngagement({ message: 'ok-1' });
      await d.notifyEngagement({ message: 'FAIL' });
      await d.notifyEngagement({ message: 'ok-2' });

      const sent = await d.flush();
      expect(sent).toBe(2); // 2 succeeded, 1 failed
      expect(d.pending()).toBe(1); // the failed one is back in the buffer
      expect(d.peekBuffered()[0]!.payload.message).toBe('FAIL');
      // Call sequence: tried ok-1 (ok), FAIL (throws), ok-2 (ok).
      expect(callCount).toBe(3);
    });

    it('fires flushed event with count + duration', async () => {
      const events: NotifyEvent[] = [];
      const d = new NotifyDispatcher({
        notifyFn: async () => undefined,
        onEvent: (e) => events.push(e),
      });
      await d.notifyEngagement({ message: 'x' });
      await d.notifyEngagement({ message: 'y' });
      await d.flush();
      const flushed = events.find((e) => e.kind === 'flushed') as Extract<
        NotifyEvent,
        { kind: 'flushed' }
      >;
      expect(flushed.count).toBe(2);
      expect(flushed.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('flushPending is an alias that matches flush semantics', async () => {
      const { fn, calls } = recordingFn();
      const d = new NotifyDispatcher({ notifyFn: fn });
      await d.notifyEngagement({ message: 'x' });
      await d.flushPending();
      expect(calls.map((c) => c.payload.message)).toEqual(['x']);
    });
  });

  describe('discardPending + peekBuffered', () => {
    it('discardPending clears + returns count', async () => {
      const { fn, calls } = recordingFn();
      const d = new NotifyDispatcher({ notifyFn: fn });
      await d.notifyEngagement({ message: 'x' });
      await d.notifyEngagement({ message: 'y' });
      expect(d.discardPending()).toBe(2);
      expect(d.pending()).toBe(0);
      await d.flush();
      expect(calls).toEqual([]); // nothing to send
    });

    it('peekBuffered returns defensive copies (deep — incl. nested meta)', async () => {
      const d = new NotifyDispatcher({ notifyFn: async () => undefined });
      await d.notifyEngagement({
        message: 'x',
        meta: { kind: 'news', nested: { tag: 'sports' } },
      });
      const peek = d.peekBuffered();
      peek[0]!.payload.message = 'MUTATED';
      (peek[0]!.payload.meta as { kind: string }).kind = 'MUTATED';
      (
        (peek[0]!.payload.meta as { nested: { tag: string } }).nested
      ).tag = 'MUTATED';
      const peek2 = d.peekBuffered();
      expect(peek2[0]!.payload.message).toBe('x');
      expect((peek2[0]!.payload.meta as { kind: string }).kind).toBe('news');
      expect(
        (peek2[0]!.payload.meta as { nested: { tag: string } }).nested.tag,
      ).toBe('sports');
    });
  });

  describe('end-to-end: silence-first priority flow', () => {
    it('fiduciary direct, engagement batched, solicited direct-or-deferred', async () => {
      const { fn, calls } = recordingFn();
      let dnd = false;
      const policy: SolicitedPolicyFn = () => (dnd ? 'defer' : 'send');
      const d = new NotifyDispatcher({
        notifyFn: fn,
        solicitedPolicy: policy,
      });
      await d.notifyFiduciary({ message: 'alarm!' });
      await d.notifySolicited({ message: 'result-normal' });
      dnd = true;
      await d.notifySolicited({ message: 'result-dnd' });
      await d.notifyEngagement({ message: 'briefing-item' });

      // Immediate sends so far: fiduciary + solicited(normal).
      expect(calls.map((c) => ({ priority: c.priority, msg: c.payload.message }))).toEqual([
        { priority: 'fiduciary', msg: 'alarm!' },
        { priority: 'solicited', msg: 'result-normal' },
      ]);
      expect(d.pending()).toBe(2); // solicited(dnd) + engagement

      // Flush: both buffered items send.
      await d.flush();
      expect(calls.map((c) => c.payload.message)).toEqual([
        'alarm!',
        'result-normal',
        'result-dnd',
        'briefing-item',
      ]);
    });
  });
});
