# Manual Testing Guide — Two Dina Home Nodes on Two Laptops

This guide walks you through running two complete Dina Home Nodes on two laptops and testing every major scenario end-to-end. It follows the actual install flow, real API shapes, and actual docker-compose services.

---

## What You're Testing

Two sovereign identities (Alonso and Sancho) running on separate hardware, communicating via encrypted Dina-to-Dina messaging. This tests:

- Identity bootstrap (DID creation, mnemonic, key derivation)
- Persona management (create, unlock, lock, tiered access)
- Encrypted vault operations (store, query, KV, batch)
- Device pairing (initiate + complete, token-based auth)
- D2D messaging (NaCl-encrypted, dead-drop ingress, outbox retry)
- PII scrubbing (regex tier in core, NER tier in brain)
- Brain reasoning (LLM query, silence classification, guardian validation)
- Admin dashboard (login, contacts, devices, settings)
- WebSocket real-time notifications
- Contact management and sharing policies

---

## Prerequisites (Both Laptops)

- Docker & Docker Compose v2
- curl, jq, python3 (all come with macOS)
- Both laptops on the same Wi-Fi/LAN (or Tailscale for remote)
- At least one LLM API key (Gemini free tier is easiest)

---

## Phase 1: Install Both Nodes

### Laptop 1 (Alonso)

```bash
git clone https://github.com/rajmohanutopai/dina.git ~/dina-alonso
cd ~/dina-alonso
./install.sh
```

The script will:
1. Check Docker prerequisites
2. Generate `secrets/brain_token` (shared secret between core and brain)
3. Generate a 256-bit identity seed
4. Ask which LLM provider (pick Gemini for free tier)
5. Write `.env` with secrets + PDS credentials
6. Build 3 Docker images (core, brain, pds)
7. Start containers and wait for health
8. Display your DID and 24-word recovery phrase

**Save the output.** You need the DID and recovery phrase.

### Laptop 2 (Sancho)

```bash
git clone https://github.com/rajmohanutopai/dina.git ~/dina-sancho
cd ~/dina-sancho
./install.sh
```

Same process, different identity. Save Sancho's DID and recovery phrase.

### Record Both Identities

```bash
# Create a reference file on each laptop
cat > /tmp/dina-test.env << 'EOF'
ALONSO_DID=did:plc:<from laptop 1 output>
SANCHO_DID=did:plc:<from laptop 2 output>
ALONSO_IP=<laptop 1 LAN IP>
SANCHO_IP=<laptop 2 LAN IP>
EOF
```

Find your LAN IP:
```bash
# macOS
ipconfig getifaddr en0    # Wi-Fi
# or
ifconfig | grep "inet " | grep -v 127.0.0.1
```

---

## Phase 2: Verify Each Node is Running

Run these on **each** laptop:

```bash
cd ~/dina-<name>

# 1. Check all 3 containers are up
docker compose ps
# Expected: core (healthy), brain (healthy), pds (healthy)

# 2. Health check (no auth required)
curl -s http://localhost:8100/healthz | jq .
# {"status":"ok"}

# 3. Readiness check
curl -s http://localhost:8100/readyz | jq .
# {"status":"ready"}

# 4. Verify DID was created
BRAIN_TOKEN=$(cat secrets/brain_token)
curl -s -H "Authorization: Bearer $BRAIN_TOKEN" \
  http://localhost:8100/v1/did | jq .
# {"did":"did:plc:..."}

# 5. AT Protocol discovery
curl -s http://localhost:8100/.well-known/atproto-did
# did:plc:...

# 6. Check brain is responding
curl -s -H "Authorization: Bearer $BRAIN_TOKEN" \
  http://localhost:8200/healthz | jq .
# {"status":"ok"}
```

### Troubleshooting

