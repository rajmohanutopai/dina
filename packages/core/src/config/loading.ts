/**
 * Configuration loading — environment variables and defaults.
 *
 * Validates required fields, applies defaults, and rejects invalid values.
 * Adapted from server config for mobile (no Docker-specific settings).
 *
 * Environment variables:
 *   DINA_CORE_URL            → listenAddr (default: ":8100")
 *   DINA_BRAIN_URL           → brainURL (default: "http://localhost:8200")
 *   DINA_VAULT_PATH          → vaultPath (default: "./data")
 *   DINA_SERVICE_KEY_DIR     → serviceKeyDir (default: "./service_keys")
 *   DINA_SECURITY_MODE       → securityMode (default: "security")
 *   DINA_SESSION_TTL         → sessionTTL (default: 86400)
 *   DINA_RATE_LIMIT          → rateLimit (default: 50)
 *   DINA_SPOOL_MAX           → spoolMaxMB (default: 500, in megabytes)
 *   DINA_MSGBOX_URL          → msgboxURL (optional)
 *   DINA_APPVIEW_URL         → appviewURL (optional)
 *   DINA_PDS_URL             → pdsURL (optional)
 *   DINA_PLC_URL             → plcURL (optional, default "https://plc.directory")
 *   DINA_PDS_HANDLE          → pdsHandle (optional, e.g. "busdriver.test-pds.dinakernel.com")
 *   DINA_PDS_ADMIN_PASSWORD  → pdsAdminPassword (optional, for first-run account creation)
 *
 * Source: core/test/config_test.go + docker-compose-test-stack.yml
 */

import { CORE_DEFAULT_PORT, DEFAULT_BRAIN_URL } from '../constants';

export const DEFAULT_PLC_URL = 'https://plc.directory';

export interface CoreConfig {
  listenAddr: string;
  brainURL: string;
  vaultPath: string;
  serviceKeyDir: string;
  securityMode: 'security' | 'convenience';
  sessionTTL: number;
  rateLimit: number;
  spoolMaxMB: number;
  msgboxURL?: string;
  appviewURL?: string;
  pdsURL?: string;
  plcURL: string;
  pdsHandle?: string;
  pdsAdminPassword?: string;
}

/** Default values for all config fields. */
const DEFAULTS: CoreConfig = {
  listenAddr: `:${CORE_DEFAULT_PORT}`,
  brainURL: DEFAULT_BRAIN_URL,
  vaultPath: './data',
  serviceKeyDir: './service_keys',
  securityMode: 'security',
  sessionTTL: 86400,
  rateLimit: 50,
  spoolMaxMB: 500,
  plcURL: DEFAULT_PLC_URL,
};

/**
 * Load configuration from environment variables with defaults.
 *
 * @param env - Environment variable map (defaults to process.env)
 */
export function loadConfig(env?: Record<string, string | undefined>): CoreConfig {
  const e = env ?? {};

  const securityMode = e.DINA_SECURITY_MODE;
  if (securityMode && securityMode !== 'security' && securityMode !== 'convenience') {
    throw new Error(
      `config: invalid security mode "${securityMode}" (must be "security" or "convenience")`,
    );
  }

  return {
    listenAddr: e.DINA_CORE_URL ?? DEFAULTS.listenAddr,
    brainURL: e.DINA_BRAIN_URL ?? DEFAULTS.brainURL,
    vaultPath: e.DINA_VAULT_PATH ?? DEFAULTS.vaultPath,
    serviceKeyDir: e.DINA_SERVICE_KEY_DIR ?? DEFAULTS.serviceKeyDir,
    securityMode: (securityMode as 'security' | 'convenience') ?? DEFAULTS.securityMode,
    sessionTTL: parseIntOrDefault(e.DINA_SESSION_TTL, DEFAULTS.sessionTTL),
    rateLimit: parseIntOrDefault(e.DINA_RATE_LIMIT, DEFAULTS.rateLimit),
    spoolMaxMB: parseIntOrDefault(e.DINA_SPOOL_MAX, DEFAULTS.spoolMaxMB),
    msgboxURL: e.DINA_MSGBOX_URL,
    appviewURL: e.DINA_APPVIEW_URL,
    pdsURL: e.DINA_PDS_URL,
    plcURL: e.DINA_PLC_URL ?? DEFAULTS.plcURL,
    pdsHandle: e.DINA_PDS_HANDLE,
    pdsAdminPassword: e.DINA_PDS_ADMIN_PASSWORD,
  };
}

/**
 * Validate a loaded config. Returns array of error messages (empty = valid).
 */
export function validateConfig(config: CoreConfig): string[] {
  const errors: string[] = [];

  if (!config.listenAddr) {
    errors.push('listenAddr is required');
  }

  if (!config.brainURL) {
    errors.push('brainURL is required');
  } else if (!isValidURL(config.brainURL)) {
    errors.push(`brainURL is not a valid URL: "${config.brainURL}"`);
  }

  if (!config.vaultPath) {
    errors.push('vaultPath is required');
  }

  if (!config.serviceKeyDir) {
    errors.push('serviceKeyDir is required');
  }

  if (config.securityMode !== 'security' && config.securityMode !== 'convenience') {
    errors.push(`securityMode must be "security" or "convenience", got "${config.securityMode}"`);
  }

  if (config.sessionTTL <= 0) {
    errors.push(`sessionTTL must be positive, got ${config.sessionTTL}`);
  }

  if (config.rateLimit < 0) {
    errors.push(`rateLimit must be non-negative, got ${config.rateLimit}`);
  }

  if (config.spoolMaxMB <= 0) {
    errors.push(`spoolMaxMB must be positive, got ${config.spoolMaxMB}`);
  }

  if (config.msgboxURL && !isValidURL(config.msgboxURL)) {
    errors.push(`msgboxURL is not a valid URL: "${config.msgboxURL}"`);
  }

  if (config.appviewURL && !isValidURL(config.appviewURL)) {
    errors.push(`appviewURL is not a valid URL: "${config.appviewURL}"`);
  }

  if (config.pdsURL && !isValidURL(config.pdsURL)) {
    errors.push(`pdsURL is not a valid URL: "${config.pdsURL}"`);
  }

  if (!config.plcURL) {
    errors.push('plcURL is required');
  } else if (!isValidURL(config.plcURL)) {
    errors.push(`plcURL is not a valid URL: "${config.plcURL}"`);
  }

  // pdsHandle and pdsAdminPassword: no format check — Handle is a string
  // the PDS validates, and password is opaque. Both optional.

  return errors;
}

/** Parse an integer from string, return default if missing or invalid. */
function parseIntOrDefault(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/** Basic URL validation — must start with http://, https://, ws://, or wss://. */
function isValidURL(url: string): boolean {
  return /^(?:https?|wss?):\/\/.+/.test(url);
}
