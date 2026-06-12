/**
 * Issue #351 — MsgBox WS keepalive: app-level ping/pong + idle-staleness
 * detection with forced reconnect.
 *
 * The live failure mode: a NAT/proxy silently kills the idle TCP
 * connection; the socket looks OPEN forever while sends vanish
 * (observed ~3.5h idle → frames_seen=0 claims). These tests drive the
 * keepalive timer with fake timers and assert: ping cadence, pong
 * handling, tight staleness (pong-capable relay), fallback staleness
 * (legacy relay), pre-auth silence, and timer cleanup on disconnect.
 */

import { TEST_ED25519_SEED } from '@dina/test-harness';

import { getPublicKey } from '../../src/crypto/ed25519';
import { deriveDIDKey } from '../../src/identity/did';
import {
  connectToMsgBox,
  disconnect,
  resetConnectionState,
  setWSFactory,
  setIdentity,
  isAuthenticated,
  isConnected,
  wakeRelay,
  KEEPALIVE_TICK_MS,
  PING_INTERVAL_MS,
  PONG_STALE_MS,
  FALLBACK_STALE_MS,
  AUTH_STALE_MS,
  type WSLike,
} from '../../src/relay/msgbox_ws';


interface MockWS extends WSLike {
  sentFrames: unknown[];
  closeCalls: number;
}

/**
 * Mock WS that mimics the RN polyfill: close() fires onclose locally
 * (even on half-open sockets), sends are recorded decoded.
 */
