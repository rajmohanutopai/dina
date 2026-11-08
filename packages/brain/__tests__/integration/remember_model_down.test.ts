/**
 * REQ-19 (docs/STATE_MACHINES.md): a /remember made while the model is down
 * is held, not filed in General. Before, the drain filed it there "with
 * confidence 1", so a health or money fact sat where any agent with General
 * access could read it. Drives the real remember runtime, drain and
 * in-process Core; the model fails, then comes back.
 */

import {
  clearVaults,
  configureRateLimiter,
  createCoreRouter,
  stagingGetItem,
  InProcessTransport,
  resetContactDirectory,
  resetStagingState,
  setPeopleRepository,
  stagingIngest,
  stagingSweep,
} from '@dina/core';
import { resetReminderState } from '@dina/core/reminders';
import { makeFakePeopleRepo } from '@dina/test-harness';

import {
  buildRememberRuntime,
  isRememberModelUnavailable,
} from '../../src/composition/remember_runtime';
import { StagingDrainScheduler } from '../../src/staging/scheduler';
import { resetReasoningProvider, setAccessiblePersonas } from '../../src/vault_context/assembly';

import {
  closeSQLiteVault,
  openSQLiteVault,
  type SQLiteVaultHandle,
} from './helpers/sqlite_vault_harness';

const T0 = Date.parse('2026-11-08T10:00:00Z');

let modelUp = false;
let calls = 0;
let clock = T0;
const llm = {
  name: 'fake',
  supportsStreaming: false,
  supportsToolCalling: true,
  supportsEmbedding: false,
  async chat(_messages: unknown, options?: { tools?: { name: string }[] }) {
    if (!modelUp) throw new Error('503 Service Unavailable');
    void options;
    // Route to health once, then finish.
    calls += 1;
    if (calls > 1) {
      return {
        content: 'Saved.',
        toolCalls: [],
        model: 'fake',
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: 'stop',
      };
    }
    return {
      content: '',
      toolCalls: [
        {
          id: 'c1',
          name: 'route_to_persona',
          arguments: { persona: 'health', reason: 'blood pressure' },
        },
      ],
      model: 'fake',
      usage: { inputTokens: 0, outputTokens: 0 },
      finishReason: 'tool_use',
    };
  },
};

describe('remember while the model is down', () => {
  const handles: SQLiteVaultHandle[] = [];

  beforeEach(() => {
    clock = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    modelUp = false;
    calls = 0;
    resetStagingState();
    clearVaults();
    resetContactDirectory();
    setPeopleRepository(makeFakePeopleRepo());
    resetReasoningProvider();
    resetReminderState();
    configureRateLimiter({ maxRequests: 10_000, windowSeconds: 60 });
    handles.push(openSQLiteVault('general'), openSQLiteVault('health'));
    setAccessiblePersonas(['general', 'health']);
  });

  afterEach(() => {
    while (handles.length > 0) closeSQLiteVault(handles.pop() as SQLiteVaultHandle);
    jest.restoreAllMocks();
  });

  function scheduler(): StagingDrainScheduler {
    const runtime = buildRememberRuntime({
      llm: llm as never,
      personas: [{ name: 'general' }, { name: 'health' }],
      timezone: 'UTC',
    });
    return new StagingDrainScheduler({
      core: new InProcessTransport(createCoreRouter()),
      drain: { rememberRuntime: runtime },
      intervalMs: 10_000,
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
  }

  it('the runtime says the model is unavailable instead of picking a vault', async () => {
    const runtime = buildRememberRuntime({
      llm: llm as never,
      personas: [{ name: 'general' }],
      timezone: 'UTC',
    });
    const err = await runtime
      .run({ memoryText: 'my blood pressure was 150/95' })
      .catch((e: unknown) => e);
    expect(isRememberModelUnavailable(err)).toBe(true);
  });

  it('holds the item through the outage and files it where the model says once it answers', async () => {
    const { id } = stagingIngest({
      source: 'user_remember',
      source_id: 'r1',
      data: {
        type: 'user_memory',
        summary: 'my blood pressure was 150/95',
        body: 'my blood pressure was 150/95',
      },
    });
    const s = scheduler();

    const first = await s.runTick();
    expect(first.results.find((r) => r.itemId === id)).toMatchObject({
      status: 'failed',
      reason: 'model_unavailable',
    });
    expect(stagingGetItem(id)).toMatchObject({ status: 'failed', retry_count: 0 });

    // Ten minutes on, still down: held again, still no retry spent.
    clock = T0 + 10 * 60 * 1000;
    stagingSweep();
    await s.runTick();
    expect(stagingGetItem(id)).toMatchObject({ status: 'failed', retry_count: 0 });

    // The model answers: the item goes where it chose, not to General.
    modelUp = true;
    clock = T0 + 20 * 60 * 1000;
    stagingSweep();
    const back = await s.runTick();
    expect(back.results.find((r) => r.itemId === id)).toMatchObject({
      status: 'stored',
      persona: 'health',
    });
  });
});
