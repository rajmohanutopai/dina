/**
 * TT-09: on a server Home Node the quarantine must survive a restart, since the
 * relay's copy is acked once a stranger's message sits in it. Drives the real
 * storage init twice on one directory.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { listQuarantined, quarantineMessage, resetQuarantineState } from '@dina/core/d2d';
import { setQuarantineRepository } from '@dina/core/storage';

import { initializeStorage } from '../src/storage/init';

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return logger;
  },
} as never;

it('a quarantined message is still listed after a restart; a past-TTL one is swept', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tt-quarantine-'));
  const seed = new Uint8Array(randomBytes(32));
  try {
    let st = await initializeStorage(seed, root, logger);
    const kept = quarantineMessage('did:plc:stranger', 'social.update', '{"text":"hi"}', undefined, 'm1');
    quarantineMessage('did:plc:stranger', 'social.update', '{}', Date.now() - 40 * 86_400_000, 'm2');
    await st.provider.closeAll();

    setQuarantineRepository(null);
    resetQuarantineState();
    st = await initializeStorage(seed, root, logger);
    expect(listQuarantined().map((m) => m.id)).toEqual([kept.id]);
    await st.provider.closeAll();
  } finally {
    setQuarantineRepository(null);
    resetQuarantineState();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
