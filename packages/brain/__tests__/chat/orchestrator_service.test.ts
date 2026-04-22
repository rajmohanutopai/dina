/**
 * BRAIN-P1-W02 — `/service` orchestrator integration.
 *
 * No orchestrator wired → friendly "coming soon" reply.
 * When a handler is installed, it gets called with (capability, payload)
 * and its `ack` string is returned to the user.
 */

import {
  handleChat,
  resetChatDefaults,
  setServiceCommandHandler,
  resetServiceCommandHandler,
} from '../../src/chat/orchestrator';
import { resetThreads } from '../../src/chat/thread';

describe('Chat orchestrator — /service', () => {
  beforeEach(() => {
    resetChatDefaults();
    resetThreads();
    resetServiceCommandHandler();
  });

  afterAll(() => {
    resetServiceCommandHandler();
  });

  it('without a handler, returns a friendly "coming soon" notice', async () => {
    const res = await handleChat('/service eta_query when will you reach me?');
    expect(res.intent).toBe('service');
    expect(res.response).toMatch(/eta_query/);
    expect(res.response).toMatch(/not wired up|coming soon/i);
  });

  it('missing capability → usage hint', async () => {
    const res = await handleChat('/service');
    // parser falls back to 'chat' for bare /service — the chat pipeline handles it.
    expect(res.intent).not.toBe('service');
  });

  it('with a handler, delegates to it and returns its ack string', async () => {
    const calls: Array<{ capability: string; payload: string }> = [];
    setServiceCommandHandler(async (capability, payload) => {
      calls.push({ capability, payload });
      return { ack: `Asking Bus Driver for ${capability}…` };
    });

    const res = await handleChat('/service eta_query when will bus 42 arrive?');

    expect(calls).toEqual([{ capability: 'eta_query', payload: 'when will bus 42 arrive?' }]);
    expect(res.response).toBe('Asking Bus Driver for eta_query…');
  });

  it('handler throwing → surfaces error message to the user (no crash)', async () => {
    setServiceCommandHandler(async () => {
      throw new Error('AppView unreachable');
    });
    const res = await handleChat('/service eta_query ?');
    expect(res.response).toMatch(/Couldn't start service query.*AppView unreachable/);
  });

  it('empty payload is forwarded to the handler as ""', async () => {
    const received: string[] = [];
    setServiceCommandHandler(async (_cap, payload) => {
      received.push(payload);
      return { ack: 'ack' };
    });
    await handleChat('/service eta_query');
    expect(received).toEqual(['']);
  });
});
