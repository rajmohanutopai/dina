/**
 * Config — defaults, parsing, the fat-finger guard on the grant cap,
 * and the secrets requirement (with the degraded escape hatch).
 */

import { loadConfig } from '../src/config';

const SECRETS = {
  OPENROUTER_PROVISIONING_KEY: 'prov',
  APPLE_TEAM_ID: 'TEAM',
  DEVICECHECK_KEY_ID: 'KID',
  DEVICECHECK_PRIVATE_KEY: 'PEM',
};

describe('loadConfig', () => {
  it('applies spec defaults (ios on, android OFF, $0.25, v4-pro pin)', () => {
    const cfg = loadConfig({ ...SECRETS });
    expect(cfg.enabledIos).toBe(true);
    expect(cfg.enabledAndroid).toBe(false);
    expect(cfg.paused).toBe(false);
    expect(cfg.grantUsd).toBe(0.25);
    expect(cfg.modelPin).toBe('deepseek/deepseek-v4-pro');
    expect(cfg.estConversations).toBe(40);
    expect(cfg.maxGrantsPerDay).toBe(500);
    expect(cfg.deviceCheckEnv).toBe('development');
  });

  it('parses overrides', () => {
    const cfg = loadConfig({
      ...SECRETS,
      GRANTS_GRANT_USD: '0.5',
      GRANTS_ENABLED_ANDROID: 'true',
      GRANTS_PAUSED: '1',
      DEVICECHECK_ENV: 'production',
      GRANTS_MAX_PER_DAY: '50',
    });
    expect(cfg.grantUsd).toBe(0.5);
    expect(cfg.enabledAndroid).toBe(true);
    expect(cfg.paused).toBe(true);
    expect(cfg.deviceCheckEnv).toBe('production');
    expect(cfg.maxGrantsPerDay).toBe(50);
  });

  it('refuses a fat-fingered cap (the most expensive typo possible)', () => {
    expect(() => loadConfig({ ...SECRETS, GRANTS_GRANT_USD: '25' })).toThrow(/sane range/);
    expect(() => loadConfig({ ...SECRETS, GRANTS_GRANT_USD: '0' })).toThrow(/sane range/);
    expect(() => loadConfig({ ...SECRETS, GRANTS_GRANT_USD: '-1' })).toThrow(/sane range/);
  });

  it('requires secrets by default, names the missing ones', () => {
    expect(() => loadConfig({})).toThrow(/OPENROUTER_PROVISIONING_KEY/);
    expect(() => loadConfig({ OPENROUTER_PROVISIONING_KEY: 'p' })).toThrow(/APPLE_TEAM_ID/);
  });

  it('does not require Apple secrets when ios grants are disabled', () => {
    const cfg = loadConfig({
      OPENROUTER_PROVISIONING_KEY: 'p',
      GRANTS_ENABLED_IOS: 'false',
    });
    expect(cfg.enabledIos).toBe(false);
  });

  it('degraded mode boots without any secrets', () => {
    const cfg = loadConfig({}, { requireSecrets: false });
    expect(cfg.openrouterProvisioningKey).toBe('');
  });

  it('rejects garbage numerics and booleans loudly', () => {
    expect(() => loadConfig({ ...SECRETS, GRANTS_GRANT_USD: 'lots' })).toThrow(/must be a number/);
    expect(() => loadConfig({ ...SECRETS, GRANTS_PAUSED: 'maybe' })).toThrow(/true\/false/);
  });
});
