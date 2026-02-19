# Advanced Setup Guide

This guide covers configuration beyond the defaults in [QUICKSTART.md](QUICKSTART.md). Two main areas:

1. **Local LLM Profile** — Run Dina with a local LLM (no cloud APIs for inference)
2. **Advanced Networking** — Custom domains, censorship resistance, sovereign mesh

> **Prerequisite:** You've already completed the [Quick Start](QUICKSTART.md) and have Dina running in the Cloud LLM profile (`docker compose up -d`).

---

## Part 1: Local LLM Profile

The Cloud LLM profile (the default) uses Gemini Flash Lite for text and Deepgram Nova-3 for voice — cheap, fast, and requires only 2GB RAM across 3 containers (core, brain, pds). The Local LLM profile adds a 4th container running a local LLM — no cloud API calls for text inference. Voice STT still uses Deepgram in all profiles for Phase 1.

### When to use Local LLM profile

- You want **zero cloud dependency** for LLM text processing
- You're on unreliable or metered internet
- You're a privacy maximalist — even PII-scrubbed queries shouldn't leave the device
- You want **maximum sensitive persona privacy** (health/financial data processed entirely locally, never leaves Home Node)
- You have the hardware (8GB+ RAM, Apple Silicon or x86 with AVX2)

### Hardware requirements

| Resource | Cloud LLM (default) | Local LLM |
|----------|----------------------|--------------|
| **RAM** | 2GB | **8GB minimum**, 16GB recommended |
| **CPU** | 2 cores | 4+ cores. Apple Silicon (unified memory) or x86 with AVX2. |
| **Storage** | 10GB | 20GB (+ ~3GB for model files) |
| **GPU** | Not needed | Not needed on Apple Silicon. Discrete GPU helps on x86. |
| **Best hardware** | Raspberry Pi, cheap VPS | **Mac Mini M4 (16GB+)**, Intel NUC, dedicated server |

### What changes

| Component | Cloud LLM | Local LLM |
|-----------|------------|--------------|
| **Text LLM** | Gemini 2.5 Flash Lite (cloud) | Gemma 3n E4B via llama (local) |
| **Voice STT** | Deepgram Nova-3 (cloud) | Deepgram Nova-3 (cloud) |
| **Embeddings** | gemini-embedding-001 (cloud) | EmbeddingGemma 308M via llama (local) |
| **PII scrubbing** | Regex (Go) + spaCy NER (Python) — always local | Regex + spaCy NER + LLM NER via Gemma 3n (local) |
| **Containers** | 3 (core, brain, pds) | 4 (core, brain, pds, llama) |
| **Sensitive personas** | Supported via Entity Vault (names/orgs/locations scrubbed, cloud sees topics only) | Best privacy — processed entirely on llama, never leaves Home Node |
| **Monthly cost** | ~$5-15 (API calls) | Hardware + electricity only |

Everything else — vault, identity, personas, messaging, PDS — is identical across profiles.

### Switching to Local LLM profile

```bash
# Start with the local-llm profile (adds llama container)
docker compose --profile local-llm up -d
```

This starts 4 containers:
- **dina-core** — vault, keys, messaging (always on)
- **dina-brain** — reasoning, agent loop (always on)
- **dina-pds** — AT Protocol PDS for reputation data (always on)
- **llama** — llama.cpp serving Gemma 3n E4B (GGUF format, ~3GB RAM)

Model files are downloaded automatically on first start. This takes 5-10 minutes depending on your internet speed.

### Verifying Local LLM profile

```bash
# Check all 4 containers are running
docker compose --profile local-llm ps

# Verify llama is healthy
curl http://localhost:8080/health

# Test text inference (should respond without cloud calls)
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}],"max_tokens":50}'
```

### Performance expectations

