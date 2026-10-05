/**
 * The phone's policy socket (UCP plan §3.4, U6): the native `DinaNet` module
 * under `@dina/net-expo/policy_socket`, so outbound fetches on the phone can
 * refuse special-use addresses and pin the socket, as the server's do.
 *
 * SELF-CHECK BEFORE USE (the repo-proof pattern): boot asks the native module
 * to resolve `localhost` and requires every answer to be refused by the shared
 * classifier. That proves the module is linked and its answers reach the
 * policy, without touching the network. A host that fails gets no socket, and
 * anything that needs one stays off; the log carries the fault class only.
 *
 * DEV SELF-TEST: in a dev build (`__DEV__`) with `EXPO_PUBLIC_DINA_NET_SELFTEST=1`
 * (bundle-time) boot also runs live cases against public hosts and logs one
 * PASS or FAIL line each, with metadata only (status, byte count, error code).
 */

import { requireOptionalNativeModule } from 'expo';

import { AppViewClient, buildA2AGuardLLMCall, GuardSlots, UcpGuardWorker } from '@dina/brain';
import {
  createUcpCheckoutRuntime,
  createUcpSearchRuntime,
  installUcpCheckoutRuntime,
  installUcpMerchantTrust,
  installUcpSearchRuntime,
  startPublisherSchedule,
  installUcpPublication,
  UcpPublisher,
  type CoreClient,
  type PublisherSchedule,
} from '@dina/core';
import { createNativePolicySocket, type DinaNetNative } from '@dina/net-expo/policy_socket';
import { isBlockedAddress, type PolicySocket, type PolicySocketRequest } from '@dina/net-policy';

import { peekAgenticRouter } from '../ai/agentic_swap';
import { appViewBase, appViewFetch } from '../peerlens/appview_base';
import { getIdentityAdapter } from '../storage/init';

import { clearUcpCardCache } from './ucp_card_cache';
import { logUcpSchemaSelfTest } from './ucp_schema_selftest';

let socket: PolicySocket | null = null;

/** The phone's policy socket, once boot has wired it; null before or when unavailable. */
export function getMobilePolicySocket(): PolicySocket | null {
  return socket;
}

function nativeModule(): DinaNetNative | null {
  try {
    return requireOptionalNativeModule<DinaNetNative>('DinaNet');
  } catch {
    return null;
  }
}

/** Wire the policy socket after the offline self-check; returns whether it is available. */
export async function wireMobilePolicySocket(): Promise<boolean> {
  socket = null;
  const native = nativeModule();
  if (native === null) {
    console.warn('[net] DinaNet module not linked; the policy socket stays off');
    return false;
  }
  try {
    const answers = await native.resolveHost('localhost');
    if (answers.length === 0 || !answers.every((a) => isBlockedAddress(a))) {
      console.warn('[net] policy socket self-check failed: localhost not refused');
      return false;
    }
  } catch (err) {
    console.warn(
      '[net] policy socket self-check failed',
      err instanceof Error ? err.constructor.name : typeof err,
    );
    return false;
  }
  socket = createNativePolicySocket(native);
  // Dev builds only: a store build never runs it, even if the flag is set.
  if (__DEV__ && process.env.EXPO_PUBLIC_DINA_NET_SELFTEST === '1') {
    void runLiveSelfTest(native, socket);
    logUcpSchemaSelfTest();
  }
  return true;
}

// ------------------------------------------------------------ dev self-test

const SCHEMA_URL = 'https://ucp.dev/2026-08-25/schemas/shopping/checkout.json';
/** A public test server that offers TLS 1.2 only. */
const TLS12_ONLY = 'https://tls-v1-2.badssl.com:1012/';

function get(url: string, over: Partial<PolicySocketRequest> = {}): PolicySocketRequest {
  return {
    method: 'GET',
    url,
    headers: {},
    accept: 'json',
    minTls: 'TLSv1.2',
    readAuthErrorBodies: false,
    maxResponseBytes: 256 * 1024,
    timeoutMs: 15_000,
    ...over,
  };
}

