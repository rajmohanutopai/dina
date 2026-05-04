/**
 * Infrastructure URL preferences — PDS, AppView, MsgBox endpoints + the
 * provider-side PDS handle/password. Persisted in Keychain so a fresh
 * launch reads the user's choice without falling back to env vars.
 *
 * Boot priority for each field: stored preference > env var > built-in
 * default. The user-facing UI in Service Sharing writes via these
 * setters; `boot_capabilities.ts` reads via the getters at startup.
 *
 * Each field gets its own Keychain "service" key so partial-set state
 * (URL set but no password) is well-defined.
 */

import * as Keychain from 'react-native-keychain';

const SERVICE_PDS_URL = 'dina.infra.pds_url';
const SERVICE_PDS_HANDLE = 'dina.infra.pds_handle';
const SERVICE_PDS_PASSWORD = 'dina.infra.pds_password';
const SERVICE_PDS_EMAIL = 'dina.infra.pds_email';
const SERVICE_APPVIEW_URL = 'dina.infra.appview_url';

export interface InfraPreferences {
  pdsUrl: string | null;
  pdsHandle: string | null;
  pdsPassword: string | null;
  pdsEmail: string | null;
  appViewURL: string | null;
}

async function get(service: string): Promise<string | null> {
  const row = await Keychain.getGenericPassword({ service });
  if (!row) return null;
  const v = row.password ?? '';
  return v.length === 0 ? null : v;
}

async function set(service: string, value: string): Promise<void> {
  if (value.length === 0) {
    await Keychain.resetGenericPassword({ service });
    return;
  }
  await Keychain.setGenericPassword(service, value, { service });
}

export async function loadInfraPreferences(): Promise<InfraPreferences> {
  const [pdsUrl, pdsHandle, pdsPassword, pdsEmail, appViewURL] = await Promise.all([
    get(SERVICE_PDS_URL),
    get(SERVICE_PDS_HANDLE),
    get(SERVICE_PDS_PASSWORD),
    get(SERVICE_PDS_EMAIL),
    get(SERVICE_APPVIEW_URL),
  ]);
  return { pdsUrl, pdsHandle, pdsPassword, pdsEmail, appViewURL };
}

export async function savePdsUrl(value: string): Promise<void> {
  return set(SERVICE_PDS_URL, value.trim());
}
export async function savePdsHandle(value: string): Promise<void> {
  return set(SERVICE_PDS_HANDLE, value.trim());
}
export async function savePdsPassword(value: string): Promise<void> {
  return set(SERVICE_PDS_PASSWORD, value);
}
export async function savePdsEmail(value: string): Promise<void> {
  return set(SERVICE_PDS_EMAIL, value.trim());
}
export async function saveAppViewURL(value: string): Promise<void> {
  return set(SERVICE_APPVIEW_URL, value.trim());
}