function makeMockWS(): MockWS {
  const ws: MockWS = {
    sentFrames: [],
    closeCalls: 0,
    send(data: string | Uint8Array | ArrayBuffer): void {
      if (typeof data === 'string') {
        ws.sentFrames.push(JSON.parse(data));
      } else {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        ws.sentFrames.push(JSON.parse(new TextDecoder().decode(bytes)));
      }
    },
    close(): void {
      ws.closeCalls += 1;
      ws.readyState = 3; // CLOSED
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

function pingsSent(ws: MockWS): unknown[] {
  return ws.sentFrames.filter(
    (f) => (f as { type?: string }).type === 'ping',
  );
}

describe('MsgBox WS keepalive (issue #351)', () => {
  let sockets: MockWS[];

  /** Connect + complete the auth handshake on the latest socket. */
  async function connectAndAuth(): Promise<MockWS> {
    const pubKey = getPublicKey(TEST_ED25519_SEED);
    setIdentity(deriveDIDKey(pubKey), TEST_ED25519_SEED);
    setWSFactory(() => {
      const ws = makeMockWS();
      sockets.push(ws);
      return ws;
    });
    await connectToMsgBox('wss://relay.test/ws');
    const ws = sockets[sockets.length - 1];
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify({ type: 'auth_challenge', nonce: 'n1', ts: 1 }) });
    ws.onmessage?.({ data: JSON.stringify({ type: 'auth_success' }) });
    expect(isAuthenticated()).toBe(true);
    return ws;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    sockets = [];
    resetConnectionState();
  });

  afterEach(() => {
    resetConnectionState();
    jest.useRealTimers();
  });

  it('sends pings on the PING_INTERVAL cadence once authenticated', async () => {
    const ws = await connectAndAuth();

    jest.advanceTimersByTime(KEEPALIVE_TICK_MS);
    expect(pingsSent(ws)).toHaveLength(1); // first tick: ping due immediately

    jest.advanceTimersByTime(PING_INTERVAL_MS);
    expect(pingsSent(ws)).toHaveLength(2);

    jest.advanceTimersByTime(PING_INTERVAL_MS);
    expect(pingsSent(ws)).toHaveLength(3);
  });

  it('does not send pings before authentication', async () => {
    const pubKey = getPublicKey(TEST_ED25519_SEED);
    setIdentity(deriveDIDKey(pubKey), TEST_ED25519_SEED);
    setWSFactory(() => {
      const ws = makeMockWS();
      sockets.push(ws);
      return ws;
    });
    await connectToMsgBox('wss://relay.test/ws');
    const ws = sockets[0];
    ws.onopen?.(); // connected but never authenticated

    jest.advanceTimersByTime(AUTH_STALE_MS - KEEPALIVE_TICK_MS);
    expect(pingsSent(ws)).toHaveLength(0);
    expect(ws.closeCalls).toBe(0);
  });

  it('recycles a socket stuck in auth limbo past AUTH_STALE_MS', async () => {
    const pubKey = getPublicKey(TEST_ED25519_SEED);
    setIdentity(deriveDIDKey(pubKey), TEST_ED25519_SEED);
    setWSFactory(() => {
      const ws = makeMockWS();
      sockets.push(ws);
      return ws;
    });
    await connectToMsgBox('wss://relay.test/ws');
    const ws = sockets[0];
    ws.onopen?.(); // auth_challenge never arrives

    jest.advanceTimersByTime(AUTH_STALE_MS + KEEPALIVE_TICK_MS * 2);
    expect(ws.closeCalls).toBe(1);
    expect(pingsSent(ws)).toHaveLength(0); // never pinged an unauthenticated socket

    jest.advanceTimersByTime(2_000);
    expect(sockets.length).toBe(2); // reconnect engaged
  });

  it('stays connected while pongs keep arriving past the tight threshold', async () => {
    const ws = await connectAndAuth();

    // Run well past PONG_STALE_MS, answering every ping with a pong.
    const totalMs = PONG_STALE_MS * 3;
    for (let elapsed = 0; elapsed < totalMs; elapsed += KEEPALIVE_TICK_MS) {
      const before = pingsSent(ws).length;
      jest.advanceTimersByTime(KEEPALIVE_TICK_MS);
      if (pingsSent(ws).length > before) {
        ws.onmessage?.({ data: JSON.stringify({ type: 'pong', ts: 1 }) });
      }
    }
    expect(ws.closeCalls).toBe(0);
    expect(isAuthenticated()).toBe(true);
  });

  it('forces reconnect after PONG_STALE_MS of silence on a pong-capable relay', async () => {
    const ws = await connectAndAuth();

    // One answered ping establishes pong support.
    jest.advanceTimersByTime(KEEPALIVE_TICK_MS);
    expect(pingsSent(ws)).toHaveLength(1);
    ws.onmessage?.({ data: JSON.stringify({ type: 'pong', ts: 1 }) });

    // Then the relay goes silent (half-open socket): pings keep going
    // out but nothing comes back. Past PONG_STALE_MS the client must
    // close and schedule a reconnect.
    jest.advanceTimersByTime(PONG_STALE_MS + KEEPALIVE_TICK_MS * 2);
    expect(ws.closeCalls).toBe(1);

    // Reconnect: backoff fires → a NEW socket is created.
    jest.advanceTimersByTime(2_000);
    expect(sockets.length).toBe(2);
  });

  it('falls back to the long idle bound against a relay that ignores pings', async () => {
    const ws = await connectAndAuth();

    // No pong ever arrives. Stay connected well past the tight bound…
    jest.advanceTimersByTime(PONG_STALE_MS * 2);
    expect(ws.closeCalls).toBe(0);

    // …but reconnect once the fallback bound is exceeded.
    jest.advanceTimersByTime(FALLBACK_STALE_MS);
    expect(ws.closeCalls).toBe(1);
    jest.advanceTimersByTime(2_000);
    expect(sockets.length).toBe(2);
  });

  it('any inbound frame (not just pong) refreshes the staleness clock', async () => {
    const ws = await connectAndAuth();

    // Establish pong support, then go pong-silent but keep real D2D
    // frames flowing — the connection is demonstrably alive and must
    // NOT be torn down.
    jest.advanceTimersByTime(KEEPALIVE_TICK_MS);
    ws.onmessage?.({ data: JSON.stringify({ type: 'pong', ts: 1 }) });

    const totalMs = PONG_STALE_MS * 2;
    for (let elapsed = 0; elapsed < totalMs; elapsed += KEEPALIVE_TICK_MS * 2) {
      jest.advanceTimersByTime(KEEPALIVE_TICK_MS * 2);
      ws.onmessage?.({
        data: JSON.stringify({ type: 'd2d', id: `m${elapsed}`, from_did: 'did:plc:x', to_did: '' }),
      });
    }
    expect(ws.closeCalls).toBe(0);
  });

  it('disconnect() stops the keepalive timer — no pings or closes afterwards', async () => {
    const ws = await connectAndAuth();
    await disconnect();
    const pingsAtDisconnect = pingsSent(ws).length;

    jest.advanceTimersByTime(FALLBACK_STALE_MS * 2);
    expect(pingsSent(ws)).toHaveLength(pingsAtDisconnect);
    expect(sockets.length).toBe(1); // no reconnect after explicit disconnect
  });
});

