/**
 * Shared Lane 1 test world: a real SQLCipher identity database with every
 * migration, the A2A store and the SQLite workflow repository on that one
 * connection, a workflow service carrying A2A's decision handler, and a fake
 * host transport serving a remote agent's card.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { a2aLaneFor, type JsonObject } from '@dina/a2a';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  A2AReleaseLog,
  A2AStore,
  a2aWorkflowHooks,
  installA2AReleaseLog,
  activateRemoteAgent,
  bindRemoteSkill,
  createA2ARuntime,
  createNoneCredential,
  registerRemoteAgent,
  installA2A,
  setA2AHostTransport,
  type A2AHttpRequest,
  type A2ARuntime,
} from '../../src/a2a';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { SQLiteWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService, type WorkflowServiceOptions } from '../../src/workflow/service';

import type { WorkflowTask } from '../../src/workflow/domain';

export const CARD_URL = 'https://agent.example/.well-known/agent-card.json';
export const RUNNER_DID = 'did:key:z6MkA2ARunner';
export const LEASE_MS = 30_000;
export const START = 1_800_000_000_000;
/** The owner's chat conversation every proposal in these tests belongs to. */
export const SESSION = 'chat:main';

export function agentCard(over: Record<string, unknown> = {}): JsonObject {
  return {
    name: 'Summarizer',
    description: 'Summarizes and extracts.',
    supportedInterfaces: [{ url: 'https://agent.example/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    version: '1.0.0',
    capabilities: {},
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [
      { id: 'summarize', name: 'Summarize', description: 'Summarize a text.', tags: ['text'] },
      { id: 'extract', name: 'Extract', description: 'Extract fields.', tags: ['data'] },
    ],
    ...over,
  } as JsonObject;
}

export const EXTRACT_SCHEMA = {
  type: 'object',
  required: ['total'],
  additionalProperties: false,
  properties: { total: { type: 'number', minimum: 0 } },
};

export class LaneWorld {
  readonly dir: string;
  db: NodeSQLiteAdapter;
  store: A2AStore;
  repo: SQLiteWorkflowRepository;
  log!: A2AReleaseLog;
  workflow!: WorkflowService;
  runtime!: A2ARuntime;
  clock = START;
  cards = new Map<string, JsonObject>();
  requests: A2AHttpRequest[] = [];

  constructor(options: { withHandler?: boolean; serviceOptions?: Partial<WorkflowServiceOptions> } = {}) {
    this.dir = mkdtempSync(path.join(tmpdir(), 'a2a-lane-'));
    this.db = this.open();
    this.store = new A2AStore(this.db);
    installA2A({ store: this.store, nowMs: () => this.clock });
    this.installLog();
    this.repo = new SQLiteWorkflowRepository(this.db);
    this.useService(options.withHandler ?? true, options.serviceOptions);
    this.cards.set(CARD_URL, agentCard());
    setA2AHostTransport(async (request) => {
      this.requests.push(request);
      const card = this.cards.get(request.url);
      if (card === undefined) return { ok: false, error: 'dns_failed', sent: false };
      return { ok: true, status: 200, body: JSON.stringify(card), connectedAddress: '203.0.113.9' };
    });
  }

  private open(): NodeSQLiteAdapter {
    const db = new NodeSQLiteAdapter({
      path: path.join(this.dir, 'identity.sqlite'),
      passphraseHex: 'ef'.repeat(32),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(db, IDENTITY_MIGRATIONS);
    return db;
  }

  private turns = 0;

  private installLog(): void {
    this.log = new A2AReleaseLog(this.db, () => this.clock);
    installA2AReleaseLog(this.log);
  }

  /** The owner says something in the conversation now: a live turn proposals can belong to. */
  turn(text = 'Please summarize my note for the agent.'): void {
    this.turns += 1;
    this.log.recordUtterance(SESSION, `turn-${this.turns}`, text);
  }

  /**
   * A process restart: close the database and open the same file again, with
   * a fresh store, repository, service and runtime. Nothing in memory survives.
   */
  restart(withHandler = true): void {
    installA2A(null);
    setWorkflowService(null);
    this.db.close();
    this.db = this.open();
    this.store = new A2AStore(this.db);
    installA2A({ store: this.store, nowMs: () => this.clock });
    this.installLog();
    this.repo = new SQLiteWorkflowRepository(this.db);
    this.useService(withHandler);
  }

  /** (Re)build the workflow service, with or without A2A's decision handler. */
  useService(withHandler: boolean, extra: Partial<WorkflowServiceOptions> = {}): void {
    const hooks = a2aWorkflowHooks(() => this.runtime);
    this.workflow = new WorkflowService({
      repository: this.repo,
      nowMsFn: () => this.clock,
      ...(withHandler ? { approvalDecisionHandler: hooks.approvalDecisionHandler } : {}),
      ...extra,
    });
    this.runtime = createA2ARuntime({ store: this.store, workflow: this.workflow, nowMs: () => this.clock });
    setWorkflowService(this.workflow);
  }

  /** Register, credential, bind `summarize` (default envelope) and `extract` (pinned schema), activate. */
  async activeAgent(cardUrl = CARD_URL): Promise<{ agentId: string; credentialRef: string }> {
    const reg = await registerRemoteAgent({ store: this.store, nowMs: () => this.clock }, cardUrl);
    if (!reg.ok) throw new Error(`register: ${reg.reason}`);
    const agentId = reg.agent.agent_id;
    const cred = createNoneCredential({ store: this.store, nowMs: () => this.clock }, agentId);
    if (!cred.ok) throw new Error(`credential: ${cred.reason}`);
    const credentialRef = cred.credential.credential_ref;
    const d = { store: this.store, nowMs: () => this.clock };
    const a = bindRemoteSkill(d, agentId, { skill: 'summarize', actionClass: 'read', credentialRef });
    const b = bindRemoteSkill(d, agentId, { skill: 'extract', actionClass: 'write', credentialRef, resultSchema: EXTRACT_SCHEMA });
    if (!a.ok || !b.ok) throw new Error('bind');
    const act = activateRemoteAgent(d, agentId);
    if (!act.ok) throw new Error(`activate: ${act.reason}`);
    this.turn();
    return { agentId, credentialRef };
  }

  /** Claim the next dispatch child on an agent's lane, as the host runner does. */
  claim(agentId: string, leaseMs = LEASE_MS): WorkflowTask | null {
    return this.repo.claimDelegationTask(RUNNER_DID, this.clock, leaseMs, a2aLaneFor(agentId));
  }

  close(): void {
    setA2AHostTransport(null);
    installA2A(null);
    installA2AReleaseLog(null);
    setWorkflowService(null);
    this.db.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