```bash
# If a container isn't healthy:
docker compose logs core | tail -30
docker compose logs brain | tail -30
docker compose logs pds | tail -30

# If port 8100 is already in use:
lsof -i :8100
# Use a different port:
DINA_CORE_PORT=8101 docker compose up -d

# Rebuild from scratch:
docker compose down -v
docker compose build --no-cache
docker compose up -d
```

---

## Phase 3: Cross-Laptop Network Verification

From **Laptop 1**, test connectivity to **Laptop 2**:

```bash
# Replace with Sancho's actual IP
SANCHO_IP=192.168.1.101

# Ping test
ping -c 3 $SANCHO_IP

# HTTP health check across LAN
curl -s http://$SANCHO_IP:8100/healthz | jq .
# {"status":"ok"}
```

From **Laptop 2**, test connectivity to **Laptop 1**:

```bash
ALONSO_IP=192.168.1.100
curl -s http://$ALONSO_IP:8100/healthz | jq .
```

If the health check fails across LAN:
- Check macOS Firewall: System Settings > Network > Firewall (temporarily disable)
- Verify both are on the same subnet
- Try `nc -zv $OTHER_IP 8100` to test raw TCP

---

## Phase 4: Device Pairing

Each node needs a CLIENT_TOKEN (device token) for admin-level operations. The BRAIN_TOKEN is internal (core <-> brain). CLIENT_TOKEN is for external clients (you, CLI, admin UI).

### On Laptop 1 (Alonso)

```bash
cd ~/dina-alonso
BRAIN_TOKEN=$(cat secrets/brain_token)

# Step 1: Initiate pairing (generates a 6-digit code)
curl -s -X POST \
  -H "Authorization: Bearer $BRAIN_TOKEN" \
  http://localhost:8100/v1/pair/initiate | jq .
# {"code":"a1b2c3","expires_in":300}

# Step 2: Complete pairing with the code
PAIR_CODE="a1b2c3"  # use the actual code from step 1
curl -s -X POST \
  -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"code\":\"$PAIR_CODE\",\"device_name\":\"alonso-macbook\"}" \
  http://localhost:8100/v1/pair/complete | jq .
# {"client_token":"hex64chars...","token_id":"tok-1","node_did":"did:plc:..."}

# Save the client token
echo "hex64chars..." > secrets/client_token
chmod 600 secrets/client_token
```

### On Laptop 2 (Sancho) — same process

```bash
cd ~/dina-sancho
BRAIN_TOKEN=$(cat secrets/brain_token)

curl -s -X POST -H "Authorization: Bearer $BRAIN_TOKEN" \
  http://localhost:8100/v1/pair/initiate | jq .

PAIR_CODE="x9y8z7"  # use actual code
curl -s -X POST \
  -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"code\":\"$PAIR_CODE\",\"device_name\":\"sancho-macbook\"}" \
  http://localhost:8100/v1/pair/complete | jq .

echo "hex64chars..." > secrets/client_token
chmod 600 secrets/client_token
```

### Verify Pairing

```bash
CLIENT_TOKEN=$(cat secrets/client_token)

# List paired devices
curl -s -H "Authorization: Bearer $CLIENT_TOKEN" \
  http://localhost:8100/v1/devices | jq .
# [{"id":"tok-1","name":"alonso-macbook","created_at":"..."}]
```

---

## Phase 5: Persona Management

### List Personas (default "personal" persona exists)

```bash
CLIENT_TOKEN=$(cat secrets/client_token)

curl -s -H "Authorization: Bearer $CLIENT_TOKEN" \
  http://localhost:8100/v1/personas | jq .
# ["personal"]
```

### Create Additional Personas

```bash
# On Laptop 1: Create a "health" persona (restricted tier)
curl -s -X POST \
  -H "Authorization: Bearer $CLIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"health","tier":"restricted","passphrase":"my-health-pass-123"}' \
  http://localhost:8100/v1/personas | jq .
# {"id":"persona-health","status":"created"}

# On Laptop 2: Create a "work" persona
curl -s -X POST \
  -H "Authorization: Bearer $CLIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"work","tier":"restricted","passphrase":"work-pass-456"}' \
  http://localhost:8100/v1/personas | jq .
```

