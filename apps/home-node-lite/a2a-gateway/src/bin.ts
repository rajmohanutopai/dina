#!/usr/bin/env node
/**
 * `dina-home-node-lite-a2a-gateway`: boot, then close on SIGINT/SIGTERM.
 * Run it under its own OS user (or container) with read access to its key
 * directory and nothing of Core's or Brain's (design §4.1, plan §3.18).
 */

import { ConfigError, ServiceKeyError, bootGateway, ensureServiceKey, loadConfig } from './main';

if (process.argv[2] === 'keygen') {
  // Print only the DID: it is public, and the operator gives it to Core.
  const { serviceKey } = loadConfig();
  ensureServiceKey(serviceKey.dir, serviceKey.file)
    .then(({ did }) => {
      console.log(did);
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error(`[a2a-gateway] ${err instanceof Error ? err.message : 'keygen failed'}`);
      process.exit(1);
    });
} else {
  serve();
}

function serve(): void {
  bootGateway()
    .then(({ app, logger }) => {
      const shutdown = (signal: NodeJS.Signals): void => {
        logger.info({ signal }, 'a2a gateway shutting down');
        app
          .close()
          .then(() => process.exit(0))
          .catch(() => process.exit(1));
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch((err: unknown) => {
      if (err instanceof ConfigError) {
        console.error(`[a2a-gateway] config error: ${err.message}`);
        for (const issue of err.issues) console.error(`  - ${issue.path}: ${issue.message}`);
        process.exit(78); // EX_CONFIG
        return;
      }
      if (err instanceof ServiceKeyError) {
        console.error(`[a2a-gateway] ${err.message}`);
        process.exit(78);
        return;
      }
      console.error('[a2a-gateway] fatal:', err instanceof Error ? err.message : 'unknown error');
      process.exit(1);
    });
}
