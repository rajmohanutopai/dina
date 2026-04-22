import { installUnhandledRejectionGuard } from '@dina/test-harness';

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
