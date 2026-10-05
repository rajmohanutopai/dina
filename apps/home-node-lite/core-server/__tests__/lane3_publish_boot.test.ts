/**
 * Where the card publisher lives (design §8.2 "publisher placement";
 * notes iteration "M5 steps 1–2", revised by the dual review's CX-4):
 * started whenever the node has a PDS, stopped on close. Without a card
 * configuration it runs only to take down a card published earlier
 * ("predicate-false always drives an unpublish"), and the owner's
 * activation answers 503; without a PDS there is none. A boot with both
 * installs it for the owner's ceremonies, and close stops it and leaves
 * neither it nor the card configuration behind. The fence and the card's envelope are signed with
 * the `dina_signing` key boot names in the DID document (plan §3.22). The
 * PDS write authority stays in core-server: neither Brain's server nor the
 * phone constructs a PDS writer or installs a card publisher. Boots with a
 * PDS load its identity from disk and reach the PDS and PLC only through a
 * faked global fetch.
 */

import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  A2A_CARD_COLLECTION,
  A2A_FENCE_COLLECTION,
  p256FromMultikey,
  readCardRecordFacts,
  readCardRecordText,
  verifyAgentCardSignatures,
  verifyDirectoryEnvelope,
  verifyFence,
} from '@dina/a2a';
import {
  deriveRotationKey,
  getA2ACardConfig,
  getA2APublisher,
  getPublicKey,
  installA2APublisher,
  multibaseToPublicKey,
  resetServiceConfigState,
  secp256k1ToDidKeyMultibase,
  setServiceConfigDurable,
  validateServiceConfigForSave,
  verify,
  type CoreRequest,
  type ServiceConfig,
} from '@dina/core';
import { resetCallerTypeState, resetMiddlewareState } from '@dina/core/runtime';

import { A2ACardPublisher } from '../src/appview/a2a_card_publisher';
import { bootServer } from '../src/boot';

import { WirePds } from './lane3_publish_fixture';

const CAP = 'owner-capability-for-lane3-tests';
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const PLC_URL = 'https://plc.example';
const PDS_IDENTITY = {
  did: 'did:plc:nodeaaaaaaaaaaaaaaaaaaaa',
  handle: 'node.example',
  password: 'pw',
  email: 'n@example.org',
  pdsUrl: 'https://pds.example',
};

/** A public listing with one skill the card projects: answered by Brain from its instruction. */
const listing = (): ServiceConfig => ({
  isDiscoverable: true,
  discoverability: 'public',
  status: 'active',
  name: 'Bus 42',
  capabilities: { eta_query: { instruction: 'Give the next arrival time.', responsePolicy: 'auto', category: 'transit' } },
  capabilitySchemas: {
    eta_query: {
      params: { type: 'object', required: ['route_id'], properties: { route_id: { type: 'string', minLength: 1 } } },
      result: { type: 'object', required: ['eta_minutes'], properties: { eta_minutes: { type: 'integer' } } },
      schemaHash: 'h-eta',
    },
  },
});

