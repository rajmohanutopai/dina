/**
 * SSRF protection — block delivery to private/reserved IP addresses.
 *
 * Prevents Server-Side Request Forgery attacks where a malicious DID
 * document points to an internal service endpoint (e.g., 10.0.0.1,
 * 127.0.0.1, 169.254.x.x, fc00::).
 *
 * Blocked ranges:
 *   IPv4: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8,
 *         169.254.0.0/16 (link-local), 0.0.0.0/8
 *   IPv6: ::1 (loopback), fc00::/7 (ULA), fe80::/10 (link-local), :: (unspecified)
 *   Hostnames: localhost, *.local
 *
 * Source: core/internal/adapter/transport/transport.go (SSRF protection)
 */

/**
 * Check if a URL's host resolves to a private/reserved IP address.
 *
 * Extracts the hostname from the URL and checks against known
 * private/reserved ranges. Returns true if the URL is safe to deliver to.
 *
 * @returns true if URL is safe (public), false if URL targets private IP
 */
export function isDiscoverableURL(url: string): boolean {
  const hostname = extractHostname(url);
  if (!hostname) return false; // can't parse → block

  // Check hostname-based blocklist
  if (isBlockedHostname(hostname)) return false;

  // Check IP-based blocklist (handles bare IPs in URLs)
  if (isPrivateIP(hostname)) return false;

  return true;
}

/**
 * Extract hostname from a URL string.
 * Handles http://, https://, and bare host:port.
 */
export function extractHostname(url: string): string | null {
  try {
    // Handle URLs with protocol (http, https, ws, wss)
    // Fix: Codex #3 — ws/wss were falling through to bare-host branch
    if (/^(?:https?|wss?):\/\//i.test(url)) {
      // Convert ws/wss to http/https for URL parsing (URL doesn't support ws natively in all runtimes)
      const normalized = url.replace(/^ws(s?):\/\//i, 'http$1://');
      const parsed = new URL(normalized);
      return parsed.hostname;
    }
    // Bare host:port
    const colonIdx = url.indexOf(':');
    return colonIdx >= 0 ? url.slice(0, colonIdx) : url;
  } catch {
    return null;
  }
}

/**
 * Check if an IPv4 address is in a private/reserved range.
 *
 * Blocked IPv4 ranges:
 *   10.0.0.0/8        — Private (Class A)
 *   172.16.0.0/12      — Private (Class B)
 *   192.168.0.0/16     — Private (Class C)
 *   127.0.0.0/8        — Loopback
 *   169.254.0.0/16     — Link-local (APIPA)
 *   0.0.0.0/8          — "This" network
 *   100.64.0.0/10      — Carrier-grade NAT (RFC 6598)
 */
export function isPrivateIP(ip: string): boolean {
  // IPv4 check
  const v4Parts = ip.split('.');
  if (v4Parts.length === 4 && v4Parts.every((p) => /^\d+$/.test(p))) {
    const octets = v4Parts.map(Number);
    if (octets.some((o) => o < 0 || o > 255)) return false;

    const [a, b] = octets;

    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12 (172.16–172.31)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 127.0.0.0/8 (loopback)
    if (a === 127) return true;
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true;
    // 0.0.0.0/8
    if (a === 0) return true;
    // 100.64.0.0/10 (carrier-grade NAT)
    if (a === 100 && b >= 64 && b <= 127) return true;

    return false;
  }

  // IPv6 check
  const lower = ip.toLowerCase();
  if (lower === '::1') return true; // loopback
  if (lower === '::') return true; // unspecified
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA (fc00::/7)
  if (lower.startsWith('fe80')) return true; // link-local
  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  if (lower.startsWith('::ffff:')) {
    const v4Part = lower.slice(7);
    return isPrivateIP(v4Part);
  }

  return false;
}

/**
 * Check if a hostname is in the blocked hostname list.
 *
 * Blocks: localhost, *.local, *.internal
 */
export function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost') return true;
  if (lower.endsWith('.local')) return true;
  if (lower.endsWith('.internal')) return true;
  return false;
}