### Unlock a Persona

```bash
# Unlock the "health" persona (opens vault, 1-hour TTL)
curl -s -X POST \
  -H "Authorization: Bearer $CLIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"persona":"persona-health","passphrase":"my-health-pass-123"}' \
  http://localhost:8100/v1/persona/unlock | jq .
# {"status":"unlocked"}
```

### Test Wrong Passphrase

```bash
curl -s -X POST \
  -H "Authorization: Bearer $CLIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"persona":"persona-health","passphrase":"wrong-pass"}' \
  http://localhost:8100/v1/persona/unlock
# 403: {"error":"invalid passphrase"}
```

---

## Phase 6: Vault Operations

The vault is SQLCipher-encrypted, per-persona. Use BRAIN_TOKEN or CLIENT_TOKEN (both are accepted by vault endpoints).

### Store Items

```bash
BRAIN_TOKEN=$(cat secrets/brain_token)

# Store a note in the "personal" vault
curl -s -X POST \
  -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "persona": "personal",
    "item": {
      "Type": "note",
      "Source": "manual-test",
      "Summary": "Sancho likes strong cardamom tea",
      "BodyText": "He always takes it strong. His mom was unwell last visit.",
      "Metadata": "{\"category\":\"relationship\"}"
    }
  }' \
  http://localhost:8100/v1/vault/store | jq .
# {"id":"<vault-item-id>"}
```

### Store Batch

```bash
curl -s -X POST \
  -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "persona": "personal",
    "items": [
      {"Type":"note","Summary":"Daughter birthday March 15","BodyText":"She turns 7. Loves dinosaurs."},
      {"Type":"note","Summary":"License renewal due April","BodyText":"Driver license expires April 30."}
    ]
  }' \
  http://localhost:8100/v1/vault/store/batch | jq .
```

### Query Vault (Search)

```bash
# Full-text search
curl -s -X POST \
  -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"persona":"personal","query":"cardamom tea","limit":10}' \
  http://localhost:8100/v1/vault/query | jq .

# Should return the Sancho note
```

### Get/Set KV (Key-Value Store)

```bash
# Set a KV pair
curl -s -X PUT \
  -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value":"true"}' \
  http://localhost:8100/v1/vault/kv/briefing_enabled | jq .

# Get a KV pair
curl -s -H "Authorization: Bearer $BRAIN_TOKEN" \
  http://localhost:8100/v1/vault/kv/briefing_enabled | jq .
```

### Get Item by ID

```bash
ITEM_ID="<from store response>"
curl -s -H "Authorization: Bearer $BRAIN_TOKEN" \
  "http://localhost:8100/v1/vault/item/$ITEM_ID?persona=personal" | jq .
```

---

## Phase 7: Contact Management

### Add Each Other as Contacts

On **Laptop 1** (Alonso adds Sancho):

```bash
CLIENT_TOKEN=$(cat secrets/client_token)
SANCHO_DID="did:plc:<sancho's DID>"

curl -s -X POST \
  -H "Authorization: Bearer $CLIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"did\":\"$SANCHO_DID\",\"name\":\"Sancho\",\"trust_level\":\"verified\"}" \
  http://localhost:8100/v1/contacts | jq .
```

On **Laptop 2** (Sancho adds Alonso):

```bash
CLIENT_TOKEN=$(cat secrets/client_token)
ALONSO_DID="did:plc:<alonso's DID>"

curl -s -X POST \
  -H "Authorization: Bearer $CLIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"did\":\"$ALONSO_DID\",\"name\":\"Alonso\",\"trust_level\":\"verified\"}" \
  http://localhost:8100/v1/contacts | jq .
```

### List Contacts

```bash
curl -s -H "Authorization: Bearer $CLIENT_TOKEN" \
  http://localhost:8100/v1/contacts | jq .
```