| Task | Cloud LLM | Local LLM (Mac Mini M4) |
|------|------------|---------------------------|
| Text response (first token) | ~300-500ms | ~1-2s |
| Voice transcription | ~150-300ms (streaming) | ~150-300ms (streaming, Deepgram) |
| Embedding generation | ~100ms | ~500ms |

Local LLM is slower for text but fully private. For interactive chat, the on-device LLM on your phone/laptop handles latency-sensitive tasks regardless of profile.

### Switching back to Cloud LLM profile

```bash
# Restart without the local-llm profile (llama container stops)
docker compose up -d
```

### Hybrid profile

You can also run in **Hybrid mode** — llama handles sensitive personas and PII scrubbing, cloud handles everything else:

```bash
# Same command — brain's LLM router decides per-query
docker compose --profile local-llm up -d
```

The LLM router in dina-brain automatically routes:
- Health/financial persona queries → llama (local only, never cloud)
- Simple lookups → SQLite FTS5 (no LLM at all)
- Complex reasoning → cloud LLM (via PII scrubber: regex + spaCy NER)
- PII scrubbing → regex + spaCy NER + llama LLM NER (three tiers, most accurate)

### Sensitive persona rule (all profiles)

Health and financial persona data always takes the strongest available privacy path:

- **With llama (Local LLM / Hybrid):** Processed entirely on llama. Never leaves the Home Node. Best privacy.
- **Without llama (Cloud LLM):** Mandatory Entity Vault scrubbing — all identifying entities (names, organizations, locations) are stripped by spaCy NER before routing to cloud LLM. The cloud provider sees health/financial **topics** but cannot identify **who**. User consents to this during setup.

This is enforced at the LLM router level in dina-brain. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full Entity Vault mechanism.

---

## Part 2: Advanced Networking

Dina supports three ingress options. The [Quick Start](QUICKSTART.md) uses Tailscale Funnel. This section covers production and sovereign networking setups.

Each option exposes your Home Node's messaging endpoint to the internet so other Dinas can reach you. dina-core listens on `localhost:443` (NaCl messaging + WebSocket + admin proxy) and `localhost:8100` (internal brain ↔ core API). Neither port is exposed to the internet until you set up ingress below.

### Option A: Tailscale Funnel (Getting Started)

> Already covered in [QUICKSTART.md](QUICKSTART.md). Included here for reference.

Zero-config. No domain, no DNS, no port forwarding. Public HTTPS URL in under 5 minutes.

```bash
# 1. Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh

# 2. Connect to your Tailnet (creates a free account if you don't have one)
sudo tailscale up

# 3. Expose Dina to the internet
sudo tailscale funnel 443
```

Done. Your Dina is reachable at `https://<machine-name>.<tailnet>.ts.net/`.

```bash
# Register the endpoint in your DID Document
dina network set-endpoint "https://<machine-name>.<tailnet>.ts.net/"
```

