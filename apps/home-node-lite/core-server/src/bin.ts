#!/usr/bin/env node
/**
 * Binary entry point — `dina-home-node-lite-core`.
 *
 * 1. Boot via `main()` (config → logger → server → listen).
 * 2. Register `uncaughtException` + `unhandledRejection` → crash-log
 *    writer (task 4.11). Must land BEFORE main() resolves so we catch
 *    crashes during the boot sequence itself.
 * 3. Register SIGINT/SIGTERM → graceful shutdown: Fastify close →
 *    (MsgBox close + DB close land as those subsystems wire in;
 *    currently just Fastify).
 */

import { main } from './main';
import { ConfigError } from './config';
import { registerSignalHandlers, type ShutdownStep } from './shutdown';
import { installCrashLogHandlers, InMemoryCrashLogWriter } from './crash_log';

main()
  .then((booted) => {
    const { app, logger } = booted;

    // Crash-log traps: uncaughtException + unhandledRejection.
    // Writer is in-memory for now — `@dina/storage-node`'s `crash_log`
    // SQLCipher table replaces this in task 4.3 (boot-ordering) wiring.
    installCrashLogHandlers({
      logger,
      writer: new InMemoryCrashLogWriter(),
    });
    logger.info('crash-log traps installed (uncaughtException, unhandledRejection)');

    // Shutdown signal handlers.
    const steps: ShutdownStep[] = [
      {
        name: 'fastify',
        close: () => app.close(),
      },
      // MsgBox step lands with task 4.3 when the relay connection is
      // wired. DB step lands with `@dina/storage-node`.
    ];
    registerSignalHandlers({ logger, steps });
    logger.info('signal handlers registered (SIGINT, SIGTERM)');
  })
  .catch((err: unknown) => {
    if (err instanceof ConfigError) {
      // eslint-disable-next-line no-console
      console.error(`[core-server] config error: ${err.message}`);
      for (const issue of err.issues) {
        // eslint-disable-next-line no-console
        console.error(`  - ${issue.path}: ${issue.message}`);
      }
      process.exit(78); // EX_CONFIG per sysexits.h
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[core-server] fatal:', err);
    process.exit(1);
  });
