/**
 * Item 2 — single-use bootstrap enrolment capability tests.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { generatePairingCode, getPairingIntent, setNodeDID } from '@dina/core';

import {
  deliverBootstrapCapability,
  resolveHandoffFromEnv,
  HANDOFF_FD_ENV,
  DEFAULT_BOOTSTRAP_DEVICE_NAME,
  type BootstrapHandoff,
} from '../src/pair/bootstrap_capability';

function fakeHandoff() {
  const writes: string[] = [];
  let closed = false;
  const handoff: BootstrapHandoff = {
    write: async (d: string) => {
      writes.push(d);
    },
    close: async () => {
      closed = true;
    },
  };
  return { handoff, writes, isClosed: () => closed };
}

const fakeGenerate = (code: string, expiresAt: number) =>
  jest.fn(() => ({ code, expiresAt })) as unknown as typeof generatePairingCode;

describe('bootstrap enrolment capability (item 2)', () => {
  describe('deliverBootstrapCapability', () => {
    it('mints a single-use agent code and hands it off on first boot', async () => {
      const { handoff, writes, isClosed } = fakeHandoff();
      const gen = fakeGenerate('TESTCODE', 1234);
      const res = await deliverBootstrapCapability({ firstBoot: true, handoff, generate: gen });
      expect(res).toEqual({ delivered: true, expiresAt: 1234 });
      // Item C — the bootstrap enrols a CODING agent, so it stamps the coding
      // agent_scope at initiate.
      expect(gen).toHaveBeenCalledWith({
        role: 'agent',
        scope: 'coding',
        deviceName: DEFAULT_BOOTSTRAP_DEVICE_NAME,
      });
      expect(JSON.parse(writes.join('').trim())).toEqual({ code: 'TESTCODE', expiresAt: 1234 });
      expect(isClosed()).toBe(true);
    });

    it('does not mint when it is not a first boot', async () => {
      const { handoff, writes, isClosed } = fakeHandoff();
      const gen = fakeGenerate('X', 1);
      const res = await deliverBootstrapCapability({ firstBoot: false, handoff, generate: gen });
      expect(res).toEqual({ delivered: false, reason: 'not_first_boot' });
      expect(gen).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
      expect(isClosed()).toBe(false);
    });

    it('does not mint when there is no handoff channel (dev / standalone boot)', async () => {
      const gen = fakeGenerate('X', 1);
      const res = await deliverBootstrapCapability({ firstBoot: true, handoff: null, generate: gen });
      expect(res).toEqual({ delivered: false, reason: 'no_handoff_channel' });
      expect(gen).not.toHaveBeenCalled();
    });

    it('closes the channel even when the write throws', async () => {
      let closed = false;
      const handoff: BootstrapHandoff = {
        write: async () => {
          throw new Error('pipe broken');
        },
        close: async () => {
          closed = true;
        },
      };
      await expect(
        deliverBootstrapCapability({ firstBoot: true, handoff, generate: fakeGenerate('X', 1) }),
      ).rejects.toThrow('pipe broken');
      expect(closed).toBe(true);
    });

    it('the delivered code is a redeemable single-use agent intent (real ceremony)', async () => {
      setNodeDID('did:key:z6MkuBootstrapTestNodeDid00000000000000000000');
      const { handoff, writes } = fakeHandoff();
      const res = await deliverBootstrapCapability({ firstBoot: true, handoff });
      expect(res.delivered).toBe(true);
      const { code } = JSON.parse(writes.join('').trim()) as { code: string };
      const intent = getPairingIntent(code);
      expect(intent?.role).toBe('agent');
    });
  });

  describe('resolveHandoffFromEnv', () => {
    it('returns null when the env var is absent', () => {
      expect(resolveHandoffFromEnv({})).toBeNull();
    });

    it('rejects stdin/stdout/stderr fds and non-integers (never write a secret there)', () => {
      for (const bad of ['0', '1', '2', 'abc', '-1', '']) {
        expect(resolveHandoffFromEnv({ [HANDOFF_FD_ENV]: bad })).toBeNull();
      }
    });

    it('delivers the payload to a real inherited fd end-to-end', async () => {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'handoff-'));
      const file = path.join(dir, 'out');
      const fh = await fsp.open(file, 'w');
      try {
        const handoff = resolveHandoffFromEnv({ [HANDOFF_FD_ENV]: String(fh.fd) });
        expect(handoff).not.toBeNull();
        await handoff!.write('HELLO\n');
        await handoff!.close(); // autoClose closes the fd
        expect(await fsp.readFile(file, 'utf8')).toBe('HELLO\n');
      } finally {
        await fh.close().catch(() => undefined); // may already be closed by autoClose
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });
  });
});
