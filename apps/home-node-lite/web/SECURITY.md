# Web target — security model

The Dina mobile app's iOS / Android builds get hardware-backed key
isolation (Secure Enclave on Apple, StrongBox / TEE on Android). The
React Native Web bundle does not — browsers have no equivalent. This
document is the honest fine print operators should read **before**
running the web client outside their own laptop.

Source: `docs/HOME_NODE_LITE_WEB_UI_TASKS.md` Phase 2 "Storage shim".

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

2. **Core vault data.** _Not stored in the browser at all._ All
   vault reads/writes go to the brain-server over HTTPS, which in
   turn talks to Core's SQLCipher file. The web client is a thin
   UI shell over the same `/api/v1/*` endpoints mobile uses.

## What is NOT stored in the browser

- The vault DEKs (those live in Core's process memory).
- The master seed / 24-word recovery mnemonic. Onboarding shows the
  mnemonic once on-screen and the operator copies it offline; the
  browser only ever holds it transiently during the verify-words
  step, after which `crypto.subtle.encrypt` wraps it for shipment
  to Core.
- Any persona-tagged vault content. Reads stream through the HTTPS
  API per request and are GC'd as soon as the React component
  unmounts.

## Mitigations vs. residual risks

| Threat                                                  | Mitigation                                                                                                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resting compromise of the user's disk (no browser open) | AES-GCM under a non-extractable WebCrypto key. Stolen IndexedDB rows are opaque.                                                                                           |
| Hostile script on the same origin (XSS, malicious ext.) | **Not mitigated.** Inside the trust boundary. Run the brain-server on a hostname you control end-to-end; never proxy through a CDN that injects ad/analytics scripts.      |
| Another user logging into the same OS account           | Browser profile separation. The same-machine-different-OS-account case is the OS's responsibility; we don't reach below the browser.                                       |
| Backup software exfiltrating browser data               | The IndexedDB rows are encrypted at rest — backups carry ciphertext only. Recovery requires the operator to restore the browser profile (which holds the wrap key) intact. |
| Network adversary                                       | TLS to the brain-server (operator-issued cert). The brain-server's `/api/v1/*` requires Ed25519 device-key signed requests just like mobile.                               |

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

## Owner control (interactive runs & watches)

The `/v1/run*` and `/v1/watch*` routes are the owner-only control plane
(`INTERACTIVE_SERVICES_ARCHITECTURE.md` §12.5): only the human owner may
create, decide, or steer a run. On mobile that owner is the in-app user
(in-process, no credential travels). On the split server the owner is the
human at a browser, so Core mints an **owner capability** —
`DINA_OWNER_CAPABILITY`, or a `0600` `owner_capability` file in the vault dir —
and only a request carrying the matching `x-dina-owner-capability` header (a
timing-safe compare, scoped to the run/watch paths) is treated as the owner.

Two ways to present it, both **opt-in and off by default**:

- **Core-served owner console (recommended) — `DINA_CORE_OWNER_CONSOLE=1`.**
  Core serves a self-contained page at `/owner` (on the Core port) whose calls
  target Core's *own* routes same-origin. The capability lives only on Core's
  origin and **never transits Brain**. This is the credential-safe surface.
- **Brain byte-pipe — `DINA_BRAIN_OWNER_PROXY=1`.** Lets the Brain-served web
  app drive runs by forwarding the header verbatim to Core. Convenient (one
  origin for the whole SPA), but the reusable capability **passes through the
  Brain process**: a fully-compromised Brain could skim it from a live request
  and then issue owner commands itself. Enable this only when that residual is
  acceptable (loopback-only dev), and prefer the Core console otherwise.

With neither flag set, the server exposes no browser owner surface at all
(fail-closed). The custom-header requirement is itself a CSRF defense — a
cross-site page can't set a custom header without a CORS preflight, and Core
sends no permissive CORS headers by default.

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
