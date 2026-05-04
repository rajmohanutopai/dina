export type HomeNodeEndpointMode = 'test' | 'release';

export interface HostedDinaEndpoints {
  mode: HomeNodeEndpointMode;
  msgboxWsUrl: string;
  pdsBaseUrl: string;
  appViewBaseUrl: string;
  plcDirectoryUrl: string;
}

export interface HomeNodeEndpointEnvKeys {
  mode: readonly string[];
  msgboxWsUrl: string;
  pdsBaseUrl: string;
  appViewBaseUrl: string;
  plcDirectoryUrl: string;
}

export type HomeNodeEndpointEnv = Readonly<Record<string, string | undefined>>;

export class HomeNodeEndpointConfigError extends Error {
  constructor(
    message: string,
    public readonly key?: string,
  ) {
    super(message);
    this.name = 'HomeNodeEndpointConfigError';
  }
}

export const SERVER_ENDPOINT_ENV_KEYS: HomeNodeEndpointEnvKeys = Object.freeze({
  mode: Object.freeze(['DINA_ENDPOINT_MODE']),
  msgboxWsUrl: 'DINA_MSGBOX_URL',
  pdsBaseUrl: 'DINA_PDS_URL',
  appViewBaseUrl: 'DINA_APPVIEW_URL',
  plcDirectoryUrl: 'DINA_PLC_URL',
});

export const MOBILE_ENDPOINT_ENV_KEYS: HomeNodeEndpointEnvKeys = Object.freeze({
  mode: Object.freeze(['EXPO_PUBLIC_DINA_ENDPOINT_MODE']),
  msgboxWsUrl: 'EXPO_PUBLIC_DINA_MSGBOX_URL',
  pdsBaseUrl: 'EXPO_PUBLIC_DINA_PDS_URL',
  appViewBaseUrl: 'EXPO_PUBLIC_DINA_APPVIEW_URL',
  plcDirectoryUrl: 'EXPO_PUBLIC_DINA_PLC_URL',
});

const TEST_ENDPOINTS: HostedDinaEndpoints = {
  mode: 'test',
  msgboxWsUrl: 'wss://test-mailbox.dinakernel.com/ws',
  pdsBaseUrl: 'https://test-pds.dinakernel.com',
  appViewBaseUrl: 'https://test-appview.dinakernel.com',
  plcDirectoryUrl: 'https://plc.directory',
};

const RELEASE_ENDPOINTS: HostedDinaEndpoints = {
  mode: 'release',
  msgboxWsUrl: 'wss://mailbox.dinakernel.com/ws',
  pdsBaseUrl: 'https://pds.dinakernel.com',
  appViewBaseUrl: 'https://appview.dinakernel.com',
  plcDirectoryUrl: 'https://plc.directory',
};

export function resolveHostedDinaEndpoints(
  mode: HomeNodeEndpointMode = 'test',
): HostedDinaEndpoints {
  switch (mode) {
    case 'test':
      return { ...TEST_ENDPOINTS };
    case 'release':
      return { ...RELEASE_ENDPOINTS };
  }
}

export function resolveHostedDinaEndpointsFromEnv(
  env: HomeNodeEndpointEnv,
  keys: HomeNodeEndpointEnvKeys,
): HostedDinaEndpoints {
  const mode = resolveEndpointMode(env, keys.mode);
  const base = resolveHostedDinaEndpoints(mode);
  return {
    mode,
    msgboxWsUrl: readURL(env, keys.msgboxWsUrl, base.msgboxWsUrl, ['ws:', 'wss:']),
    pdsBaseUrl: stripTrailingSlash(
      readURL(env, keys.pdsBaseUrl, base.pdsBaseUrl, ['http:', 'https:']),
    ),
    appViewBaseUrl: stripTrailingSlash(
      readURL(env, keys.appViewBaseUrl, base.appViewBaseUrl, ['http:', 'https:']),
    ),
    plcDirectoryUrl: stripTrailingSlash(
      readURL(env, keys.plcDirectoryUrl, base.plcDirectoryUrl, ['http:', 'https:']),
    ),
  };
}

export function resolveServerHostedDinaEndpoints(
  env: HomeNodeEndpointEnv = currentEnv(),
): HostedDinaEndpoints {
  return resolveHostedDinaEndpointsFromEnv(env, SERVER_ENDPOINT_ENV_KEYS);
}

export function resolveMobileHostedDinaEndpoints(
  env: HomeNodeEndpointEnv = currentEnv(),
): HostedDinaEndpoints {
  return resolveHostedDinaEndpointsFromEnv(env, MOBILE_ENDPOINT_ENV_KEYS);
}

export function pdsHostForEndpoints(endpoints: Pick<HostedDinaEndpoints, 'pdsBaseUrl'>): string {
  try {
    return new URL(endpoints.pdsBaseUrl).host;
  } catch {
    throw new HomeNodeEndpointConfigError(
      `PDS URL must be absolute (got ${JSON.stringify(endpoints.pdsBaseUrl)})`,
      'pdsBaseUrl',
    );
  }
}

function resolveEndpointMode(
  env: HomeNodeEndpointEnv,
  keys: readonly string[],
): HomeNodeEndpointMode {
  for (const key of keys) {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') continue;
    return parseEndpointMode(raw, key);
  }
  return 'test';
}

function parseEndpointMode(raw: string, key: string): HomeNodeEndpointMode {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'test') return 'test';
  if (normalized === 'release') return 'release';
  throw new HomeNodeEndpointConfigError(
    `${key} must be "test" or "release" (got ${JSON.stringify(raw)})`,
    key,
  );
}

function readURL(
  env: HomeNodeEndpointEnv,
  key: string,
  defaultValue: string,
  allowedProtocols: readonly string[],
): string {
  const raw = env[key];
  const value = raw === undefined || raw.trim() === '' ? defaultValue : raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HomeNodeEndpointConfigError(
      `${key} must be an absolute URL (got ${JSON.stringify(value)})`,
      key,
    );
  }
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new HomeNodeEndpointConfigError(
      `${key} protocol must be ${allowedProtocols.join(' or ')} (got ${JSON.stringify(
        parsed.protocol,
      )})`,
      key,
    );
  }
  return value;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function currentEnv(): HomeNodeEndpointEnv {
  return typeof process === 'undefined' ? {} : process.env;
}
