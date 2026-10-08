/**
 * Alonso's core-server for the scenario fleet, with one test-only change: its
 * A2A transport can reach the local reference agent (`agent.test` →
 * 127.0.0.1, its self-signed certificate trusted) and nothing else. The stock
 * transport refuses loopback addresses and unknown CAs, rightly, so a local
 * test agent is otherwise unreachable (docs/REAL_LIFE_SCENARIOS.md area L).
 * Everything else boots exactly as `src/bin.ts` does.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { setA2AHostTransport } from '@dina/core';
import { createA2AHostTransport } from '@dina/net-node';

import { main } from '../../apps/home-node-lite/core-server/src/main';

const CERT = readFileSync(
  path.join(__dirname, '..', '..', 'apps', 'home-node-lite', 'core-server', '__tests__', 'fixtures', 'a2a_tls', 'localhost.cert.pem'),
  'utf8',
);

main()
  .then((booted) => {
    setA2AHostTransport(
      createA2AHostTransport({
        resolve: async (host) => (host === 'agent.test' ? ['127.0.0.1'] : []),
        isAllowedAddress: (a) => a === '127.0.0.1',
        ca: CERT,
      }),
    );
    booted.logger.info('scenario fleet: A2A transport limited to the local test agent');
    const stop = (): void => {
      void booted.app.close().finally(() => process.exit(0));
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  })
  .catch((err: unknown) => {
    console.error('[core-server] boot failed', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
