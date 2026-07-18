# AGENTS.md — Dina (project context for Codex and other agents)

This file orients any agent (Codex CLI, Codex plugin, MCP-connected tools) working in this
repository. **`CLAUDE.md` is the authoritative working guide; this file is a concise primer that
points to it.** For depth, read, in order: `README.md` (product vision), `ARCHITECTURE.md`
(engineering blueprint, ~500 lines), `CLAUDE.md` (build/test/gotchas), `dina_details.md`, and the
per-subsystem design docs under `docs/` (`PLUGIN_ARCHITECTURE.md`, `AGENT_CONTROL_PLANE.md`,
`CONTACT_SERVICES_ARCHITECTURE.md`, `CURATION_SERVICES_ARCHITECTURE.md`, `PUSH_SERVICES_ARCHITECTURE.md`,
`INTERACTIVE_SERVICES_ARCHITECTURE.md`).

## What Dina is

**Dina is a sovereign personal AI and the user-owned authority / control plane for autonomous
agents.** She holds one person's identity, encrypted memory, and policy, and serves that person
alone — not advertisers or platforms. Any agent supporting the Dina protocol submits its *intent*
before acting; Dina gates risky actions for the user's approval. Loyalty is enforced by
cryptography (the user holds the keys), not by policy. When many Dinas connect they form **PeerLens**,
a trust network on AT Protocol.

### The Four Laws (every design decision honours these)
1. **Silence First** — never push content; speak only when asked or when silence causes harm
   (tiers: Fiduciary=interrupt, Solicited=notify, Engagement=briefing).
2. **Verified Truth** — rank by trust, not ad spend (PeerLens, not marketing).
3. **Absolute Loyalty** — the human holds the encryption keys; enforced by math.
4. **Never Replace a Human** (Anti-Her) — connect the user to people, never simulate intimacy.

## What ships today (stack reality)

- **The TypeScript stack is the product.** The same `@dina/core`, `@dina/brain`, `@dina/protocol`
  packages run on a phone (Expo/React Native, a full Home Node on-device — **iOS live on the App
  Store**, Android in progress) and on a server (`apps/home-node-lite`, two Fastify processes:
  Core `:8100`, Brain `:8200`). Only the platform adapters (`packages/*-node` vs `packages/*-expo`)
  differ.
- **`legacy/` (Go Core + Python Brain) is a reference oracle, not the product.** Do **not** add new
  product behavior to `legacy/`; new work goes in `packages/` + `apps/`.

## Architecture invariants (most likely to matter in review)

- **Kernel, not platform.** No untrusted code ever runs inside Dina's trust boundary. External
  agents talk via MCP; peers via D2D. Plugins are **signed, content-addressed manifests** that run
  *either* as interpreted data in a hardened first-party runtime *or* as out-of-process code paired
  as a device — never as in-process third-party code. Plugins are **not** agents.
- **Sidecar / split-brain.** **Core is the vault keeper** — holds the master seed, opens per-persona
  SQLCipher vaults, enforces persona access + egress, signs, does D2D; never runs an LLM or touches
  the network on its own. **Brain is the analyst** — reasons, routes to LLMs, delegates via MCP;
  holds no keys, never touches SQLite; it is an **untrusted tenant**. On a server the boundary is two
  OS processes with Ed25519-signed calls; on mobile it is a typed import graph in one JS VM (no
  signing). Egress + persona gating happen in Core, in compiled code, with no LLM in the enforcement
  path.
- **Sovereign identity + personas.** One `did:plc` root identity; each persona is a separate
  encrypted `.sqlite` vault with its own DEK. No external system crosses compartments.
- **4-tier gatekeeper.** Personas are default / standard / sensitive / locked. The single
  deterministic agent check (`packages/core/src/agent/access.ts`) fires only for agent callers; a
  sensitive/locked persona with no grant creates an idempotent approval task and returns *without
  reading the vault*.
- **Two key derivations, one seed.** BIP-39 → SLIP-0010 (Ed25519 signing tree, hardened-only,
  purpose `9999'`) **and** HKDF-SHA256 over the raw seed for per-persona SQLCipher DEKs. Keep them
  independent; BIP-44 purpose `44'` is forbidden. DEKs are never stored (only a hash).

## Wire / protocol constraints (byte-exact)

- **All JSON on the wire is `snake_case`.**
- `@dina/protocol` has **zero runtime dependencies** (crypto injected via callbacks); do not add
  `@dina/*` or third-party runtime imports to it. Wire-format changes bump the protocol major.
- **Sealed-box nonce = BLAKE2b(24)**, never truncated SHA-512 (frozen conformance vector).
- Canonical signed-request payload: `{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{NONCE}\n{SHA256_HEX(BODY)}`
  with headers `X-DID`, `X-Timestamp`, `X-Nonce`, `X-Signature`.
- The live Core↔Brain contract is the hand-written routes in `packages/core/src/server/routes/*`
  (tested by `__tests__/server/routes/*`), **not** the deprecated `api/*.yaml` OpenAPI specs.

## Build / test quick reference

- Node ≥ 22 (`nvm use`), then `npm install` at the repo root. From the root: `npm test` (jest),
  `npm run typecheck`, `npm run lint`, `npm run format`. Tests need `DINA_RATE_LIMIT=100000`.

## Rules for agents operating here

- **No git writes** (commit, push, branch, tag, reset, discarding checkout) unless the user
  explicitly asks in that turn. Read-only git (status, log, diff, fetch, pull) is fine.
- **Stay inside the project root** (`/Users/rajmohan/OpenSource/dina2/dina/`).
- **PII must never reach stdout** — log metadata only (persona, type, count, latency), never vault
  content, queries, or plaintext.
- Do not add new product behavior to `legacy/`.
