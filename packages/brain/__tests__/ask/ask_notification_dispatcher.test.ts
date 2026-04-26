/**
 * Tests for `AskNotificationDispatcher`.
 *
 * Strategy: drive the registry through real state transitions
 * (enqueue → markPendingApproval) and assert the dispatcher emits
 * exactly one notification frame per pending_approval event, with
 * the right priority + message + correlation id. The sink is a
 * recording spy; the registry is the real `AskRegistry`.
 */

import {
  AskNotificationDispatcher,
  ASK_NOTIFICATION_PREVIEW_CHARS,
  type AskNotificationDispatcherEvent,
  type NotificationSink,
} from '../../src/ask/ask_notification_dispatcher';
import { AskRegistry, InMemoryAskAdapter, type AskEvent } from '../../src/ask/ask_registry';
import {
  NOTIFICATION_FRAME_TYPE,
  NOTIFICATION_FRAME_VERSION,
  type NotificationFrame,
} from '../../src/notify/notification_frame';

const REQUESTER_DID = 'did:key:z6MkAlonsoTester';
const FROZEN_NOW_MS = 1_750_000_000_000;

interface Harness {
  registry: AskRegistry;
  dispatcher: AskNotificationDispatcher;
  sinkCalls: NotificationFrame[];
  dispatcherEvents: AskNotificationDispatcherEvent[];
}

function buildHarness(
  opts: {
    notify?: NotificationSink;
  } = {},
): Harness {
  const sinkCalls: NotificationFrame[] = [];
  const dispatcherEvents: AskNotificationDispatcherEvent[] = [];
  const askEvents: AskEvent[] = [];

  // We have to build the dispatcher AFTER the registry, but the
  // registry's onEvent hook needs a function we can wire to the
  // dispatcher.handle. Forward-reference via a let.
  let dispatcher: AskNotificationDispatcher | null = null;
  const registry = new AskRegistry({
    adapter: new InMemoryAskAdapter(),
    nowMsFn: () => FROZEN_NOW_MS,
    onEvent: (event) => {
      askEvents.push(event);
      dispatcher?.handle(event);
    },
  });

  dispatcher = new AskNotificationDispatcher({
    registry,
    notify:
      opts.notify ??
      ((frame) => {
        sinkCalls.push(frame);
      }),
    nowMsFn: () => FROZEN_NOW_MS,
    onEvent: (e) => dispatcherEvents.push(e),
  });

  return { registry, dispatcher, sinkCalls, dispatcherEvents };
}

