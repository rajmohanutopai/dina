/**
 * The node's publisher against the REAL profile host (`createUcpHost` from
 * @dina/ucp, the one AppView serves) on in-memory storage, behind a fake
 * policy socket: the node and host contracts end to end (UCP plan §3.5).
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  createUcpHost,
  memoryHostLog,
  memoryHostStore,
  UCP_PROFILE_HOST,
  UCP_VERSION,
  type HostResponse,
  type LabelState,
} from '@dina/ucp';

import {
  deriveUcpIdentity,
  setUcpSigningGeneration,
  type UcpIdentity,
} from '../../../src/commerce/ucp/identity';
import { UcpPublisher } from '../../../src/commerce/ucp/publisher';
import {
  installUcpWebhookOrigin,
  setUcpWebhooksStoodDown,
  ucpOrderWebhookUrl,
} from '../../../src/commerce/ucp/webhooks';
import { freshRing } from '../../../src/crypto/key_rotation';
import { deriveRootSigningKey } from '../../../src/crypto/slip0010';
import { kvDelete, kvSet } from '../../../src/kv/store';

import type { UcpFetchResult } from '../../../src/commerce/ucp/fetch';
import type { PolicySocketRequest } from '@dina/net-policy';

const SEED = Uint8Array.from(
  Buffer.from('b0a1c2d3e4f5061728394a5b6c7d8e9fa0b1c2d3e4f5061728394a5b6c7d8e9f', 'hex'),
);
const DID = 'did:plc:7s5vldbcs2wwwxfzeigew6o5';
const OTHER_DID = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const ROOT_PUBLIC = ed25519.getPublicKey(deriveRootSigningKey(SEED, 0).privateKey);

/** The real host, its storage, and a socket in front of it that tests can break. */
class Rig {
  store = memoryHostStore();
  log = memoryHostLog();
  keys = new Map<string, Uint8Array | 'unavailable'>([[DID, ROOT_PUBLIC]]);
  requests: { method: string; url: string }[] = [];
  /** Run after the host answers a state read, before the node's next request (to race the node). */
  afterStateRead: (() => Promise<void>) | null = null;
  /** Run after the host answers a change, before the node reads the answer. */
  afterChange: (() => Promise<void>) | null = null;
  down = false;
  host = createUcpHost({
    profileHost: UCP_PROFILE_HOST,
    store: this.store,
    log: this.log,
    signingKeyFor: async (did) => this.keys.get(did) ?? null,
    sha256,
    ed25519Verify: (pk, m, sig) => ed25519.verify(sig, m, pk),
  });

  socket = async (r: PolicySocketRequest): Promise<UcpFetchResult> => {
    this.requests.push({ method: r.method, url: r.url });
    if (this.down) return { ok: false, error: 'connect_failed', sent: false };
    const url = new URL(r.url);
    const answer: HostResponse = await this.host.handle({
      method: r.method,
      hostname: url.hostname,
      path: url.pathname,
      headers: {},
      body: r.body ?? null,
    });
    if (url.pathname.endsWith('/state') && this.afterStateRead !== null) {
      const hook = this.afterStateRead;
      this.afterStateRead = null;
      await hook();
    }
    if (r.method !== 'GET' && this.afterChange !== null) {
      const hook = this.afterChange;
      this.afterChange = null;
      await hook();
    }
    return {
      ok: true,
      status: answer.status,
      bodyBytes: new TextEncoder().encode(answer.body),
      headers: answer.headers,
      connectedAddress: '203.0.114.7',
    };
  };

  label(): LabelState | undefined {
    return this.store.labels.get(identity.label);
  }
  puts(): number {
    return this.requests.filter((q) => q.method !== 'GET').length;
  }
}

let identity: UcpIdentity = deriveUcpIdentity(SEED);
let installed: UcpIdentity | null = identity;
let rig: Rig;
let uuid = 0;
let tick = 0;
const publisher = (did = DID) =>
  new UcpPublisher({
    did,
    identity: () => installed,
    fetch: rig.socket,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    // A moving clock: two uploads of the same revision differ (issued_at), as real ones do.
    now: () => 1_759_000_000_000 + ++tick,
  });

