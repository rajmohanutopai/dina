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

import * as Keychain from './keychain';

export const DEFAULT_PDS_URL = 'https://test-pds.dinakernel.com';
export const DEFAULT_APPVIEW_URL = 'https://test-appview.dinakernel.com';

const SERVICE_PDS_URL = 'dina.infra.pds_url';
const SERVICE_PDS_HANDLE = 'dina.infra.pds_handle';
const SERVICE_PDS_PASSWORD = 'dina.infra.pds_password';
const SERVICE_PDS_EMAIL = 'dina.infra.pds_email';
const SERVICE_APPVIEW_URL = 'dina.infra.appview_url';
const SERVICE_SERVICES_APPVIEW_URL = 'dina.infra.services_appview_url';

export interface InfraPreferences {
  pdsUrl: string | null;
  pdsHandle: string | null;
  pdsPassword: string | null;
  pdsEmail: string | null;
  /** AppView used for PeerLens trust attestations. */
  appViewURL: string | null;
  /**
   * AppView used for service discovery. When null, falls back to
   * `appViewURL` — the common case where one AppView handles both.
   * Set this only when PeerLens and service discovery run on separate
   * AppView instances.
   */
  servicesAppViewURL: string | null;
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
  // P2.8: infra prefs include the PDS password (a secret) — keep every entry
  // device-bound (no iCloud/backup migration), readable after first unlock.
  await Keychain.setGenericPassword(service, value, {
    service,
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

export async function loadInfraPreferences(): Promise<InfraPreferences> {
  const [pdsUrl, pdsHandle, pdsPassword, pdsEmail, appViewURL, servicesAppViewURL] =
    await Promise.all([
      get(SERVICE_PDS_URL),
      get(SERVICE_PDS_HANDLE),
      get(SERVICE_PDS_PASSWORD),
      get(SERVICE_PDS_EMAIL),
      get(SERVICE_APPVIEW_URL),
      get(SERVICE_SERVICES_APPVIEW_URL),
    ]);
  return { pdsUrl, pdsHandle, pdsPassword, pdsEmail, appViewURL, servicesAppViewURL };
}

/** Effective URL for service discovery — falls back to appViewURL when no override is set. */
export function resolveServicesAppViewURL(prefs: InfraPreferences): string | null {
  return prefs.servicesAppViewURL ?? prefs.appViewURL;
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
export async function saveServicesAppViewURL(value: string): Promise<void> {
  return set(SERVICE_SERVICES_APPVIEW_URL, value.trim());
}
