/**
 * Boot — wire real adapters from env config and serve.
 *
 * Degraded mode: with GRANTS_ALLOW_DEGRADED=1 the service boots without
 * secrets and serves getConfig (reporting paused/disabled) while every
 * claim refuses — useful for infra smoke tests and staged rollout.
 */

import { loadConfig } from './config';
import { DevStubDeviceState } from './dev_devicecheck_stub';
import { DeviceCheckClient } from './devicecheck';
import { GoogleAccessTokenMinter } from './google_oauth';
import { OpenRouterProvisioner } from './openrouter_provisioner';
import { PlayIntegrityClient } from './play_integrity';
import { SqliteGrantLedger } from './ledger';
import { buildServer } from './server';

import type { DeviceState, KeyProvisioner } from './ports';
import type { CreditsPlatform } from '@dina/protocol';

const PLAY_INTEGRITY_SCOPE = 'https://www.googleapis.com/auth/playintegrity';

async function main(): Promise<void> {
  const degraded = process.env.GRANTS_ALLOW_DEGRADED === '1';
  const config = loadConfig(process.env, { requireSecrets: !degraded });
  if (degraded) config.paused = true;

  // DEV/E2E ONLY: bypass Apple so a simulator can drive a real mint.
  // Never set in production (deploy_shared_infra.sh does not set it).
  const fakeDeviceCheck = process.env.GRANTS_FAKE_DEVICECHECK === '1';

  // One attestation backend per platform. iOS → DeviceCheck; Android →
  // Play Integrity. The dev stubs stand in only under their explicit dev
  // flags. A disabled platform is simply left unwired (platform gating
  // refuses it as `platform_disabled` before any backend is consulted).
  const deviceStates: Partial<Record<CreditsPlatform, DeviceState>> = {};

  if (fakeDeviceCheck) {
    deviceStates.ios = new DevStubDeviceState();
  } else if (config.enabledIos) {
    deviceStates.ios = new DeviceCheckClient({
      teamId: config.appleTeamId,
      keyId: config.deviceCheckKeyId,
      privateKeyPem: config.deviceCheckPrivateKey,
      env: config.deviceCheckEnv,
    });
  }

  if (config.devAllowAndroidClaim) {
    deviceStates.android = new DevStubDeviceState();
  } else if (config.enabledAndroid) {
    const minter = new GoogleAccessTokenMinter({
      serviceAccount: {
        clientEmail: config.googleServiceAccountEmail,
        privateKeyPem: config.googleServiceAccountPrivateKey,
      },
      scope: PLAY_INTEGRITY_SCOPE,
    });
    deviceStates.android = new PlayIntegrityClient({
      packageName: config.androidPackageName,
      tokenMinter: minter,
    });
  }

  // DEV/E2E ONLY: hand out a fixed pre-minted key instead of calling the
  // OpenRouter provisioning API, so the claim→mint→activate chain can be
  // driven without the crown-jewel provisioning key. Never set in prod.
  const devStaticKey = process.env.GRANTS_DEV_STATIC_KEY;
  const provisioner: KeyProvisioner =
    devStaticKey !== undefined && devStaticKey !== ''
      ? { createCappedKey: async () => ({ key: devStaticKey, orKeyId: 'dev-static' }) }
      : new OpenRouterProvisioner({ provisioningKey: config.openrouterProvisioningKey });
  const ledger = new SqliteGrantLedger(config.dbPath);

  const app = await buildServer({ config, deviceStates, provisioner, ledger });

  const shutdown = async (): Promise<void> => {
    await app.close();
    ledger.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: config.port, host: config.host });
  if (fakeDeviceCheck) {
    app.log.warn('⚠️  GRANTS_FAKE_DEVICECHECK=1 — Apple attestation BYPASSED. DEV/E2E ONLY.');
  }
  if (config.devAllowAndroidClaim) {
    app.log.warn('⚠️  GRANTS_DEV_ALLOW_ANDROID=1 — Android claim gate OPEN. DEV/E2E ONLY.');
  }
  if (devStaticKey !== undefined && devStaticKey !== '') {
    app.log.warn('⚠️  GRANTS_DEV_STATIC_KEY set — provisioning BYPASSED (fixed key). DEV/E2E ONLY.');
  }
  app.log.info(
    {
      port: config.port,
      ios: config.enabledIos,
      android: config.enabledAndroid,
      paused: config.paused,
      degraded,
      fakeDeviceCheck,
    },
    'grants service up',
  );
}

void main().catch((err) => {
  // Config errors are actionable and safe to print; nothing here is a secret.
  console.error('[grants] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
