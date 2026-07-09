/**
 * Anti-DNS-rebinding Host allowlist for the brain-server HTTP surface.
 *
 * The `/api/v1/*` API is unauthenticated + loopback-bound by design. Loopback
 * binding stops direct remote access, but a browser tricked into resolving an
 * attacker hostname to 127.0.0.1 (DNS rebinding) would still reach the server
 * — sending the attacker's hostname in the `Host` header — and could POST the
 * state-mutating agent-approval gate (approve/cancel) or read owner-private
 * data (contacts, workflow tasks) using the owner's origin. Rejecting any
 * request whose Host isn't loopback (or an operator-allowlisted proxy host)
 * closes that hole.
 *
 * The check keys on the HOSTNAME, not the port: a rebinding attack always
 * carries a foreign hostname (`evil.com`), never `localhost` / `127.0.0.1` on
 * some other port — so loopback is allowed on any port, which also keeps
 * light-my-request's default `Host: localhost:80` (used by inject tests)
 * working.
 */

import type { FastifyInstance } from 'fastify';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * The hostname portion of a `Host` header value, port stripped.
 * `127.0.0.1:8402` → `127.0.0.1`; `[::1]:8402` → `[::1]`; `localhost` →
 * `localhost`; bare IPv6 `::1` (no brackets, multiple colons) → `::1`.
 */
function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end >= 0 ? h.slice(0, end + 1) : h;
  }
  const first = h.indexOf(':');
  // Strip a port only for the `host:port` form (exactly one colon); a bare
  // IPv6 literal has multiple colons and no port to strip.
  if (first >= 0 && h.indexOf(':', first + 1) === -1) return h.slice(0, first);
  return h;
}

/**
 * Operator-configured extra hosts (reverse-proxy hostnames) from
 * `DINA_BRAIN_ALLOWED_HOSTS` (comma-separated). Loopback is always allowed and
 * is NOT listed here.
 */
export function buildAllowedHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const h of (process.env.DINA_BRAIN_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '')) {
    hosts.add(h);
  }
  return hosts;
}

/**
 * True if a request with this `Host` header should be served. Loopback
 * hostnames (any port) and an absent Host pass; operator-allowlisted hosts
 * pass (matched on full host or hostname); everything else is rejected.
 */
export function isHostAllowed(hostHeader: string, extraHosts: Set<string>): boolean {
  const h = (hostHeader ?? '').trim().toLowerCase();
  if (h === '') return true; // absent Host — loopback bind is the backstop
  const name = hostnameOf(h);
  if (LOOPBACK_HOSTNAMES.has(name)) return true;
  return extraHosts.has(h) || extraHosts.has(name);
}

/**
 * Register the Host allowlist as an `onRequest` hook (runs before every
 * route). A present, non-allowlisted Host gets `421 Misdirected Request`. Call
 * this immediately after the Fastify instance is created, before any route
 * registration.
 */
export function registerHostAllowlistGuard(app: FastifyInstance): void {
  const extraHosts = buildAllowedHosts();
  app.addHook('onRequest', async (req, reply) => {
    if (!isHostAllowed(req.headers.host ?? '', extraHosts)) {
      return reply.code(421).send({ error: 'host_not_allowed' });
    }
  });
}