### Set Sharing Policy

```bash
curl -s -X PUT \
  -H "Authorization: Bearer $CLIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"categories":{"presence":"summary","availability":"full","health":"none"}}' \
  "http://localhost:8100/v1/contacts/$SANCHO_DID/policy" | jq .
```

---

## Phase 8: D2D Messaging (The Core Test)

This is the heart of Dina — two sovereign nodes exchanging NaCl-encrypted messages.

### Step 1: Configure Known Peers

Each node must know the other's DID and HTTP endpoint. Add to `.env` or pass via environment:

**Laptop 1** (Alonso knows how to reach Sancho):
```bash
cd ~/dina-alonso
# Add to .env:
echo "DINA_KNOWN_PEERS=$SANCHO_DID=http://$SANCHO_IP:8100" >> .env
docker compose up -d core  # restart core to pick up config
```

**Laptop 2** (Sancho knows how to reach Alonso):
```bash
cd ~/dina-sancho
echo "DINA_KNOWN_PEERS=$ALONSO_DID=http://$ALONSO_IP:8100" >> .env
docker compose up -d core
```

### Step 2: Send a Message (Alonso → Sancho)

On **Laptop 1**:

```bash
BRAIN_TOKEN=$(cat secrets/brain_token)
SANCHO_DID="did:plc:<sancho's DID>"

curl -s -X POST \
  -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"to\": \"$SANCHO_DID\",
    \"body\": \"$(echo -n 'Hello Sancho, I am making tea!' | base64)\",
    \"type\": \"nudge\"
  }" \
  http://localhost:8100/v1/msg/send | jq .
# {"id":"msg_...","status":"queued"}
```

### Step 3: Check Inbox (on Sancho's Laptop)

On **Laptop 2**:

```bash
BRAIN_TOKEN=$(cat secrets/brain_token)

curl -s -H "Authorization: Bearer $BRAIN_TOKEN" \
  http://localhost:8100/v1/msg/inbox | jq .
# Should contain the message from Alonso
```

### Step 4: Send a Reply (Sancho → Alonso)

On **Laptop 2**:

```bash
ALONSO_DID="did:plc:<alonso's DID>"

curl -s -X POST \
  -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"to\": \"$ALONSO_DID\",
    \"body\": \"$(echo -n 'Thank you! Mom is better now.' | base64)\",
    \"type\": \"response\"
  }" \
  http://localhost:8100/v1/msg/send | jq .
```

### Step 5: Verify on Alonso

On **Laptop 1**:

```bash
curl -s -H "Authorization: Bearer $BRAIN_TOKEN" \
  http://localhost:8100/v1/msg/inbox | jq .
```

### Monitor D2D in Logs

```bash
# On either laptop, watch the core logs for D2D activity:
docker compose logs -f core | grep -E "ingress|outbox|D2D|msg"
```

### What's Happening Under the Hood

```
Alonso types "send msg to Sancho"
  → core looks up Sancho's DID in known peers
  → derives Sancho's NaCl public key from DID document
  → encrypts message body with crypto_box_seal (ephemeral sender key)
  → signs the envelope with Alonso's Ed25519 signing key
  → POST encrypted envelope to http://<sancho-ip>:8100/msg
  → Sancho's ingress router receives it:
       - If vault is unlocked: fast-path decrypt + verify + store
       - If vault is locked: dead-drop (stored encrypted, decrypted on next unlock)
  → Sancho checks /v1/msg/inbox: sees decrypted message
```

---

## Phase 9: PII Scrubbing

### Core-Level Scrubbing (Regex — Go)

```bash
BRAIN_TOKEN=$(cat secrets/brain_token)

curl -s -X POST \
  -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Call John Doe at 555-123-4567, SSN 123-45-6789, email john@example.com"}' \
  http://localhost:8100/v1/pii/scrub | jq .
# Structured PII (phone, SSN, email) should be redacted
```