beforeEach(async () => {
  rig = new Rig();
  identity = deriveUcpIdentity(SEED);
  installed = identity;
  setUcpSigningGeneration(null);
  await kvDelete('publisher', 'ucp');
});

/** The bytes a publisher builds for its stored ring. */
async function built(p: UcpPublisher): Promise<string> {
  const keys = (await p.state()).keys;
  if (keys === undefined) throw new Error('no ring yet');
  return p.profileBytes(identity, keys);
}

describe('the order webhook_url the profile lists (UCP plan §3.13, S8, S9)', () => {
  const urlIn = (bytes: string): unknown =>
    (
      JSON.parse(bytes) as {
        ucp: { capabilities: Record<string, { config?: { webhook_url?: string } }[]> };
      }
    ).ucp.capabilities['dev.ucp.shopping.order']?.[0]?.config?.webhook_url;
  const reset = () => {
    installUcpWebhookOrigin(null);
    setUcpWebhooksStoodDown(false);
  };
  beforeEach(reset);
  afterEach(reset);

  it('a public node lists its own; with no public origin, or while stood down, the drop-box', () => {
    const p = publisher();
    const ring = freshRing(0);
    expect(urlIn(p.profileBytes(identity, ring))).toBe(
      `https://${identity.label}.${UCP_PROFILE_HOST}/webhooks/orders`,
    );
    installUcpWebhookOrigin('https://node.example');
    expect(urlIn(p.profileBytes(identity, ring))).toBe('https://node.example/ucp/webhooks/orders');
    setUcpWebhooksStoodDown(true);
    expect(urlIn(p.profileBytes(identity, ring))).toBe(
      `https://${identity.label}.${UCP_PROFILE_HOST}/webhooks/orders`,
    );
  });

  it('a node that stands down stops taking webhooks; reading its state back at boot keeps it so', async () => {
    installUcpWebhookOrigin('https://node.example');
    expect(ucpOrderWebhookUrl()).toBe('https://node.example/ucp/webhooks/orders');
    await kvSet(
      'publisher',
      JSON.stringify({
        instance: '00000000-0000-4000-8000-000000000099',
        epoch: 3,
        role: 'stood_down',
        fence: 0,
        enabled: true,
        keyRetired: false,
        pendingControl: null,
        status: 'stood_down',
      }),
      'ucp',
    );
    await publisher().state();
    expect(ucpOrderWebhookUrl()).toBeNull();
  });
});

describe('publishing', () => {
  it('a fresh node claims epoch 1, uploads revision 1, and the host serves its exact bytes', async () => {
    const p = publisher();
    expect(await p.publish()).toBe('served');
    expect(rig.label()).toMatchObject({ did: DID, revision: 1, epoch: 1, serving: true });
    expect(rig.label()?.documents[UCP_VERSION]).toBe(await built(p));
    expect(await p.verifyServed()).toBe('served');
  });

  it('the daily re-upload takes the next revision', async () => {
    const p = publisher();
    await p.publish();
    expect(await p.publish()).toBe('served');
    expect(rig.label()?.revision).toBe(2);
  });

  it('re-reads and retries when another upload took the revision first', async () => {
    const p = publisher();
    await p.publish();
    rig.afterStateRead = async () => {
      await p.publish();
    };
    expect(await p.publish()).toBe('served');
    expect(rig.label()?.revision).toBe(3);
  });

  it('reports an unreachable host, and a served copy that differs as stale', async () => {
    const p = publisher();
    rig.down = true;
    expect(await p.publish()).toBe('unreachable');
    rig.down = false;
    await p.publish();
    const s = rig.label() as LabelState;
    rig.store.labels.set(identity.label, {
      ...s,
      documents: { [UCP_VERSION]: '{"tampered":true}' },
    });
    expect(await p.verifyServed()).toBe('stale');
  });

  it('one failed hourly check does not end the checks', async () => {
    const p = publisher();
    await p.publish();
    rig.down = true;
    expect(await p.verifyServed()).toBe('unreachable');
    rig.down = false;
    expect(await p.verifyServed()).toBe('served');
  });

  it('a host that cannot resolve the DID now (503) is temporary: unreachable, then served on the next run', async () => {
    const p = publisher();
    rig.keys.set(DID, 'unavailable');
    expect(await p.publish()).toBe('unreachable');
    expect((await p.state()).status).toBe('unreachable');
    rig.keys.set(DID, ROOT_PUBLIC);
    expect(await p.publish()).toBe('served');
  });

  it('a signature the host rejects (401) is a refusal, not a retry', async () => {
    const p = publisher();
    rig.keys.set(DID, ed25519.getPublicKey(new Uint8Array(32).fill(3)));
    expect(await p.publish()).toBe('refused');
    expect((await p.state()).detail).toBe('invalid');
  });

  it('a fresh node finding its label served by another installation stands down rather than fight', async () => {
    // Here the other installation is another DID's; the node never sends, so the host's label_owned is not reached.
    rig.keys.set(OTHER_DID, ROOT_PUBLIC);
    await publisher(OTHER_DID).publish();
    await kvDelete('publisher', 'ucp');
    const puts = rig.puts();
    expect(await publisher().publish()).toBe('stood_down');
    expect(rig.puts()).toBe(puts);
  });

  it('a vault sealed during a run sends nothing more', async () => {
    const p = publisher();
    await p.publish();
    rig.afterStateRead = async () => {
      installed = null; // sealVault: installUcpIdentity(null)
    };
    const puts = rig.puts();
    await p.publish();
    expect(rig.puts()).toBe(puts);
  });
});

