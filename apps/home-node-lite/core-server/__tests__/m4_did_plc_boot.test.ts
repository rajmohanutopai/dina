/**
 * M4 DID credentials on the server (design §5.1; notes M4 step 1:
 * "core-server's DID resolver"). A boot with Lane 2 configured installs
 * D2D's uncached lookup as the A2A resolver, so a client binds a did:plc
 * whose document the directory serves: Core reads the document's Ed25519
 * key and checks the signature against it. A boot without Lane 2 installs
 * none, and the same binding is did_unresolvable.
 *
 * No directory is reached: `fetch` is replaced before boot, and the
 * resolver takes it at construction. The PLC URL is the built-in
 * plc.directory, which is also the configured one while DINA_PLC_URL is
 * unset (notes, open question "M4: which PLC directory").
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bytesToHex } from '@noble/hashes/utils.js';

import { A2A_DID_BINDING_PATH, A2A_DID_COMPLETE_ROUTE, didBindingSigningInput } from '@dina/a2a';
import { getA2ADidResolver, getPublicKey, installA2ADidResolver, publicKeyToMultibase, sign, type CoreRequest } from '@dina/core';
import { resetCallerTypeState, resetMiddlewareState } from '@dina/core/runtime';

import { bootServer } from '../src/boot';

const CAP = 'owner-capability-for-m4-plc-tests';
const GATEWAY_DID = 'did:key:z6MkM4PlcBootGateway';
const PLC_DID = 'did:plc:mfourbindtestclientabcde';
const PLC_URL = `https://plc.directory/${PLC_DID}`;

const keyOf = (n: number) => {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, publicKey: getPublicKey(privateKey) };
};
/** The key the DID's document names `#dina_signing`. */
const CLIENT_KEY = keyOf(61);
/** A key the document does not hold. */
const OTHER_KEY = keyOf(62);

/** A document as PLC serves it: no `authentication` member, a secp256k1 `#atproto` key beside the Ed25519 one. */
const PLC_DOCUMENT = {
  '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
  id: PLC_DID,
  alsoKnownAs: ['at://m4-client.example'],
  verificationMethod: [
    {
      id: `${PLC_DID}#atproto`,
      type: 'Multikey',
      controller: PLC_DID,
      publicKeyMultibase: 'zQ3shXjHeiBuRCKmM36cuYnm7YEMzhGnCmCyW92sRJ9pribSF',
    },
    {
      id: `${PLC_DID}#dina_signing`,
      type: 'Multikey',
      controller: PLC_DID,
      publicKeyMultibase: publicKeyToMultibase(CLIENT_KEY.publicKey),
    },
  ],
  service: [],
};

const urlOf = (input: unknown): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

