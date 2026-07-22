/**
 * PSVC-0 — the lite Core `wireWorkflowPlane` must register the WatchService so
 * the owner subscription routes (`/v1/watch/*`) resolve `getWatchService()`
 * instead of 503-ing. Before this wiring the watch service lived only in the
 * mobile boot, so subscriptions were unreachable on the split server.
 *
 * This drives the REAL `wireWorkflowPlane` with a locally-fabricated identity
 * (no PDS account) and asserts the watch service is wired + functional, and
 * that `dispose()` deregisters it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { pino } from 'pino';

import { createCoreRouter, getWatchService } from '@dina/core';

import { deriveIdentity } from '../src/identity/derivations';
import { initializeStorage } from '../src/storage/init';
import { wireWorkflowPlane, type WiredWorkflowPlane } from '../src/workflow/wire_workflow_plane';

import type { PdsIdentity } from '../src/identity/provision_pds';

const logger = pino({ level: 'silent' });

describe('wireWorkflowPlane registers the WatchService (subscriptions)', () => {
  let dir: string;
  let wired: WiredWorkflowPlane | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'watch-wiring-'));
  });

  afterEach(async () => {
    if (wired !== undefined) await wired.dispose();
    wired = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('wires getWatchService() and can create + list a poll watch; dispose deregisters', async () => {
    // 32-byte deterministic seed → identity DB + root signing key (no network).
    const seed = new Uint8Array(32).fill(7);
    const { identityDB } = await initializeStorage(seed, dir, logger);
    const derivations = deriveIdentity({ masterSeed: seed });
    const coreRouter = createCoreRouter({});

    // A locally-fabricated identity struct — NOT a provisioned PDS account.
    const pdsIdentity: PdsIdentity = {
      did: 'did:plc:localwatchtest0000000000000',
      handle: 'watchtest.local',
      password: 'x',
      email: 'watchtest@local',
      pdsUrl: 'https://pds.invalid',
    };

    expect(getWatchService()).toBeNull(); // not wired yet

    wired = wireWorkflowPlane({
      identityDB,
      pdsIdentity,
      signingKeypair: {
        publicKey: derivations.root.publicKey,
        privateKey: derivations.root.privateKey,
      },
      msgboxURL: 'wss://msgbox.invalid',
      appViewURL: 'https://appview.invalid',
      coreRouter,
      brainUrl: 'http://127.0.0.1:8299',
      logger,
    });

    const svc = getWatchService();
    expect(svc).not.toBeNull(); // ← the fix: the subscriptions route no longer 503s
    if (svc === null) throw new Error('unreachable');

    const task = svc.createPollWatch({
      subscription_id: 'sub-wiring-1',
      persona: 'general',
      service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
      provider_did: 'did:plc:prov',
      capability: 'com.dinakernel.capability.status',
      poll_interval_sec: 60,
      query: {},
    });
    expect(typeof task.id).toBe('string');
    expect(svc.listActive().some((t) => t.id === task.id)).toBe(true);

    await wired.dispose();
    wired = undefined;
    expect(getWatchService()).toBeNull(); // dispose deregistered the global
  });
});
