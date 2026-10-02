/**
 * MsgBox delete-on-ack, client side. The relay keeps each message until the
 * phone acknowledges it, and sends unacknowledged ones again on the next
 * connect (msgbox/internal/ack_test.go pins the relay half). Here: the client
 * asks for the feature, acks only what the relay granted, acks after the
 * handler has settled rather than on receipt, keeps what nothing could take,
 * and does not handle a message sent again twice.
 */

import { TEST_ED25519_SEED } from '@dina/test-harness';

import { getPublicKey } from '../../src/crypto/ed25519';
import { deriveDIDKey } from '../../src/identity/did';
import { kvHas, kvSet, resetKVStore, setKVRepository } from '../../src/kv/store';
import {
  connectToMsgBox,
  resetConnectionState,
  setWSFactory,
  setIdentity,
  isAuthenticated,
  onD2DMessage,
  onRPCRequest,
  type MsgBoxEnvelope,
  type WSLike,
} from '../../src/relay/msgbox_ws';

import type { KVRepository } from '../../src/kv/repository';

interface Sent {
  binary: boolean;
  frame: Record<string, unknown>;
}

interface MockWS extends WSLike {
  sent: Sent[];
}

function makeMockWS(): MockWS {
  const ws: MockWS = {
    sent: [],
    send(data: string | Uint8Array | ArrayBuffer): void {
      if (typeof data === 'string') {
        ws.sent.push({ binary: false, frame: JSON.parse(data) });
      } else {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        ws.sent.push({ binary: true, frame: JSON.parse(new TextDecoder().decode(bytes)) });
      }
    },
    close(): void {
      ws.readyState = 3;
      if (ws.onclose) ws.onclose({ code: 1000, reason: 'closed' });
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    readyState: 1,
  };
  return ws;
}

const MY_DID = deriveDIDKey(getPublicKey(TEST_ED25519_SEED));
const PEER = 'did:plc:peerdina0001';

function d2d(id: string, extra: Partial<MsgBoxEnvelope> = {}): MsgBoxEnvelope {
  return { type: 'd2d', id, from_did: PEER, to_did: MY_DID, ciphertext: '{}', ...extra };
}

function acks(ws: MockWS): Sent[] {
  return ws.sent.filter((s) => s.frame.type === 'ack');
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe('MsgBox delete-on-ack (client)', () => {
  let sockets: MockWS[];

  async function connect(authSuccess: Record<string, unknown>): Promise<MockWS> {
    setIdentity(MY_DID, TEST_ED25519_SEED);
    setWSFactory(() => {
      const ws = makeMockWS();
      sockets.push(ws);
      return ws;
    });
    await connectToMsgBox('wss://relay.test/ws');
    const ws = sockets[sockets.length - 1];
    if (ws === undefined) throw new Error('no socket');
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify({ type: 'auth_challenge', nonce: 'n1', ts: 1 }) });
    ws.onmessage?.({ data: JSON.stringify({ type: 'auth_success', ...authSuccess }) });
    expect(isAuthenticated()).toBe(true);
    return ws;
  }

  function deliver(ws: MockWS, env: MsgBoxEnvelope): void {
    ws.onmessage?.({ data: JSON.stringify(env) });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    sockets = [];
    resetConnectionState();
    resetKVStore();
  });

  afterEach(() => {
    resetConnectionState();
    jest.useRealTimers();
  });

  it('asks the relay for the ack feature in its auth response', async () => {
    const ws = await connect({ features: ['ack'] });
    const response = ws.sent.find((s) => s.frame.type === 'auth_response');
    expect(response?.frame.features).toEqual(['ack']);
  });

  it('acks a message once its handler has settled, not on receipt', async () => {
    let finish: () => void = () => undefined;
    onD2DMessage(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const ws = await connect({ features: ['ack'] });

    deliver(ws, d2d('msg-1'));
    await settle();
    expect(acks(ws)).toHaveLength(0);

    finish();
    await settle();
    expect(acks(ws)).toEqual([
      { binary: true, frame: { type: 'ack', id: 'msg-1', from_did: PEER } },
    ]);
  });

  it('sends no acks to a relay that did not grant the feature', async () => {
    onD2DMessage(() => undefined);
    const ws = await connect({});
    deliver(ws, d2d('msg-old'));
    await settle();
    expect(acks(ws)).toHaveLength(0);
  });

  it('keeps a message nothing could take: no ack, and the next copy is handled afresh', async () => {
    const seen: string[] = [];
    let ready = false;
    onD2DMessage((env) => {
      seen.push(env.id);
      return ready ? undefined : false;
    });
    const ws = await connect({ features: ['ack'] });

    deliver(ws, d2d('msg-early'));
    await settle();
    expect(acks(ws)).toHaveLength(0);

    ready = true;
    deliver(ws, d2d('msg-early'));
    await settle();
    expect(seen).toEqual(['msg-early', 'msg-early']);
    expect(acks(ws)).toHaveLength(1);
  });

  it('a copy sent again after handling is acked without running the handler twice', async () => {
    const handled = jest.fn();
    onD2DMessage(handled);
    const first = await connect({ features: ['ack'] });
    deliver(first, d2d('msg-again'));
    await settle();
    expect(acks(first)).toHaveLength(1);

    // The ack was lost with the socket; the relay sends the message again.
    first.close();
    const second = await connect({ features: ['ack'] });
    deliver(second, d2d('msg-again'));
    await settle();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(acks(second)).toEqual([
      { binary: true, frame: { type: 'ack', id: 'msg-again', from_did: PEER } },
    ]);
  });

  it('a copy arriving while the first is still being handled is skipped; one ack follows', async () => {
    let finish: () => void = () => undefined;
    const handled = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    onD2DMessage(handled);
    const ws = await connect({ features: ['ack'] });

    deliver(ws, d2d('msg-slow'));
    deliver(ws, d2d('msg-slow'));
    await settle();
    expect(handled).toHaveBeenCalledTimes(1);
    finish();
    await settle();
    expect(acks(ws)).toHaveLength(1);
  });

  it('acks a message whose handler failed, so it does not come back forever', async () => {
    onRPCRequest(() => Promise.reject(new Error('boom')));
    const ws = await connect({ features: ['ack'] });
    deliver(ws, {
      type: 'rpc',
      id: 'req-bad',
      from_did: 'did:key:zcli',
      to_did: MY_DID,
      direction: 'request',
      ciphertext: 'x',
    });
    await settle();
    expect(acks(ws).map((a) => a.frame.id)).toEqual(['req-bad']);
  });

  it('acks what it drops on purpose (expired) and keeps what has no handler yet', async () => {
    const ws = await connect({ features: ['ack'] });
    deliver(ws, d2d('msg-expired', { expires_at: 1 }));
    deliver(ws, d2d('msg-unhandled'));
    await settle();
    expect(acks(ws).map((a) => a.frame.id)).toEqual(['msg-expired']);
  });

  it('a new connection starts without the feature until its relay grants it', async () => {
    onD2DMessage(() => undefined);
    const first = await connect({ features: ['ack'] });
    first.close();
    const second = await connect({});
    deliver(second, d2d('msg-new-relay'));
    await settle();
    expect(acks(second)).toHaveLength(0);
  });

  it('a resend after a restart is acked from the durable record, not handled again', async () => {
    const handled = jest.fn();
    onD2DMessage(handled);
    const first = await connect({ features: ['ack'] });
    deliver(first, d2d('msg-durable'));
    await settle();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(await kvHas(`${PEER}:msg-durable`, 'msgbox_handled')).toBe(true);

    // The process restarts (memory gone, the identity store kept) before the
    // relay saw the ack; the relay sends the message again.
    resetConnectionState();
    const afterRestart = jest.fn();
    onD2DMessage(afterRestart);
    const second = await connect({ features: ['ack'] });
    deliver(second, d2d('msg-durable'));
    await settle();
    expect(afterRestart).not.toHaveBeenCalled();
    expect(acks(second).map((a) => a.frame.id)).toEqual(['msg-durable']);
  });

  it('a still-running handler is not run again when its resend arrives behind 600 newer messages', async () => {
    let finishSlow: () => void = () => undefined;
    const calls = new Map<string, number>();
    onD2DMessage((env) => {
      calls.set(env.id, (calls.get(env.id) ?? 0) + 1);
      if (env.id === 'msg-slow') {
        return new Promise<void>((resolve) => {
          finishSlow = resolve;
        });
      }
      return undefined;
    });
    const ws = await connect({ features: ['ack'] });
    deliver(ws, d2d('msg-slow'));
    for (let i = 0; i < 600; i++) deliver(ws, d2d(`msg-${String(i)}`));
    await settle();
    deliver(ws, d2d('msg-slow'));
    await settle();
    expect(calls.get('msg-slow')).toBe(1);
    finishSlow();
    await settle();
    expect(acks(ws).filter((a) => a.frame.id === 'msg-slow')).toHaveLength(1);
  });

  /** A KV store whose reads or writes fail on demand, over a real map. */
  function flakyStore(): { repo: KVRepository; failReads: boolean; failWrites: boolean } {
    const rows = new Map<string, { key: string; value: string; updatedAt: number }>();
    const state = { failReads: false, failWrites: false } as {
      repo: KVRepository;
      failReads: boolean;
      failWrites: boolean;
    };
    state.repo = {
      get: async (k) => rows.get(k) ?? null,
      set: async (k, v) => {
        if (state.failWrites) throw new Error('disk full');
        rows.set(k, { key: k, value: v, updatedAt: Date.now() });
      },
      delete: async (k) => rows.delete(k),
      has: async (k) => {
        if (state.failReads) throw new Error('database locked');
        return rows.has(k);
      },
      list: async (prefix) =>
        [...rows.values()].filter((r) => prefix === undefined || r.key.startsWith(prefix)),
      count: async () => rows.size,
    };
    return state;
  }

  it('a store that cannot say whether a message was handled leaves it unhandled and unacked', async () => {
    const store = flakyStore();
    setKVRepository(store.repo);
    const handled = jest.fn();
    onD2DMessage(handled);
    const ws = await connect({ features: ['ack'] });
    store.failReads = true;
    deliver(ws, d2d('msg-unsure'));
    await settle();
    expect(handled).not.toHaveBeenCalled();
    expect(acks(ws)).toHaveLength(0);

    store.failReads = false;
    deliver(ws, d2d('msg-unsure'));
    await settle();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(acks(ws).map((a) => a.frame.id)).toEqual(['msg-unsure']);
  });

  it('a record that cannot be written means no ack; the resend retries the record, not the handler', async () => {
    const store = flakyStore();
    setKVRepository(store.repo);
    const handled = jest.fn();
    onD2DMessage(handled);
    const ws = await connect({ features: ['ack'] });
    store.failWrites = true;
    deliver(ws, d2d('msg-unrecorded'));
    await settle();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(acks(ws)).toHaveLength(0);

    deliver(ws, d2d('msg-unrecorded')); // still failing
    await settle();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(acks(ws)).toHaveLength(0);

    store.failWrites = false;
    deliver(ws, d2d('msg-unrecorded'));
    await settle();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(acks(ws).map((a) => a.frame.id)).toEqual(['msg-unrecorded']);
    expect(await kvHas(`${PEER}:msg-unrecorded`, 'msgbox_handled')).toBe(true);
  });

  it('a node that stays connected prunes old records as it handles messages', async () => {
    jest.setSystemTime(new Date('2026-10-02T00:00:00.000Z'));
    onD2DMessage(() => undefined);
    await kvSet(`${PEER}:msg-ancient`, String(Date.now() - 26 * 60 * 60 * 1000), 'msgbox_handled');
    const ws = await connect({ features: ['ack'] }); // prunes once now
    await settle();
    await kvSet(`${PEER}:msg-old`, String(Date.now()), 'msgbox_handled');

    // Two days on, still connected: handling a message prunes again.
    jest.setSystemTime(new Date('2026-10-04T00:00:00.000Z'));
    deliver(ws, d2d('msg-today'));
    await settle();
    await settle();
    expect(await kvHas(`${PEER}:msg-ancient`, 'msgbox_handled')).toBe(false);
    expect(await kvHas(`${PEER}:msg-old`, 'msgbox_handled')).toBe(false);
    expect(await kvHas(`${PEER}:msg-today`, 'msgbox_handled')).toBe(true);
  });
});