describe('boot', () => {
  const originalEnv = { ...process.env };
  let dir: string;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), 'lane3-boot-'));
    process.env['DINA_VAULT_DIR'] = dir;
    process.env['DINA_CORE_HOST'] = '127.0.0.1';
    process.env['DINA_CORE_PORT'] = '0';
    process.env['DINA_LOG_LEVEL'] = 'silent';
    process.env['DINA_MSGBOX_ENABLED'] = 'false';
    process.env['DINA_OWNER_CAPABILITY'] = CAP;
    process.env['DINA_A2A_PUBLIC_URL'] = 'https://dina.example.org';
    process.env['DINA_A2A_GATEWAY_DID'] = 'did:key:z6MkLane3Gateway';
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
    for (const [k, v] of Object.entries(originalEnv)) {
      if (typeof v === 'string') process.env[k] = v;
    }
    installA2APublisher(null);
    resetMiddlewareState();
    resetCallerTypeState();
    jest.restoreAllMocks();
  });

  const owner = (path: string, body: unknown = {}): CoreRequest =>
    ({
      method: 'POST',
      path,
      query: {},
      headers: {},
      body,
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'owner',
      ownerCapability: CAP,
    }) as unknown as CoreRequest;

  // Plan E160 and E161 (the no-PDS half)
  it('a card configuration without a PDS starts no publisher: the switch works, activation answers 503, and close leaves nothing installed', async () => {
    const booted = await bootServer();
    try {
      expect(getA2ACardConfig()).not.toBeNull();
      expect(getA2APublisher()).toBeNull();
      const on = await booted.coreRouter.handle(owner('/v1/owner/a2a/directory-listing', { enabled: true }));
      expect(on.status).toBe(200);
      const activate = await booted.coreRouter.handle(owner('/v1/owner/a2a/publisher/activate'));
      expect(activate).toEqual(expect.objectContaining({ status: 503, body: { error: 'publisher_unavailable' } }));
      const deactivate = await booted.coreRouter.handle(owner('/v1/owner/a2a/publisher/deactivate'));
      expect(deactivate.status).toBe(503);
      // Whatever a host installed, close takes it down with the card configuration.
      installA2APublisher({ activate: async () => ({ ok: true, epoch: 1 }), deactivate: async () => ({ ok: true }), nudge: () => undefined });
    } finally {
      await booted.app.close();
    }
    expect(getA2APublisher()).toBeNull();
    expect(getA2ACardConfig()).toBeNull();
  }, 60_000);

  /** A PDS identity on disk, so boot loads it with no network call. */
  const withPdsIdentity = (dinaUpdateApplied: boolean) => {
    writeFileSync(join(dir, 'pds_identity.json'), JSON.stringify({ ...PDS_IDENTITY, dinaUpdateApplied }));
    process.env['DINA_PDS_PROVISION'] = '1';
    process.env['DINA_PDS_HANDLE'] = PDS_IDENTITY.handle;
    process.env['DINA_PDS_URL'] = PDS_IDENTITY.pdsUrl;
    process.env['DINA_PLC_URL'] = PLC_URL;
  };

  // Plan E160 and E161 (the PDS half)
  it('a card configuration with a PDS installs one publisher, the owner’s activation reaches it, and close stops it and takes it down', async () => {
    withPdsIdentity(true);
    const calls: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      // The PLC directory answers: the document names no card key yet, so the card key ring
      // starts at generation 0 and the card can be built (UCP plan §4.8). The PDS is down.
      if (url === `${PLC_URL}/${PDS_IDENTITY.did}/log/audit`)
        return new Response(
          JSON.stringify([{ operation: { type: 'plc_operation', verificationMethods: { atproto: 'did:key:zQ3shatproto' } } }]),
          { status: 200 },
        );
      return new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 });
    });
    const start = jest.spyOn(A2ACardPublisher.prototype, 'start');
    const stop = jest.spyOn(A2ACardPublisher.prototype, 'stop');
    const booted = await bootServer();
    let installed: unknown = null;
    try {
      installed = getA2APublisher();
      expect(installed).toBeInstanceOf(A2ACardPublisher);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.contexts[0]).toBe(installed);
      expect(stop).not.toHaveBeenCalled();
      // The route that answered 503 without a PDS now reaches the publisher, which finds the repository down.
      const on = await booted.coreRouter.handle(owner('/v1/owner/a2a/directory-listing', { enabled: true }));
      expect(on.status).toBe(200);
      const activate = await booted.coreRouter.handle(owner('/v1/owner/a2a/publisher/activate'));
      expect(activate).toEqual(expect.objectContaining({ status: 409, body: { error: 'repo_unreachable' } }));
      expect(calls.some((u) => u.startsWith(`${PDS_IDENTITY.pdsUrl}/xrpc/`))).toBe(true);
    } finally {
      await booted.app.close();
    }
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop.mock.contexts[0]).toBe(installed);
    expect(getA2APublisher()).toBeNull();
    expect(getA2ACardConfig()).toBeNull();
  }, 60_000);

  // Plan E160 (the card-configuration half); cold audit C4-6: the refusal names its real cause
  it('a PDS without a card configuration runs the publisher for cleanup only: activation answers that there is no card to publish', async () => {
    withPdsIdentity(true);
    Reflect.deleteProperty(process.env, 'DINA_A2A_PUBLIC_URL');
    Reflect.deleteProperty(process.env, 'DINA_A2A_GATEWAY_DID');
    const calls: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return new Response('{}', { status: 503 });
    });
    const start = jest.spyOn(A2ACardPublisher.prototype, 'start');
    const stop = jest.spyOn(A2ACardPublisher.prototype, 'stop');
    const booted = await bootServer();
    try {
      expect(getA2ACardConfig()).toBeNull();
      expect(getA2APublisher()).not.toBeNull();
      expect(start).toHaveBeenCalledTimes(1);
      const activate = await booted.coreRouter.handle(owner('/v1/owner/a2a/publisher/activate'));
      expect(activate).toEqual(expect.objectContaining({ status: 409, body: { error: 'not_configured' } }));
      // A node that never published has nothing to clean up: its publisher reads Core, never the repository.
      await (start.mock.contexts[0] as A2ACardPublisher).flush();
      expect(calls.filter((u) => u.includes('a2a'))).toEqual([]);
    } finally {
      await booted.app.close();
    }
    expect(stop).toHaveBeenCalledTimes(1);
  }, 60_000);

  // Codex review CX-4 (design §8.2: "predicate-false always drives an unpublish", gateway disable among the cases)
  it('a card published under a gateway is taken down after a restart with the gateway removed; the fence stays', async () => {
    withPdsIdentity(false);
    const seed = new Uint8Array(32).fill(12);
    writeFileSync(join(dir, 'keyfile'), seed, { mode: 0o600 });
    chmodSync(join(dir, 'keyfile'), 0o600);
    const pds = new WirePds();
    // The PLC directory as in the test above: boot and the card key check post to it and read its log.
    const plcLog: { operation: Record<string, unknown> }[] = [
      {
        operation: {
          type: 'plc_operation',
          rotationKeys: [`did:key:${secp256k1ToDidKeyMultibase(deriveRotationKey(seed, 0).publicKey)}`],
          verificationMethods: { atproto: 'did:key:zQ3shatproto' },
          services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: PDS_IDENTITY.pdsUrl } },
          alsoKnownAs: [`at://${PDS_IDENTITY.handle}`],
          prev: null,
          sig: 'sig',
        },
      },
    ];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(`${PDS_IDENTITY.pdsUrl}/xrpc/`)) return pds.fetch(input, init);
      if (url === `${PLC_URL}/${PDS_IDENTITY.did}/log/audit`) return new Response(JSON.stringify(plcLog), { status: 200 });
      if (url === `${PLC_URL}/${PDS_IDENTITY.did}` && init?.method === 'POST') {
        plcLog.push({ operation: JSON.parse(String(init.body)) as Record<string, unknown> });
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 503 });
    });
    const card = `${A2A_CARD_COLLECTION}/self`;
    const fence = `${A2A_FENCE_COLLECTION}/self`;
    // 1. With a gateway: the owner lists the node and activates; the card goes out.
    const first = await bootServer();
    try {
      await setServiceConfigDurable(listing(), 'self');
      expect((await first.coreRouter.handle(owner('/v1/owner/a2a/directory-listing', { enabled: true }))).status).toBe(200);
      expect((await first.coreRouter.handle(owner('/v1/owner/a2a/publisher/activate'))).status).toBe(200);
      await (getA2APublisher() as A2ACardPublisher).flush();
      expect(pds.records.has(card)).toBe(true);
      expect(pds.records.has(fence)).toBe(true);
    } finally {
      await first.app.close();
      resetServiceConfigState();
    }
    const fenceBefore = pds.records.get(fence);
    // 2. The operator removes the gateway and restarts.
    Reflect.deleteProperty(process.env, 'DINA_A2A_PUBLIC_URL');
    Reflect.deleteProperty(process.env, 'DINA_A2A_GATEWAY_DID');
    const start = jest.spyOn(A2ACardPublisher.prototype, 'start');
    const second = await bootServer();
    try {
      expect(getA2ACardConfig()).toBeNull();
      await (start.mock.contexts[0] as A2ACardPublisher).flush();
      // The card is gone; the fence that says who holds the repository is not.
      expect(pds.records.has(card)).toBe(false);
      expect(pds.records.get(fence)).toEqual(fenceBefore);
      const view = await second.coreRouter.handle({ ...owner('/v1/owner/a2a/publisher'), method: 'GET' } as CoreRequest);
      // Still active, and no longer eligible: a gateway configured again puts the card back.
      expect(view.body).toEqual(expect.objectContaining({ state: 'not_published', active: true, eligible: false }));
    } finally {
      await second.app.close();
      resetServiceConfigState();
    }
  }, 60_000);

  // Plan E163
  it('the fence and the card’s directory envelope are signed with the dina_signing key boot put in the DID document', async () => {
    withPdsIdentity(false); // boot posts the Dina additions to the PLC document
    // A known seed, so the fake directory can name the rotation key boot signs with.
    const seed = new Uint8Array(32).fill(11);
    writeFileSync(join(dir, 'keyfile'), seed, { mode: 0o600 });
    chmodSync(join(dir, 'keyfile'), 0o600);
    const pds = new WirePds();
    const plcLog: { operation: Record<string, unknown> }[] = [
      {
        operation: {
          type: 'plc_operation',
          rotationKeys: [`did:key:${secp256k1ToDidKeyMultibase(deriveRotationKey(seed, 0).publicKey)}`],
          verificationMethods: { atproto: 'did:key:zQ3shatproto' },
          services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: PDS_IDENTITY.pdsUrl } },
          alsoKnownAs: [`at://${PDS_IDENTITY.handle}`],
          prev: null,
          sig: 'sig',
        },
      },
    ];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(`${PDS_IDENTITY.pdsUrl}/xrpc/`)) return pds.fetch(input, init);
      if (url === `${PLC_URL}/${PDS_IDENTITY.did}/log/audit`) return new Response(JSON.stringify(plcLog), { status: 200 });
      if (url === `${PLC_URL}/${PDS_IDENTITY.did}` && init?.method === 'POST') {
        plcLog.push({ operation: JSON.parse(String(init.body)) as Record<string, unknown> });
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 503 });
    });
    const booted = await bootServer();
    try {
      // What the DID document names as dina_signing, as boot posted it.
      const named = (plcLog[1]?.operation.verificationMethods as Record<string, string> | undefined)?.dina_signing ?? '';
      expect(named.startsWith('did:key:z6Mk')).toBe(true);
      const dinaSigning = multibaseToPublicKey(named.slice('did:key:'.length));
      const config = listing();
      expect(validateServiceConfigForSave(config).ok).toBe(true);
      await setServiceConfigDurable(config, 'self');
      expect((await booted.coreRouter.handle(owner('/v1/owner/a2a/directory-listing', { enabled: true }))).status).toBe(200);
      expect((await booted.coreRouter.handle(owner('/v1/owner/a2a/publisher/activate'))).status).toBe(200);
      await (getA2APublisher() as A2ACardPublisher).flush();

      const fence = pds.records.get(`${A2A_FENCE_COLLECTION}/self`)?.value;
      const card = pds.records.get(`${A2A_CARD_COLLECTION}/self`)?.value;
      expect(fence).toBeDefined();
      expect(card).toBeDefined();
      // The document as it stands now, with the card key added, still names that dina_signing key.
      const latest = plcLog.at(-1)?.operation.verificationMethods as Record<string, string> | undefined;
      expect(latest?.dina_signing).toBe(named);
      // The card verifies under the card key the document names: boot put in the key that signs the card.
      const cardKey = p256FromMultikey((latest?.a2a_card ?? '').slice('did:key:'.length));
      if (cardKey === null) throw new Error('the document names no P-256 card key');
      const report = await verifyAgentCardSignatures(JSON.parse(card?.card as string) as Record<string, unknown>, ({ signingInputs, signature }) =>
        signingInputs.some((input) => p256.verify(signature, input, cardKey)),
      );
      expect(report.state).toBe('verified');
      // Cold audit C4-9: the record as it went out passes the directory's own record rules (shared in @dina/a2a):
      // exactly the published members, the card's canonical text, its extension naming this repository's DID,
      // and endpoint, protocol version and skills that agree with the card.
      const text = readCardRecordText({ $type: A2A_CARD_COLLECTION, ...card });
      if (!text.ok) throw new Error(`record refused: ${text.reason}`);
      expect(readCardRecordFacts(text.card, text.record, PDS_IDENTITY.did)).toEqual(
        expect.objectContaining({ ok: true, skillIds: ['eta_query@self'] }),
      );
      const { $type: _type, ...fenceBody } = fence ?? {};
      const fenceUnder = (key: Uint8Array) => verifyFence(fenceBody, PDS_IDENTITY.did, (m, sig) => verify(key, m, sig)).ok;
      const envelopeUnder = (key: Uint8Array) =>
        verifyDirectoryEnvelope(
          card?.directory_envelope,
          { repoDid: PDS_IDENTITY.did, collection: A2A_CARD_COLLECTION, rkey: 'self', cardText: card?.card as string },
          (b) => sha256(b),
          (m, sig) => verify(key, m, sig),
        ).ok;
      expect(fenceUnder(dinaSigning)).toBe(true);
      expect(envelopeUnder(dinaSigning)).toBe(true);
      // Control: under any other Ed25519 key neither verifies.
      const other = getPublicKey(new Uint8Array(32).fill(3));
      expect(fenceUnder(other)).toBe(false);
      expect(envelopeUnder(other)).toBe(false);
    } finally {
      await booted.app.close();
      resetServiceConfigState();
    }
  }, 60_000);
});