describe('wakeRelay — foreground reconnect (issue #351 complement)', () => {
  let sockets: MockWS[];

  function setup(): void {
    const pubKey = getPublicKey(TEST_ED25519_SEED);
    setIdentity(deriveDIDKey(pubKey), TEST_ED25519_SEED);
    setWSFactory(() => {
      const ws = makeMockWS();
      sockets.push(ws);
      return ws;
    });
  }

  async function connectAndAuth(): Promise<MockWS> {
    setup();
    await connectToMsgBox('wss://relay.test/ws');
    const ws = sockets[sockets.length - 1];
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify({ type: 'auth_challenge', nonce: 'n1', ts: 1 }) });
    ws.onmessage?.({ data: JSON.stringify({ type: 'auth_success' }) });
    expect(isAuthenticated()).toBe(true);
    return ws;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    sockets = [];
    resetConnectionState();
  });

  afterEach(() => {
    resetConnectionState();
    jest.useRealTimers();
  });

  it('is a no-op when the relay is already authenticated on an OPEN socket', async () => {
    const ws = await connectAndAuth();
    wakeRelay();
    expect(sockets.length).toBe(1); // no new socket
    expect(ws.closeCalls).toBe(0); // existing one untouched
    expect(isAuthenticated()).toBe(true);
  });

  it('reconnects IMMEDIATELY when the socket died (the background→foreground case)', async () => {
    const ws = await connectAndAuth();
    // Simulate iOS killing the socket while suspended: it's CLOSED but
    // no onclose ran (JS was paused), so our state still thinks it's up.
    ws.readyState = 3; // CLOSED
    wakeRelay();
    // A fresh socket is created synchronously (no backoff wait, no
    // staleness-threshold wait).
    expect(sockets.length).toBe(2);
    const fresh = sockets[1];
    fresh.onopen?.();
    fresh.onmessage?.({ data: JSON.stringify({ type: 'auth_challenge', nonce: 'n2', ts: 2 }) });
    fresh.onmessage?.({ data: JSON.stringify({ type: 'auth_success' }) });
    expect(isAuthenticated()).toBe(true);
  });

  it('bypasses a pending backoff timer (no double-connect)', async () => {
    await connectAndAuth();
    // Force the socket closed → schedules a backoff reconnect.
    sockets[0].close();
    expect(isConnected()).toBe(false);
    // wakeRelay should reconnect NOW and cancel the pending backoff so it
    // doesn't fire a SECOND socket later.
    wakeRelay();
    const afterWake = sockets.length;
    expect(afterWake).toBe(2);
    // Advance well past any backoff window — no third socket from a
    // leftover timer.
    jest.advanceTimersByTime(FALLBACK_STALE_MS);
    expect(sockets.length).toBe(afterWake);
  });

  it('does NOT reconnect after an explicit disconnect()', async () => {
    await connectAndAuth();
    await disconnect();
    wakeRelay();
    expect(sockets.length).toBe(1); // shouldReconnect=false → no-op
  });

  it('is a no-op before any connect (nothing to wake)', () => {
    setup();
    wakeRelay();
    expect(sockets.length).toBe(0);
  });
});