describe('two installations of one identity', () => {
  it('a restored node stands down until the owner activates it; then the old one stands down', async () => {
    const original = publisher();
    await original.publish();
    const originalState = await original.state();
    // A restore on a new device: same seed and label, a new installation (the archive leaves the record out).
    await kvDelete('publisher', 'ucp');
    const restored = publisher();
    expect(await restored.publish()).toBe('stood_down');
    expect(await restored.activate()).toBe('served');
    expect(rig.label()).toMatchObject({ epoch: 2 });
    // The old installation, with its record back, uploads again and is told to stand down.
    await kvSet('publisher', JSON.stringify(originalState), 'ucp');
    expect(await publisher().publish()).toBe('stood_down');
    expect(rig.label()?.epoch).toBe(2);
  });

  it('an upload refused after the owner activated this device cannot stand it down', async () => {
    const p = publisher();
    await p.publish();
    // Between this device's read and its upload, another installation claims epoch 2.
    rig.afterStateRead = async () => {
      const s = rig.label() as LabelState;
      rig.store.labels.set(identity.label, {
        ...s,
        epoch: 2,
        instance: '00000000-0000-4000-8000-0000000000bb',
      });
    };
    // The upload goes out at epoch 1 and is refused (stale_epoch); before the node
    // reads that answer, the owner activates this device (epoch 3, served).
    rig.afterChange = async () => {
      expect(await p.activate()).toBe('served');
    };
    await p.publish();
    // The late refusal is dropped: this device stays active and served.
    expect(await p.state()).toMatchObject({ role: 'active', status: 'served', epoch: 3 });
    expect(rig.label()).toMatchObject({ epoch: 3, serving: true });
  });
});