describe('a did:plc binding through the booted server (§5.1, plan D33)', () => {
  const originalEnv = { ...process.env };
  let dir: string;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // The directory, before boot: PLC answers this one DID; anything else gets a 503.
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      urlOf(input) === PLC_URL
        ? new Response(JSON.stringify(PLC_DOCUMENT), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('{}', { status: 503 }),
    );
    dir = mkdtempSync(join(tmpdir(), 'm4-plc-boot-'));
    process.env['DINA_VAULT_DIR'] = dir;
    process.env['DINA_CORE_HOST'] = '127.0.0.1';
    process.env['DINA_CORE_PORT'] = '0';
    process.env['DINA_LOG_LEVEL'] = 'silent';
    process.env['DINA_MSGBOX_ENABLED'] = 'false';
    process.env['DINA_OWNER_CAPABILITY'] = CAP;
    Reflect.deleteProperty(process.env, 'DINA_PLC_URL');
    Reflect.deleteProperty(process.env, 'DINA_A2A_PUBLIC_URL');
    Reflect.deleteProperty(process.env, 'DINA_A2A_GATEWAY_DID');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
    for (const [k, v] of Object.entries(originalEnv)) {
      if (typeof v === 'string') process.env[k] = v;
    }
    // A test that failed before its close still leaves the next one none.
    installA2ADidResolver(null);
    resetMiddlewareState();
    resetCallerTypeState();
    jest.restoreAllMocks();
  });

  const lane2 = () => {
    process.env['DINA_A2A_PUBLIC_URL'] = 'https://dina.example.org';
    process.env['DINA_A2A_GATEWAY_DID'] = GATEWAY_DID;
  };

  const owner = (path: string, body: unknown = {}, method = 'POST'): CoreRequest =>
    ({
      method,
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

  /** The gateway's forward of the client's binding request: the body as sent, no credential. */
  const fromGateway = (body: string): CoreRequest => {
    const envelope = { request: { method: 'POST', path: A2A_DID_BINDING_PATH, query: '', body }, client_auth: {} };
    return {
      method: 'POST',
      path: A2A_DID_COMPLETE_ROUTE,
      query: {},
      headers: {},
      body: envelope,
      rawBody: new TextEncoder().encode(JSON.stringify(envelope)),
      params: {},
      trustedInProcess: true,
      callerType: 'gateway',
      callerDID: GATEWAY_DID,
    } as unknown as CoreRequest;
  };

  type Booted = Awaited<ReturnType<typeof bootServer>>;

  /** A new client, a challenge for PLC_DID, and the binding body signed with `key`. */
  async function bindingBody(booted: Booted, key: ReturnType<typeof keyOf>): Promise<{ clientId: string; body: string }> {
    const made = await booted.coreRouter.handle(owner('/v1/owner/a2a/clients', { display_name: 'PLC agent' }));
    expect(made.status).toBe(201);
    const clientId = (made.body as { client: { client_id: string } }).client.client_id;
    const issued = await booted.coreRouter.handle(owner(`/v1/owner/a2a/clients/${clientId}/did-challenge`, { did: PLC_DID }));
    expect(issued.status).toBe(201);
    const { challenge, node_did: nodeDid } = issued.body as { challenge: string; node_did: string };
    const input = didBindingSigningInput({ nodeDid, clientId, did: PLC_DID, challenge });
    const signature = bytesToHex(sign(key.privateKey, new TextEncoder().encode(input)));
    return { clientId, body: JSON.stringify({ did: PLC_DID, challenge, signature }) };
  }

  async function boundDidOf(booted: Booted, clientId: string): Promise<string | null | undefined> {
    const listed = await booted.coreRouter.handle(owner('/v1/owner/a2a/clients', undefined, 'GET'));
    const clients = (listed.body as { clients: { client_id: string; bound_did: string | null }[] }).clients;
    return clients.find((c) => c.client_id === clientId)?.bound_did;
  }

  const plcFetches = () => fetchSpy.mock.calls.map((c) => urlOf(c[0])).filter((u) => u.startsWith('https://plc.directory/'));

  it('closing the server takes its DID lookup down with the rest of Lane 2', async () => {
    lane2();
    const booted = await bootServer();
    expect(getA2ADidResolver()).not.toBeNull();
    await booted.app.close();
    expect(getA2ADidResolver()).toBeNull();
  });

  it('with Lane 2 configured, binds a did:plc through the directory’s document, looked up afresh each time', async () => {
    lane2();
    const booted = await bootServer();
    try {
      // Signed with a key the document does not hold: refused, and nothing is bound.
      const wrong = await bindingBody(booted, OTHER_KEY);
      expect(await booted.coreRouter.handle(fromGateway(wrong.body))).toEqual(
        expect.objectContaining({ status: 403, body: { error: 'signature_invalid' } }),
      );
      expect(await boundDidOf(booted, wrong.clientId)).toBeNull();
      expect(plcFetches()).toEqual([PLC_URL]);
      // Signed with the document's #dina_signing key: bound.
      const right = await bindingBody(booted, CLIENT_KEY);
      const bound = await booted.coreRouter.handle(fromGateway(right.body));
      expect(bound.status).toBe(200);
      expect(bound.body).toEqual(expect.objectContaining({ client_id: right.clientId, did: PLC_DID }));
      expect(await boundDidOf(booted, right.clientId)).toBe(PLC_DID);
      // No cache: the second binding asked the directory again.
      expect(plcFetches()).toEqual([PLC_URL, PLC_URL]);
    } finally {
      await booted.app.close();
    }
  }, 60_000);

  it('without Lane 2, installs no resolver: the same signed binding is did_unresolvable, and the directory is never asked', async () => {
    const booted = await bootServer();
    try {
      const { clientId, body } = await bindingBody(booted, CLIENT_KEY);
      expect(await booted.coreRouter.handle(fromGateway(body))).toEqual(
        expect.objectContaining({ status: 400, body: { error: 'did_unresolvable' } }),
      );
      expect(await boundDidOf(booted, clientId)).toBeNull();
      expect(plcFetches()).toEqual([]);
    } finally {
      await booted.app.close();
    }
  }, 60_000);
});
