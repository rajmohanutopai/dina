/**
 * Live mobile-home-node harness.
 *
 * Not a regression test — a long-running script that boots a mobile
 * Core against the REAL test-mailbox relay, generates a pair code, and
 * keeps the WS open so a docker `openclaw-user` container can pair
 * against it.
 *
 * Run:  npx jest __tests__/harness/mobile_node_harness --no-coverage --runInBand
 * Stop: Ctrl+C (or wait for the 30 min timeout).
 *
 * Output (on stderr so it surfaces past jest's dots):
 *   [HARNESS] did:       did:key:z6Mk...
 *   [HARNESS] pair code: 123456 (expires in 5 min)
 *
 * Gate with LIVE_HARNESS=1 so CI never runs this.
 */

/* eslint-disable no-console */

// Node `ws` has no bundled .d.ts. The shape we need (`send`, `close`,
// event emitter) is stable across versions; cast to a local structural
// type so ts-jest doesn't need @types/ws installed.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WebSocket = require('ws') as unknown as {
  new (url: string): NodeWS;
};
interface NodeWS {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: string | Buffer) => void): void;
  on(event: 'close', cb: (code: number, reason: Buffer) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}
import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { bootstrapMsgBox } from '../../src/relay/msgbox_boot';
import { createCoreRouter } from '../../src/server/core_server';
import { setNodeDID, generatePairingCode, clearPairingState } from '../../src/pairing/ceremony';
import { resetDeviceRegistry, getDeviceByDID, listDevices } from '../../src/devices/registry';
import { resetCallerTypeState, setDeviceRoleResolver, isDevice } from '../../src/auth/caller_type';
import { setWorkflowRepository, InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { setWorkflowService, WorkflowService } from '../../src/workflow/service';
import { createDIDPLC } from '../../src/identity/directory';
import type { WSLike } from '../../src/relay/msgbox_ws';

// Jest guards — opt-in via env so CI doesn't try to open live sockets.
const LIVE = process.env.LIVE_HARNESS === '1';
const describeLive = LIVE ? describe : describe.skip;

const MSGBOX_URL = process.env.DINA_MSGBOX_URL ?? 'wss://test-mailbox.dinakernel.com/ws';
const PAIR_DEVICE_NAME = process.env.PAIR_DEVICE_NAME ?? 'openclaw-user';
const PAIR_ROLE: 'agent' | 'rich' | 'thin' | 'cli' =
  (process.env.PAIR_ROLE as 'agent' | 'rich' | 'thin' | 'cli') ?? 'agent';
const TIMEOUT_MS = 30 * 60 * 1000;

function wsAdapter(url: string): WSLike {
  console.error(`[WS] connecting ${url}`);
  const socket = new WebSocket(url);
  const like: WSLike = {
    send: (data: string) => {
      console.error(`[WS] → ${data.slice(0, 120)}`);
      socket.send(data);
    },
    close: () => socket.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    readyState: socket.readyState,
  };
  socket.on('open', () => {
    console.error(`[WS] open (readyState=${socket.readyState})`);
    like.readyState = socket.readyState;
    if (like.onopen) like.onopen();
  });
  socket.on('message', (data) => {
    const text = typeof data === 'string' ? data : data.toString('utf-8');
    console.error(`[WS] ← ${text.slice(0, 200)}`);
    if (like.onmessage) like.onmessage({ data: text });
  });
  socket.on('close', (code, reason) => {
    console.error(`[WS] close code=${code} reason="${reason.toString('utf-8')}"`);
    like.readyState = socket.readyState;
    if (like.onclose) {
      like.onclose({ code, reason: reason.toString('utf-8') });
    }
  });
  socket.on('error', (err) => {
    console.error(`[WS] error ${err.message}`);
    if (like.onerror) like.onerror(err);
  });
  return like;
}

describeLive('live mobile-home-node harness', () => {
  // jest default is 5s; overriding to the full TIMEOUT_MS so the
  // script stays alive waiting for the docker agent to pair.
  jest.setTimeout(TIMEOUT_MS + 60_000);

  it('boots, prints pair code, waits for a docker agent to pair', async () => {
    clearPairingState();
    resetDeviceRegistry();
    resetCallerTypeState();

    // 1. Identity — register a real did:plc on the live PLC directory
    //    (secp256k1 rotation sig + dag-cbor + base64url, per ATProto
    //    PLC spec). Mirrors what main-dina's home node does on
    //    onboarding. The `#dina_signing` verificationMethod published
    //    here is what `dina-cli`'s `_resolve_homenode_x25519_pub`
    //    looks up.
    const handlePrefix = `harness${bytesToHex(randomBytes(4))}`;
    const pdsUrl = process.env.DINA_PDS_URL ?? 'https://test-pds.dinakernel.com';
    const pdsDomain = pdsUrl.replace(/^https?:\/\//, '');
    const handle = `${handlePrefix}.${pdsDomain}`;
    const signingSeed = randomBytes(32);
    const rotationSeed = randomBytes(32);

    console.error(`[HARNESS] registering did:plc on live PLC directory...`);
    const plcResult = await createDIDPLC(
      {
        signingKey: signingSeed,
        rotationSeed,
        msgboxEndpoint: MSGBOX_URL,
        handle,
      },
      { plcURL: process.env.DINA_PLC_URL, fetch: globalThis.fetch },
    );
    const did = plcResult.did;
    const privateKey = signingSeed;
    console.error(`[HARNESS] registered: did=${did}`);
    setNodeDID(did);

    // 2. Role resolver so the agent DID lands as callerType='agent'
    //    once pairing completes (otherwise the claim path 403s).
    setDeviceRoleResolver((d) => {
      const device = getDeviceByDID(d);
      return device?.role ?? null;
    });

    // 3. In-memory workflow so the claim endpoint has a service to
    //    serve.
    const repo = new InMemoryWorkflowRepository();
    setWorkflowRepository(repo);
    setWorkflowService(new WorkflowService({ repository: repo }));

    // 4. Build the Core router + bootstrap MsgBox.
    const router = createCoreRouter();
    // readyTimeoutMs=0 → bootstrap returns immediately after sending
    // auth_response; we don't block on `auth_success` because some
    // MsgBox variants only send it on the first inbound envelope.
    // With a fresh did:key there's no pending traffic, so waiting
    // deadlocks. The next envelope (pair RPC from docker) flips the
    // flag implicitly via the existing authChallengeSeen fallback.
    await bootstrapMsgBox({
      did,
      privateKey,
      msgboxURL: MSGBOX_URL,
      wsFactory: wsAdapter,
      coreRouter: router,
      resolveSender: async (_did) => ({ keys: [], trust: 'untrusted' }),
      readyTimeoutMs: 0,
    });

    // 5. Mint pair code + broadcast.
    const { code, expiresAt } = generatePairingCode({
      deviceName: PAIR_DEVICE_NAME,
      role: PAIR_ROLE,
    });
    const secondsLeft = expiresAt - Math.floor(Date.now() / 1000);

    console.error('');
    console.error('================================================================');
    console.error(' MOBILE HOME NODE — READY FOR PAIRING');
    console.error('================================================================');
    console.error(` DID          : ${did}`);
    console.error(` Pair code    : ${code}`);
    console.error(` Expires in   : ${secondsLeft}s`);
    console.error(` MsgBox URL   : ${MSGBOX_URL}`);
    console.error(` Device name  : ${PAIR_DEVICE_NAME}`);
    console.error(` Role         : ${PAIR_ROLE}`);
    console.error('');
    console.error(' .env for docker/openclaw:');
    console.error(`   DINA_MSGBOX_URL=${MSGBOX_URL}`);
    console.error(`   DINA_HOMENODE_DID=${did}`);
    console.error('   DINA_TRANSPORT=msgbox');
    console.error(`   USER_PAIRING_CODE=${code}`);
    console.error('================================================================');
    console.error('');

    // 6. Poll the registry every 2s until the agent shows up, or the
    //    timeout elapses. On pair success we log + keep running so
    //    follow-up signed RPCs (claim, heartbeat) can be observed.
    const startMs = Date.now();
    let pairedLogged = false;
    await new Promise<void>((resolve) => {
      const id = setInterval(() => {
        const devs = listDevices();
        if (!pairedLogged && devs.length > 0) {
          pairedLogged = true;
          for (const d of devs) {
            console.error(`[HARNESS] paired: ${d.deviceName} (${d.role}) did=${d.did}`);
          }
          console.error(`[HARNESS] isDevice(${devs[0].did}) = ${isDevice(devs[0].did)}`);
          console.error('[HARNESS] staying up; issue signed RPC calls to exercise the claim path');
        }
        if (Date.now() - startMs >= TIMEOUT_MS) {
          clearInterval(id);
          resolve();
        }
      }, 2_000);
    });
    // Final registry snapshot before the test exits.
    const finalDevs = listDevices();
    console.error(`[HARNESS] final device count: ${finalDevs.length}`);
    for (const d of finalDevs) {
      console.error(`[HARNESS]   ${d.deviceName}  ${d.role}  ${d.did}`);
    }
    expect(true).toBe(true);
  });
});
