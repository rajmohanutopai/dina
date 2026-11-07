/** Boot: config from the environment, the SQLite store, serve. */

import { loadConfig } from './config';
import { buildServer } from './server';
import { CopyStore } from './store';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const store = new CopyStore(config.dbPath);
  const app = await buildServer({ config, store });

  const shutdown = async (): Promise<void> => {
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: config.port, host: config.host });
  app.log.info({ port: config.port, maxCopyBytes: config.maxCopyBytes }, 'backup store up');
}

void main().catch((err) => {
  console.error('[backup] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
