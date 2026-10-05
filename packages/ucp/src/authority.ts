/**
 * Namespace authority binding (overview/index.md:847-969): an entity's
 * `schema` URL must be served from a host whose reversed labels equal the
 * entity's name or are a label-aligned prefix of it. It proves provenance
 * only, never trust, and is not a fetch-safety control: the resolved-address
 * checks of the policy transport apply separately.
 *
 * The check runs before any `schema` fetch; an entity that fails it is
 * treated as not present and never activated (:949-955).
 */

export type AuthorityCheck =
  | { ok: true; authorityPrefix: string }
  | {
      ok: false;
      reason:
        | 'unparseable'
        | 'not_https'
        | 'userinfo'
        | 'ip_literal'
        | 'single_label'
        | 'not_bound';
    };

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Why a WHATWG-parsed hostname cannot be a public DNS name (an IP literal, or
 * fewer than two labels), or null. One rule for schema authorities and for
 * merchant origins: neither can live at an address or a bare local name.
 */
export function hostNameProblem(hostname: string): 'ip_literal' | 'single_label' | null {
  if (hostname.startsWith('[') || IPV4_LITERAL.test(hostname)) return 'ip_literal';
  const labels = (hostname.endsWith('.') ? hostname.slice(0, -1) : hostname).split('.');
  return labels.length < 2 || labels.some((l) => l === '') ? 'single_label' : null;
}

/** The reversed-label authority of an https URL's host, or why it has none. */
export function authorityPrefixOf(schemaUrl: string): AuthorityCheck {
  let url: URL;
  try {
    url = new URL(schemaUrl);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'userinfo' };
  // WHATWG has already lower-cased the host and turned an IDN into A-labels.
  const problem = hostNameProblem(url.hostname);
  if (problem !== null) return { ok: false, reason: problem };
  const host = url.hostname.endsWith('.') ? url.hostname.slice(0, -1) : url.hostname;
  return { ok: true, authorityPrefix: host.split('.').reverse().join('.') };
}

/** Whether `name` is bound to `schemaUrl`'s host (exact or label-aligned prefix). */
export function checkAuthorityBinding(name: string, schemaUrl: string): AuthorityCheck {
  const prefix = authorityPrefixOf(schemaUrl);
  if (!prefix.ok) return prefix;
  const p = prefix.authorityPrefix;
  if (name === p || name.startsWith(`${p}.`)) return prefix;
  return { ok: false, reason: 'not_bound' };
}
