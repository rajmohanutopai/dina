# A2A gateway

The public door for outside A2A agents (docs/A2A_GATEWAY_ARCHITECTURE.md §4.1,
Lane 2). It serves:

| Path | What |
|---|---|
| `GET /.well-known/agent-card.json` | The node's signed Agent Card, as Core built it |
| `GET /.well-known/jwks.json` | The key set the card's `jku` names |
| `POST /a2a/v1` | JSON-RPC: every A2A v1.0 method; `SendStreamingMessage` and `SubscribeToTask` answer as Server-Sent Events |
| `GET`, `POST`, `DELETE /a2a/rest/…` | REST (HTTP+JSON): the same methods at the v1.0 paths (`/message:send`, `/message:stream`, `/tasks`, `/tasks/{id}`, `/tasks/{id}:cancel`, `/tasks/{id}:subscribe`, `/tasks/{id}/pushNotificationConfigs[/{configId}]`, `/extendedAgentCard`); answers are `application/a2a+json`, errors `google.rpc.Status` |
| `POST /a2a/v1/did-binding` | Binds a client to a DID with the owner's challenge (design §5.1) |
| `GET /healthz` | Liveness |

## What it does and does not do

The gateway decides nothing. It keeps each client's body as raw bytes, picks
Core's internal route by the table in `@dina/a2a` (from the body for
JSON-RPC, `ingressPathFor`; from the method and path for REST,
`restIngressPath`), and forwards the request as sent (method, path, query,
raw body) with the client's credential (its `Authorization` header, or a
DID-bound client's signature headers) to Core, signed with its own service
key. Core authenticates the client, checks the route against what the client
sent, and writes the answer, rendered for the binding the client used. The gateway relays only answers Core marks as
written for the client (`x-dina-a2a-answer`). Anything else, such as Core
refusing the gateway itself, reaches the client as `503`.

The gateway answers only what needs no authority: malformed JSON-RPC, a call
with no route id, a REST path no operation has (404) or a wrong method on one
(405), bodies over 256 KB, its own per-address limit (120 calls a minute by
default) and its stream limit.

It also delivers task events (design §7.5). Core records each change a client
can see; the gateway claims the due ones, writes them to its open streams, and
POSTs them to the webhooks clients configured. Webhook POSTs go through the
same outbound policy as Dina's own A2A calls (HTTPS, no private address, the
vetted address pinned, no redirects), with the client's `Authorization` and
`X-A2A-Notification-Token`; Core decides retries. A stream ends when its task
does, when its client's authority goes, after 30 minutes, or when the client
falls more than 1 MB behind; the client may subscribe again.

It holds no vault, no durable state, and no key of Core's or Brain's. Its
logs carry the method, status and latency, never a body, a token, a URL or a
task id.

## Running it

Core must know the gateway, and the gateway must have its own key:

1. Create the key once and print its DID:
   `dina-home-node-lite-a2a-gateway keygen` (with `DINA_A2A_GATEWAY_KEY_DIR` set).
2. Give Core `DINA_A2A_GATEWAY_DID` (that DID) and `DINA_A2A_PUBLIC_URL`
   (the https origin clients will use). Set both or neither.
3. Start the gateway. Put a TLS terminator in front of it; the gateway itself
   listens on loopback (`127.0.0.1:8400`) by default.

| Variable | Default | Meaning |
|---|---|---|
| `DINA_A2A_GATEWAY_HOST` | `127.0.0.1` | Listen host |
| `DINA_A2A_GATEWAY_PORT` | `8400` | Listen port |
| `DINA_CORE_URL` | `http://127.0.0.1:8100` | Core |
| `DINA_A2A_GATEWAY_KEY_DIR` | (required) | Directory holding the key |
| `DINA_A2A_GATEWAY_KEY_FILE` | `gateway.ed25519` | The key file: a raw 32-byte Ed25519 seed |
| `DINA_A2A_GATEWAY_DID` | (optional) | Checked against the key at boot |
| `DINA_A2A_GATEWAY_IP_LIMIT` | `120` | Calls per minute per client address |
| `DINA_A2A_GATEWAY_MAX_STREAMS` | `500` | Event streams open at once |
| `DINA_A2A_GATEWAY_STREAMS_PER_IP` | `20` | Of those, per client address |
| `DINA_A2A_GATEWAY_TRUST_PROXY` | `0` | How many proxies in front set `X-Forwarded-For` (normally `1`). Their count, never "trust all": a client can write its own entries |

With Docker: `docker compose -f apps/home-node-lite/docker-compose.lite.yml
--profile a2a run --rm a2a-gateway keygen`, put the printed DID and the public
URL in `.env`, then `docker compose --profile a2a up -d`.

## Isolation (design §4.1, plan §3.18)

The compromise model assumes the gateway cannot read Core's files and cannot
reach Brain. The compose file gives it its own container, user (UID 10003),
read-only root and key volume, on a network (`dina-a2a`) that only Core
shares. Brain is on another network the gateway cannot reach.

A native install that runs the gateway as the same OS user as Core and Brain
does not meet this. Do not open the gateway's port to the network there.
