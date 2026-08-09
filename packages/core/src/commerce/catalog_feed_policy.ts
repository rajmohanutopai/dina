/**
 * Catalog feed fetch policy (§10.3).
 *
 * A large catalog may live behind an HTTPS feed whose digest the supplier pins
 * in their repo. That makes the feed URL SUPPLIER-CONTROLLED INPUT pointed at
 * our own network stack — the classic SSRF shape. The spec says so plainly:
 * "AppView fetchers treat the feed URL as hostile input."
 *
 * This module is PURE POLICY and performs no I/O. That split is deliberate.
 * The dangerous part of a fetcher is the decision, not the socket, and a
 * decision function can be tested against every address form an attacker
 * would try. A fetcher calls these; nothing here can be talked into a request.
 *
 * WHY THE ADDRESS CHECK RUNS TWICE. A hostname that resolves to a public
 * address when validated can resolve to 169.254.169.254 when connected — DNS
 * rebinding. So the URL check is not sufficient and never claims to be:
 * `isBlockedAddress` must ALSO run against the address actually connected to,
 * on every redirect hop. A fetcher that only validates the URL has not
 * implemented this policy.
 */

/** §10.3 caps. Bounded work before any of it is trusted. */
export const CATALOG_FEED_LIMITS = {
  /** ONE response, compressed. */
  maxBytes: 8 * 1024 * 1024,
  /**
   * Every response of one ingest added together. The per-response cap alone
   * bounds nothing useful when a snapshot may name a thousand pages: a feed
   * that serves the maximum each time would be within policy and still cost
   * gigabytes.
   */
  maxTotalBytes: 64 * 1024 * 1024,
  /** Wall-clock for a whole ingest, including redirects and every page. */
  maxMillis: 60_000,
  maxRedirects: 3,
  /**
   * Decompressed:compressed ratio. A gzip bomb is small on the wire and vast
   * in memory, so the byte cap alone does not bound it.
   */
  maxDecompressionRatio: 100,
  maxDecompressedBytes: 64 * 1024 * 1024,
} as const;

export type FeedUrlRefusal =
  | 'not_https'
  | 'credentials_in_url'
  | 'blocked_address'
  | 'unresolvable_shape';

const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/octet-stream',
]);

/**
 * Media types a SPREADSHEET connector may serve (WS-9.1).
 *
 * A separate set rather than three more entries in the one above, because
 * these two allow-lists answer different questions. A catalog FEED serves
 * signed records this code parses as JSON; a spreadsheet serves CSV. Widening
 * the feed's list to accept `text/csv` would let a feed host serve something
 * the feed parser cannot read, which is a refusal a hop later and a wider
 * surface for no gain.
 *
 * `application/octet-stream` appears in both because exporters routinely serve
 * a CSV download that way, and refusing it would refuse most real spreadsheets.
 */
export const SPREADSHEET_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/octet-stream',
]);

/**
 * Reject anything that is not a plain HTTPS URL to a host we may talk to.
 *
 * HTTPS ONLY, and not merely "not http": `file:`, `ftp:`, `gopher:` and
 * friends are all ways to make a fetcher read something local. An allow-list
 * of one scheme is the only version of this that stays correct as URL parsers
 * gain features.
 */
export function checkCatalogFeedUrl(raw: string): FeedUrlRefusal | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'unresolvable_shape';
  }
  if (url.protocol !== 'https:') return 'not_https';
  // `https://user:pass@host/` leaks credentials into logs and lets a URL
  // smuggle an identity past a reviewer reading only the host.
  if (url.username !== '' || url.password !== '') return 'credentials_in_url';
  if (url.hostname === '') return 'unresolvable_shape';
  // A hostname that is ALREADY a literal address can be judged now. A name
  // cannot — that is what the connect-time check is for.
  const literal = parseIpLiteral(url.hostname);
  if (literal !== null && isBlockedAddress(literal)) return 'blocked_address';
  return null;
}