describe('the owner switch', () => {
  it('turning UCP off pauses serving, retires nothing, and stops later uploads', async () => {
    const p = publisher();
    await p.publish();
    expect(await p.turnOff()).toBe('off');
    expect(rig.label()).toMatchObject({ serving: false, retired: [] });
    const before = rig.requests.length;
    expect(await p.publish()).toBe('off');
    expect(rig.requests.length).toBe(before);
    expect(await p.activate()).toBe('served');
    expect(rig.label()?.serving).toBe(true);
  });

  it('turning UCP off while the host is unreachable stays pending (stopping) and is carried out by a later run', async () => {
    const p = publisher();
    await p.publish();
    rig.down = true;
    expect(await p.turnOff()).toBe('stopping');
    expect(await p.publish()).toBe('stopping');
    expect((await p.state()).pendingControl).toBe('pause');
    rig.down = false;
    expect(await p.publish()).toBe('off');
    expect(rig.label()?.serving).toBe(false);
    expect((await p.state()).pendingControl).toBeNull();
  });

  it('a host outage (503) during "turn off" is temporary too', async () => {
    const p = publisher();
    await p.publish();
    rig.keys.set(DID, 'unavailable');
    expect(await p.turnOff()).toBe('stopping');
    rig.keys.set(DID, ROOT_PUBLIC);
    expect(await p.publish()).toBe('off');
  });

  it('"turn off" on a stood-down device takes effect: it claims the next epoch and pauses', async () => {
    const first = publisher();
    await first.publish();
    await kvDelete('publisher', 'ucp');
    const second = publisher();
    expect(await second.publish()).toBe('stood_down');
    expect(await second.turnOff()).toBe('off');
    expect(rig.label()).toMatchObject({ serving: false, epoch: 2 });
  });

  it('an upload whose fence moved while it ran stops without sending', async () => {
    const p = publisher();
    await p.publish();
    // The owner turns UCP off between the upload's read and its send (the host is down for the pause).
    rig.afterStateRead = async () => {
      rig.down = true;
      await p.turnOff();
      rig.down = false;
    };
    const uploads = () => rig.requests.filter((q) => q.method === 'PUT').length;
    const before = uploads();
    await p.publish();
    expect(uploads()).toBe(before);
    expect(rig.label()?.serving).toBe(true);
    expect((await p.state()).pendingControl).toBe('pause');
  });

  it('"my key may be compromised" retires the key for good, then publishes again under the next generation', async () => {
    const p = publisher();
    await p.publish();
    const old = identity.key.jwk.kid;
    expect(await p.retireKey()).toBe('served');
    expect(rig.label()?.retired).toEqual([old]);
    // Signs with generation 1 at once: no wait (the old key must stop now).
    expect(identity.key.generation).toBe(1);
    expect(rig.label()).toMatchObject({ serving: true, highestGeneration: 1 });
    expect(rig.label()?.documents[UCP_VERSION]).not.toContain(old);
    expect(await p.state()).toMatchObject({ keyRetired: false, keys: { active: 1, retiring: [] } });
  });

  it('"my key may be compromised" while UCP is off retires and stays off; turning it on publishes the next generation', async () => {
    const p = publisher();
    await p.publish();
    await p.turnOff();
    expect(await p.retireKey()).toBe('off');
    expect(rig.label()).toMatchObject({ serving: false, retired: [identity.keyAt(0).jwk.kid] });
    expect(await p.activate()).toBe('served');
    expect(identity.key.generation).toBe(1);
  });

  it('"my key may be compromised" while unreachable is retried until the host confirms', async () => {
    const p = publisher();
    await p.publish();
    rig.down = true;
    expect(await p.retireKey()).toBe('stopping');
    // The key stops signing at once, before the host confirms.
    expect(identity.signingKey()).toBeNull();
    // A later "turn off" does not downgrade the pending retirement.
    expect(await p.turnOff()).toBe('stopping');
    expect((await p.state()).pendingControl).toBe('retire');
    rig.down = false;
    // The "turn off" stands: retired, and off until the owner turns it on.
    expect(await p.publish()).toBe('off');
    expect(rig.label()?.retired).toEqual([identity.keyAt(0).jwk.kid]);
    expect(rig.label()?.serving).toBe(false);
  });
});

describe('the stored record', () => {
  it('a corrupt or wrong-shaped record starts again as a fresh installation', async () => {
    for (const raw of [
      'not json',
      '{"instance":"x","epoch":-1}',
      JSON.stringify({ instance: 5 }),
      // A record without its pending control is not this version's record.
      JSON.stringify({
        instance: '00000000-0000-4000-8000-000000000001',
        epoch: 1,
        role: 'active',
        fence: 0,
        enabled: true,
        keyRetired: false,
        status: 'served',
      }),
    ]) {
      await kvSet('publisher', raw, 'ucp');
      const s = await publisher().state();
      expect(s).toMatchObject({
        epoch: 0,
        role: 'active',
        enabled: true,
        keyRetired: false,
        pendingControl: null,
      });
    }
  });
});
