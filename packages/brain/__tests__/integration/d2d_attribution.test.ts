/**
 * PH-S13 (docs/STATE_MACHINES.md): a contact's message is stored and read with
 * its author named. Stored as bare words, Sancho's "I will send you the deck by
 * Friday" read later as the owner's own note: the remember loop set the owner a
 * reminder to send the deck, and Ask called it the owner's promise. Found on
 * the simulator, 2026-11-08. Drives the real drain over the in-process Core.
 */

import {
  addContact,
  clearVaults,
  configureRateLimiter,
  createCoreRouter,
  InProcessTransport,
  resetContactDirectory,
  resetStagingState,
  setPeopleRepository,
  stagingIngest,
} from '@dina/core';
import { resetReminderState } from '@dina/core/reminders';
import { makeFakePeopleRepo, makeStubRememberRuntime } from '@dina/test-harness';

import { attributeMessage } from '../../src/staging/drain';
import { StagingDrainScheduler } from '../../src/staging/scheduler';
import { resetReasoningProvider, setAccessiblePersonas } from '../../src/vault_context/assembly';

import {
  closeSQLiteVault,
  openSQLiteVault,
  type SQLiteVaultHandle,
} from './helpers/sqlite_vault_harness';

describe('attributeMessage', () => {
  it('names the author of plain text and of a Talk body', () => {
    expect(attributeMessage('Sancho', 'I will send it')).toBe(
      'Sancho wrote to you: I will send it',
    );
    expect(attributeMessage('Sancho', '{"text":"I will send it"}')).toBe(
      'Sancho wrote to you: I will send it',
    );
  });

  it('leaves structured JSON with no text alone', () => {
    const raw = '{"kind":"vouch","level":2}';
    expect(attributeMessage('Sancho', raw)).toBe(raw);
  });
});

describe('a contact’s message in the drain', () => {
  const handles: SQLiteVaultHandle[] = [];
  let scheduler: StagingDrainScheduler | undefined;

  beforeEach(() => {
    resetStagingState();
    clearVaults();
    resetContactDirectory();
    setPeopleRepository(makeFakePeopleRepo());
    resetReasoningProvider();
    resetReminderState();
    configureRateLimiter({ maxRequests: 10_000, windowSeconds: 60 });
    handles.push(openSQLiteVault('general'));
    setAccessiblePersonas(['general']);
    addContact('did:plc:sancho', 'Sancho', 'verified');
  });

  afterEach(() => {
    scheduler?.stop();
    while (handles.length > 0) closeSQLiteVault(handles.pop() as SQLiteVaultHandle);
    resetContactDirectory();
    resetReminderState();
  });

  let resolved: Record<string, unknown>[] = [];

  async function drain(data: Record<string, unknown>): Promise<string[]> {
    const seen: string[] = [];
    resolved = [];
    const core = new InProcessTransport(createCoreRouter());
    const realResolve = core.stagingResolve.bind(core);
    core.stagingResolve = async (input) => {
      resolved.push(input.data as Record<string, unknown>);
      return realResolve(input);
    };
    const stub = makeStubRememberRuntime('general');
    stagingIngest({
      source: 'd2d',
      source_id: `d2d-${Math.random()}`,
      producer_id: 'sancho',
      data,
    });
    scheduler = new StagingDrainScheduler({
      core,
      drain: {
        rememberRuntime: {
          run: async (turn: { memoryText: string }) => {
            seen.push(turn.memoryText);
            return stub.run();
          },
        } as never,
      },
      intervalMs: 10_000,
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    const tick = await scheduler.runTick();
    expect(tick.stored).toBe(1);
    return seen;
  }

  it('gives the remember loop and the vault the author’s name', async () => {
    const seen = await drain({
      type: 'message',
      summary: 'I will send you the deck by Friday.',
      body: '{"text":"I will send you the deck by Friday."}',
      ingress_channel: 'd2d',
      origin_did: 'did:plc:sancho',
    });
    expect(seen).toEqual(['Sancho wrote to you: I will send you the deck by Friday.']);
    const [stored] = resolved;
    expect(stored?.summary).toBe('Sancho wrote to you: I will send you the deck by Friday.');
    expect(stored?.body).toBe('Sancho wrote to you: I will send you the deck by Friday.');
    expect(stored?.content_l0).toContain('Sancho wrote to you');
  });

  it('leaves the owner’s own memory as written', async () => {
    const seen = await drain({
      type: 'user_memory',
      source: 'user_remember',
      summary: 'I will send Mike the deck by Friday.',
      body: 'I will send Mike the deck by Friday.',
    });
    expect(seen).toEqual(['I will send Mike the deck by Friday.']);
  });
});
