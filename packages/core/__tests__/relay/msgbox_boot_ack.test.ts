/**
 * Delete-on-ack through the real MsgBox bootstrap wiring: when a D2D message
 * is acked. Stored outcomes (staged, quarantined) are acked once the receive
 * pipeline has run; service traffic, which the pipeline does not store, is
 * acked only after the dispatcher has had it — and kept at the relay when no
 * dispatcher is wired. `handleInboundD2D` is stubbed to return each outcome;
 * everything between the socket and it is the shipped code.
 */

import { TEST_ED25519_SEED } from '@dina/test-harness';

import { getPublicKey } from '../../src/crypto/ed25519';
import { deriveDIDKey } from '../../src/identity/did';

import type { MsgBoxBootConfig } from '../../src/relay/msgbox_boot';
import type { WSLike } from '../../src/relay/msgbox_ws';
import type { CoreRouter } from '../../src/server/router';

// The shared setup file loads the relay modules before a hoisted mock could
// apply, so the modules under test are loaded fresh, after the stub.
const mockInbound = jest.fn();
let bootstrapMsgBox: (config: MsgBoxBootConfig) => Promise<void>;
let resetConnectionState: () => void;
let resetKVStore: () => void;

beforeAll(async () => {
  jest.resetModules();
  jest.doMock('../../src/relay/msgbox_handlers', () => {
    const actual = jest.requireActual('../../src/relay/msgbox_handlers');
    return { ...actual, handleInboundD2D: (...args: unknown[]) => mockInbound(...args) };
  });
  ({ bootstrapMsgBox } = await import('../../src/relay/msgbox_boot'));
  ({ resetConnectionState } = await import('../../src/relay/msgbox_ws'));
  ({ resetKVStore } = await import('../../src/kv/store'));
});

const MY_DID = deriveDIDKey(getPublicKey(TEST_ED25519_SEED));
const PEER = 'did:plc:servicepeer01';

interface MockWS extends WSLike {
  frames: Record<string, unknown>[];
}

function makeSocket(): MockWS {
  const ws: MockWS = {
    frames: [],
    send(data: string | Uint8Array | ArrayBuffer): void {
      const text =
        typeof data === 'string'
          ? data
          : new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data));
      ws.frames.push(JSON.parse(text));
    },
    close(): void {
      ws.readyState = 3;
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    readyState: 1,
  };
  setTimeout(() => {
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify({ type: 'auth_challenge', nonce: 'n', ts: 1 }) });
    ws.onmessage?.({ data: JSON.stringify({ type: 'auth_success', features: ['ack'] }) });
  }, 0);
  return ws;
}

async function boot(extra: Record<string, unknown>): Promise<MockWS> {
  let socket: MockWS | null = null;
  await bootstrapMsgBox({
    did: MY_DID,
    privateKey: TEST_ED25519_SEED,
    msgboxURL: 'wss://relay.test/ws',
    wsFactory: () => {
      socket = makeSocket();
      return socket;
    },
    coreRouter: {} as CoreRouter,
    resolveSender: async () => ({ keys: [], trust: 'unknown' }),
    readyTimeoutMs: 2000,
    ...extra,
  });
  if (socket === null) throw new Error('no socket');
  return socket;
}

function deliver(ws: MockWS, id: string): void {
  ws.onmessage?.({
    data: JSON.stringify({ type: 'd2d', id, from_did: PEER, to_did: MY_DID, ciphertext: '{}' }),
  });
}

const acked = (ws: MockWS): unknown[] => ws.frames.filter((f) => f.type === 'ack').map((f) => f.id);
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

const bypassed = {
  success: true,
  pipelineAction: 'bypassed',
  bypassedBody: { capability: 'eta_query' },
  messageType: 'service.query',
  senderDID: PEER,
};

describe('bootstrapMsgBox — when a D2D message is acked', () => {
  beforeEach(() => {
    resetConnectionState();
    resetKVStore();
    mockInbound.mockReset();
  });
  afterEach(() => resetConnectionState());

  it('service traffic is acked only after the dispatcher has finished with it', async () => {
    mockInbound.mockResolvedValue(bypassed);
    let finish: () => void = () => undefined;
    const dispatcher = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const ws = await boot({ onBypassedD2D: dispatcher });

    deliver(ws, 'svc-1');
    await tick();
    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(acked(ws)).toEqual([]);

    finish();
    await tick();
    expect(acked(ws)).toEqual(['svc-1']);
  });

  it('service traffic on a node with no dispatcher is dropped on purpose, and acked', async () => {
    // Holding it would not help: the pipeline has recorded its id against
    // replay, so the next copy would be refused as a replay and acked anyway.
    mockInbound.mockResolvedValue(bypassed);
    const ws = await boot({});
    deliver(ws, 'svc-orphan');
    await tick();
    expect(acked(ws)).toEqual(['svc-orphan']);
  });

  it('a staged message is acked once stored, without waiting for the UI fan-out', async () => {
    mockInbound.mockResolvedValue({
      success: true,
      pipelineAction: 'staged',
      stagedBody: 'hello',
      messageType: 'social.update',
      senderDID: PEER,
    });
    const neverDone = jest.fn(() => new Promise<void>(() => undefined));
    const ws = await boot({ onStagedD2D: neverDone });
    deliver(ws, 'chat-1');
    await tick();
    expect(neverDone).toHaveBeenCalledTimes(1);
    expect(acked(ws)).toEqual(['chat-1']);
  });
});
