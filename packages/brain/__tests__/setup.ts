import { installUnhandledRejectionGuard } from '@dina/test-harness';
import { installNodeTraceScopeStorage } from '../node-trace-storage';

import {
  ingest as stagingIngest,
  getItem as getStagingItem,
} from '../../core/src/staging/service';
import {
  clearVaults,
  DEFAULT_TEST_PERSONAS,
} from '../../core/src/vault/crud';
import {
  InMemoryWorkflowRepository,
  setWorkflowRepository,
} from '../../core/src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../core/src/workflow/service';
import { setRememberCoreClient } from '../src/chat/orchestrator';

// Mirrors `packages/core/__tests__/setup.ts`. Brain has its own
// fire-and-forget async path (e.g. `void repo.deleteThread(id).catch(...)`
// in `chat/thread.ts`); without this guard, a future refactor that drops
// a `.catch(...)` handler would produce an unhandled rejection that
// doesn't fail the containing test. The guard turns any rejection into
// a test failure so the bug surfaces in the responsible spec rather
// than years later in a soak run. Gap identified during task 2.4's
// deep review — Core installed the guard at task 11.8 but Brain's
// jest.config.js never pointed to a setup file.
installUnhandledRejectionGuard();
installNodeTraceScopeStorage();

/**
 * Pre-wire in-memory vaults for the default test persona set before
 * each brain test. The strict `requireRepo()` resolver no longer
 * auto-provisions on miss — production needs that strictness to
 * surface forgotten `openPersonaDB()` calls — but most brain tests
 * exercise chat / vault-context code that immediately queries
 * `general` (and friends) with no explicit vault setup. Eagerly
 * seeding the default set keeps those tests one-line clean while
 * still letting tests opt into a tighter list (e.g. only `general`)
 * by calling `clearVaults(['general'])` inside their own
 * `beforeEach` AFTER this hook runs.
 *
 * Tests that need a non-default persona (`work`, `finance`, etc.)
 * can extend the seed: `clearVaults([...DEFAULT_TEST_PERSONAS, 'work'])`
 * — the latest call wins.
 */
beforeEach(() => {
  clearVaults(DEFAULT_TEST_PERSONAS);
  const workflowRepo = new InMemoryWorkflowRepository();
  setWorkflowRepository(workflowRepo);
  setWorkflowService(new WorkflowService({ repository: workflowRepo }));
  setRememberCoreClient({
    async stagingIngest(req) {
      const result = stagingIngest({
        source: req.source,
        source_id: req.sourceId,
        ...(req.producerId !== undefined ? { producer_id: req.producerId } : {}),
        ...(req.data !== undefined ? { data: req.data } : {}),
        ...(req.expiresAt !== undefined ? { expires_at: req.expiresAt } : {}),
      });
      const item = getStagingItem(result.id);
      return {
        itemId: result.id,
        duplicate: result.duplicate,
        status: item?.status ?? 'received',
      };
    },
  });
});

afterEach(() => {
  setWorkflowService(null);
  setWorkflowRepository(null);
});
