# Web target — security model

The Dina mobile app's iOS / Android builds get hardware-backed key
isolation (Secure Enclave on Apple, StrongBox / TEE on Android). The
React Native Web bundle does not — browsers have no equivalent. This
document is the honest fine print operators should read **before**
running the web client outside their own laptop.

Source: `docs/WEB_THIN_CLIENT_DESIGN.md` (the thin-client conversion) +
`docs/HOME_NODE_LITE_WEB_UI_TASKS.md`.

> **Status (2026-06-30):** the thin-client model below is now **implemented**,
> not aspirational — the web build boots no in-process node and drives a
> durable server over `/api/v1/*`. This doc describes the shipped behaviour.

## Trust boundary

| Mobile (iOS / Android)              | Web (this build)                                      |
| ----------------------------------- | ----------------------------------------------------- |
| Device-local OS keychain            | Browser IndexedDB at `origin` granularity             |
| Hardware-backed key isolation       | Software-only AES-GCM at rest                         |
| Biometric / passcode gate at the OS | Operator's logged-in browser session is the gate      |
| Per-app sandboxing                  | Per-origin sandboxing (same-site = same blast radius) |

**The trust boundary on web is the operator's logged-in browser
session.** Anything else in the same origin — a malicious extension,
a hostile script injected via XSS, another tab on the same site —
sits inside that boundary and can read everything we store. Browsers
don't provide a tighter isolation primitive than the origin.

## What is stored where

Two surfaces hold device-local material:

1. **`keychain.web.ts`** (`apps/mobile/src/services/keychain.web.ts`).
   - Backing store: IndexedDB database `dina-keychain`, object store
     `entries`, one row per `service` name.
   - Stored fields per row: `service` (cleartext key), `username`
     (cleartext), `iv` (12 random bytes), `ct` (ciphertext + GCM tag).
   - **Encryption-at-rest:** AES-256-GCM under a per-origin wrap
     key generated at first install. The wrap key is a
     **non-extractable** `CryptoKey` — IndexedDB persists it via
     structured clone, but the raw key bytes never enter JavaScript
     memory in any form WebCrypto exposes. An attacker who
     exfiltrates the raw IndexedDB rows cannot decrypt them without
     also driving the browser's WebCrypto subsystem on the
     compromised origin.

2. **Node state (vault, identity, contacts, people, service config,
   workflow, devices).** _Not stored in the browser at all._ The web
   build is a **thin client**: it boots **no in-process node**
   (`bootWebThinNode` — no `createCoreRouter`, no SQLite, no in-memory
   repos) and drives a durable Home Node Lite server over the
   brain-server's `/api/v1/*` proxy. The brain-server proxies to Core
   (SQLCipher vault, `did:plc`); Core does all crypto. The browser holds
   a `BrowserCoreProxyClient` — an **unsigned, same-origin** HTTP client,
   nothing more.

   > **Web vs. mobile transport differ.** Mobile runs the node
   > **in-process** (`InProcessTransport` → `createCoreRouter`); web is the
   > thin-client `/api/v1/*` proxy. Both consume the same `CoreClient`
   > interface, which is why the SPA hooks are transport-agnostic — but the
   > web bundle never instantiates the in-process node (asserted in
   > `web_thin_node.test.ts`).

## What is NOT stored in the browser

- **No signing key.** The `BrowserCoreProxyClient` is unsigned. The
  Ed25519 service key that signs Core requests lives **only** on the
  brain-server (the signed hop is brain→Core, never browser→brain). The
  browser must never hold a signing key — that is why it talks to the
  same-origin brain-server proxy and never to Core directly.
- **No master seed / DEK / recovery mnemonic.** The seed lives on the
  **server** in thin-client mode. The browser never sees it: there is no
  in-browser onboarding (it adopts the server's already-provisioned
  `did:plc`), and the seed-bound settings rows (View / Confirm recovery
  phrase, Change passphrase) are **hidden on web** — revealing the
  mnemonic would put it in browser memory, which this model forbids.
- **No AI provider (BYOK) key.** Provider keys are stored server-side; the
  browser holds at most a redacted status (`{provider, last4, active}`).
- **No persona-tagged vault content.** Reads stream through the
  `/api/v1/*` proxy per request and are GC'd as the React component
  unmounts; the vault DEKs stay in Core's process memory.

## Mitigations vs. residual risks

