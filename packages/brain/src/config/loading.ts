/**
 * Brain configuration loading — environment variables and defaults.
 *
 * Environment variables:
 *   DINA_CORE_URL            → coreURL
 *   DINA_BRAIN_PORT          → listenPort
 *   DINA_SERVICE_KEY_DIR     → serviceKeyDir
 *   DINA_LOG_LEVEL           → logLevel
 *   DINA_LLM_URL             → llmURL (optional)
 *   DINA_APPVIEW_URL         → appviewURL (optional)
 *   DINA_PDS_URL             → pdsURL (optional)
 *   DINA_PLC_URL             → plcURL (default "https://plc.directory")
 *   DINA_PDS_HANDLE          → pdsHandle (optional)
 *   DINA_PDS_ADMIN_PASSWORD  → pdsAdminPassword (optional)
 *
 * Source: brain/tests/test_config.py + docker-compose-test-stack.yml
 */

import { DEFAULT_CORE_URL, BRAIN_DEFAULT_PORT } from '../../../core/src/constants';

export const DEFAULT_PLC_URL = 'https://plc.directory';

export interface BrainConfig {
  coreURL: string;
  listenPort: number;
  serviceKeyDir: string;
  logLevel: string;
  llmURL?: string;
  appviewURL?: string;
  pdsURL?: string;
  plcURL: string;
  pdsHandle?: string;
  pdsAdminPassword?: string;
}

const DEFAULTS: BrainConfig = {
  coreURL: DEFAULT_CORE_URL,
  listenPort: BRAIN_DEFAULT_PORT,
  serviceKeyDir: './service_keys',
  logLevel: 'info',
  plcURL: DEFAULT_PLC_URL,
};

/** Load brain config from environment variables. */
export function loadBrainConfig(env?: Record<string, string | undefined>): BrainConfig {
  const e = env ?? {};
  return {
    coreURL: e.DINA_CORE_URL ?? DEFAULTS.coreURL,
    listenPort: parseIntOrDefault(e.DINA_BRAIN_PORT, DEFAULTS.listenPort),
    serviceKeyDir: e.DINA_SERVICE_KEY_DIR ?? DEFAULTS.serviceKeyDir,
    logLevel: e.DINA_LOG_LEVEL ?? DEFAULTS.logLevel,
    llmURL: e.DINA_LLM_URL,
    appviewURL: e.DINA_APPVIEW_URL,
    pdsURL: e.DINA_PDS_URL,
    plcURL: e.DINA_PLC_URL ?? DEFAULTS.plcURL,
    pdsHandle: e.DINA_PDS_HANDLE,
    pdsAdminPassword: e.DINA_PDS_ADMIN_PASSWORD,
  };
}

/** Validate brain config. Returns array of errors (empty = valid). */
export function validateBrainConfig(config: BrainConfig): string[] {
  const errors: string[] = [];
  if (!config.coreURL) errors.push('coreURL is required');
  else if (!/^https?:\/\/.+/.test(config.coreURL))
    errors.push(`coreURL is not a valid URL: "${config.coreURL}"`);
  if (!config.serviceKeyDir) errors.push('serviceKeyDir is required');
  if (config.listenPort <= 0 || config.listenPort > 65535)
    errors.push(`listenPort must be 1-65535, got ${config.listenPort}`);
  if (config.llmURL && !/^https?:\/\/.+/.test(config.llmURL))
    errors.push(`llmURL is not a valid URL: "${config.llmURL}"`);
  if (config.appviewURL && !/^https?:\/\/.+/.test(config.appviewURL))
    errors.push(`appviewURL is not a valid URL: "${config.appviewURL}"`);
  if (config.pdsURL && !/^https?:\/\/.+/.test(config.pdsURL))
    errors.push(`pdsURL is not a valid URL: "${config.pdsURL}"`);
  if (!config.plcURL) errors.push('plcURL is required');
  else if (!/^https?:\/\/.+/.test(config.plcURL))
    errors.push(`plcURL is not a valid URL: "${config.plcURL}"`);
  return errors;
}

function parseIntOrDefault(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}
