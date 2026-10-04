/**
 * The URL rule for every outbound A2A connection (design §6.6): HTTPS only,
 * no credentials in the URL, no literal IP address (an address must come
 * from resolution, where the host checks it), a bounded length, no
 * fragment. The address check itself is the host transport's, on the
 * resolved answer. One rule wherever a URL may become a connection: Core's
 * registration, credentials and webhooks, and Brain's directory candidates.
 */

const MAX_URL_LENGTH = 2048;

export type OutboundUrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

function isLiteralIp(hostname: string): boolean {
  if (hostname.startsWith('[')) return true; // IPv6 literal
  // WHATWG URL parsing already turns every IPv4 spelling (hex, octal,
  // shortened) into dotted decimal, so one pattern catches them all.
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

export function checkOutboundUrl(raw: string): OutboundUrlCheck {
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) return { ok: false, reason: 'url_length' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'url_unparseable' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials_in_url' };
  if (url.hostname === '') return { ok: false, reason: 'no_host' };
  if (isLiteralIp(url.hostname)) return { ok: false, reason: 'literal_ip' };
  if (url.hash !== '') return { ok: false, reason: 'fragment' };
  return { ok: true, url };
}
