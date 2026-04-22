import { dinaMatchers, installUnhandledRejectionGuard } from '@dina/test-harness';

expect.extend(dinaMatchers);

// Task 11.8 — unhandled promise rejections are a soak-time concern
// but also a regular-run one: a `.catch`-less Promise slipping through
// a green test is a latent bug. The guard converts any rejection that
// fires during a test into a test failure so the responsible test
// surfaces it immediately.
installUnhandledRejectionGuard();
