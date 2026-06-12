/**
 * Grants service configuration — env-driven, validated at boot.
 *
 * Secrets in this process (and ONLY this process, by design —
 * docs/CREDITS_DESIGN.md "isolated because it holds two secrets"):
 *   - OPENROUTER_PROVISIONING_KEY — mints spend-capped runtime keys.
 *   - DEVICECHECK_PRIVATE_KEY — Apple .p8 (ES256) for DeviceCheck API.
 *
 * Everything user-visible (grant size, model pin, estimate, per-platform
 * enablement, the kill switch) is config so it can change without an
 * app release — the client renders from `getConfig`.
 */

export interface GrantsConfig {
  port: number;
  host: string;
  /** SQLite ledger path. ':memory:' allowed for tests. */
  dbPath: string;

  /** Per-platform enablement. Android ships FALSE until Play Integrity
   *  verification is done (spec: no weak path for symmetry's sake). */
  enabledIos: boolean;
  enabledAndroid: boolean;
  /** Kill switch — overrides everything; getConfig reports disabled. */
  paused: boolean;

  /** Cap for newly provisioned keys, USD. */
  grantUsd: number;
  /** Model id the client pins all tiers to while on credits. */
  modelPin: string;
  /** Server-side "≈ N conversations" estimate for the grant. */
  estConversations: number;

  /** Hard daily ceiling on grants minted (global). 0 = unlimited. */
  maxGrantsPerDay: number;

  /** OpenRouter provisioning (management) key. */
  openrouterProvisioningKey: string;
  /** Apple DeviceCheck credentials. */
  appleTeamId: string;
  deviceCheckKeyId: string;
  /** PEM/PKCS8 contents of the .p8 (NOT a path — inject via secret). */
  deviceCheckPrivateKey: string;
  /** Apple environment: api.development vs api. */
  deviceCheckEnv: 'development' | 'production';
}

class ConfigError extends Error {}

function num(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ConfigError(`${key} must be a number, got '${raw}'`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, key: string, dflt: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return dflt;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new ConfigError(`${key} must be true/false/1/0, got '${raw}'`);
}

function str(env: NodeJS.ProcessEnv, key: string, dflt: string): string {
  const raw = env[key];
  return raw === undefined || raw === '' ? dflt : raw;
}

/**
 * Load + validate config from env. `requireSecrets: false` lets the
 * service boot in a degraded paused mode without secrets (useful for
 * smoke tests and for getConfig-only operation); claims then refuse
 * with `grants_paused`.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: { requireSecrets?: boolean } = {},
): GrantsConfig {
  const cfg: GrantsConfig = {
    port: num(env, 'GRANTS_PORT', 8300),
    host: str(env, 'GRANTS_HOST', '0.0.0.0'),
    dbPath: str(env, 'GRANTS_DB_PATH', './grants.sqlite'),

    enabledIos: bool(env, 'GRANTS_ENABLED_IOS', true),
    enabledAndroid: bool(env, 'GRANTS_ENABLED_ANDROID', false),
    paused: bool(env, 'GRANTS_PAUSED', false),

    grantUsd: num(env, 'GRANTS_GRANT_USD', 0.25),
    modelPin: str(env, 'GRANTS_MODEL_PIN', 'deepseek/deepseek-v4-pro'),
    estConversations: num(env, 'GRANTS_EST_CONVERSATIONS', 40),
    maxGrantsPerDay: num(env, 'GRANTS_MAX_PER_DAY', 500),

    openrouterProvisioningKey: str(env, 'OPENROUTER_PROVISIONING_KEY', ''),
    appleTeamId: str(env, 'APPLE_TEAM_ID', ''),
    deviceCheckKeyId: str(env, 'DEVICECHECK_KEY_ID', ''),
    // .p8 PEM rides env vars \n-escaped (compose/.env are single-line);
    // unescape so createPrivateKey gets real newlines (review P2).
    deviceCheckPrivateKey: str(env, 'DEVICECHECK_PRIVATE_KEY', '').replace(/\\n/g, '\n'),
    deviceCheckEnv:
      str(env, 'DEVICECHECK_ENV', 'development') === 'production' ? 'production' : 'development',
  };

  if (cfg.grantUsd <= 0 || cfg.grantUsd > 5) {
    // A fat-fingered cap is the most expensive config typo possible —
    // refuse anything outside sachet range at boot.
    throw new ConfigError(`GRANTS_GRANT_USD out of sane range (0, 5]: ${cfg.grantUsd}`);
  }
  if (cfg.estConversations < 0) throw new ConfigError('GRANTS_EST_CONVERSATIONS must be >= 0');
  if (cfg.maxGrantsPerDay < 0) throw new ConfigError('GRANTS_MAX_PER_DAY must be >= 0');

  if (opts.requireSecrets ?? true) {
    const missing: string[] = [];
    if (cfg.openrouterProvisioningKey === '') missing.push('OPENROUTER_PROVISIONING_KEY');
    if (cfg.enabledIos) {
      if (cfg.appleTeamId === '') missing.push('APPLE_TEAM_ID');
      if (cfg.deviceCheckKeyId === '') missing.push('DEVICECHECK_KEY_ID');
      if (cfg.deviceCheckPrivateKey === '') missing.push('DEVICECHECK_PRIVATE_KEY');
    }
    if (missing.length > 0) {
      throw new ConfigError(`missing required secrets: ${missing.join(', ')}`);
    }
  }
  return cfg;
}
