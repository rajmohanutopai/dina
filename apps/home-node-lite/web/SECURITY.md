# Web target — security model

The Dina mobile app's iOS / Android builds get hardware-backed key
isolation (Secure Enclave on Apple, StrongBox / TEE on Android). The
React Native Web bundle does not — browsers have no equivalent. This
document is the honest fine print operators should read **before**
running the web client outside their own laptop.

Source: `docs/HOME_NODE_LITE_WEB_UI_TASKS.md` Phase 2 "Storage shim";
`docs/WEB_OWNER_SURFACE_PLAN.md` (Core serves the page; the owner device).

**Where the page lives.** Core serves the web app at `/app/` on Core's port
(`DINA_CORE_WEB_UI=1`). Owner calls go to Core on that same origin, signed by
this browser's owner device; chat, contacts, reminders and notifications go to
Brain's `/api/*` cross-origin, which Brain allows for exactly Core's origin
(`DINA_BRAIN_WEB_ORIGIN`). Nothing Brain returns is ever served from Core's
origin.

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

Three surfaces hold device-local material:

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

2. **The owner device** (`apps/mobile/src/services/owner_device.web.ts`).
   - Backing store: IndexedDB database `dina-owner-device`, one record.
   - An Ed25519 signing key made with WebCrypto as **non-extractable**:
     the page can ask the browser to sign with it, but no script can read
     it out. Core registered its public half as a device with role
     `owner`; a lost laptop is one revoke (Settings → Owner access, or
     Agents from any owner surface).
   - The owner key (`owner_capability`) is used once to pair and is **not
     stored**.

3. **The owner's vault.** _Not stored in the browser._ Owner reads and
   decisions go to Core; the rest to Brain. (The web build also runs a
   small node of its own in the tab — onboarding creates a browser
   identity — which holds none of the owner's vault.)

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
| Hostile script on the same origin (XSS, malicious ext.) | **Partly.** The page's CSP runs only its own scripts (`script-src 'self'`, no inline, no `eval`). A script that did run could act as the owner while the page is open, but could not take the owner device key away (non-extractable). On a security-mode node spending, pairing, plugin consent and money cards still need the passphrase; a convenience-mode node has none, so there the script could do them too. |
| Another user logging into the same OS account           | Browser profile separation. The same-machine-different-OS-account case is the OS's responsibility; we don't reach below the browser.                                       |
| Backup software exfiltrating browser data               | The IndexedDB rows are encrypted at rest — backups carry ciphertext only. Recovery requires the operator to restore the browser profile (which holds the wrap key) intact. |
| Network adversary                                       | Core and Brain stay on loopback; a remote browser reaches both through an SSH tunnel or a private network (Tailscale). Owner calls carry an Ed25519 signature, a timestamp and a nonce (replay refused). Brain's `/api/*` is unauthenticated by design: never publish it. |

## What this means in practice

**Recommended deployments:**

- A personal laptop the operator owns. Single user, single browser
  profile, no shared extensions.
- A locked-down browser kiosk on the operator's premises (e.g. a
  dedicated Mac mini running Safari with only this site
  whitelisted).
- A self-hosted Home Node reached only over loopback, through
  `ssh -L 8100:127.0.0.1:8100 -L 8200:127.0.0.1:8200 host` or a
  private network such as Tailscale.

**Discouraged:**

- Shared workstations (libraries, schools, conference rooms).
  Anyone with intra-session access to the browser reads the keys.
  Use the mobile app instead.
- Putting Core or Brain behind a public CDN or proxy that injects
  third-party scripts. It sits inside the trust boundary by definition.
- Sharing a browser profile across users. Don't.

## Owner control

Only the human owner may decide an approval card, place an order, award a
tender, grant staff authority, pair a device or install a plugin. On mobile
that owner is the in-app user (in-process, no credential travels). On a
server node the owner is the human at a browser, and Core recognises the
owner two ways, both only on the owner routes:

- **The owner device (the web app).** A browser connected under Settings →
  Owner access signs each request with its non-extractable key; Core's
  entry point verifies the signature against a device of role `owner` and
  treats the request as the owner. Off the owner routes the device reaches
  nothing.
- **The owner capability** (`DINA_OWNER_CAPABILITY`, or the `0600`
  `owner_capability` file in the vault dir), in the `x-dina-owner-capability`
  header: for headless servers, scripts, and pairing the first owner device.
  A timing-safe compare, scoped to the owner routes.

Neither ever reaches Brain. The old path that let the Brain-served page
forward the capability through Brain (`DINA_BRAIN_OWNER_PROXY`) and Brain's
own copy of the app (`/web`) are gone. The Core-served `/owner` console
(`DINA_CORE_OWNER_CONSOLE=1`) remains for now, same-origin with Core's
routes.

**Presence.** The powerful actions — spending, staff authority, pairing a
coding agent, staff phone, owner device or approval phone, plugin consent and
updates, invites, buyer and supplier settings, choosing a reasoning backend,
the yes on a money or staff-escalation card, lowering an agent's supervision —
also need the owner's passphrase within the last five minutes (a person
present), on every surface. The proof counts only for the surface that made
it (this browser, another browser, the capability). Revoking and declining
never do. This holds on a node in **security mode**
(`DINA_UNLOCK_PASSPHRASE` set before the server's first boot); a
convenience-mode node has no passphrase to ask for and gates none of these.

A cross-site page cannot forge an owner call: it holds no key, and a custom
header or signature needs a CORS preflight Core never grants.

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