| Property | Value |
|----------|-------|
| TLS | Automatic (Let's Encrypt via Tailscale) |
| NAT traversal | Handled by Tailscale relay (DERP) |
| DDoS protection | None |
| Custom domain | No (tailnet subdomain only) |
| Firewall changes | None — outbound-only connection |
| Latency | ~50-100 ms |

**Stopping it:** `sudo tailscale funnel --off 443`

**Alternative: Zrok (fully open source)**

If you prefer not to depend on Tailscale, [Zrok](https://zrok.io/) provides a similar zero-config tunnel built on OpenZiti. Self-hostable.

```bash
curl -sSf https://get.openziti.io/install-zrok.bash | bash
zrok enable <your-token>
zrok share public localhost:443
```

---

### Option B: Cloudflare Tunnel (Recommended for Daily Use)

Custom domain, DDoS protection, WAF, geo-blocking. Your domain, your rules. Requires a Cloudflare account (free tier is sufficient) and a domain managed by Cloudflare DNS.

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
    service: https://localhost:443
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

```bash
dina network set-endpoint "https://dina.yourdomain.com/"
```

| Property | Value |
|----------|-------|
| TLS | Cloudflare edge (automatic, custom domain) |
| NAT traversal | Outbound tunnel — no inbound ports needed |
| DDoS protection | Cloudflare WAF, rate limiting, geo-blocking |
| Custom domain | Yes |
| Firewall changes | None — outbound-only connection |
| Latency | ~10-30 ms (Cloudflare edge PoP) |

**Recommended Cloudflare settings:**

- **WAF rules:** Allow only `/.well-known/did.json` and DIDComm message paths. Block everything else.
- **Rate limiting:** 60 requests/minute per IP.
- **Geo-blocking:** Optional — restrict to your country if desired.
- **Bot management:** Enable — Dina-to-Dina traffic uses DIDComm headers, not browsers.

**Stopping it:** `sudo systemctl stop cloudflared && sudo systemctl disable cloudflared`

---

### Option C: Yggdrasil (Maximum Sovereignty)

No corporate infrastructure. No DNS. No certificate authority. Your Dina gets a stable IPv6 address derived from its Ed25519 public key — philosophically aligned with DIDs. Censorship-resistant.

Both Dinas must be on the Yggdrasil mesh for this to work. Best for communities that want zero dependence on centralized services.

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

Done. Your Dina is reachable at `https://[200:abcd:...]:443/` from any other Yggdrasil node.

```bash
dina network set-endpoint "https://[200:1234:5678:abcd::1]:443/"
```

| Property | Value |
|----------|-------|
| TLS | Yggdrasil encryption (E2E) + NaCl encryption (double layer) |
| NAT traversal | Full mesh — automatic via Yggdrasil overlay |
| DDoS protection | None (but address is not in public DNS) |
| Custom domain | No (IPv6 address only) |
| Firewall changes | None — outbound-only peer connections |
| Latency | ~20-80 ms (depends on mesh path) |
| Censorship resistance | High — no DNS, no CA, no corporate infrastructure |

**Why double encryption?** Traffic between two Dinas on Yggdrasil is encrypted twice:

1. **Yggdrasil layer** — Curve25519 session key, protects against mesh eavesdropping
2. **NaCl layer** — libsodium `crypto_box_seal` per-message encryption, ensures only the intended DID can read it

Even if a Yggdrasil peer node is compromised, NaCl encryption keeps your messages private.

**Stopping it:** `sudo systemctl stop yggdrasil && dina network disable-yggdrasil`

---

### Running Multiple Ingress Options Simultaneously

All three can run at the same time. Each independently forwards traffic to `localhost:443`:

```
Internet
  ├── Tailscale Funnel ──→ localhost:443
  ├── Cloudflare Tunnel ──→ localhost:443
  └── Yggdrasil mesh ──→ [ygg_ipv6]:443
                              │
                          dina-core
```

Your DID Document can advertise multiple endpoints. Connecting Dinas pick whichever they can reach:

```bash
# Register multiple endpoints
dina network set-endpoint "https://dina.yourdomain.com/" --id didcomm-cf
dina network set-endpoint "https://[200:abcd:...]:443/" --id didcomm-ygg
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
      "serviceEndpoint": "https://[200:abcd:...]:443/"
    }
  ]
}
```

When you change your ingress setup, update your DID Document:

```bash
dina network set-endpoint "https://new-endpoint.example.com/"
```

Peers discover the updated endpoint on their next connection attempt.

---

### Firewall

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

### Which networking option should I pick?

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

### Future: Dina Foundation Relay

> Not available yet. Planned for post-Phase 1.

The Dina Foundation will operate a free relay at `*.dina.host` using [frp](https://github.com/fatedier/frp). This gives every Dina a public subdomain (`alice.dina.host`) without needing a Tailscale or Cloudflare account.

The relay is a dumb pipe — it forwards TCP and terminates TLS for the wildcard domain. It never holds your keys, never reads your messages, and never stores data. If it goes down, you fall back to your other ingress options.