/** Live cases against public hosts (T-U6-8). Logs metadata only. */
export async function runLiveSelfTest(native: DinaNetNative, policy: PolicySocket): Promise<void> {
  const report = (name: string, pass: boolean, detail: string): void => {
    console.log(`[dina-net selftest] ${pass ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  };
  const run = async (name: string, body: () => Promise<[boolean, string]>): Promise<void> => {
    try {
      const [pass, detail] = await body();
      report(name, pass, detail);
    } catch (err) {
      report(name, false, `threw ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  let etag: string | undefined;
  await run('json fetch over a pinned socket', async () => {
    const r = await policy(get(SCHEMA_URL, { minTls: 'TLSv1.3' }));
    if (!r.ok) return [false, `${r.error} sent=${r.sent}`];
    etag = r.rawHeaders.find(([n]) => n === 'etag')?.[1];
    const json = JSON.parse(new TextDecoder().decode(r.bodyBytes)) as { name?: string };
    const pass =
      r.status === 200 &&
      json.name === 'dev.ucp.shopping.checkout' &&
      !isBlockedAddress(r.connectedAddress);
    return [pass, `status=${r.status} bytes=${r.bodyBytes.length} name=${json.name ?? '-'}`];
  });
  await run('304 with If-None-Match', async () => {
    if (etag === undefined) return [false, 'no etag from the first fetch'];
    const r = await policy(get(SCHEMA_URL, { ifNoneMatch: etag }));
    return [
      r.ok && r.status === 304 && r.bodyBytes.length === 0,
      r.ok ? `status=${r.status}` : r.error,
    ];
  });
  await run('localhost refused before connecting', async () => {
    const r = await policy(get('https://localhost/'));
    return [
      !r.ok && r.error === 'address_blocked' && !r.sent,
      r.ok ? `status=${r.status}` : `${r.error} sent=${r.sent}`,
    ];
  });
  await run('redirect refused', async () => {
    const r = await policy(get('https://ucp.dev/latest'));
    return [!r.ok && r.error === 'redirect_refused', r.ok ? `status=${r.status}` : r.error];
  });
  await run('html refused for a json request', async () => {
    const r = await policy(get('https://ucp.dev/'));
    return [!r.ok && r.error === 'bad_content_type', r.ok ? `status=${r.status}` : r.error];
  });
  await run('size cap', async () => {
    const r = await policy(get(SCHEMA_URL, { maxResponseBytes: 1000 }));
    return [!r.ok && r.error === 'too_large', r.ok ? `status=${r.status}` : r.error];
  });
  await run('certificate checked against the name, not the address', async () => {
    const other = (await native.resolveHost('example.com'))[0];
    if (other === undefined) return [false, 'example.com did not resolve'];
    const r = await native.fetchPinned({
      method: 'GET',
      url: SCHEMA_URL,
      address: other,
      headers: [['accept', 'application/json']],
      bodyBase64: null,
      minTls: 'TLSv1.2',
      readBody: true,
      readAuthErrorBodies: false,
      maxResponseBytes: 256 * 1024,
      maxHeaderFields: 128,
      maxHeaderBytes: 65536,
      timeoutMs: 15_000,
    });
    return [
      !r.ok && r.error === 'tls_failed' && !r.sent,
      r.ok ? `status=${r.status}` : `${r.error} sent=${r.sent}`,
    ];
  });
  await run('an address that never answers fails without sending', async () => {
    const r = await native.fetchPinned({
      method: 'GET',
      url: SCHEMA_URL,
      address: '10.255.255.1',
      headers: [],
      bodyBase64: null,
      minTls: 'TLSv1.2',
      readBody: true,
      readAuthErrorBodies: false,
      maxResponseBytes: 1024,
      maxHeaderFields: 128,
      maxHeaderBytes: 65536,
      timeoutMs: 3_000,
    });
    return [
      !r.ok && (r.error === 'timeout' || r.error === 'connect_failed') && !r.sent,
      r.ok ? `status=${r.status}` : `${r.error} sent=${r.sent}`,
    ];
  });
  await run('TLS floor 1.3 refuses a TLS 1.2-only server', async () => {
    const r = await policy(get(TLS12_ONLY, { minTls: 'TLSv1.3' }));
    return [
      !r.ok && r.error === 'tls_failed' && !r.sent,
      r.ok ? `status=${r.status}` : `${r.error} sent=${r.sent}`,
    ];
  });
  await run('TLS floor 1.2 accepts it (then its HTML is refused)', async () => {
    const r = await policy(get(TLS12_ONLY, { minTls: 'TLSv1.2' }));
    return [
      !r.ok && r.error === 'bad_content_type' && r.sent,
      r.ok ? `status=${r.status}` : `${r.error} sent=${r.sent}`,
    ];
  });
  await run('a refused credential is its status, the body unread unless asked', async () => {
    const challenge = get('https://api.github.com/user', {
      headers: { 'user-agent': 'dina-selftest' },
    });
    const dropped = await policy(challenge);
    const read = await policy({ ...challenge, readAuthErrorBodies: true });
    const pass =
      dropped.ok &&
      dropped.status === 401 &&
      dropped.bodyBytes.length === 0 &&
      read.ok &&
      read.status === 401 &&
      read.bodyBytes.length > 0;
    return [
      pass,
      `${dropped.ok ? dropped.status : dropped.error}/${dropped.ok ? dropped.bodyBytes.length : '-'} then ${read.ok ? read.status : read.error}/${read.ok ? read.bodyBytes.length : '-'}`,
    ];
  });
  console.log('[dina-net selftest] done');
}

// ------------------------------------------------------------ UCP on the phone

let publication: PublisherSchedule | null = null;
let guard: UcpGuardWorker | null = null;
/**
 * One limit for the process: a worker still finishing after a restart counts
 * against it too. Made on the first start, not when this module loads.
 */
let guardSlots: GuardSlots | null = null;

type Bootstrap = typeof import('../hooks/useNodeBootstrap');

/** The booted node's in-process Core client; null before boot. */
function bootedCore(): CoreClient | null {
  // Required here, not imported: the bootstrap hook reaches this module through the boot.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bootstrap = require('../hooks/useNodeBootstrap') as Bootstrap;
  return bootstrap.getBootedNode()?.coreClient ?? null;
}

/**
 * Start UCP on this phone when it is enabled (`EXPO_PUBLIC_DINA_UCP_ENABLED=1`,
 * off until the profile host is deployed) and the node has a did:plc the host
 * can resolve: the buyer profile's upload (plan §3.5), merchant search on the
 * identity database (§3.16), and the guard over merchant text (§3.11), which
 * claims from the booted node's Core and asks the live model (a Settings
 * provider swap applies at once; with no model no verdict is posted and the
 * text stays withheld). Safe to call on every boot; a previous run is stopped,
 * and its worker finished, first. Returns whether UCP started.
 */
export async function startUcp(did: string): Promise<boolean> {
  await stopUcp();
  if (process.env.EXPO_PUBLIC_DINA_UCP_ENABLED !== '1' || !did.startsWith('did:plc:')) return false;
  const profileHost = process.env.EXPO_PUBLIC_DINA_UCP_PROFILE_HOST;
  const host = profileHost !== undefined && profileHost !== '' ? { profileHost } : {};
  const publisher = new UcpPublisher({ did, ...host });
  // A rotated key signs from the first merchant call after a restart (U7).
  await publisher.restoreKeys();
  publication = startPublisherSchedule(publisher);
  // The owner's UCP settings: status, key ring, and the four actions (§3.5, §4.8).
  installUcpPublication({ publisher, schedule: publication });
  const db = getIdentityAdapter();
  if (db !== null) {
    installUcpSearchRuntime(createUcpSearchRuntime(db, { client: host }));
    // Checkouts and carts (plan §3.7): swept while the app is open.
    // The app catches its own claimed link (§3.17): a link's sign-in page opens here.
    const checkout = createUcpCheckoutRuntime(db, { client: host, linksOpenHere: true });
    installUcpCheckoutRuntime(checkout);
    checkout.start();
  }
  // The comparison card's trust lines: this phone's Core asks PeerLens itself (plan §3.7).
  installUcpMerchantTrust(async (subject) => {
    const peerlens = new AppViewClient({ appViewURL: await appViewBase(), fetch: appViewFetch });
    return peerlens.resolveTrust({ subject, context: 'before-transaction' });
  });
  guard = new UcpGuardWorker({
    core: {
      claimUcpGuardJob: async () => (await bootedCore()?.claimUcpGuardJob()) ?? null,
      submitUcpGuardVerdict: async (input) => {
        const core = bootedCore();
        return core === null
          ? { ok: false, status: 503, reason: 'node_not_booted' }
          : core.submitUcpGuardVerdict(input);
      },
    },
    llm: async (system, prompt) => {
      const router = peekAgenticRouter();
      if (router === null) throw new Error('no model configured');
      return buildA2AGuardLLMCall(router)(system, prompt);
    },
    slots: (guardSlots ??= new GuardSlots()),
    // Job ids, verdicts and codes only (the worker never logs text).
    logger: (entry) => console.log('[ucp guard]', JSON.stringify(entry)),
  });
  guard.start();
  return true;
}

/** Whether UCP runs on this phone now: an ask offers the shopping tools only then. */
export function ucpRunning(): boolean {
  return guard !== null;
}

/** Tell the guard worker a search's products are waiting; a no-op while UCP is not running. */
export function kickUcpGuard(): void {
  void guard?.tick();
}

/**
 * Stop UCP on this phone (the vault sealed, sign-out, erase): no upload, no
 * search, and no claim after this; resolves once the guard's jobs in hand
 * are judged. Call it before the identity database closes.
 */
export async function stopUcp(): Promise<void> {
  installUcpPublication(null);
  publication?.stop();
  publication = null;
  installUcpSearchRuntime(null);
  installUcpCheckoutRuntime(null);
  installUcpMerchantTrust(null);
  // The cards' memory of what the owner shopped for goes with UCP.
  clearUcpCardCache();
  const worker = guard;
  guard = null;
  await worker?.stop();
}
