/**
 * Narrow test for WM-CORE-10's "hot shutdown unwires them" invariant.
 *
 * `shutdownAllPersistence` is the teardown called on logout / app
 * background. It must clear the per-persona repo maps AND the
 * module-global MemoryService so the /v1/memory routes 503 until the
 * next boot re-installs them.
 *
 * We don't spin up op-sqlite here — `shutdownAllPersistence` is
 * designed to be safe when `initializePersistence` never ran (its
 * inner `resetDBProvider` handles a null provider).
 */

import { shutdownAllPersistence } from '../../src/storage/init';
import {
  setMemoryService,
  getMemoryService,
  MemoryService,
} from '../../../core/src/memory/service';
import {
  setTopicRepository,
  getTopicRepository,
  InMemoryTopicRepository,
} from '../../../core/src/memory/repository';
import { setVaultRepository, getVaultRepository } from '../../../core/src/vault/repository';

describe('shutdownAllPersistence — memory teardown', () => {
  it('drops the module-global MemoryService', async () => {
    setMemoryService(
      new MemoryService({
        resolve: () => null,
        listPersonas: () => [],
        nowSecFn: () => 0,
      }),
    );
    expect(getMemoryService()).not.toBeNull();
    await shutdownAllPersistence();
    expect(getMemoryService()).toBeNull();
  });

  it('clears per-persona topic + vault repo maps', async () => {
    setTopicRepository('health', new InMemoryTopicRepository());
    // Hand a minimal object to the vault map just to confirm it clears.
    setVaultRepository('health', {} as never);
    expect(getTopicRepository('health')).not.toBeNull();
    expect(getVaultRepository('health')).not.toBeNull();
    await shutdownAllPersistence();
    expect(getTopicRepository('health')).toBeNull();
    expect(getVaultRepository('health')).toBeNull();
  });
});
