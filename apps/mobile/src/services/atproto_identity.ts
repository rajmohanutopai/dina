import { defaultFetch } from '@dina/core';

import { loadInfraPreferences } from './infra_preferences';

const DEFAULT_PLC_URL = 'https://plc.directory';
const HANDLE_RESOLUTION_FALLBACKS = [
  'https://bsky.social',
  'https://public.api.bsky.app',
] as const;

export interface PlcOperationData {
  did: string;
  handle: string | null;
  pdsUrl: string;
  rotationKeys: string[];
  alsoKnownAs: string[];
  verificationMethods: Record<string, string>;
  services: Record<string, { type: string; endpoint: string }>;
}

export interface ResolveExistingAtprotoIdentityOptions {
  plcURL?: string;
  fetchFn?: typeof globalThis.fetch;
}

export async function resolveExistingAtprotoIdentity(
  identifier: string,
  options: ResolveExistingAtprotoIdentityOptions = {},
): Promise<PlcOperationData> {
  const fetchFn = options.fetchFn ?? defaultFetch();
  const plcURL = (options.plcURL ?? process.env.EXPO_PUBLIC_DINA_PLC_URL ?? DEFAULT_PLC_URL)
    .replace(/\/$/, '');
  const normalized = normalizeIdentifier(identifier);
  const did = normalized.startsWith('did:')
    ? validateDidPlc(normalized)
    : await resolveHandleToDid(normalized, fetchFn);
  return fetchPlcOperationData(did, plcURL, fetchFn, normalized.startsWith('did:') ? null : normalized);
}

export function normalizeIdentifier(identifier: string): string {
  return identifier
    .trim()
    .replace(/^at:\/\//i, '')
    .replace(/^@/, '')
    .toLowerCase();
}

async function resolveHandleToDid(
  handle: string,
  fetchFn: typeof globalThis.fetch,
): Promise<string> {
  if (handle.length === 0) throw new Error('Enter an AT Protocol handle or did:plc');
  if (handle.includes('/') || handle.includes(' ')) {
    throw new Error('AT Protocol handles cannot contain spaces or slashes');
  }

  const wellKnownDid = await resolveHandleViaWellKnown(handle, fetchFn);
  if (wellKnownDid !== null) return wellKnownDid;

  const infra = await loadInfraPreferences();
  const endpoints = [
    infra.pdsUrl,
    process.env.EXPO_PUBLIC_DINA_PDS_URL,
    ...HANDLE_RESOLUTION_FALLBACKS,
  ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);

  let lastError: string | null = null;
  for (const endpoint of unique(endpoints)) {
    try {
      const did = await resolveHandleViaXrpc(handle, endpoint, fetchFn);
      if (did !== null) return did;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  throw new Error(
    lastError === null
      ? `Could not resolve ${handle}`
      : `Could not resolve ${handle}: ${lastError}`,
  );
}

async function resolveHandleViaWellKnown(
  handle: string,
  fetchFn: typeof globalThis.fetch,
): Promise<string | null> {
  try {
    const res = await fetchFn(`https://${handle}/.well-known/atproto-did`, {
      headers: { Accept: 'text/plain' },
    });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text.startsWith('did:plc:') ? text : null;
  } catch {
    return null;
  }
}

async function resolveHandleViaXrpc(
  handle: string,
  pdsUrl: string,
  fetchFn: typeof globalThis.fetch,
): Promise<string | null> {
  const base = pdsUrl.replace(/\/$/, '');
  const url = `${base}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`;
  const res = await fetchFn(url, { headers: { Accept: 'application/json' } });
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) throw new Error(`${new URL(base).host} returned HTTP ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const did = body.did;
  return typeof did === 'string' && did.startsWith('did:plc:') ? did : null;
}

async function fetchPlcOperationData(
  did: string,
  plcURL: string,
  fetchFn: typeof globalThis.fetch,
  fallbackHandle: string | null,
): Promise<PlcOperationData> {
  const res = await fetchFn(`${plcURL}/${did}/data`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`PLC directory returned HTTP ${res.status} for ${did}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  const rotationKeys = readStringArray(body.rotationKeys);
  if (rotationKeys.length === 0) {
    throw new Error(`${did} has no PLC rotation keys`);
  }
  const services = readServicesMap(body.services);
  const pdsUrl = services.atproto_pds?.endpoint ?? null;
  if (pdsUrl === null) {
    throw new Error(`${did} does not advertise an atproto PDS service`);
  }
  const alsoKnownAs = readStringArray(body.alsoKnownAs);
  const handle = handleFromAlsoKnownAs(alsoKnownAs) ?? fallbackHandle;
  return {
    did,
    handle,
    pdsUrl,
    rotationKeys,
    alsoKnownAs,
    verificationMethods: readStringMap(body.verificationMethods),
    services,
  };
}

function validateDidPlc(did: string): string {
  if (!did.startsWith('did:plc:')) {
    throw new Error('Dina currently supports existing did:plc identities only');
  }
  return did;
}

function handleFromAlsoKnownAs(values: string[]): string | null {
  for (const value of values) {
    if (!value.startsWith('at://')) continue;
    const handle = value.slice('at://'.length).trim();
    if (handle.length > 0) return handle;
  }
  return null;
}

function readStringMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === 'string') out[key] = val;
  }
  return out;
}

function readServicesMap(value: unknown): Record<string, { type: string; endpoint: string }> {
  if (value === null || typeof value !== 'object') return {};
  const out: Record<string, { type: string; endpoint: string }> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (val === null || typeof val !== 'object') continue;
    const entry = val as Record<string, unknown>;
    const type = typeof entry.type === 'string' ? entry.type : '';
    const endpoint = typeof entry.endpoint === 'string' ? entry.endpoint : '';
    if (type !== '' && endpoint !== '') out[key] = { type, endpoint };
  }
  return out;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim().replace(/\/$/, '')).filter(Boolean))];
}
