/**
 * Mobile test setup — pre-wires in-memory vaults for the default
 * persona set before each test.
 *
 * The strict `requireRepo()` resolver in `packages/core/src/vault/crud.ts`
 * no longer auto-provisions on miss — production needs that
 * strictness so a forgotten `openPersonaDB()` surfaces immediately
 * instead of silently routing writes into volatile RAM. Mobile tests
 * get the same in-memory repos eagerly here, no per-file change
 * required.
 *
 * Tests that need a non-default persona (`work`, `finance`, etc.)
 * can call `clearVaults([...])` with the extended list inside their
 * own `beforeEach` (the latest call wins).
 *
 * Mirrors `packages/{core,brain}/__tests__/setup.ts`.
 */

// Mock react-native-safe-area-context globally: components using
// `useSafeAreaInsets` (e.g. the guided-demo banner) render under jsdom without
// a SafeAreaProvider. Return zero insets + pass-through provider/consumer.
jest.mock('react-native-safe-area-context', () => {
  const inset = { top: 0, right: 0, bottom: 0, left: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  return {
    useSafeAreaInsets: () => inset,
    useSafeAreaFrame: () => frame,
    SafeAreaProvider: ({ children }: { children: unknown }) => children,
    SafeAreaConsumer: ({ children }: { children: (i: typeof inset) => unknown }) =>
      children(inset),
    SafeAreaView: ({ children }: { children: unknown }) => children,
    initialWindowMetrics: { insets: inset, frame },
  };
});

import { setRememberCoreClient } from '../../../packages/brain/src/chat/orchestrator';
import {
  ingest as stagingIngest,
  getItem as getStagingItem,
} from '../../../packages/core/src/staging/service';
import {
  clearVaults,
  DEFAULT_TEST_PERSONAS,
} from '../../../packages/core/src/vault/crud';

beforeEach(() => {
  clearVaults(DEFAULT_TEST_PERSONAS);
  const rememberCore = {
    async stagingIngest(req: {
      source: string;
      sourceId: string;
      producerId?: string;
      data?: Record<string, unknown>;
      expiresAt?: number;
    }) {
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
  };
  setRememberCoreClient(rememberCore);
});
