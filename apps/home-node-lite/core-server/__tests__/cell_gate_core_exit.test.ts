/**
 * docs/STATE_MACHINES.md HOSTED-1: Core dies just after answering the last set-up
 * call. The gate must not call that cell unlocked: it has no Core. The sign-up
 * still counts, since the seed is on disk, and the owner unlocks to start again.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { generateMnemonic, mnemonicToEntropy, serializeWrappedSeed, wrapSeed } from '@dina/core';
import Fastify from 'fastify';

import { createGate, type CoreHandle, type GateEvent } from '../src/cell/gate';
import { WRAPPED_SEED_NAME } from '../src/identity/master_seed';

const PASS = 'a long cell passphrase';
const CAP = 'cell-owner-capability-0123456789abcdef';

it('setup ends locked, with the words and the mark, and unlock starts Core again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const vaultDir = path.join(dir, 'v');
  fs.mkdirSync(vaultDir);
  const socket = path.join(dir, 'c.sock');
  const events: GateEvent[] = [];
  let spawns = 0;

  const spawnCore = (passphrase: string): CoreHandle => {
    spawns += 1;
    const dies = spawns === 1;
    let exit: (c: number | null) => void = () => undefined;
    let bootDone: (v: null) => void = () => undefined;
    const exited = new Promise<number | null>((r) => (exit = r));
    const app = Fastify();
    app.get('/readyz', async () => ({ ok: true }));
    app.post('/v1/commerce/catalog/drafts/presence', async () => ({ ok: true }));
    app.get('/v1/owner/setup/status', async () => ({ home_did: 'did:plc:c' }));
    app.post('/v1/owner/setup/owner-device', async () => ({ code: 'OWNERCODE' }));
    app.put('/v1/commerce/settings/buyer', async () => ({ ok: true }));
    app.post('/v1/commerce/install/begin', async () => ({ install_id: 'i', status: 'pending' }));
    app.post('/v1/commerce/install/bind_reference_runner', async () => ({ device_did: 'did:key:z' }));
    app.post('/v1/commerce/install/confirm', async (_q, reply) => {
      if (dies) {
        // The exit reaches the gate first, then the end of the handoff pipe.
        setTimeout(() => {
          void app.close().then(() => {
            exit(1);
            bootDone(null);
          });
        }, 5);
      } else {
        bootDone(null);
      }
      return reply.send({ ok: true });
    });
    void (async () => {
      if (dies) {
        const w = await wrapSeed(passphrase, mnemonicToEntropy(generateMnemonic()));
        fs.writeFileSync(path.join(vaultDir, WRAPPED_SEED_NAME), serializeWrappedSeed(w), {
          mode: 0o600,
        });
        fs.writeFileSync(path.join(vaultDir, 'owner_capability'), CAP, { mode: 0o600 });
      }
      fs.rmSync(socket, { force: true });
      await app.listen({ path: socket });
    })();
    return {
      bootstrap: new Promise((r) => (bootDone = r as never)),
      exited,
      async stop() {
        await app.close();
        exit(0);
      },
    };
  };

  const gate = createGate({
    vaultDir,
    coreSocket: socket,
    spawnCore,
    emit: (e) => events.push(e),
    verifyPassphrase: async (p) => p === PASS,
  });
  const ticket = events.find((e) => e.event === 'ticket') as unknown as { ticket: string };
  const post = async (url: string, body: unknown) => {
    const res = await gate.app.inject({
      method: 'POST',
      url,
      payload: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };

  const r = await post('/cell/setup', { ticket: ticket.ticket, passphrase: PASS });
  expect(r.status).toBe(200);
  expect((r.body.words as string[]).length).toBeGreaterThan(0);
  expect(gate.state()).toBe('locked');

  const u = await post('/cell/unlock', { passphrase: PASS });
  expect(u.body.already).toBeUndefined();
  expect(u.status).toBe(200);
  expect(gate.state()).toBe('unlocked');
  expect(spawns).toBe(2);

  await gate.close();
  fs.rmSync(dir, { recursive: true, force: true });
}, 60000);