### Brain-Level Scrubbing (spaCy NER — Python)

```bash
curl -s -X POST \
  -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Patient John Doe from Google Inc visited Dr. Smith in New York"}' \
  http://localhost:8200/api/v1/pii/scrub | jq .
# Names, organizations, locations should be identified and scrubbed
```

---

## Phase 10: Brain Reasoning

### Ask Brain a Question

```bash
BRAIN_TOKEN=$(cat secrets/brain_token)

curl -s -X POST \
  -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "What do I know about Sancho?",
    "persona_id": "personal",
    "persona_tier": "open"
  }' \
  http://localhost:8200/api/v1/reason | jq .
# Brain searches vault for "Sancho", builds context, calls LLM, returns answer
# Should mention cardamom tea, mom was unwell, etc.
```

### Process an Event (Guardian Loop)

```bash
curl -s -X POST \
  -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "agent_intent",
    "agent_did": "did:example:review-bot",
    "action": "send_email",
    "body": "Send purchase confirmation to vendor",
    "risk_level": "medium"
  }' \
  http://localhost:8200/api/v1/process | jq .
# Guardian evaluates: is this safe? Should it interrupt the user?
```

---

## Phase 11: DID Operations

### Sign Data

```bash
BRAIN_TOKEN=$(cat secrets/brain_token)

curl -s -X POST \
  -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"data":"hello world"}' \
  http://localhost:8100/v1/did/sign | jq .
# {"signature":"hex...","did":"did:plc:..."}
```

### Verify Signature

Take the signature from above and verify it:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"data\": \"hello world\",
    \"signature\": \"<hex from sign response>\",
    \"did\": \"<your DID>\"
  }" \
  http://localhost:8100/v1/did/verify | jq .
# {"valid":true}
```

### Cross-Node Verification

Sign on Alonso, verify on Sancho:

1. On **Laptop 1**: Sign data, note the signature and DID
2. On **Laptop 2**: Call `/v1/did/verify` with Alonso's DID, the data, and signature
3. Should return `{"valid":true}` — proves Sancho can verify Alonso's identity

---

## Phase 12: Admin Dashboard

### Access the Admin UI

The admin UI runs inside the brain container and is proxied through core at `/admin/`.

```bash
# First, you need DINA_INTERNAL_TOKEN set (for production).
# In dev/test mode, the proxy works without it but warns.

# Open in browser:
open http://localhost:8100/admin/login
```

Login with the CLIENT_TOKEN (from Phase 4 pairing).

### Test Admin Endpoints via curl

```bash
CLIENT_TOKEN=$(cat secrets/client_token)

# Dashboard status
curl -s -H "Authorization: Bearer $CLIENT_TOKEN" \
  http://localhost:8100/admin/status | jq .

# List contacts via admin
curl -s -H "Authorization: Bearer $CLIENT_TOKEN" \
  http://localhost:8100/admin/contacts | jq .

# List devices via admin
curl -s -H "Authorization: Bearer $CLIENT_TOKEN" \
  http://localhost:8100/admin/devices | jq .
```

---

## Phase 13: WebSocket Real-Time

### Connect via WebSocket

```bash
# Using websocat (brew install websocat)
CLIENT_TOKEN=$(cat secrets/client_token)

websocat "ws://localhost:8100/ws?token=$CLIENT_TOKEN"
# Connection opens. You'll receive heartbeat pings.
# Messages sent to /v1/notify will appear here in real time.
```

### Send a Notification

In another terminal:

```bash
CLIENT_TOKEN=$(cat secrets/client_token)

curl -s -X POST \
  -H "Authorization: Bearer $CLIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Test notification from Dina"}' \
  http://localhost:8100/v1/notify | jq .
