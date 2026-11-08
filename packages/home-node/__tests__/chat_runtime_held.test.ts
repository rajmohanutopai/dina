/**
 * REQ-19 (docs/STATE_MACHINES.md): the /remember drain hook tells a held item
 * (the model did not answer) apart from a failed save, so the reply says the
 * fact is kept instead of "the vault would not accept it".
 */

import { handleChat, resetRememberCoreClient, resetRememberDrainHook } from '@dina/brain/chat';

import { wireChatRememberRuntime } from '../src/chat_runtime';

interface Tick {
  results: { itemId: string; status: string; persona?: string; reason?: string }[];
}

function wire(status: string, reason?: string): () => void {
  const core = {
    stagingIngest: async () => ({ itemId: 'stg-1', duplicate: false, status: 'received' }),
  };
  const drain = {
    runTick: async (): Promise<Tick> => ({
      results: [{ itemId: 'stg-1', status, ...(reason !== undefined ? { reason } : {}) }],
    }),
  };
  const handle = wireChatRememberRuntime({ core: core as never, stagingDrain: drain as never });
  return () => handle.dispose();
}

afterEach(() => {
  resetRememberDrainHook();
  resetRememberCoreClient();
});

it('a held item is kept, with the reason', async () => {
  const dispose = wire('failed', 'model_unavailable');
  const out = await handleChat('/remember my blood pressure was 150/95');
  expect(out.response).toContain("I've kept that");
  expect(out.response).not.toContain("couldn't save");
  dispose();
});

it('a failed save still says it failed', async () => {
  const dispose = wire('failed', 'storage_error');
  const out = await handleChat('/remember my blood pressure was 150/95');
  expect(out.response).toContain("I couldn't save that");
  dispose();
});
