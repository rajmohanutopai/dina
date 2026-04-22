#!/usr/bin/env node
/**
 * Binary entry point — `dina-home-node-lite-brain` (task 5.7).
 *
 * 1. Boot via `main()` (config → logger → Fastify → listen).
 * 2. Register SIGINT/SIGTERM → graceful shutdown: Fastify close.
 *    Additional shutdown steps (Core WS client, MCP subprocess,
 *    notify bridge) land with their respective subsystems.
 */

import { bootServer, ConfigError } from './main';

bootServer()
  .then((booted) => {
    const { app, logger } = booted;

    const shutdown = (signal: NodeJS.Signals): void => {
      logger.info({ signal }, 'brain-server received shutdown signal');
      app.close()
        .then(() => {
          logger.info('brain-server closed');
          process.exit(0);
        })
        .catch((err: unknown) => {
          logger.error({ err }, 'brain-server shutdown failed');
          process.exit(1);
        });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    logger.info('signal handlers registered (SIGINT, SIGTERM)');
  })
  .catch((err: unknown) => {
    if (err instanceof ConfigError) {
      // eslint-disable-next-line no-console
      console.error(`[brain-server] config error: ${err.message}`);
      for (const issue of err.issues) {
        // eslint-disable-next-line no-console
        console.error(`  - ${issue.path}: ${issue.message}`);
      }
      process.exit(78); // EX_CONFIG per sysexits.h
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[brain-server] fatal:', err);
    process.exit(1);
  });