/**
 * The dispatcher's handle is fire-and-forget — drain all queued
 * microtasks before asserting. `setImmediate` runs strictly after
 * every microtask currently in the queue, so this is robust against
 * arbitrary `await` chain depth inside the dispatcher.
 */
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('AskNotificationDispatcher', () => {
  describe('construction', () => {
    it('rejects missing registry', () => {
      // @ts-expect-error testing runtime validation
      expect(() => new AskNotificationDispatcher({ notify: () => {} })).toThrow(
        'registry is required',
      );
    });

    it('rejects missing notify', () => {
      const registry = new AskRegistry({ adapter: new InMemoryAskAdapter() });
      // @ts-expect-error testing runtime validation
      expect(() => new AskNotificationDispatcher({ registry })).toThrow(
        'notify must be a function',
      );
    });
  });

  describe('event filtering', () => {
    it('does NOT dispatch on enqueue', async () => {
      const h = buildHarness();
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'hello?',
        requesterDid: REQUESTER_DID,
      });
      await flushAsync();
      expect(h.sinkCalls).toHaveLength(0);
      expect(h.dispatcherEvents).toHaveLength(0);
    });

    it('does NOT dispatch on completion', async () => {
      const h = buildHarness();
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'hello?',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markComplete('ask-1', '{"answer":"hi"}');
      await flushAsync();
      expect(h.sinkCalls).toHaveLength(0);
    });

    it('does NOT dispatch on failure', async () => {
      const h = buildHarness();
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'hello?',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markFailed('ask-1', '{"reason":"oops"}');
      await flushAsync();
      expect(h.sinkCalls).toHaveLength(0);
    });

    it('does NOT dispatch on approval_resumed', async () => {
      const h = buildHarness();
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'hello?',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-1', 'appr-1');
      await flushAsync();
      h.sinkCalls.length = 0;
      h.dispatcherEvents.length = 0;

      await h.registry.resumeAfterApproval('ask-1');
      await flushAsync();
      expect(h.sinkCalls).toHaveLength(0);
      expect(h.dispatcherEvents).toHaveLength(0);
    });
  });

  describe('pending_approval dispatch — happy path', () => {
    it('emits one solicited frame on pending_approval', async () => {
      const h = buildHarness();
      await h.registry.enqueue({
        id: 'ask-1',
        question: "what's my balance?",
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-1', 'appr-1');
      await flushAsync();

      expect(h.sinkCalls).toHaveLength(1);
      const frame = h.sinkCalls[0]!;
      expect(frame.type).toBe(NOTIFICATION_FRAME_TYPE);
      expect(frame.v).toBe(NOTIFICATION_FRAME_VERSION);
      expect(frame.priority).toBe('solicited');
      expect(frame.message).toBe("Approval needed for: what's my balance?");
      expect(frame.id).toBe('notif-ask-ask-1-appr-1');
      expect(frame.ts).toBe(FROZEN_NOW_MS);
    });

    it('emits a dispatcher event with the askId + frameId', async () => {
      const h = buildHarness();
      await h.registry.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-1', 'appr-1');
      await flushAsync();

      expect(h.dispatcherEvents).toEqual([
        { kind: 'dispatched', askId: 'ask-1', frameId: 'notif-ask-ask-1-appr-1' },
      ]);
    });

    it('truncates long questions to ASK_NOTIFICATION_PREVIEW_CHARS', async () => {
      const h = buildHarness();
      const long = 'x'.repeat(ASK_NOTIFICATION_PREVIEW_CHARS + 50);
      await h.registry.enqueue({
        id: 'ask-1',
        question: long,
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-1', 'appr-1');
      await flushAsync();

      const frame = h.sinkCalls[0]!;
      // Prefix "Approval needed for: " + truncated body + ellipsis.
      expect(frame.message.startsWith('Approval needed for: ')).toBe(true);
      const body = frame.message.slice('Approval needed for: '.length);
      expect(body.length).toBe(ASK_NOTIFICATION_PREVIEW_CHARS);
      expect(body.endsWith('…')).toBe(true);
    });

    it('does not truncate when the question fits exactly', async () => {
      const h = buildHarness();
      const exact = 'y'.repeat(ASK_NOTIFICATION_PREVIEW_CHARS);
      await h.registry.enqueue({
        id: 'ask-1',
        question: exact,
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-1', 'appr-1');
      await flushAsync();

      const frame = h.sinkCalls[0]!;
      const body = frame.message.slice('Approval needed for: '.length);
      expect(body).toBe(exact);
      expect(body.endsWith('…')).toBe(false);
    });

    it('frame id includes approvalId so re-approval cycles produce distinct ids', async () => {
      // The dispatcher's contract: a re-approval (same ask, second
      // approval) gets a new frame id so consumer-side dedupe keyed
      // on id doesn't suppress the second prompt.
      const h = buildHarness();
      await h.registry.enqueue({
        id: 'ask-loop',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-loop', 'appr-1');
      await flushAsync();
      await h.registry.resumeAfterApproval('ask-loop');
      await h.registry.markPendingApproval('ask-loop', 'appr-2');
      await flushAsync();

      expect(h.sinkCalls).toHaveLength(2);
      expect(h.sinkCalls[0]!.id).toBe('notif-ask-ask-loop-appr-1');
      expect(h.sinkCalls[1]!.id).toBe('notif-ask-ask-loop-appr-2');
      expect(h.sinkCalls[0]!.id).not.toBe(h.sinkCalls[1]!.id);
    });

    it('one frame per pending_approval transition (no double-fire)', async () => {
      const h = buildHarness();
      await h.registry.enqueue({
        id: 'ask-A',
        question: 'A',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-A', 'appr-A');
      await flushAsync();

      await h.registry.enqueue({
        id: 'ask-B',
        question: 'B',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markPendingApproval('ask-B', 'appr-B');
      await flushAsync();

      expect(h.sinkCalls).toHaveLength(2);
      expect(h.sinkCalls.map((f) => f.id)).toEqual([
        'notif-ask-ask-A-appr-A',
        'notif-ask-ask-B-appr-B',
      ]);
    });
  });

  describe('custom builders', () => {
    it('uses an injected message builder when present', async () => {
      const sink: NotificationFrame[] = [];
      let d: AskNotificationDispatcher | null = null;
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        onEvent: (e) => d?.handle(e),
        nowMsFn: () => FROZEN_NOW_MS,
      });
      d = new AskNotificationDispatcher({
        registry: reg,
        notify: (f) => {
          sink.push(f);
        },
        buildMessage: (record) => `OPERATOR: ${record.requesterDid} → "${record.question}"`,
        nowMsFn: () => FROZEN_NOW_MS,
      });

      await reg.enqueue({
        id: 'ask-1',
        question: 'view balance',
        requesterDid: REQUESTER_DID,
      });
      await reg.markPendingApproval('ask-1', 'appr-1');
      await flushAsync();

      expect(sink).toHaveLength(1);
      expect(sink[0]!.message).toBe(`OPERATOR: ${REQUESTER_DID} → "view balance"`);
    });

    it('uses an injected frame-id builder when present', async () => {
      const sink: NotificationFrame[] = [];
      let d: AskNotificationDispatcher | null = null;
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        onEvent: (e) => d?.handle(e),
        nowMsFn: () => FROZEN_NOW_MS,
      });
      d = new AskNotificationDispatcher({
        registry: reg,
        notify: (f) => {
          sink.push(f);
        },
        buildFrameId: (record) => `custom-${record.id}-${record.approvalId}`,
        nowMsFn: () => FROZEN_NOW_MS,
      });

      await reg.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await reg.markPendingApproval('ask-1', 'appr-77');
      await flushAsync();

      expect(sink[0]!.id).toBe('custom-ask-1-appr-77');
    });
  });

  describe('failure paths', () => {
    it('emits sink_failed when the sink throws synchronously', async () => {
      const events: AskNotificationDispatcherEvent[] = [];
      let d: AskNotificationDispatcher | null = null;
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        onEvent: (e) => d?.handle(e),
        nowMsFn: () => FROZEN_NOW_MS,
      });
      d = new AskNotificationDispatcher({
        registry: reg,
        notify: () => {
          throw new Error('ws closed');
        },
        nowMsFn: () => FROZEN_NOW_MS,
        onEvent: (e) => events.push(e),
      });

      await reg.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await reg.markPendingApproval('ask-1', 'appr-1');
      await flushAsync();

      expect(events).toEqual([{ kind: 'sink_failed', askId: 'ask-1', detail: 'ws closed' }]);
    });

    it('emits sink_failed when the sink rejects asynchronously', async () => {
      const events: AskNotificationDispatcherEvent[] = [];
      let d: AskNotificationDispatcher | null = null;
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        onEvent: (e) => d?.handle(e),
        nowMsFn: () => FROZEN_NOW_MS,
      });
      d = new AskNotificationDispatcher({
        registry: reg,
        notify: async () => {
          throw new Error('ws timeout');
        },
        nowMsFn: () => FROZEN_NOW_MS,
        onEvent: (e) => events.push(e),
      });

      await reg.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await reg.markPendingApproval('ask-1', 'appr-1');
      await flushAsync();

      expect(events).toEqual([{ kind: 'sink_failed', askId: 'ask-1', detail: 'ws timeout' }]);
    });

    it('emits record_missing when the registry record was wiped before lookup', async () => {
      // We construct a registry that emits a fake pending_approval
      // event for a record that was never enqueued. Easiest way:
      // call dispatcher.handle() directly with a synthetic event.
      const events: AskNotificationDispatcherEvent[] = [];
      const sink: NotificationFrame[] = [];
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        nowMsFn: () => FROZEN_NOW_MS,
      });
      const d = new AskNotificationDispatcher({
        registry: reg,
        notify: (f) => {
          sink.push(f);
        },
        nowMsFn: () => FROZEN_NOW_MS,
        onEvent: (e) => events.push(e),
      });
      // handle() now returns a Promise<void> so tests can await
      // dispatch deterministically — no microtask-flush race.
      await d.handle({ kind: 'pending_approval', id: 'ask-ghost', approvalId: 'appr-x' });

      expect(sink).toHaveLength(0);
      expect(events).toEqual([{ kind: 'record_missing', askId: 'ask-ghost' }]);
    });

    it('emits sink_failed when buildMessage throws', async () => {
      const events: AskNotificationDispatcherEvent[] = [];
      const sink: NotificationFrame[] = [];
      let d: AskNotificationDispatcher | null = null;
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        onEvent: (e) => d?.handle(e),
        nowMsFn: () => FROZEN_NOW_MS,
      });
      d = new AskNotificationDispatcher({
        registry: reg,
        notify: (f) => {
          sink.push(f);
        },
        buildMessage: () => {
          throw new Error('builder broken');
        },
        nowMsFn: () => FROZEN_NOW_MS,
        onEvent: (e) => events.push(e),
      });

      await reg.enqueue({
        id: 'ask-1',
        question: 'q',
        requesterDid: REQUESTER_DID,
      });
      await reg.markPendingApproval('ask-1', 'appr-1');
      await flushAsync();

      expect(sink).toHaveLength(0);
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe('sink_failed');
      const evt = events[0] as Extract<AskNotificationDispatcherEvent, { kind: 'sink_failed' }>;
      expect(evt.detail).toContain('frame_build_failed');
      expect(evt.detail).toContain('builder broken');
    });
  });

  describe('integration with full ask cycle', () => {
    it('produces no notification on a fast-path complete ask', async () => {
      const h = buildHarness();
      await h.registry.enqueue({
        id: 'ask-fast',
        question: 'open vault?',
        requesterDid: REQUESTER_DID,
      });
      await h.registry.markComplete('ask-fast', '{"answer":"yes"}');
      await flushAsync();
      expect(h.sinkCalls).toHaveLength(0);
    });

    it('produces exactly one notification for a sensitive ask cycle', async () => {
      const h = buildHarness();
      await h.registry.enqueue({
        id: 'ask-sens',
        question: 'show balance',
        requesterDid: REQUESTER_DID,
      });
      // Step 1 — pending_approval → notification fires.
      await h.registry.markPendingApproval('ask-sens', 'appr-x');
      await flushAsync();
      expect(h.sinkCalls).toHaveLength(1);
      // Step 2 — operator approves; resume fires; NO new notification.
      await h.registry.resumeAfterApproval('ask-sens');
      await flushAsync();
      expect(h.sinkCalls).toHaveLength(1);
      // Step 3 — answer arrives; NO notification.
      await h.registry.markComplete('ask-sens', '{"answer":"$1234"}');
      await flushAsync();
      expect(h.sinkCalls).toHaveLength(1);
    });
  });
});
