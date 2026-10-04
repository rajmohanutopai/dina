/**
 * A2A service parameters (spec §3.2.6, §3.6, §9.2): `A2A-Version` and
 * `A2A-Extensions`, carried as HTTP headers in the JSON-RPC binding.
 */

import { A2A_EMPTY_VERSION_MEANS, A2A_PROTOCOL_VERSION, A2A_VERSION_GRAMMAR } from './constants';

export type VersionCheck =
  | { ok: true; version: typeof A2A_PROTOCOL_VERSION }
  | { ok: false; requested: string };


/**
 * Accept `Major.Minor` = 1.0 (spec §3.6). The value comes from the
 * `A2A-Version` header, or, when the header is absent, from the request
 * parameter of the same name (§3.6: clients MAY send it that way). A missing
 * or empty value means 0.3 (§3.6). A patch number SHOULD NOT be sent, and
 * negotiation matches `Major.Minor` only, so `1.0.1` is read as `1.0`. A
 * non-canonical spelling (`01.0`, `1.00`) is not a version and is refused.
 */
export function checkRequestedVersion(
  header: string | undefined | null,
  requestParameter?: string | null,
): VersionCheck {
  const raw = header ?? requestParameter ?? '';
  const value = raw.trim();
  if (value === '') return { ok: false, requested: A2A_EMPTY_VERSION_MEANS };
  const match = A2A_VERSION_GRAMMAR.exec(value);
  if (match === null) return { ok: false, requested: value };
  const majorMinor = `${match[1] ?? ''}.${match[2] ?? ''}`;
  if (majorMinor !== A2A_PROTOCOL_VERSION) return { ok: false, requested: majorMinor };
  return { ok: true, version: A2A_PROTOCOL_VERSION };
}

/** Comma-separated extension URIs, trimmed, empty entries dropped, de-duplicated. */
export function parseExtensionsHeader(header: string | undefined | null): string[] {
  if (header === undefined || header === null) return [];
  const out: string[] = [];
  for (const raw of header.split(',')) {
    const uri = raw.trim();
    if (uri !== '' && !out.includes(uri)) out.push(uri);
  }
  return out;
}