| Threat                                                  | Mitigation                                                                                                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resting compromise of the user's disk (no browser open) | AES-GCM under a non-extractable WebCrypto key. Stolen IndexedDB rows are opaque.                                                                                           |
| Hostile script on the same origin (XSS, malicious ext.) | **Not mitigated.** Inside the trust boundary. Run the brain-server on a hostname you control end-to-end; never proxy through a CDN that injects ad/analytics scripts.      |
| Another user logging into the same OS account           | Browser profile separation. The same-machine-different-OS-account case is the OS's responsibility; we don't reach below the browser.                                       |
| Backup software exfiltrating browser data               | The IndexedDB rows are encrypted at rest — backups carry ciphertext only. Recovery requires the operator to restore the browser profile (which holds the wrap key) intact. |
| Network adversary                                       | TLS to the brain-server (operator-issued cert). The browser→brain `/api/v1/*` hop is **unsigned + same-origin**, gated by the access cookie below (NOT Ed25519 signing — the browser holds no key); the brain→Core hop is Ed25519-signed. |
| Another local process driving the node API              | The **access gate** (below): without the session cookie, `/api/v1/*` returns 401. Same-origin + `127.0.0.1` binding alone do **not** stop a local process — the cookie does. |

## Access gate — the `/api/v1/*` surface (D4)

The `/api/v1/*` proxy is **gated by default** (`web_access_gate.ts`). Because
the browser holds no signing key, authorization is a **server-minted browser
session**, not a request signature:

- At boot the brain mints a crypto-random token and prints a tokenised URL
  (`…/web/?token=<token>`) to the **server console** — the out-of-band channel
  only the operator who started the node can see (Jupyter's notebook-token
  model).
- The operator opens that URL. The gate validates the token, sets an
  **`HttpOnly; SameSite=Strict`** session cookie, and 302-redirects to the clean
  `/web/` URL (so the token doesn't linger in history/referrer). Browsers
  auto-attach the cookie to every same-origin `/api/v1/*` request.
- An **unauthenticated `/web` load (no cookie, no valid token) gets `401` and
  NO cookie** — the secret is never handed to an arbitrary visitor. (Setting the
  cookie unconditionally would let any local process `curl /web`, read the
  secret off the `Set-Cookie` header, and replay it — the exact hole this
  closes.)
- **Every `/api/v1/*` request must carry the cookie; otherwise `401`.** Together
  with the token-gated issuance, this stops *other local processes* (they never
  saw the console token) and *cross-origin pages* (`SameSite=Strict` means the
  cookie isn't sent from a different site) — same-origin + loopback binding
  alone do **not** stop a local process.
- On loopback there are no sibling same-site origins, so the cookie alone is
  the CSRF defense — no separate CSRF token is needed.
- The brain-server **binds `127.0.0.1`** by default. Any non-loopback exposure
  additionally needs TLS + a CORS allow-list (and, for multi-user, device
  pairing — out of scope here).
- **Dev/test escape:** `DINA_BRAIN_DEV_OPEN=1` disables the gate entirely. This
  is the **only** unauthenticated path and must never be set in a shipped web
  build.

## What this means in practice

**Recommended deployments:**

- A personal laptop the operator owns. Single user, single browser
  profile, no shared extensions.
- A locked-down browser kiosk on the operator's premises (e.g. a
  dedicated Mac mini running Safari with only this site
  whitelisted).
- A self-hosted brain-server reachable only from the operator's
  LAN / Tailscale net.

**Discouraged:**

- Shared workstations (libraries, schools, conference rooms).
  Anyone with intra-session access to the browser reads the keys.
  Use the mobile app instead.
- Hosting the brain-server on a public CDN that injects third-party
  scripts. The CDN sits inside the trust boundary by definition.
- Sharing a browser profile across users. Don't.

## Verifying the security claims locally

The dual-mode parity test
(`apps/mobile/__tests__/services/keychain_dual.test.ts`) includes a
direct ciphertext-on-disk inspection: it stores a known plaintext
canary string and asserts the raw IndexedDB row contains neither
the canary string nor any substring of it. Run:

```sh
npx jest --rootDir apps/mobile __tests__/services/keychain_dual.test.ts
```

This proves the encryption-at-rest path runs end-to-end under the
exact `fake-indexeddb` + Node-WebCrypto code path the browser uses.
