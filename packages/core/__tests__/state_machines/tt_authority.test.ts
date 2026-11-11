/**
 * docs/STATE_MACHINES.md issue 5: authority must not outlive its revoke.
 * TT-02, TT-04, TT-05, TT-15, TT-16, on real SQLCipher files and real routes.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { bytesToHex } from '@noble/hashes/utils.js';

import { NodeSQLiteAdapter } from '../../../storage-node/src/index';
import { requireAgentPersonaAccess, reserveAgentPersonaGrant } from '../../src/agent/access';
import { mintAskAuthority, resolveAskAuthority } from '../../src/agent/ask_authority';
import {
  SQLiteAgentGrantRepository,
  getAgentGrantRepository,
  setAgentGrantRepository,
} from '../../src/agent/grant_repository';
import { isDevice, resetCallerTypeState, setDeviceRoleResolver } from '../../src/auth/caller_type';
import { buildCanonicalPayload, signRequest } from '../../src/auth/canonical';
import { getNonceCache } from '../../src/auth/middleware';
import {
  SQLiteSignedNonceRepository,
  setSignedNonceRepository,
} from '../../src/auth/nonce_repository';
import { addContact, deleteContact } from '../../src/contacts/directory';
import { SQLiteContactRepository, setContactRepository } from '../../src/contacts/repository';
import { getPublicKey, sign } from '../../src/crypto/ed25519';
import {
  getDeviceByDID,
  hydrateDeviceRegistry,
  persistDeviceDurable,
  resetDeviceRegistry,
  revokeDeviceDurable,
} from '../../src/devices/registry';
import { SQLiteDeviceRepository, setDeviceRepository } from '../../src/devices/repository';
import { deriveDIDKey, publicKeyToMultibase } from '../../src/identity/did';
import { SQLiteKVRepository } from '../../src/kv/repository';
import { resetKVStore, setKVRepository } from '../../src/kv/store';
import {
  clearPairingState,
  completePairing,
  generatePairingCode,
  setNodeDID,
} from '../../src/pairing/ceremony';
import { SQLitePeopleRepository, setPeopleRepository } from '../../src/people/repository';
import { createPersona, resetPersonaState } from '../../src/persona/service';
import { createInProcessDispatch } from '../../src/server/in_process_dispatch';
import { CoreRouter } from '../../src/server/router';
import { registerPersonasRoutes } from '../../src/server/routes/personas';
import { applyOwnerWorkflowDecision } from '../../src/server/routes/workflow';
import {
  SQLiteServiceGrantRepository,
  getServiceGrantRepository,
  setServiceGrantRepository,
} from '../../src/service/service_grant_repository';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { SQLiteWorkflowRepository } from '../../src/workflow/repository';
import {
  WorkflowService,
  getWorkflowService,
  setWorkflowService,
} from '../../src/workflow/service';

import type { DatabaseAdapter } from '../../src/storage/db_adapter';

const NODE = 'did:plc:nodeprobe';

function openDb(): DatabaseAdapter {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-authority-'));
  const db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  } as never) as unknown as DatabaseAdapter;
  applyMigrations(db as never, IDENTITY_MIGRATIONS);
  return db;
}

function pair(role: 'cli' | 'agent', key: Uint8Array) {
  const { code } = generatePairingCode({ deviceName: 'x', role });
  return completePairing(code, 'x', publicKeyToMultibase(getPublicKey(key)), role);
}

function newKey(): { key: Uint8Array; did: string } {
  const key = new Uint8Array(randomBytes(32));
  return { key, did: deriveDIDKey(getPublicKey(key)) };
}

let db: DatabaseAdapter;

beforeEach(() => {
  db = openDb();
  resetPersonaState();
  resetDeviceRegistry();
  clearPairingState();
  resetCallerTypeState();
  setNodeDID(NODE);
  createPersona('health', 'sensitive');
  createPersona('general', 'default');
  setAgentGrantRepository(new SQLiteAgentGrantRepository(db));
  setWorkflowService(new WorkflowService({ repository: new SQLiteWorkflowRepository(db) }));
  setDeviceRepository(new SQLiteDeviceRepository(db));
  setKVRepository(new SQLiteKVRepository(db));
  setDeviceRoleResolver((d) => getDeviceByDID(d)?.role ?? null);
});

afterEach(() => {
  setWorkflowService(null as never);
  setAgentGrantRepository(null);
  setDeviceRepository(null);
  setKVRepository(null);
  resetKVStore();
  setSignedNonceRepository(null);
  resetDeviceRegistry();
});

describe('TT-02: a stale approval card', () => {
  async function raiseCardThenRevoke(role: 'cli' | 'agent', sessionId: string | null) {
    const { key, did } = newKey();
    const r = pair(role, key);
    await persistDeviceDurable(r.deviceId);
    const first = requireAgentPersonaAccess({
      agentDID: did,
      persona: 'health',
      mode: 'read',
      scope: 'q',
      sessionId,
    });
    expect(first.kind).toBe('approval_required');
    return { key, did, deviceId: r.deviceId, taskId: (first as { taskId: string }).taskId };
  }

  it('the revoke cancels the card, approve is refused, and a re-paired key asks again', async () => {
    const { key, did, deviceId, taskId } = await raiseCardThenRevoke('cli', null);
    expect((await revokeDeviceDurable(deviceId)).durable).toBe(true);
    expect(getWorkflowService()!.store().getById(taskId)?.status).toBe('cancelled');

    await expect(
      applyOwnerWorkflowDecision(taskId, 'approve', {}, { presenceVerified: true }),
    ).rejects.toThrow();
    expect(getAgentGrantRepository()!.listActiveForAgent(did, Date.now())).toHaveLength(0);

    pair('cli', key);
    const after = requireAgentPersonaAccess({
      agentDID: did,
      persona: 'health',
      mode: 'read',
      scope: 'q2',
      sessionId: null,
    });
    expect(after.kind).toBe('approval_required');
    expect((after as { taskId: string }).taskId).not.toBe(taskId);
  });

  it('a card the cascade missed still mints nothing for a revoked device', async () => {
    const { did, deviceId, taskId } = await raiseCardThenRevoke('cli', null);
    // A revoke that ran with no workflow service wired: the card survives.
    const service = getWorkflowService()!;
    setWorkflowService(null as never);
    await revokeDeviceDurable(deviceId);
    setWorkflowService(service);
    expect(service.store().getById(taskId)?.status).toBe('pending_approval');

    const task = service.store().getById(taskId)!;
    expect(reserveAgentPersonaGrant(task)).toBeNull();
    await expect(
      applyOwnerWorkflowDecision(taskId, 'approve', {}, { presenceVerified: true }),
    ).rejects.toThrow(/revoked/);
    expect(getAgentGrantRepository()!.listActiveForAgent(did, Date.now())).toHaveLength(0);
    expect(service.store().getById(taskId)?.status).toBe('cancelled');
  });

  it('the boot reconciler cancels a card left by a crash inside the cascade', async () => {
    const { deviceId, taskId } = await raiseCardThenRevoke('cli', null);
    const service = getWorkflowService()!;
    setWorkflowService(null as never);
    await revokeDeviceDurable(deviceId);
    setWorkflowService(service);

    resetDeviceRegistry();
    resetCallerTypeState();
    await hydrateDeviceRegistry();
    expect(service.store().getById(taskId)?.status).toBe('cancelled');
  });
});

describe('TT-04: signed request replay', () => {
  function dispatcher() {
    const router = new CoreRouter();
    registerPersonasRoutes(router, { resolveList: () => [] });
    return createInProcessDispatch({ router });
  }

  it('a captured request is refused after a restart inside its window', async () => {
    setSignedNonceRepository(new SQLiteSignedNonceRepository(db));
    const { key, did } = newKey();
    pair('cli', key);
    const dispatch = dispatcher();
    const h = signRequest('GET', '/v1/personas', '', new Uint8Array(0), key, did);
    expect((await dispatch('GET', '/v1/personas', h as never, new Uint8Array(0))).status).toBe(200);
    expect((await dispatch('GET', '/v1/personas', h as never, new Uint8Array(0))).status).toBe(401);
    // What a fresh process starts with: both buffers empty, a new repo object.
    getNonceCache().rotate();
    getNonceCache().rotate();
    setSignedNonceRepository(new SQLiteSignedNonceRepository(db));
    expect((await dispatch('GET', '/v1/personas', h as never, new Uint8Array(0))).status).toBe(401);
  });

  it('a timestamp ahead of the clock cannot outlast the nonce, durable store or not', async () => {
    for (const durable of [true, false]) {
      setSignedNonceRepository(durable ? new SQLiteSignedNonceRepository(db) : null);
      const { key, did } = newKey();
      pair('cli', key);
      const dispatch = dispatcher();
      const T = Date.now();
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
      try {
        jest.setSystemTime(T);
        getNonceCache().rotate();
        jest.setSystemTime(T + 4 * 60_000); // seen 4 min into the buffer's life
        const ts = new Date(T + 8.5 * 60_000).toISOString().replace(/\.\d+Z/, 'Z');
        const nonce = bytesToHex(randomBytes(16));
        const msg = buildCanonicalPayload('GET', '/v1/personas', '', ts, nonce, new Uint8Array(0));
        const headers = {
          'X-DID': did,
          'X-Timestamp': ts,
          'X-Nonce': nonce,
          'X-Signature': bytesToHex(sign(key, new TextEncoder().encode(msg))),
        };
        expect((await dispatch('GET', '/v1/personas', headers, new Uint8Array(0))).status).toBe(
          200,
        );
        // Other traffic rotates the buffers along the way.
        jest.setSystemTime(T + 5 * 60_000 + 1000);
        getNonceCache().check('x1');
        jest.setSystemTime(T + 10 * 60_000 + 2000);
        getNonceCache().check('x2');
        expect((await dispatch('GET', '/v1/personas', headers, new Uint8Array(0))).status).toBe(
          401,
        );
      } finally {
        jest.useRealTimers();
      }
    }
  });

  it('a store that cannot answer refuses the request', async () => {
    setSignedNonceRepository({
      spend: () => {
        throw new Error('SQLITE_BUSY');
      },
    });
    const { key, did } = newKey();
    pair('cli', key);
    const h = signRequest('GET', '/v1/personas', '', new Uint8Array(0), key, did);
    expect((await dispatcher()('GET', '/v1/personas', h as never, new Uint8Array(0))).status).toBe(
      401,
    );
  });

  it('a DID no caller holds writes nothing to the durable store', async () => {
    setSignedNonceRepository(new SQLiteSignedNonceRepository(db));
    const { key, did } = newKey(); // never paired
    const h = signRequest('GET', '/v1/personas', '', new Uint8Array(0), key, did);
    await dispatcher()('GET', '/v1/personas', h as never, new Uint8Array(0));
    expect(db.query('SELECT 1 FROM signed_request_nonces')).toHaveLength(0);
  });

  it('the store forgets a nonce once its timestamp could no longer pass', () => {
    const repo = new SQLiteSignedNonceRepository(db);
    expect(repo.spend('did:a', 'n', 1000, 500)).toBe(true);
    expect(repo.spend('did:a', 'n', 1000, 900)).toBe(false);
    expect(repo.spend('did:b', 'n', 1000, 900)).toBe(true); // scoped to its signer
    expect(repo.spend('did:a', 'n', 3000, 2000)).toBe(true); // its hold ended
    expect(repo.purgeExpired(5000)).toBe(2);
  });
});

describe('TT-05: a service grant dies with the contact', () => {
  it('deleting the contact revokes the grant', () => {
    setPeopleRepository(new SQLitePeopleRepository(db));
    setContactRepository(new SQLiteContactRepository(db));
    setServiceGrantRepository(new SQLiteServiceGrantRepository(db));
    try {
      const X = 'did:plc:exfriend';
      const OTHER = 'did:a2a:client';
      addContact(X, 'Ex', 'verified');
      const grants = getServiceGrantRepository()!;
      grants.create({
        grantId: 'g1',
        granteeDid: X,
        serviceRkey: 'rk',
        capability: 'availability',
        grantType: 'standing',
        createdAt: 1,
      });
      grants.create({
        grantId: 'g2',
        granteeDid: OTHER,
        serviceRkey: 'rk',
        capability: 'availability',
        grantType: 'standing',
        createdAt: 1,
      });
      expect(deleteContact(X)).toBe(true);
      const nowSec = Math.floor(Date.now() / 1000);
      expect(
        grants.isAuthorized({
          granteeDid: X,
          serviceRkey: 'rk',
          capability: 'availability',
          nowSec,
        }),
      ).toBe(false);
      // Someone else's grant in the same table stays.
      expect(
        grants.isAuthorized({
          granteeDid: OTHER,
          serviceRkey: 'rk',
          capability: 'availability',
          nowSec,
        }),
      ).toBe(true);
    } finally {
      setServiceGrantRepository(null);
      setPeopleRepository(null);
      setContactRepository(null);
    }
  });

  it('a grant revoke that fails leaves the contact in place to retry', () => {
    setPeopleRepository(new SQLitePeopleRepository(db));
    setContactRepository(new SQLiteContactRepository(db));
    setServiceGrantRepository({
      revokeAllForGrantee: () => {
        throw new Error('SQLITE_BUSY');
      },
    } as never);
    try {
      addContact('did:plc:y', 'Y', 'verified');
      expect(() => deleteContact('did:plc:y')).toThrow('SQLITE_BUSY');
    } finally {
      setServiceGrantRepository(null);
      setPeopleRepository(null);
      setContactRepository(null);
    }
  });
});

describe('TT-15: a failed revoke survives a restart', () => {
  async function pairThenFailRevoke() {
    const { key, did } = newKey();
    const r = pair('cli', key);
    await persistDeviceDurable(r.deviceId);
    const real = new SQLiteDeviceRepository(db);
    setDeviceRepository({
      register: (d: never) => real.register(d),
      list: () => real.list(),
      revoke: async () => {
        throw new Error('SQLITE_BUSY');
      },
    } as never);
    const rev = await revokeDeviceDurable(r.deviceId);
    expect(rev.durable).toBe(false);
    expect(isDevice(did)).toBe(false);
    return { key, did, deviceId: r.deviceId, real };
  }

  it('the next boot finishes the revoke', async () => {
    const { did, real } = await pairThenFailRevoke();
    resetDeviceRegistry();
    resetCallerTypeState();
    setDeviceRepository(real); // restart, SQL healthy again
    await hydrateDeviceRegistry();
    expect(isDevice(did)).toBe(false);
    expect(getDeviceByDID(did)?.revoked).toBe(true);
    expect((await real.list()).find((d) => d.did === did)?.revoked).toBe(true);

    // Done for good: a later boot has no marker left to act on.
    resetDeviceRegistry();
    resetCallerTypeState();
    await hydrateDeviceRegistry();
    expect(getDeviceByDID(did)?.revoked).toBe(true);
  });

  it('stays cut when SQL is still failing at the next boot', async () => {
    const { did } = await pairThenFailRevoke();
    resetDeviceRegistry();
    resetCallerTypeState();
    await hydrateDeviceRegistry();
    expect(isDevice(did)).toBe(false);
    expect(getDeviceByDID(did)?.revoked).toBe(true);
  });

  it('retries in-process, and an owner re-pair cancels the retry', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    try {
      const { did, deviceId, real } = await pairThenFailRevoke();
      setDeviceRepository(real);
      await jest.advanceTimersByTimeAsync(61_000);
      expect((await real.list()).find((d) => d.deviceId === deviceId)?.revoked).toBe(true);
      expect(getDeviceByDID(did)?.revoked).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a re-pair after the failed revoke is not undone by the marker', async () => {
    const { key, did, real } = await pairThenFailRevoke();
    setDeviceRepository(real);
    pair('cli', key);
    await new Promise((r) => setImmediate(r));
    resetDeviceRegistry();
    resetCallerTypeState();
    await hydrateDeviceRegistry();
    expect(getDeviceByDID(did)?.revoked).toBe(false);
    expect(isDevice(did)).toBe(true);
  });
});

describe('TT-16: an ask authority dies with its device', () => {
  it('a session-less device loses it on revoke, and a re-pair does not bring it back', async () => {
    const { key, did } = newKey();
    const r = pair('cli', key);
    await persistDeviceDurable(r.deviceId);
    const a = mintAskAuthority({ requesterDid: did, sessionId: null });
    const other = mintAskAuthority({ requesterDid: 'did:key:zSomeoneElse', sessionId: null });
    await revokeDeviceDurable(r.deviceId);
    expect(resolveAskAuthority(a.id)).toBeNull();
    expect(resolveAskAuthority(other.id)).not.toBeNull();
    pair('cli', key);
    expect(resolveAskAuthority(a.id)).toBeNull();
  });
});