/**
 * Normalise a hostname that is an IP literal, or null when it is a name.
 *
 * Handles the bracketed IPv6 form the URL parser leaves in place. Decimal and
 * octal IPv4 shorthands (`https://2130706433/`) are NOT decoded here on
 * purpose: `new URL` already normalises them to dotted quad, and re-parsing
 * them ourselves would be a second, disagreeing implementation.
 */
function parseIpLiteral(hostname: string): string | null {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1).toLowerCase();
  }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ? hostname : null;
}

/**
 * Is this address one a catalog fetch must never reach?
 *
 * Called by the fetcher against the address it ACTUALLY connected to, on every
 * hop. Covers loopback, private ranges, link-local (which is where the cloud
 * metadata endpoint lives), carrier-grade NAT, and the IPv6 equivalents
 * including the IPv4-mapped form that otherwise smuggles 127.0.0.1 past an
 * IPv4-only check.
 */
export function isBlockedAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  if (value === '') return true;

  // IPv6, including the ::ffff:a.b.c.d mapped form.
  if (value.includes(':')) {
    if (value === '::' || value === '::1') return true;
    // Unique-local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd]/.test(value)) return true;
    if (/^fe[89ab]/.test(value)) return true;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
    if (mapped !== null) return isBlockedAddress(mapped[1]);
    // An IPv4-mapped address written in hex still resolves to IPv4 space; we
    // cannot decode every form, so anything else containing ':' that is not
    // plainly a global unicast address is refused rather than guessed at.
    return !/^[23][0-9a-f]{3}:/.test(value);
  }

  const octets = value.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local: cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

export type RedirectRefusal = 'too_many_redirects' | FeedUrlRefusal;

/**
 * Judge a redirect hop.
 *
 * A redirect is a second chance to reach a blocked address, so the target is
 * validated exactly as the original was — an allow-listed first URL that
 * bounces to `http://169.254.169.254/` is the whole attack.
 */
export function checkCatalogFeedRedirect(
  target: string,
  hopsSoFar: number,
): RedirectRefusal | null {
  if (hopsSoFar >= CATALOG_FEED_LIMITS.maxRedirects) return 'too_many_redirects';
  return checkCatalogFeedUrl(target);
}

/**
 * Content-type must be one we intend to parse.
 *
 * Parameters (`; charset=utf-8`) are stripped before comparison because the
 * media type is what decides the parser; an unexpected charset is not a
 * different format.
 */
export function checkCatalogFeedContentType(
  header: string | null,
  allowed: ReadonlySet<string> = ALLOWED_CONTENT_TYPES,
): boolean {
  if (header === null) return false;
  const mediaType = header.split(';')[0]?.trim().toLowerCase() ?? '';
  return allowed.has(mediaType);
}

export type DecompressionRefusal = 'ratio_exceeded' | 'decompressed_cap_exceeded';

/**
 * Bound a decompression before it finishes.
 *
 * Both limits matter and neither implies the other. The RATIO catches a small
 * archive that expands enormously; the ABSOLUTE cap catches a large archive
 * that expands merely a lot. A fetcher should call this as bytes arrive rather
 * than after, which is why it takes running totals.
 */
export function checkCatalogFeedDecompression(
  compressedBytes: number,
  decompressedBytes: number,
): DecompressionRefusal | null {
  if (decompressedBytes > CATALOG_FEED_LIMITS.maxDecompressedBytes) {
    return 'decompressed_cap_exceeded';
  }
  // Guard the divide: zero compressed bytes with output is degenerate, and
  // treating it as an infinite ratio is the safe reading.
  if (compressedBytes <= 0) {
    return decompressedBytes > 0 ? 'ratio_exceeded' : null;
  }
  if (decompressedBytes / compressedBytes > CATALOG_FEED_LIMITS.maxDecompressionRatio) {
    return 'ratio_exceeded';
  }
  return null;
}
