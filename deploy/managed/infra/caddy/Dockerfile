# Caddy with the Hetzner Cloud DNS module, for the UCP profile host's wildcard
# certificate (docs/UCP_IMPLEMENTATION_PLAN.md §3.5). A wildcard needs the
# DNS-01 challenge. DNS for the domain stays at Namecheap, whose API replaces a
# zone's records all at once; one CNAME there points
# `_acme-challenge.<UCP_PROFILE_HOST>` at a small Hetzner zone, and Caddy writes
# only that zone's TXT records (`dns_challenge_override_domain`).
#
# The module is pinned; Caddy itself follows the stock image this replaces.
FROM caddy:2-builder-alpine AS builder
RUN xcaddy build --with github.com/caddy-dns/hetzner/v2@v2.0.1

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
