/**
 * Guards the Expo-safe hosted-endpoint resolution. The original release bug was
 * the package resolving env via a dynamic `env[key]` lookup that Expo doesn't
 * inline -> a production build fell back to the TEST fleet (test-pds etc.) while
 * createAccount hit prod, breaking onboarding. jest can't reproduce Expo's
 * static-inline transform, but these tests lock the WIRING: the helper must read
 * every EXPO_PUBLIC_* key and resolve the prod fleet under ENDPOINT_MODE=release
 * (so dropping a key or mis-mapping the mode regresses loudly).
 */
import { mobileHostedEndpoints } from '../../src/services/hosted_endpoints';

const ENV_KEYS = [
  'EXPO_PUBLIC_DINA_ENDPOINT_MODE',
  'EXPO_PUBLIC_DINA_MSGBOX_URL',
  'EXPO_PUBLIC_DINA_PDS_URL',
  'EXPO_PUBLIC_DINA_APPVIEW_URL',
  'EXPO_PUBLIC_DINA_PLC_URL',
] as const;

describe('mobileHostedEndpoints', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('resolves the prod fleet when ENDPOINT_MODE=release', () => {
    process.env.EXPO_PUBLIC_DINA_ENDPOINT_MODE = 'release';
    const ep = mobileHostedEndpoints();
    expect(ep.mode).toBe('release');
    expect(ep.pdsBaseUrl).toBe('https://pds.dinakernel.com');
    expect(ep.appViewBaseUrl).toBe('https://appview.dinakernel.com');
    expect(ep.msgboxWsUrl).toBe('wss://mailbox.dinakernel.com/ws');
  });

  it('defaults to the test fleet when no mode is set', () => {
    const ep = mobileHostedEndpoints();
    expect(ep.mode).toBe('test');
    expect(ep.pdsBaseUrl).toBe('https://test-pds.dinakernel.com');
  });

  it('honors an explicit per-URL override (release mode)', () => {
    process.env.EXPO_PUBLIC_DINA_ENDPOINT_MODE = 'release';
    process.env.EXPO_PUBLIC_DINA_PDS_URL = 'https://pds.example.test';
    expect(mobileHostedEndpoints().pdsBaseUrl).toBe('https://pds.example.test');
  });
});
