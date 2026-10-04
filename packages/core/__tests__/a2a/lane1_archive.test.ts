/**
 * Lane 1 state and the export archive (design §9 Lifecycle, §5.3, A2A-I9):
 * credential secrets, sealed originals and held results never travel in an
 * archive, so a restored node holds none of them, and a persona exported on
 * its own takes none of its sealed spans with it.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { bytesToHex } from '@noble/hashes/utils.js';

import { NodeSQLiteAdapter } from '@dina/storage-node';
import { makeVaultItem } from '@dina/test-harness';

import {
  activateRemoteAgent,
  beginOutboundDispatch,
  bindRemoteSkill,
  createRemoteCredential,
  proposeDelegation,
  recordRemoteOutcome,
  registerRemoteAgent,
} from '../../src/a2a';
import {
  buildArchivePayload,
  createArchive,
  importArchive,
  readManifest,
  setArchiveDataSource,
  type ArchiveDataSource,
} from '../../src/export/archive';
import { registerPersonaDEK, releasePersonaDEK } from '../../src/persona/orchestrator';
import { createPersona, resetPersonaState } from '../../src/persona/service';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS, PERSONA_MIGRATIONS } from '../../src/storage/schemas';
import { clearVaults, getItem, storeItem } from '../../src/vault/crud';
import { SQLiteVaultRepository, setVaultRepository } from '../../src/vault/repository';

import { LaneWorld, RUNNER_DID, SESSION, START, agentCard } from './outbound_fixture';

const PASS = 'archive passphrase for lane one';
const API_KEY = 'KEY-SECRET-7731';
const EMAIL = 'alonso@example.com';
const MAIL = `Write to ${EMAIL} about the booking.`;
const CLINIC = `Clinic email is ${EMAIL} for bookings.`;
const HELD = 'HELD-REMOTE-TEXT-5512';
const KEYED_URL = 'https://keyed.example/.well-known/agent-card.json';

let world: LaneWorld;
let agentId: string;
let dir: string;
const open: NodeSQLiteAdapter[] = [];

function adapter(file: string, migrations: typeof IDENTITY_MIGRATIONS): NodeSQLiteAdapter {
  const a = new NodeSQLiteAdapter({ path: path.join(dir, file), passphraseHex: randomBytes(32).toString('hex'), journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(a, migrations);
  open.push(a);
  return a;
}

function source(identity: NodeSQLiteAdapter | null, personas: Map<string, NodeSQLiteAdapter>): ArchiveDataSource {
  return {
    identityAdapter: () => identity,
    personaSources: async () => [...personas.entries()].map(([name, a]) => ({ name, tier: name === 'general' ? 'default' : 'sensitive', adapter: a })),
    openPersonaForRestore: async (name) => {
      const existing = personas.get(name);
      if (existing !== undefined) return existing;
      const made = adapter(`restored-${name}.sqlite`, PERSONA_MIGRATIONS);
      personas.set(name, made);
      return made;
    },
    hasExistingUserData: async () => false,
  };
}

const op = (operationId: string) => {
  const row = world.store.getTaskByExternal('outbound', 'owner', operationId);
  if (row === null) throw new Error('no operation');
  return row;
};

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'a2a-archive-'));
  clearVaults();
  resetPersonaState();
  createPersona('general', 'default');
  registerPersonaDEK('general', new Uint8Array(randomBytes(32)));
  world = new LaneWorld();
  ({ agentId } = await world.activeAgent());
});

afterEach(() => {
  setArchiveDataSource(null);
  releasePersonaDEK('general');
  resetPersonaState();
  jest.restoreAllMocks();
  world.close();
  for (const a of open.splice(0)) a.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A credential with material, two sealed originals and one held result:
 * everything Lane 1 keeps that must stay home. The general persona's vault
 * is its own SQLite file, so whatever Core writes for the persona lands in
 * the file an export reads.
 */
