/**
 * WS-2.2 / WS-2.4 — the commerce background ticks must actually RUN against a
 * real installed runtime.
 *
 * `recoverAdmissions()` is what turns an abandoned `pre_effect` reservation
 * into a `rejected(decision_timeout)` and gives its quote capacity back. It
 * was built and unit-tested and nothing called it: the only callers in the
 * repository were its own tests. On a running node no reservation ever timed
 * out, every abandoned order held capacity indefinitely, and the buyer's
 * reconcile answered `received_processing` for ever.
 *
 * It was then started inside `wireWorkflowPlane`, under a comment claiming
 * both boots got it from one place. They did not — the phone never calls that
 * plane — so the sweep still did not run on the product's primary surface.
 * Both ticks now live in `startCommerceSweepers`, called once by each
 * composition root, and `boundary.test.ts` fails if either root stops calling
 * it.
 *
 * What THIS test adds on top of that static guard: the sweep, run over the
 * runtime a real `initializeStorage` installs, actually reaches the engine.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { pino } from 'pino';

import {
  getCommerceRuntime,
  installCommerceRuntime,
  startCommerceSweepers,
  type CommerceRuntime,
  type CommerceSweepers,
} from '@dina/core';

import { initializeStorage } from '../src/storage/init';

const logger = pino({ level: 'silent' });

describe('startCommerceSweepers runs the commerce admission recovery sweep', () => {
  let dir: string;
  let sweepers: CommerceSweepers | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'commerce-sweep-wiring-'));
  });

  afterEach(() => {
    sweepers?.stop();
    sweepers = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('sweeps the installed commerce runtime as soon as the ticks start', async () => {
    const seed = new Uint8Array(32).fill(11);
    await initializeStorage(seed, dir, logger);
    // `initializeStorage` installs the real runtime. Wrap it so the assertion
    // is about the WIRING reaching the global, not about a fabricated engine:
    // everything else stays the production object.
    const real = getCommerceRuntime();
    expect(real).not.toBeNull();
    if (real === null) throw new Error('unreachable');
    let sweeps = 0;
    installCommerceRuntime({
      ...real,
      admission: {
        ...real.admission,
        recoverAdmissions: () => {
          sweeps += 1;
          return real.admission.recoverAdmissions();
        },
      },
    } as unknown as CommerceRuntime);

    sweepers = startCommerceSweepers({
      admission: { engine: () => getCommerceRuntime()?.admission ?? null },
      epoch: { service: () => null },
    });

    // The claim that fails without the wiring: a sweep happened at start, not
    // one interval later and not never.
    expect(sweeps).toBe(1);
  });

  it('starts and stops cleanly on a node with commerce present but no epoch', async () => {
    // The ticks must not care whether commerce is live. This boot has a
    // runtime but no published epoch (§16.2), which is the ordinary state of
    // a node that has not provisioned a PDS repo — the sweep is quiet and
    // start/stop still succeed.
    const seed = new Uint8Array(32).fill(11);
    await initializeStorage(seed, dir, logger);
    sweepers = startCommerceSweepers({
      admission: { engine: () => getCommerceRuntime()?.admission ?? null },
      epoch: { service: () => null },
    });
    expect(() => sweepers?.stop()).not.toThrow();
  });
});
