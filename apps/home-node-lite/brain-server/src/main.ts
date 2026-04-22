/**
 * Composition root for the Fastify Brain server.
 *
 * The ordered boot sequence (task 5.1 scaffold, task 5.3+ full) lives
 * in `./boot.ts`. This file re-exports the public surface.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5a.
 */

export { bootServer, type BootedServer } from './boot';
export { ConfigError, loadConfig, type BrainServerConfig } from './config';
export { createLogger, type Logger } from './logger';
