/**
 * Inbound D2D → main-chat bridge. The drain's onD2DMessage handler (wired at
 * boot) must post a received peer message into the `main` thread as a
 * source='d2d' bubble attributed to the sender — that's what the web SPA's
 * /api/v1/chat/stream SSE subscription mirrors so the thin-client's chat shows
 * inbound Talk messages (F4 / MRS-04).
 */

import { getThread, resetThreads, type ChatMessage } from '@dina/brain/chat';

import { postInboundD2DToMainChat } from '../src/inbound_d2d_chat';

describe('postInboundD2DToMainChat', () => {
  beforeEach(() => {
    resetThreads();
  });

  it('posts the message into `main` as a source=d2d bubble attributed to the sender', () => {
    postInboundD2DToMainChat({
      senderDid: 'did:plc:alonso',
      senderName: 'Alonso',
      body: 'Dinner at 8 on Friday?',
      messageType: 'coordination.request',
      timestamp: 1_783_000_000_000,
    });

    const thread: ChatMessage[] = getThread('main');
    expect(thread).toHaveLength(1);
    const msg = thread[0];
    expect(msg?.threadId).toBe('main');
    expect(msg?.type).toBe('dina'); // left-aligned bubble, not a user message
    expect(msg?.content).toBe('Dinner at 8 on Friday?');
    expect(msg?.metadata?.source).toBe('d2d');
    expect(msg?.metadata?.senderDID).toBe('did:plc:alonso');
    expect(msg?.metadata?.senderName).toBe('Alonso');
    expect(msg?.metadata?.messageType).toBe('coordination.request');
    // Sender's wire time is used for correct burst ordering (MT-19-I2).
    expect(msg?.timestamp).toBe(1_783_000_000_000);
  });

  it('omits the timestamp override when the sender clock is unknown (0)', () => {
    postInboundD2DToMainChat({
      senderDid: 'did:plc:sancho',
      senderName: 'Sancho',
      body: 'On my way',
      messageType: 'social.update',
      timestamp: 0,
    });
    const msg = getThread('main')[0];
    expect(msg?.content).toBe('On my way');
    // A real (non-zero) timestamp was stamped by addMessage, not the 0 sentinel.
    expect(msg?.timestamp).toBeGreaterThan(0);
  });
});
