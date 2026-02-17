# Networking Setup Guide

Dina supports three ingress options out of the box. Pick one, or run all three simultaneously. Each option exposes your Home Node's DIDComm endpoint to the internet so other Dinas can reach you.

> **Prerequisite:** Your Home Node is already running (`docker compose up -d`). dina-core listens on `localhost:8443` (DIDComm + WebSocket) and `localhost:8100` (internal brain ↔ core API). Neither port is exposed to the internet until you set up ingress below.

---

## Option A: Tailscale Funnel (Recommended for Getting Started)

Zero-config. No domain, no DNS, no port forwarding. You get a public HTTPS URL in under 5 minutes.

### Steps

```bash
# 1. Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh

# 2. Connect to your Tailnet (creates a free account if you don't have one)
sudo tailscale up

# 3. Expose Dina to the internet
sudo tailscale funnel 8443
```

Done. Your Dina is reachable at `https://<machine-name>.<tailnet>.ts.net/`.

### Register the endpoint in your DID Document

```bash
dina network set-endpoint "https://<machine-name>.<tailnet>.ts.net/"
```

This publishes your endpoint to your DID Document so other Dinas can find you.

### What you get

| Property | Value |
|----------|-------|
| TLS | Automatic (Let's Encrypt via Tailscale) |
| NAT traversal | Handled by Tailscale relay (DERP) |
| DDoS protection | None |
| Custom domain | No (tailnet subdomain only) |
| Firewall changes | None — outbound-only connection |
| Latency | ~50-100 ms |

### Stopping it

```bash
sudo tailscale funnel --off 8443
```

### Alternative: Zrok (fully open source)

If you prefer not to depend on Tailscale, [Zrok](https://zrok.io/) provides a similar zero-config tunnel built on OpenZiti. Self-hostable.

```bash
# Install
curl -sSf https://get.openziti.io/install-zrok.bash | bash

# Enable (one-time — creates your identity)
zrok enable <your-token>

# Expose Dina
zrok share public localhost:8443
```

---

## Option B: Cloudflare Tunnel (Recommended for Daily Use)

Custom domain, DDoS protection, WAF, geo-blocking. Your domain, your rules. Requires a Cloudflare account (free tier is sufficient) and a domain managed by Cloudflare DNS.

### Steps

```bash
# 1. Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb \
  -o cloudflared.deb && sudo dpkg -i cloudflared.deb

# 2. Authenticate with Cloudflare
cloudflared tunnel login

# 3. Create a named tunnel
cloudflared tunnel create dina-homenode

# 4. Note the Tunnel ID from the output, then create the config
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: dina-homenode
credentials-file: /home/dina/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: dina.yourdomain.com
    service: https://localhost:8443
    originRequest:
      noTLSVerify: true
  - service: http_status:404
EOF

# 5. Point your domain at the tunnel
cloudflared tunnel route dns dina-homenode dina.yourdomain.com

# 6. Run as a persistent service
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

Done. Your Dina is reachable at `https://dina.yourdomain.com/`.

### Register the endpoint in your DID Document

```bash
dina network set-endpoint "https://dina.yourdomain.com/"
```

### What you get

| Property | Value |
|----------|-------|
| TLS | Cloudflare edge (automatic, custom domain) |
| NAT traversal | Outbound tunnel — no inbound ports needed |
| DDoS protection | Cloudflare WAF, rate limiting, geo-blocking |
| Custom domain | Yes |
| Firewall changes | None — outbound-only connection |
| Latency | ~10-30 ms (Cloudflare edge PoP) |

### Recommended Cloudflare settings

After setup, go to the Cloudflare dashboard for your domain:

- **WAF rules:** Allow only `/.well-known/did.json` and DIDComm message paths. Block everything else.
- **Rate limiting:** 60 requests/minute per IP.
- **Geo-blocking:** Optional — restrict to your country if desired.
- **Bot management:** Enable — Dina-to-Dina traffic uses DIDComm headers, not browsers.

### Stopping it

```bash
sudo systemctl stop cloudflared
sudo systemctl disable cloudflared
```

---

## Option C: Yggdrasil (Maximum Sovereignty)

No corporate infrastructure. No DNS. No certificate authority. Your Dina gets a stable IPv6 address derived from its Ed25519 public key — philosophically aligned with DIDs. Censorship-resistant.

Both Dinas must be on the Yggdrasil mesh for this to work. Best for communities that want zero dependence on centralized services.

### Steps

```bash
# 1. Install Yggdrasil
# Debian/Ubuntu:
sudo apt install yggdrasil
# macOS:
brew install yggdrasil

# 2. Generate config
sudo yggdrasil -genconf -json | sudo tee /etc/yggdrasil/yggdrasil.conf > /dev/null

# 3. Add public peers (find current list at https://publicpeers.neilalexander.dev/)
# Edit /etc/yggdrasil/yggdrasil.conf — add peers to the "Peers" array:
```

Example peers (pick 2-3 geographically close to you):

```json
{
  "Peers": [
    "tls://ygg-uplink.thingylabs.io:443",
    "tls://51.15.204.214:12345",
    "tls://ygg.mkg20001.io:443"
  ]
}
```

```bash
# 4. Start Yggdrasil
sudo systemctl enable --now yggdrasil

# 5. Get your stable IPv6 address
yggdrasilctl getSelf
# Output includes your address, e.g.: 200:1234:5678:abcd::1

# 6. Tell dina-core to also listen on the Yggdrasil interface
dina network enable-yggdrasil
```

Done. Your Dina is reachable at `https://[200:abcd:...]:8443/` from any other Yggdrasil node.

### Register the endpoint in your DID Document

```bash
dina network set-endpoint "https://[200:1234:5678:abcd::1]:8443/"
```

### What you get

| Property | Value |
|----------|-------|
| TLS | Yggdrasil encryption (E2E) + DIDComm encryption (double layer) |
| NAT traversal | Full mesh — automatic via Yggdrasil overlay |
| DDoS protection | None (but address is not in public DNS) |
| Custom domain | No (IPv6 address only) |
| Firewall changes | None — outbound-only peer connections |
| Latency | ~20-80 ms (depends on mesh path) |
| Censorship resistance | High — no DNS, no CA, no corporate infrastructure |

### Why double encryption?

Traffic between two Dinas on Yggdrasil is encrypted twice:

1. **Yggdrasil layer** — Curve25519 session key, protects against mesh eavesdropping
2. **DIDComm layer** — X25519 per-message key, ensures only the intended DID can read it

Even if a Yggdrasil peer node is compromised, DIDComm encryption keeps your messages private.

### Stopping it

```bash
sudo systemctl stop yggdrasil
dina network disable-yggdrasil
```

---

## Running Multiple Options Simultaneously

All three can run at the same time. Each independently forwards traffic to `localhost:8443`:

```
Internet
  ├── Tailscale Funnel ──→ localhost:8443
  ├── Cloudflare Tunnel ──→ localhost:8443
  └── Yggdrasil mesh ──→ [ygg_ipv6]:8443
                              │
                          dina-core
```

Your DID Document can advertise multiple endpoints. Connecting Dinas pick whichever they can reach:

```bash
# Register multiple endpoints
dina network set-endpoint "https://dina.yourdomain.com/" --id didcomm-cf
dina network set-endpoint "https://[200:abcd:...]:8443/" --id didcomm-ygg
```

This publishes a DID Document with both service endpoints:

```json
{
  "service": [
    {
      "id": "#didcomm-cf",
      "type": "DIDCommMessaging",
      "serviceEndpoint": "https://dina.yourdomain.com/"
    },
    {
      "id": "#didcomm-ygg",
      "type": "DIDCommMessaging",
      "serviceEndpoint": "https://[200:abcd:...]:8443/"
    }
  ]
}
```

### Switching endpoints

When you change your ingress setup, update your DID Document:

```bash
dina network set-endpoint "https://new-endpoint.example.com/"
```

This publishes the updated endpoint to your DID Document. Peers discover it on their next connection attempt.

---

## Firewall

You don't need to open any inbound ports. All three options use outbound connections:

- **Tailscale** — outbound WireGuard (UDP)
- **Cloudflare** — outbound HTTPS to Cloudflare edge
- **Yggdrasil** — outbound TCP/TLS to mesh peers

```bash
# VPS: deny all inbound, allow all outbound
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw enable
```

Home server behind a router: no port forwarding needed.

---

## Which should I pick?

| | Tailscale Funnel | Cloudflare Tunnel | Yggdrasil |
|---|---|---|---|
| **Setup** | 3 commands | ~15 minutes | ~10 minutes |
| **Custom domain** | No | Yes | No |
| **DDoS protection** | No | Yes | No |
| **Censorship resistance** | Low | Low | High |
| **Corporate dependency** | Tailscale Inc. | Cloudflare Inc. | None |
| **Provider sees** | Encrypted blobs | TLS terminated at edge | Nothing (E2E mesh) |
| **Best for** | Getting started, testing | Production daily use | Maximum sovereignty |

**Our recommendation:** Start with **Option A** (Tailscale Funnel). When you're ready for a custom domain or DDoS protection, add **Option B** (Cloudflare Tunnel). If you care about censorship resistance and zero corporate dependencies, add **Option C** (Yggdrasil). They all run side by side.

---

## Future: Dina Foundation Relay

> Not available yet. Planned for post-Phase 1.

The Dina Foundation will operate a free relay at `*.dina.host` using [frp](https://github.com/fatedier/frp). This gives every Dina a public subdomain (`alice.dina.host`) without needing a Tailscale or Cloudflare account.

The relay is a dumb pipe — it forwards TCP and terminates TLS for the wildcard domain. It never holds your keys, never reads your messages, and never stores data. If it goes down, you fall back to your other ingress options.
