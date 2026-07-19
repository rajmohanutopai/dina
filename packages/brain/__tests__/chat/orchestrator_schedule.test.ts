/**
 * Contact Services seam 2 — contact-scoped intent routing.
 *
 * A `/schedule …` (the suggestion-chip lane) routes the scheduling intent to
 * the THREAD'S contact instead of public provider discovery. The orchestrator
 * makes the routing decision and delegates the wire send to the injected
 * `ContactServiceHandler` (mobile wires it to `chat_d2d.sendServiceQuery`).
 *
 * The routing contract this pins:
 *   - contact thread (contactDID known) → handler called with that DID + the
 *     `availability_coordination` capability + the user's free-text intent;
 *   - dispatched → orchestrator returns EMPTY (handler posted its own card);
 *   - not dispatched (no grant) → the handler's explanatory ack is surfaced;
 *   - NO contact (main tab) → never calls the handler; redirects instead.
 */

import {
  handleChat,
  resetChatDefaults,
  setContactServiceHandler,
  resetContactServiceHandler,
  type ContactServiceHandler,
} from '../../src/chat/orchestrator';
import { resetThreads } from '../../src/chat/thread';

const PEER = 'did:plc:sancho';

describe('Chat orchestrator — /schedule (contact-scoped routing, seam 2)', () => {
  beforeEach(() => {
    resetChatDefaults();
    resetThreads();
    resetContactServiceHandler();
  });

  afterAll(() => {
    resetContactServiceHandler();
  });

  it('routes a scheduling intent to the thread contact (explicit contactDID)', async () => {
    const calls: { contactDID: string; capability: string; intent: string }[] = [];
    const handler: ContactServiceHandler = async (args) => {
      calls.push(args);
      return { ack: 'sent', dispatched: true };
    };
    setContactServiceHandler(handler);

    const res = await handleChat('/schedule find a time next week', PEER, { contactDID: PEER });

    expect(res.intent).toBe('schedule');
    expect(calls).toHaveLength(1);
    expect(calls[0].contactDID).toBe(PEER);
    expect(calls[0].capability).toBe('availability_coordination');
    expect(calls[0].intent).toBe('find a time next week');
    // Dispatched → handler owns the card; orchestrator returns no extra bubble.
    expect(res.response).toBe('');
  });

  it('infers the contact from a did:-shaped threadId when no explicit context is given', async () => {
    const calls: { contactDID: string }[] = [];
    setContactServiceHandler(async (args) => {
      calls.push(args);
      return { ack: 'sent', dispatched: true };
    });

    // The Talk thread is keyed by the peer DID — passing it as threadId alone
    // (no context) must still route contact-scoped.
    const res = await handleChat('/schedule coffee?', PEER);
    expect(res.intent).toBe('schedule');
    expect(calls).toHaveLength(1);
    expect(calls[0].contactDID).toBe(PEER);
  });

  it('surfaces the handler ack when the dispatch did NOT go out (no grant/offer)', async () => {
    setContactServiceHandler(async () => ({
      ack: "You haven't been offered scheduling by this contact yet.",
      dispatched: false,
    }));
    const res = await handleChat('/schedule meet up', PEER, { contactDID: PEER });
    expect(res.response).toMatch(/haven't been offered/i);
  });

  it('does NOT call the handler outside a contact thread — redirects instead', async () => {
    let called = false;
    setContactServiceHandler(async () => {
      called = true;
      return { ack: 'sent', dispatched: true };
    });

    // Main chat tab → threadId 'main', no contactDID → not contact-scoped.
    const res = await handleChat('/schedule with someone', 'main');
    expect(called).toBe(false);
    expect(res.intent).toBe('schedule');
    expect(res.response).toMatch(/open a chat with a contact/i);
  });

  it('without a handler wired, a contact-scoped /schedule degrades to a coming-soon notice', async () => {
    const res = await handleChat('/schedule lunch', PEER, { contactDID: PEER });
    expect(res.intent).toBe('schedule');
    expect(res.response).toMatch(/not wired up|coming soon/i);
  });

  it('stores the user bubble as the clean payload (no slash prefix leak)', async () => {
    setContactServiceHandler(async () => ({ ack: 'sent', dispatched: true }));
    await handleChat('/schedule find a time', PEER, { contactDID: PEER });
    const { getThread } = await import('../../src/chat/thread');
    const thread = getThread(PEER);
    // First message is the user bubble; it must show the clean payload + mode.
    expect(thread[0].type).toBe('user');
    expect(thread[0].content).toBe('find a time');
    expect(thread[0].metadata?.mode).toBe('schedule');
  });
});