```

The WebSocket terminal should display the notification.

---

## Phase 14: End-to-End Scenario — "Sancho Visits Alonso"

This is the full vision test from the README. Run these steps in order.

### Morning: Alonso Stores Context

On **Laptop 1** (Alonso):

```bash
BRAIN_TOKEN=$(cat secrets/brain_token)

# Store relationship context
curl -s -X POST -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "persona":"personal",
    "item":{"Type":"note","Summary":"Sancho preferences",
            "BodyText":"Sancho likes strong cardamom tea. His mother was unwell last visit. He is sensitive about it."}
  }' http://localhost:8100/v1/vault/store | jq .

# Store calendar event
curl -s -X POST -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "persona":"personal",
    "item":{"Type":"event","Summary":"Sancho visiting today at 3pm",
            "BodyText":"Clear afternoon schedule. Sancho is coming over."}
  }' http://localhost:8100/v1/vault/store | jq .
```

### Afternoon: Sancho Leaves Home

On **Laptop 2** (Sancho):

```bash
BRAIN_TOKEN=$(cat secrets/brain_token)
ALONSO_DID="did:plc:<alonso>"

# Sancho's Dina notifies Alonso's Dina
curl -s -X POST -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"to\":\"$ALONSO_DID\",
    \"body\":\"$(echo -n '{\"type\":\"arrival\",\"eta_minutes\":15}' | base64)\",
    \"type\":\"nudge\"
  }" http://localhost:8100/v1/msg/send | jq .
```

### Alonso's Dina Prepares

On **Laptop 1** (Alonso):

```bash
# Check inbox — should have Sancho's arrival nudge
curl -s -H "Authorization: Bearer $BRAIN_TOKEN" \
  http://localhost:8100/v1/msg/inbox | jq .

# Ask Brain for context
curl -s -X POST -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Sancho is arriving in 15 minutes. What should I prepare?","persona_id":"personal","persona_tier":"open"}' \
  http://localhost:8200/api/v1/reason | jq .
# Brain should recall: "cardamom tea, strong" and "ask about his mother"
```

### Verification

```bash
# Verify message delivery
docker compose logs core | grep -E "outbox|delivered|acked"

# Verify vault search works
curl -s -X POST -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"persona":"personal","query":"Sancho tea mother"}' \
  http://localhost:8100/v1/vault/query | jq '.[] | .Summary'
```

---

## Phase 15: Security Scenarios

### Test Auth Boundaries

```bash
# Brain token should NOT work for persona management
BRAIN_TOKEN=$(cat secrets/brain_token)
curl -s -X POST -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"evil","tier":"open","passphrase":"x"}' \
  http://localhost:8100/v1/personas
# Should be rejected (wrong token scope)

# No token should fail
curl -s http://localhost:8100/v1/vault/query
# 401 unauthorized

# Invalid token should fail
curl -s -H "Authorization: Bearer invalid_token_here" \
  http://localhost:8100/v1/vault/query
# 401 unauthorized
```

### Test Locked Persona Access

```bash
CLIENT_TOKEN=$(cat secrets/client_token)

# Create a locked persona
curl -s -X POST -H "Authorization: Bearer $CLIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"financial","tier":"locked","passphrase":"fin-pass-789"}' \
  http://localhost:8100/v1/personas | jq .

# Try to query the locked persona's vault (should fail with 403)
BRAIN_TOKEN=$(cat secrets/brain_token)
curl -s -X POST -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"persona":"financial","query":"anything"}' \
  http://localhost:8100/v1/vault/query
# Should fail — persona is locked

# Unlock it
curl -s -X POST -H "Authorization: Bearer $CLIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"persona":"persona-financial","passphrase":"fin-pass-789"}' \
  http://localhost:8100/v1/persona/unlock | jq .
# {"status":"unlocked"}

# Now vault query should work
curl -s -X POST -H "Authorization: Bearer $BRAIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"persona":"financial","query":"anything"}' \
  http://localhost:8100/v1/vault/query | jq .
