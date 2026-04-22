/**
 * Composition root for the Fastify Core server.
 *
 * The ordered boot sequence (task 4.3) lives in `./boot.ts`. This file
 * re-exports the public surface.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4a.
 */

export { bootServer as main, type BootedServer } from './boot';