async function lane1Secrets(): Promise<{ sealed: Uint8Array[]; general: NodeSQLiteAdapter; itemId: string }> {
  const general = adapter('general.sqlite', PERSONA_MIGRATIONS);
  setVaultRepository('general', new SQLiteVaultRepository(general));
  world.cards.set(
    KEYED_URL,
    agentCard({
      supportedInterfaces: [{ url: 'https://keyed.example/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      securitySchemes: { key: { apiKeySecurityScheme: { location: 'header', name: 'X-Api-Key' } } },
      securityRequirements: [{ schemes: { key: { list: [] } } }],
    }),
  );
  const d = { store: world.store, nowMs: () => world.clock };
  const keyed = await registerRemoteAgent(d, KEYED_URL);
  if (!keyed.ok) throw new Error(keyed.reason);
  const credential = createRemoteCredential(d, keyed.agent.agent_id, { kind: 'api_key', scheme: 'key', secret: { value: API_KEY } });
  if (!credential.ok) throw new Error(credential.reason);
  bindRemoteSkill(d, keyed.agent.agent_id, { skill: 'summarize', actionClass: 'read', credentialRef: credential.credential.credential_ref });
  activateRemoteAgent(d, keyed.agent.agent_id);

  // The owner's own words: an original kept in the identity file.
  world.turn(MAIL);
  const fromOwner = proposeDelegation(world.runtime, { agentId, skill: 'summarize', text: MAIL, sources: [{ quote: MAIL, from: 'owner' }], releaseSession: SESSION });
  if (!fromOwner.ok) throw new Error(fromOwner.reason);
  // A vault item saved before the conversation: an original sealed under the persona.
  const item = makeVaultItem({ summary: 'Note', body: CLINIC });
  jest.spyOn(Date, 'now').mockReturnValueOnce(START - 60_000);
  storeItem('general', item);
  getItem('general', item.id, { sessionId: SESSION, audience: 'brain' });
  const fromVault = proposeDelegation(world.runtime, {
    agentId,
    skill: 'summarize',
    text: CLINIC,
    sources: [{ quote: CLINIC, from: 'vault', persona: 'general', item_id: item.id }],
    releaseSession: SESSION,
  });
  if (!fromVault.ok) throw new Error(fromVault.reason);

  // A result held for the guard.
  world.workflow.approve(fromOwner.approvalTaskId);
  const task = world.claim(agentId);
  if (task === null) throw new Error('no claim');
  const claim = { childTaskId: task.id, claimId: task.claim_id as string, runnerDid: RUNNER_DID };
  beginOutboundDispatch(world.runtime, claim);
  recordRemoteOutcome(world.runtime, claim, { kind: 'result', parts: [{ text: HELD }] });
  expect(op(fromOwner.operationId).state).toBe('quarantined');

  const sealed = [op(fromOwner.operationId), op(fromVault.operationId)].flatMap((row) => world.store.entitiesOf(row.id).map((e) => e.sealed));
  expect(world.store.entitiesOf(op(fromOwner.operationId).id).map((e) => e.seal)).toEqual(['identity_db']);
  expect(world.store.entitiesOf(op(fromVault.operationId).id).map((e) => e.seal)).toEqual(['persona_dek']);
  expect(world.db.query('SELECT COUNT(*) AS n FROM a2a_credential_secrets')).toEqual([{ n: 1 }]);
  // The vault item itself is in the persona's own file, and nowhere else.
  expect(general.query('SELECT id FROM vault_items')).toEqual([{ id: item.id }]);
  return { sealed, general, itemId: item.id };
}

/**
 * Every way a Lane 1 secret could show in archive JSON: as text, or as the
 * hex an archive gives a BLOB. The vault item's own body rightly carries
 * EMAIL, so the owner's sealed words are looked for whole.
 */
function leaks(text: string, sealed: Uint8Array[]): string[] {
  const needles = [API_KEY, HELD, MAIL, bytesToHex(new TextEncoder().encode(API_KEY)), ...sealed.map((s) => bytesToHex(s))];
  return needles.filter((n) => text.includes(n));
}

describe('what an archive carries of Lane 1 (design §9 Lifecycle)', () => {
  // Plan X-10, B218
  it('carries no credential secret, no sealed original and no held result, and a restored node holds none of them', async () => {
    const { sealed, general, itemId } = await lane1Secrets();
    // Ordinary owner data beside it, so the restore below really writes.
    world.db.execute('INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)', ['theme', 'dark', 1]);
    setArchiveDataSource(source(world.db, new Map([['general', general]])));
    const archive = await createArchive(PASS);

    const payload = await readManifest(archive, PASS);
    expect(Object.keys(payload.identity.tables).filter((t) => t.startsWith('a2a_') || t.startsWith('workflow_'))).toEqual([]);
    expect(payload.personas[0]?.tables.vault_items?.map((r) => r.id)).toEqual([itemId]);
    expect(leaks(JSON.stringify(payload), sealed)).toEqual([]);

    const target = adapter('restored-identity.sqlite', IDENTITY_MIGRATIONS);
    const restored = new Map<string, NodeSQLiteAdapter>();
    setArchiveDataSource(source(target, restored));
    await importArchive(archive, PASS);
    expect(target.query(`SELECT value FROM kv_store WHERE key = 'theme'`)).toEqual([{ value: 'dark' }]);
    // The persona comes back with its item, and its sealed spans stay behind.
    expect(restored.get('general')?.query('SELECT id, body FROM vault_items')).toEqual([{ id: itemId, body: CLINIC }]);
    for (const table of ['a2a_credential_secrets', 'a2a_entities', 'a2a_remote_credentials', 'a2a_tasks', 'a2a_guard_jobs']) {
      expect(target.query(`SELECT COUNT(*) AS n FROM ${table}`)).toEqual([{ n: 0 }]);
    }
  });

  // Plan X-10
  it('a persona exported on its own takes none of its sealed spans', async () => {
    const { sealed, general, itemId } = await lane1Secrets();
    const payload = await buildArchivePayload(source(null, new Map([['general', general]])));
    expect(payload.identity.tables).toEqual({});
    expect(payload.personas[0]?.tables.vault_items?.map((r) => r.id)).toEqual([itemId]);
    expect(payload.personas.map((p) => Object.keys(p.tables).filter((t) => t.startsWith('a2a_')))).toEqual([[]]);
    expect(leaks(JSON.stringify(payload), sealed)).toEqual([]);
  });
});