/** Every .ts and .tsx source file under a directory, tests and builds left out. */
function sources(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === '__tests__' || name === 'dist' || name.startsWith('.')) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

const offenders = (root: string, pattern: RegExp) =>
  sources(join(REPO_ROOT, root))
    .filter((f) => pattern.test(readFileSync(f, 'utf8')))
    .map((f) => relative(REPO_ROOT, f));

describe('placement', () => {
  // Plan E43
  it('Brain’s server builds no PDS writer and no card publisher: it cannot write the card behind Core', () => {
    // No PDS client, no PDS credentials, no card publisher.
    const pdsWriter = /new PDSPublisher\b|DINA_PDS_|pds_identity\.json|com\.atproto\.repo\.putRecord|A2ACardPublisher|installA2APublisher|cardRepoOverPds/;
    expect(offenders('apps/home-node-lite/brain-server/src', pdsWriter)).toEqual([]);
  });

  // Plan E44
  it('publishing is server-only: core-server’s boot is the one place a card publisher is installed', () => {
    // A call that installs something: not the definition, not an uninstall.
    const installs = /(?<!function )installA2APublisher\(\s*(?!null\s*\))\S/;
    // The pattern catches an install with any argument, an object literal too; it skips the uninstall and the definition.
    expect(installs.test('installA2APublisher({ activate, deactivate, nudge });')).toBe(true);
    expect(installs.test('installA2APublisher(\n  publisher,\n);')).toBe(true);
    expect(installs.test('installA2APublisher(null);')).toBe(false);
    expect(installs.test('export function installA2APublisher(port: A2APublisherPort | null): void {')).toBe(false);
    const installers = [...offenders('apps', installs), ...offenders('packages', installs)];
    expect(installers).toEqual(['apps/home-node-lite/core-server/src/boot.ts']);
    expect(offenders('apps/mobile', /installA2APublisher|A2ACardPublisher/)).toEqual([]);
  });
});
