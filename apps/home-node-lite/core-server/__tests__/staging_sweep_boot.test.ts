/**
 * REQ-01: a real Lite Core boot schedules the staging sweep. Runs every interval
 * the boot registers: a row whose claim lapsed returns to the queue. Before the
 * fix this boot registered six intervals and none reached `sweep`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { getStagingRepository, ingest, stagingGetItem } from '@dina/core';

import { bootServer } from '../src/boot';

class FakeWS {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  private closed = false;
  constructor(public url: string) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
      this.onmessage?.({
        data: JSON.stringify({ type: 'auth_challenge', nonce: 'n', ts: 1700000000 }),
      });
    });
  }
  send(d: string | Uint8Array): void {
    const text = typeof d === 'string' ? d : new TextDecoder().decode(d);
    try {
      if ((JSON.parse(text) as { type?: string }).type === 'auth_response') {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'auth_success' }) }));
      }
    } catch {
      /* not a control frame */
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: 'test' });
  }
}

describe('Lite Core boot schedules the staging sweep', () => {
  const realSetInterval = global.setInterval;
  const env = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'staging-sweep-boot-'));
    process.env.DINA_VAULT_DIR = dir;
    process.env.DINA_CORE_HOST = '127.0.0.1';
    process.env.DINA_CORE_PORT = '0';
    process.env.DINA_LOG_LEVEL = 'silent';
  });

  afterEach(() => {
    global.setInterval = realSetInterval;
    process.env = { ...env };
    rmSync(dir, { recursive: true, force: true });
  });

  it('a lapsed claim returns to received when the boot intervals run', async () => {
    const intervals: (() => unknown)[] = [];
    (global as unknown as { setInterval: unknown }).setInterval = (fn: () => unknown) => {
      intervals.push(fn);
      return realSetInterval(() => undefined, 1e8);
    };
    const booted = await bootServer({
      msgboxWsFactory: (url: string) => new FakeWS(url) as never,
      msgboxReadyTimeoutMs: 1000,
    } as never);
    try {
      const repo = getStagingRepository();
      expect(repo).not.toBeNull();
      const { id } = ingest({ source: 'connector', source_id: 'crash', data: { body: 'x' } });
      const nowS = Math.floor(Date.now() / 1000);
      repo!.claim(1, 1, nowS - 100, 'user'); // claimed, then the worker died
      expect(stagingGetItem(id)?.status).toBe('classifying');

      for (const fn of intervals) {
        try {
          await fn();
        } catch {
          /* other ticks need network the test does not give them */
        }
      }

      expect(stagingGetItem(id)?.status).toBe('received');
    } finally {
      global.setInterval = realSetInterval;
      await booted.app.close();
    }
  }, 120_000);
});