```

### Test Dead-Drop (Message While Vault is Locked)

1. Lock the persona on Sancho's node (or stop the vault)
2. Send a D2D message from Alonso
3. Message should land in dead-drop (stored encrypted)
4. Unlock Sancho's persona
5. Background sweeper (every 10s) should decrypt and deliver

```bash
# Monitor on Sancho's laptop:
docker compose logs -f core | grep -E "dead.drop|sweeper|pending"
```

---

## Phase 16: Recovery Phrase Verification

The 24-word mnemonic is the master backup.

```bash
BRAIN_TOKEN=$(cat secrets/brain_token)

# Get mnemonic (only works once for security in production; in dev mode always available)
curl -s -H "Authorization: Bearer $BRAIN_TOKEN" \
  http://localhost:8100/v1/identity/mnemonic | jq .
# {"did":"did:plc:...","mnemonic":"word1 word2 ... word24"}
```

---

## Cleanup

### Stop Containers

```bash
cd ~/dina-alonso
docker compose down

cd ~/dina-sancho
docker compose down
```

### Full Cleanup (Deletes All Data)

```bash
docker compose down -v    # removes named volumes (vault data!)
rm -rf secrets/ .env      # removes secrets
```

---

## Quick Reference: All Endpoints

### Core (port 8100) — No Auth

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/healthz` | Liveness |
| GET | `/readyz` | Readiness |
| GET | `/.well-known/atproto-did` | AT Protocol DID discovery |
| POST | `/msg` | NaCl-encrypted D2D ingress (authenticated by sealed box) |

### Core (port 8100) — BRAIN_TOKEN or CLIENT_TOKEN

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/vault/store` | Store item |
| POST | `/v1/vault/store/batch` | Batch store |
| POST | `/v1/vault/query` | Search vault |
| GET | `/v1/vault/item/{id}` | Get item |
| DELETE | `/v1/vault/item/{id}` | Delete item |
| GET/PUT | `/v1/vault/kv/{key}` | KV get/set |
| GET | `/v1/did` | Get DID |
| POST | `/v1/did/sign` | Sign data |
| POST | `/v1/did/verify` | Verify signature |
| GET | `/v1/did/document` | DID document |
| GET | `/v1/identity/mnemonic` | Recovery phrase |
| POST | `/v1/msg/send` | Send D2D message |
| GET | `/v1/msg/inbox` | Check inbox |
| POST | `/v1/pii/scrub` | PII scrubbing |
| POST | `/v1/task/ack` | Acknowledge task |
| POST | `/v1/notify` | Push notification |
| WS | `/ws` | WebSocket (real-time) |

### Core (port 8100) — CLIENT_TOKEN Only

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v1/personas` | List personas |
| POST | `/v1/personas` | Create persona |
| POST | `/v1/persona/unlock` | Unlock persona |
| POST | `/v1/pair/initiate` | Start pairing |
| POST | `/v1/pair/complete` | Complete pairing |
| GET | `/v1/devices` | List devices |
| DELETE | `/v1/devices/{id}` | Revoke device |
| GET/POST | `/v1/contacts` | List/add contacts |
| PUT/DELETE | `/v1/contacts/{did}` | Update/delete contact |
| GET/PUT | `/v1/contacts/{did}/policy` | Sharing policy |

### Brain (port 8200, internal only) — BRAIN_TOKEN

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/healthz` | Health |
| POST | `/api/v1/reason` | LLM reasoning |
| POST | `/api/v1/process` | Event processing |
| POST | `/api/v1/pii/scrub` | NER-based PII scrubbing |

### Admin (proxied through core at /admin/) — CLIENT_TOKEN

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/login` | Login page |
| POST | `/admin/login` | Authenticate |
| GET | `/admin/` | Dashboard |
| GET | `/admin/contacts` | Contact management |
| GET | `/admin/devices` | Device management |
| GET/PUT | `/admin/settings` | Settings |
| POST | `/admin/api/chat` | Chat interface |
