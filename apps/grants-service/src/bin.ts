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
import { SqliteGrantLedger } from './ledger';
import { OpenRouterProvisioner } from './openrouter_provisioner';
import { buildServer } from './server';

import type { DeviceState, KeyProvisioner } from './ports';

async function main(): Promise<void> {
  const degraded = process.env.GRANTS_ALLOW_DEGRADED === '1';
  const config = loadConfig(process.env, { requireSecrets: !degraded });
  if (degraded) config.paused = true;

  // DEV/E2E ONLY: bypass Apple so a simulator can drive a real mint.
  // Never set in production (deploy_shared_infra.sh does not set it).
  const fakeDeviceCheck = process.env.GRANTS_FAKE_DEVICECHECK === '1';
  const deviceState: DeviceState = fakeDeviceCheck
    ? new DevStubDeviceState()
    : new DeviceCheckClient({
        teamId: config.appleTeamId,
        keyId: config.deviceCheckKeyId,
        privateKeyPem: config.deviceCheckPrivateKey,
        env: config.deviceCheckEnv,
      });
  const provisioner: KeyProvisioner = new OpenRouterProvisioner({
    provisioningKey: config.openrouterProvisioningKey,
  });
  const ledger = new SqliteGrantLedger(config.dbPath);

  const app = await buildServer({ config, deviceState, provisioner, ledger });

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
