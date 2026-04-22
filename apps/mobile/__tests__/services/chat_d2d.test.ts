/**
 * Tests for `sendChatMessage` — the outbound-chat wrapper over Core's
 * D2DSender. Covers the optimistic-local-echo behaviour, the wire
 * payload shape, and the failure path that writes an error row.
 */

import { sendChatMessage, ChatSendError } from '../../src/services/chat_d2d';
import { setD2DSender, getD2DSender } from '../../../core/src/server/routes/d2d_msg';
import { resetThreads, getThread } from '../../../brain/src/chat/thread';

const PEER = 'did:plc:testbusdriver';

beforeEach(() => {
  resetThreads();
  setD2DSender(null);
});

afterEach(() => {
  setD2DSender(null);
});

describe('sendChatMessage', () => {
  it('throws ChatSendError when the D2D sender is not wired', async () => {
    await expect(sendChatMessage(PEER, 'hi')).rejects.toBeInstanceOf(ChatSendError);
  });

  it('rejects empty peer DID', async () => {
    setD2DSender(async () => {});
    await expect(sendChatMessage('', 'hi')).rejects.toThrow(/peerDID/);
  });

  it('rejects empty text (after trim)', async () => {
    setD2DSender(async () => {});
    await expect(sendChatMessage(PEER, '   ')).rejects.toThrow(/text/);
  });

  it('sends a coordination.request with {text} body and echos locally', async () => {
    const calls: Array<{ to: string; type: string; body: unknown }> = [];
    setD2DSender(async (to, type, body) => {
      calls.push({ to, type, body });
    });

    const msg = await sendChatMessage(PEER, 'hello');
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe(PEER);
    expect(calls[0].type).toBe('coordination.request');
    expect(calls[0].body).toEqual({ text: 'hello' });

    const thread = getThread(PEER);
    expect(thread).toHaveLength(1);
    expect(thread[0].id).toBe(msg.id);
    expect(thread[0].content).toBe('hello');
    expect(thread[0].type).toBe('user');
    expect(thread[0].metadata?.source).toBe('d2d');
    expect(thread[0].metadata?.peerDID).toBe(PEER);
  });

  it('trims the outgoing text', async () => {
    const calls: Array<{ body: unknown }> = [];
    setD2DSender(async (_to, _type, body) => {
      calls.push({ body });
    });
    await sendChatMessage(PEER, '   padded hi   ');
    expect(calls[0].body).toEqual({ text: 'padded hi' });
    expect(getThread(PEER)[0].content).toBe('padded hi');
  });

  it('keeps the user bubble AND appends an error row on send failure', async () => {
    setD2DSender(async () => {
      throw new Error('relay down');
    });

    await expect(sendChatMessage(PEER, 'try me')).rejects.toThrow(/relay down/);
    const thread = getThread(PEER);
    expect(thread).toHaveLength(2);
    expect(thread[0].type).toBe('user');
    expect(thread[0].content).toBe('try me');
    expect(thread[1].type).toBe('error');
    expect(thread[1].content).toMatch(/relay down/);
    expect(thread[1].metadata?.failedMessageId).toBe(thread[0].id);
  });

  it('does not hit the sender when validation fails', async () => {
    let hit = 0;
    setD2DSender(async () => {
      hit++;
    });
    await expect(sendChatMessage(PEER, '')).rejects.toThrow();
    expect(hit).toBe(0);
    expect(getThread(PEER)).toHaveLength(0);
  });

  it('leaves the installed D2D sender untouched across calls', async () => {
    const fn = jest.fn(async () => {});
    setD2DSender(fn);
    await sendChatMessage(PEER, 'first');
    await sendChatMessage(PEER, 'second');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(getD2DSender()).toBe(fn);
  });
});
