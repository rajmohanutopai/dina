# Dina as a Plugin — The Developer Surface

## Functional & Technical Specification, v1 — full functionality (July 2026)

**Status:** Implemented developer preview. The Home Node Lite runtime, automatic
coding-agent enrollment, Claude Code and Codex packages, and all nine tool
surfaces are implemented. Public native-release/marketplace publication, automatic
phone-to-HNL continuity, and multi-phone approval routing remain release work
(§22).
**Owner:** Rajmohan H
**One line:** Your Dina — the whole of her — available inside the agent you already use.
**Scope of this document:** the **complete** developer surface. Every Dina functionality
(remember, ask, task, talk, PeerLens, reminders, security, approvals, services) reachable from a
coding agent, plus publish/consume and cross-Dina D2D. The four-density order in §5 is a
**recommended build sequence**, not a feature boundary — v1 is the union of all of it.

**Runtime policy:** `docs/CONNECTED_AGENT_GATING_AND_BRAIN.md` defines the
implemented three-profile gate and connected-host Brain architecture. This
document remains the complete developer surface; that document owns runtime
policy and reasoning-job details.

> **Two ground rules that shape the whole document.**
>
> 1. **Vocabulary.** "Claude Code plugin" is the _distribution package_. Inside Dina, Claude Code
>    authenticates as an **agent** — an external reasoner acting _under_ Dina's authority — **not**
>    as Dina's internal `plugin` role (a bounded capability installed _into_ Dina; see
>    `docs/PLUGIN_ARCHITECTURE.md`). "The plugin" = the package; "the agent" = the caller identity
>    Core sees. The agent is untrusted and lives outside the trust boundary.
> 2. **This is real Core work, not a repackaging.** The _strategy_ reuses Dina's existing **agent
>    model** and the already-designed services/D2D/PeerLens layers. But the developer surface needs
>    concrete new Core work — a Core-owned action classifier, an agent-safe memory-ingress route, a
>    Core-mediated ask, a durable session registry, PDS-backed bootstrap, and a laptop↔phone
>    approval transport. §7 enumerates what exists versus what must be built; nothing below claims a
>    path works that the current code does not support.
>
> **Platform-fact caveat.** Every Claude Code / Codex mechanism cited (hook I/O, matchers, MCP
> resources vs Tool Search, marketplace schema, Codex hooks) moves fast and MUST be re-verified at
> build time. Where a claim is load-bearing, the design works regardless of how the detail resolves.

### As-built snapshot (2026-07-25)

| Area | Current state |
| --- | --- |
| Home Node lifecycle | Source-free native install/start/ensure/stop/status/logs/uninstall, encrypted backup/restore, manifest-verified upgrade, and rollback are implemented in `dina-agent`. |
| Enrollment | First install automatically creates a separate revocable `coding`-scoped `did:key`; no owner or one-time pairing capability is printed or persisted by the installer. |
| Identity | HNL can start immediately with a local `did:key`. Passing `--pds-handle` provisions or rehydrates the owner's `did:plc` for public Services and PeerLens. Existing mobile identity/data can be moved manually with the same recovery phrase plus a `.dina` archive; automatic phone-to-HNL continuity is not implemented. |
| Host adapters | Claude Code and Codex plugin packages contain MCP, skills, lifecycle hooks, and catch-all local tool gates. Host-mediated enforcement limits remain disclosed in each README. |
| Connected Brain | Plugin setup can owner-bind the exact enrolled coding `did:key` as a foreground `connected_host`. Core still owns routing, context projection, leases, schemas, commit, and revocation; host reasoning is available only while the host runs and explicitly processes work. |
| Nine surfaces | Remember, Ask, reminders, Task/delegation, Talk, PeerLens, security, approvals, and Services are exposed through narrow Core-owned routes and the coding MCP profile. |
| Network publishing | Services and PeerLens use the owner's PDS and deployed AppView. Their writes are durable and retried; a `did:plc`/PDS configuration is required. |
| Distribution | Local package validation passes. Platform-specific native release archives and marketplace entries still need to be published from a release commit before a source-free external install can work. |

---

## The one thing to hold onto

**The host may become Dina's Brain; it does not become Dina's control plane.**
Install the plugin and your Dina is reachable from Claude Code or Codex. The
owner may also select that exact coding identity as a foreground reasoning
backend. Core, identity, keys, policy, commit, and audit remain outside the
host. This boundary is the differentiator.

1. **The gate cannot live inside the thing it gates.** The agent is untrusted; Core — keys, policy,
   audit — sits _outside_ it and judges it. Making Claude Code or Codex the foreground reasoner does
   not move those authorities into the host. If the whole of Dina became the host, the gate would be
   theatre. (Necessary but not sufficient — §12
   and §16 show what "the agent cannot subvert its own verdict" actually requires: a Core-owned
   classifier and a payload-bound permit, not just process separation.)
2. **One you, not many yous.** "Becomes" makes every agent its own Dina — its own identity, memory,
   reputation, grants. "Reachable" keeps one identity, one memory, one reputation, one grant set,
   one approval surface, **one place your services are published from and your trust accrues to** —
   every agent a window onto the same you. That is the thing the incumbents structurally will not
   build, because portable-across-competitors memory and identity attack their own lock-in. For the
   full functionality this matters even more: a service you publish, a review you write, a contact
   who grants you access — all attach to _one_ you, not to whichever tool happened to act.

---

# Part I — Functional

## 1. What the developer gets (the full pitch, in priority order)

**Lead with agents working together. Not memory, and not the gate.** Memory is commoditised; leading
with the gate walks into the "the built-in prompts already do this" objection. What nobody else
offers is **agents that work with each other under one identity you own** — and, at full v1, **those
agents publishing and consuming services, and reaching other people's Dinas, all as one you.**

Two products, separated by how many people must install before value exists:

- **Your own agents, working together (one person).** Two or more agents _you_ run — a second Claude
  Code, the `dina-agent` CLI, a home-node agent — sharing one context, one identity, handing work
  between each other.
- **Your agent and other people's (two people).** Publish a service another developer's agent
  consumes; D2D between two people's Dinas; PeerLens reviews and trust. Delivers once a second
  person is present.

**Order of claims:** (1) your agents share one context and hand work between each other; (2) that
context is yours and portable across the agents you run; (3) a deterministic gate + phone approval
for sensitive actions; (4) publish and consume services; (5) talk to other people's agents, with
PeerLens trust behind it.

> **Honesty-gate note (DPD-016).** Claude Code and Codex host packages now ship
> from one coding MCP contract and one setup engine. Portability claims still
> exclude host tools that are not observable through each host's hook surface;
> those limits are listed in the package READMEs and conformance tests.

**Trigger vs retention.** "My agents work together" makes someone _install_; persistent context that
quietly survives makes them _still be using it on day 14_. Measure them apart (§20).

---

## 2. The nine functionalities, through the plugin

v1 surfaces all of Dina's functionality (`dina_details.md` §3) to a coding agent. Each is an MCP
tool and/or a gate behaviour; every one that acts on a sensitive/locked vault or takes a risky
action passes the gate (§12).

| Dina functionality | Developer surface (MCP tool / behaviour)                                                                            | Backing                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Remember**       | `dina_remember(text, category?)` — write a memory as an agent caller                                                | agent memory-ingress route (§14, new work)                                                         |
| **Ask**            | `dina_recall`/`dina_ask(query)` — read/reason across permitted vaults                                               | Core-mediated ask into Brain (§14, new work)                                                       |
| **Reminders**      | reminders auto-created from remembered facts surface as `dina_reminders()` + notifications                          | existing reminder pipeline                                                                         |
| **Task**           | `dina_delegate(task)` — hand work to a paired external agent (`dina-agent`/OpenClaw)                                | Core delegation façade + `dina-agent` (§17, new)                                                   |
| **Talk (D2D)**     | `dina_talk(contact, message)` — your Dina messages another person's Dina, sealed                                    | Core `dina_talk` façade over D2D/MsgBox (§17, new)                                                 |
| **PeerLens**       | `dina_review(subject, category, sentiment)` / `dina_peerlens(query)` — write/read trust attestations                | Core PeerLens façades → PDS write → AppView index (§18, new)                                       |
| **Security**       | the gate itself — the agent submits intent before risky actions                                                     | Core gatekeeper (§12)                                                                              |
| **Approvals**      | sensitive actions raise a card on your phone; you approve/deny/scope                                                | approval transport (§13)                                                                           |
| **Services**       | `dina_publish_service` / `dina_find_service` / `dina_invoke_service` — publish a capability, discover + call others | publish/invoke reuse service-config + `service.query`; find = new Core AppView-search façade (§17) |

Two invariants hold across all nine: (a) **the agent is untrusted** — it holds **only its own
revocable paired-device Ed25519 credential** (the wire-auth key it signs Core calls with, §11), and
**never** receives Dina's master seed, persona DEKs, root/PDS signing keys, or vault keys (all
Core-held); every
sensitive action is gated in Core; (b) **one identity** — every write, service, review, grant, and
contact attaches to the single `did:plc`, whichever of your agents acted.

---

## 3. User journeys (full functionality)

- **3.1 First install** — the plugin auto-bootstraps a local Core and enrols via a single-use
  capability (§8). Core owns identity; the plugin asks it "who am I?" and gets a DID **immediately** —
  use Core's existing identity, provision/restore a `did:plc` when
  `--pds-handle` is supplied, or mint a local `did:key` on the spot (§8).
  Identity is foundational (the gate signs with it, D2D needs it), so a
  local-only first run can start immediately. Public Services and PeerLens
  require selecting/restoring the handle during install; automatic
  first-publish prompting is not implemented.
- **3.2 Second agent (same person)** — a second Claude Code or the CLI discovers the running Core
  and enrols under the same identity; shared vaults, no new identity.
- **3.3 Pair the phone** — `/dina:pair-phone` establishes an authenticated laptop-Core↔phone channel
  (§13) so the phone decides approvals.
- **3.4 Remember + recall across agents** — write in one agent (§14 ingress), recall in another.
- **3.5 The gate fires** — the hook sends the _raw_ tool call to Core; Core classifies + scores it
  (§12); SAFE→allow, local-confirmable→native prompt, sensitive→phone, blocked→deny.
- **3.6 Publish a service** — `dina_publish_service` exposes a capability from a vault, scoped, with
  access tiers. The listing is saved locally at once; **PDS/AppView discoverability is a durable async
  step** (§17, COLD-5) — the tool reports "saved locally; publication pending" and confirms discoverable
  only after the AppView indexes it.
- **3.7 Consume a service** — `dina_find_service` (a Core AppView-search façade, §17) →
  `dina_invoke_service` (D2D `service.query` → the provider answers → typed result card).
- **3.8 Talk to another person's Dina** — `dina_talk` sends a sealed `talk.message.v1` through a Core
  façade that pins the message type and enforces contact + sharing policy at egress (§17).
- **3.9 Write/read a PeerLens attestation** — `dina_review` publishes a trust attestation to your PDS
  (the AppView then indexes it); `dina_peerlens` reads ranked results behind a service or product
  decision (§18).
- **3.10 Delegate a task** — `dina_delegate` hands a task to a paired external agent through the
  existing `dina-agent`/MsgBox path (never in-process third-party code).

---

## 4. Acceptance (what "working" means)

**Memory + gate (first, one person, two of _their_ agents):** on day 8, Claude Code still knows the
project conventions without being retold; and something researched in one of your agents (a second
Claude Code or the CLI) is available in another without copy-paste.

**Services (one person, becomes two):** you publish a capability from Claude Code; **after the durable
publish confirms it indexed** (§17, COLD-5 — not merely "saved locally"), another of your agents (or,
once a second person installs, their agent) discovers it via the AppView directory and invokes it, and
the typed result card renders. The acceptance test **must exercise the publish→PDS→AppView-index path
and a publish-failure/retry case**, not just local persistence. This is the two-sided-market acceptance.

**D2D + trust (two people):** two people's Dinas exchange a sealed `talk.message.v1` under
contact + sharing-policy gating; a PeerLens attestation written from one agent ranks a result read by
another.

Every acceptance test asserts the gate: a sensitive action raises exactly one phone card, approving
it lets exactly that action proceed, and the audit log records the non-SAFE decision.

---

## 5. Build order (a sequence, not a scope boundary)

v1 is the whole thing; you still build it in dependency order (by how many people are needed for a
piece to deliver value), so an early installer gets working software:

1. **Foundation** — bootstrap + gate + memory + sessions + phone approval (one person).
2. **Services** — publish/find/invoke + the first Codex host (§18) (one person, useful at two).
3. **D2D + contact-services** (two people).
4. **PeerLens trust, outcome loop, curation** (many).

Nothing in a later stage is out of v1; it is scheduled behind its dependencies.

---

## 6. Non-goals (out even for full v1)

- **In-process third-party code.** External agents reach Dina via MCP/D2D; they never run inside the
  trust boundary (kernel rule, `AGENTS.md`). `dina_delegate` hands out through `dina-agent`/MsgBox.
- **Dina touching money.** Cart-handover only; the gate BLOCKS payment execution.
- **Emotional-intimacy simulation** (Anti-Her) — always connect to humans.
- **Policy customisation beyond the fixed risk table** (v1 uses the deterministic table + coding
  extensions in Core, §12).

---

# Part II — Technical

## 7. Architecture — and exactly what exists vs. what must be built

```
   Claude Code / Codex / CLI  (untrusted agents — do the work)
     │                                  │
     │ PreToolUse hook (catch-all;      │ MCP server (memory, services, talk,
     │  COMMAND hook only — §10; HTTP    │  peerlens, delegate)
     │  fails open — forwards RAW call)  │
     ▼                                  ▼
   dina-gate                         dina-mcp
     └───────────────┬──────────────────┘  signed requests over localhost
                     ▼
        Dina Core — local daemon (home-node-lite, did:plc)
        Core-owned classifier + policy table + grants + audit + keys + D2D
             │  MsgBox (approval + D2D + services)   ▲ signed owner decision
             ▼                                       │
        Phone (approval client)   ◄── AppView (PeerLens + service directory)
```

**Trust boundary.** The agent is untrusted, signed, over localhost. Core holds keys/policy/audit;
every risk decision is deterministic, no LLM in the path, and **Core — not the untrusted forwarder —
classifies the raw tool call** (§12, DPD-001). Services/D2D/PeerLens ride the existing sealed,
signed, relayed paths.

**Reused as-is** (verified against current code): the deterministic risk table + fail-safe +
BRAIN_DENIED + plugin-floor pattern (`gatekeeper/intent.ts`); the persona gate
(`agent/access.ts:131-211`); durable grants (`agent/grant_repository.ts`, `schemas.ts:483-508`);
canonical signed auth (`auth/*`); the identity tree (`crypto/slip0010.ts`, `hkdf.ts`); the Tier-1
provider runner + service-config/`service.query` mechanics; **PeerLens** (`appview/`,
`com.dinakernel.peerlens.*` lexicons).

**Reused only AFTER a named hardening — not safe "as-is" under the untrusted-Brain / frozen-wire model
(cold-audit findings).** The kernel law is that Brain is an untrusted tenant and the sealed wire is
frozen; several shipped subsystems do not yet honour that for an agent/plugin caller, so v1 must fix
each **before** the plugin rides it:

- **Owner-decision guard is NOT owner-only (COLD-1, critical).** `ownerDecisionGuard`
  (`workflow.ts:834-845`) rejects only `agent`/`plugin` and **admits `brain`** (comment: the
  user-driven `/service_approve` chat command) — plus `device`/`admin`. On the server split Brain is
  untrusted, so a compromised Brain could approve intent-validation/persona-access tasks and mint
  session/durable grants (`authz.ts:212-213`, `workflow.ts:616-639`). Every security-sensitive approval
  must instead require an **authenticated owner/device/admin decision — a phone signature bound to
  {task, decision, scope, session, expiry}** — with **Brain unable to approve or deny**; add
  compromised-Brain tests proving it cannot mint a permit or grant.
- **Sealed D2D still accepts the forbidden nonce (COLD-3, high).** `nacl.ts:89-93` derives a legacy
  truncated-SHA-512 sealed-box nonce and `:227-258` accepts **both** schemes; `msgbox_handlers.ts`
  mirrors/defaults responses to it — but the frozen contract is **BLAKE2b(24)** (`AGENTS.md:65`).
  Shipping approval/Talk/service-RPC over this would preserve non-conformant crypto. **Prerequisite:**
  remove SHA-512 acceptance/emission/default/mirroring, permit only BLAKE2b(24), version the change,
  and add frozen-vector + negative legacy-ciphertext tests across approval/Talk/RPC.
- **Brain's `:8200` HTTP surface is unauthenticated + confused-deputy (COLD-2, high).** Brain's whole
  HTTP API is deliberately unauthenticated (`brain-server/boot.ts:785-798`) yet forwards privileged ops
  to Core signed with **Brain's** credential — service-config PUT/DELETE (`service_config_proxy.ts`),
  workflow approve/cancel (`routes/workflow.ts`), via `core_client.ts:47-60`. Any co-resident process
  can drive it. "No raw Brain around Core" is not enough: **remove the privileged unauthenticated Brain
  proxies, or require authenticated owner-bound inbound provenance Core can verify**, and route mutable
  ops through **narrowly-scoped Core-minted capabilities**, never Brain's ambient credential; test that
  an unsigned localhost caller and a compromised Brain cannot proxy an agent or owner action.

**Reused with a caveat noted elsewhere:** the pairing ceremony (`server/routes/pair.ts`) — see §8/§11
for how the plugin's admin-less path and `agent_scope` attach; and the services publish/find paths —
see §17 for the durable-publish and search-façade corrections (COLD-5/COLD-7).

**What v1 required, with current implementation status
(DPD-001/004/006/007/008/009/011):**

1. **Core-owned classifier + payload-bound permit — implemented.** Core takes
   the raw `(tool_name, tool_input)`, maps it to a risk action, and binds
   approvals to the exact payload/session/tool-call identity. The host hook
   forwards raw calls; it does not choose the policy action.
2. **Agent-safe memory-ingress + Core-mediated ask.** Implemented for the coding-agent P0:
   `POST /v1/agent/memory` is session-bound, persona-gated, and provenance-stamped; Core's
   `/api/v1/ask` adapter forwards an authenticated DID/session DTO to loopback Brain and enforces
   requester + session ownership on status. These are dedicated façades — agents are not widened
   onto raw vault writes or given Brain credentials.
3. **Coding MCP profile — implemented.** `dina_ask`, `dina_vaults`,
   `dina_reminders`, Services, PeerLens, Talk, delegation, validation, audit,
   and PII tools call dedicated agent-safe façades. Raw persona/vault routes
   remain closed to coding agents.
4. **Durable session registry** — implemented: the registry is authenticated and caller-DID-bound,
   rejects unknown/foreign/ended/expired sessions, and revokes session grants/approvals on end
   (§15).
5. **Laptop-Core↔phone approval transport — implemented for one phone.**
   MsgBox carries sealed approval cards and signed decisions. Multi-phone
   routing remains deferred (§13).
6. **PDS-backed network identity — implemented as an explicit install
   option.** `dina home-node install --pds-handle ...` provisions or
   rehydrates `did:plc` and enables public Services/PeerLens. A no-handle HNL
   deliberately remains local `did:key`; automatic first-publish prompting and
   automatic phone identity reuse are not implemented.
7. **Catch-all gates, coverage tests, and audit persistence — implemented.**
   Claude Code and Codex have separate host adapters and explicitly document
   paths the host does not expose to hooks.
8. **Agent-facing Services / D2D / PeerLens / delegation — implemented as
   Core façades, not broad wrappers.** `dina_publish_service` and
   `dina_invoke_service` reuse the existing
   service-config PUT + `service.query` D2D routes, gated by a **specific** agent authz row (§14), not
   a prefix-wide grant. Every other network surface uses a dedicated Core façade:
   - **Service discovery (NEW-01)** validates and bounds search in Core, then
     calls the shared Brain/AppView adapter. The plugin receives neither Brain
     credentials nor the AppView origin.
   - **Talk / D2D (NEW-03)** pins `talk.message.v1`, the recipient, and the exact
     text in an idempotent owner-approval task. It stamps the disclosed
     `message_text` category; agents remain unauthorized for generic
     `/v1/msg/send`.
   - **PeerLens (F-06)** validates the structured attestation, stamps
     `createdAt` and `isAgentGenerated`, obtains owner approval, and persists a
     fenced publish job before writing to the owner's PDS. Search is a bounded
     Core projection over AppView.
   - **Delegation (F-07 / NEW-04)** stamps kind/origin/agent
     identity/initial-state in Core and validates the target runner and bounded
     payload; generic workflow creation stays closed to coding agents. This
     façade constrains **what** is delegated; it does **not** enforce the
     delegated agent's **downstream** side effects —
     today the runner path is cooperative (`dina validate` is voluntary and bypassable,
     `AGENT_CONTROL_PLANE.md:2642-2648`; `agent_daemon.py:139-145` runs the runner directly). Enforced
     downstream gating needs a runner-side PEP + payload-bound execution permits (new work, §17); until
     that ships the downstream guarantee is **cooperative-only** and is excluded from the
     deterministic-gate acceptance.

---

## 8. The Core daemon + bootstrap authority (DPD-002/003/005/006)

The existing home-node-lite Core (loopback `127.0.0.1:8100`) + Brain (`:8200`), run as a background
daemon.

**As-built identity model — Core owns the owner identity; the host holds only a
revocable device identity (DPD-006, resolves COLD-9).** The Home Node owns the
sovereign seed and the plugin **never receives it**. Claude Code or Codex signs
Core calls with a separate coding-scoped `did:key`; Core attributes authorized
network writes to the owner identity. Three first-run cases:

1. **An existing Home Node is present:** setup repairs the coding-device
   enrollment without changing the owner identity.
2. **A public PDS handle is supplied:** the Home Node provisions or rehydrates
   the owner's `did:plc`; the coding host still receives only its own `did:key`.
3. **Local only:** the Home Node creates a local owner `did:key`; the coding
   host receives a distinct coding `did:key`. A phone is optional and can be
   paired later for approvals.

Automatic phone-to-Home-Node identity/data continuity is not implemented.
Reusing a mobile owner identity remains a private-terminal recovery-phrase plus
portable-archive flow; neither secret is entered into the coding host.

**Implemented preview boundary.** `dina-agent` now owns a source-free native lifecycle for Home Node
Lite. It downloads one platform/architecture release archive containing bundled Core, Brain, the
offline archive tool, a matching Node runtime, and the matching native SQLCipher binding. It rejects
unsafe archive entries, verifies the manifest's SHA-256 inventory, installs the release read-only,
generates an isolated Brain service key, serializes lifecycle operations, starts a small native
supervisor, waits for both health endpoints, and preserves encrypted data on ordinary uninstall. A
destructive `--purge-data` additionally removes local coding-agent credentials only when an
installer-owned receipt, current config, and current signing key still identify that exact Home Node;
ordinary uninstall never removes them.

The supervisor restarts Core or Brain after a process crash while it is running. It is not an OS
login/startup service in V1. Claude and Codex `SessionStart` hooks call
`dina home-node ensure --if-installed`, which starts an installed Home Node when the agent begins a
session. Release changes use an explicit upgrade with a consistent private data snapshot and automatic
failed/interrupted-candidate rollback. Release archives still need to be published for every supported
platform. The current verifier proves that extracted files match the downloaded manifest, while HTTPS
protects the GitHub download; a separate publisher signature/attestation check is not implemented and
must not be claimed. The phone-approval bridge links this Home Node to mobile for owner decisions; it
does not merge their identities. Mobile remains reachable at its canonical `did:plc`, while the coding
agent and laptop approval client each use separate, revocable paired `did:key` devices (§13.1).

**The DID is created immediately in every case — it is FOUNDATIONAL, not deferred.** The gate signs its
decisions with it, Dina-to-Dina (D2D) needs it, and your own agents address each other by DID. So
identity exists from the first second: a `did:key`/local identity backs the approval plane at once,
upgraded to `did:plc` in the same first-run. Nothing about _having_ an identity waits.

**Only the public HANDLE is optional for local-only use.** A human-readable
handle — Login-with-Bluesky or pick-a-name; policy **forbids auto-deriving
one** (`identity/provision_pds.ts:81-99`) — is the naming layer on top of the
DID. You need it when **others must find you**, i.e. to publish a service or
post a PeerLens review. The as-built installer therefore accepts
`--pds-handle` up front. Without it, local memory/gating still work, but public
publication returns `not_configured`; there is no fake pending retry.
First-publish prompting remains future UX, not current behavior.

**Pairing-time signing (build decision).** When the phone pairs, the laptop Core must sign requests
without you typing your seed. Two options: **(a)** copy the signing key to the laptop — simpler; **(b)**
give the laptop its **own child key the phone authorizes** — safer, **revocable per device** (the same
"each device its own revocable key" principle as F-03). Ship **(b)** eventually; **(a)** is acceptable
for the earliest cut.

**Zero-prompt enrolment — the authority problem, native implementation, and residual limit
(DPD-005, F-03).**
`/v1/pair/initiate` is admin-only (`authz.ts:100-104`) and Lite has no admin key by default
(`boot.ts:235-245`), so a bare agent cannot initiate pairing — and a public `initiate`, or a standing
admin key in the plugin, would let any co-resident process self-enrol. v1 uses a **single-use
bootstrap capability**. The plugin-owned installer is already the process that created and owns the
mode-0700 Home Node directory. After Core is healthy, it reads the owner capability directly from that
private data directory, sends it only in memory to Core's loopback owner API, mints a five-minute
single-use setup capability whose server-side intent fixes `role=agent, scope=coding`, and redeems it
with a newly generated Ed25519 public key. Neither owner capability nor pairing capability appears in
argv, environment variables, logs, or CLI config. The controller verifies through the owner API that
the exact key was durably registered as a coding agent before publishing local config. If local
persistence fails, it revokes that device; if the process dies after pairing but before config, a
later run matches the retained local key DID against Core's coding-agent list and repairs config
without minting duplicate authority.

Automatic enrolment never replaces an existing CLI config. A compatible key is reused; an unrelated
Home Node config fails with an explicit conflict and requires a separate `DINA_CONFIG_DIR` or an
explicit owner decision. `--no-enroll` keeps installation lifecycle-only, and
`dina home-node enroll-agent` is the explicit recovery path.

**Honest residual:** mode 0700/0600 protects against other OS users, not another compromised process
running as the same user. Such a process can read the private Home Node directory, including bootstrap
authority and local keys. Stronger separation requires a distinct OS account, sandbox, non-exportable
OS-keystore credential, or phone-held key. Loopback is only transport exposure; the owner capability
plus single-use ceremony is the HTTP authorization boundary, and same-UID filesystem ownership is the
local bootstrap boundary in V1.

**Keys at rest — honest posture (DPD-002/003).**

- **Same-UID compromise is in scope and not defeated by file mode.** `0600` excludes other OS
  _users_, not other _processes as you_; the seed file grants the seed to anyone with filesystem read
  (`identity/master_seed.ts:12-16`). A compromised agent/dependency running as you can read the
  convenience-mode seed **and** the agent key. Strong mitigation = OS account/sandbox, a
  non-exportable OS-keystore credential, or the **phone-held-key** variant. Ship the laptop-keyholder
  model, **name this in the README**, and do not claim same-user process isolation.
- **Never log the mnemonic.** Fixed: first boot writes the recovery phrase to a `0600` file and logs
  only that file's path (`core-server/src/boot.ts:303-312`). Wrapped-seed (Argon2id) is still not
  wired through boot (`master_seed.ts:18-25`) — keep it marked unavailable until implemented and
  tested.

**Lifecycle status and remaining target.** The source-free install/start/stop/status/logs/uninstall
controller is implemented in `dina-agent`; its install state and advisory lock replace a raw
`core.lock`, while a supervisor token, heartbeat, verified process command, and health endpoints are
the runtime authorities rather than a stale PID. The installed release includes its matching Node
runtime and native SQLCipher ABI. Automatic first-agent enrollment uses the same-UID private-directory
boundary above. Every installation has distinct private code, runtime, key, log, and data paths.
Upgrade snapshots the stopped data directory, health-checks both candidate services, and restores the
prior release and data after a failure or interruption. `did:plc` provision/rehydration is implemented when install
receives `--pds-handle`. Remaining: public native release availability and automatic continuity
with an already-running phone Dina. Manual continuity is supported by restoring
the same recovery phrase/handle and importing the phone's encrypted `.dina`
archive. **Not** `DINA_DEBUG_MODE` (a test-only
owner-bypass that refuses production endpoints).

---

## 9. The plugin package

```
dina/
├── .claude-plugin/plugin.json   # name required; description recommended
├── hooks/hooks.json             # PreToolUse gate + SessionEnd cleanup (§12/§15)
├── .mcp.json                    # MCP server (memory, services, talk, peerlens, delegate)
├── skills/{status,vaults,grant,audit,services,pair-phone}/SKILL.md
└── bin/{dina-gate,dina-mcp}
```

Slash commands surface control, namespaced by plugin name (Claude invokes plugin skills as
`/<plugin>:<skill>`): `/dina:status`, `/dina:vaults`, `/dina:grant`, `/dina:audit`, `/dina:services`,
`/dina:pair-phone`. Verify the exact invocation syntax at build.

---

## 10. Hook transport + context cost (F-01, DPD-015)

**The enforcement hook MUST be a command — HTTP hooks fail OPEN (F-01).** An earlier draft claimed a
command **or** an HTTP handler would do, with the security argument unchanged. That is **wrong for
enforcement**: Claude Code treats an HTTP hook's non-2xx response, connection failure, or timeout as
a **non-blocking** error that lets the tool run — so a stopped or unreachable Core would silently
open the gate, contradicting §12.4's fail-closed rule. Therefore the gate's enforcement path is a
**command hook** (`bin/dina-gate`): the command calls Core and, on a _handled_ error (Core unreachable,
timeout, malformed reply), returns `deny` / exit 2 — fail-closed. HTTP hooks, if used at all, are
**telemetry only**, never the enforcement path, unless/until Claude adds fail-closed HTTP semantics.

**But "use a command hook" is not by itself fail-closed (NEW-27).** Only **exit 2** blocks a
`PreToolUse` tool call; **every other** command outcome — a missing/unexecutable `bin/dina-gate`, a
launcher failure, a crash/signal, an ordinary `exit 1`, or a host-side timeout — is a **non-blocking**
error, and the tool runs. A binary that cannot launch or that crashes never reaches its own
`deny`-emitting error handler. So the hook definition must **normalize every failure to exit 2**: invoke
the gate through a tiny **supervisor** (a shell wrapper or an `exec`-and-trap launcher, itself
dependency-free and always present) that runs the real gate, and on **any** non-clean outcome — spawn
failure, non-2/non-0 exit, signal, or the gate's **own internal deadline** (set **shorter than the host
hook timeout**, so Core-slowness resolves to a deny _inside_ the window rather than a non-blocking host
timeout) — prints the block decision and exits `2`. Ship two **separate** classes of conformance tests
(NEW-27): (a) **child-gate failures** — missing/chmod-0 _gate_ binary, gate `exit 1`, gate killed by
signal, Core timeout (gate deadline fires), malformed Core reply — the supervisor catches these, so each
must **block** (exit 2), not allow; (b) **supervisor-self failures** — a missing/unexecutable or hung
**supervisor**, and a host-side hook timeout — these **cannot** self-report, so the test **demonstrates
and documents the fail-open residual** (the tool runs) on unmodified Claude Code, and is required to
**block only when an independently specified deny-by-default host enforcement mechanism is installed**.

**Honest residual — the Claude Code gate is fail-closed only up to the host running the hook (NEW-27).**
The supervisor can normalize its _child's_ failures, but it **cannot** normalize **its own**: if Claude
Code never launches the supervisor (missing/unexecutable), the supervisor process crashes, or the
**host-side hook timeout** fires (Claude Code cancels the hook non-blocking), no `exit 2` is ever
emitted and the tool runs. Only exit 2 blocks a `PreToolUse` call; a cancelled/failed hook is
non-blocking. So on Claude Code the gate is **fail-closed for everything downstream of a launched,
living supervisor** (Core unreachable/slow-within-the-gate-deadline, gate crash, malformed reply) but
retains a **disclosed residual: supervisor launch failure, supervisor crash, and host-timeout are
fail-open** unless an **independent host-level enforcement** (e.g. a deny-by-default host policy for the
covered tools when the hook does not return) is available. v1 therefore does **not** claim an
unconditional fail-closed gate on Claude Code; it states this residual wherever the gate is described
(§12.1, §21, summary), and — where the host later offers a mechanism to deny on a non-returning hook —
adopts it and narrows the residual. Codex's own PreToolUse hook is assessed the same way at build.

(This does not resurrect "command-only as the sole hook type" — HTTP hooks exist; they are just not
safe as the _gate_.)

**Context cost.** Do not assume "MCP resources cost context every turn": current docs describe
resources fetched _when referenced_ with Tool Search on by default. **Measure** `dina-mcp`'s per-turn
footprint under current behaviour; keep descriptions terse. Confirm at build.

---

## 11. Enrolment & auth

Enrolment uses the pairing ceremony via a **single-use owner-minted capability** (§8), not an
admin-less `initiate`. The plugin registers an Ed25519 key → a `did:key` device under the Home Node
identity. Every plugin→Core call is signed (canonical
`{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{NONCE}\n{SHA256_HEX(BODY)}` + `X-DID/X-Timestamp/X-Nonce/
X-Signature`, ±5-min, nonce-replay-after-signature, per-DID rate limit), even over localhost. **The
signed key is the wire boundary; the enrolment capability is the who-may-enrol boundary; neither is
"localhost."** Grants/revocation reuse `agent_persona_grants` (§15) and `revokeDeviceDurable`
(cascade-tombstone grants on device revoke).

**`agent_scope` is a server-side pairing attribute, never a client claim (NEW-19).** The `coding`/
`runner` scope (§14) is modelled exactly like `DeviceRole`: fixed by the **enrolling authority**,
persisted on the durable device/pairing record, and **derived by Core** from the signature-authenticated
device DID at request time — Core attaches it to the internal auth context before `isAuthorized`. It is
**not** an `X-Agent-Scope`-style header: the canonical signed payload is only method/path/query/
timestamp/nonce/body-hash (`canonical.ts:35-47`), so a request-supplied scope would be unsigned and
spoofable — a `coding` plugin could assert `runner` to claim workflow tasks, or a `runner` assert
`coding` to reach the façades. Any client-sent scope is **ignored**. For backward compatibility, an
agent/plugin record with no valid scope is treated as the historical `runner` scope; it therefore
remains denied on every `coding` façade and can never self-upgrade to `coding`. Spoofed-scope tests
pin that a client-asserted scope cannot escalate, without changing the canonical signed-request
format.

**Where the scope is stamped — on the PRIMARY enrolment path, not just `/v1/pair/initiate` (COLD-10).**
The plugin's first-install path does **not** traverse public/admin-less `/v1/pair/initiate`. It calls
the owner-authorized `/v1/owner/setup/coding-agent` route, which creates a single-use pairing intent
with server-fixed `role='agent'` and `scope='coding'`; `/v1/pair/complete` reads those values from the
intent and ignores client role/scope claims. The inherited-FD direct-spawn path stamps the same values.
Either way the completing device never picks its own scope, and no coding device is created without
owner-authorized scope.

**Durable scope state (implemented).** `paired_devices.scope`, the registry/repository projection,
pairing-intent binding, signed-request derivation, and route enforcement are wired. This project is
still greenfield and has no committed production database requiring a migration. An absent/corrupt
scope conservatively resolves to the historical **`runner`** behavior and remains denied on all
`coding` façades; `coding` is granted only through a fresh owner-authorized enrolment and is never
backfilled implicitly.

---

## 12. The gate — Core-owned classifier, catch-all hook, payload-bound permit

### 12.1 Mechanism (DPD-001/004/015)

- **Catch-all, fail-closed _up to the host running the hook_ (DPD-004, NEW-27).** The hook matches
  **every** tool. **Every other tool — including un-enumerated ones (`NotebookEdit`, `WebFetch`,
  `WebSearch`, MCP tools, future tools)** — goes to Core. Nothing bypasses the gate **once the hook
  runs**. The one honest residual (§10): on Claude Code a supervisor that never launches, crashes, or is
  cancelled by the host-side timeout is **non-blocking** — that failure mode is fail-**open** absent an
  independent host-level deny. So "nothing bypasses the gate" holds for a launched, living hook; the
  supervisor-launch/host-timeout residual is disclosed, not hidden. Keep a versioned coverage/conformance
  test (including the supervisor-self-failure cases) + an "uncovered paths" report.
- **Reads are classified by Core, path-aware — the hook decides nothing (F-02).** The forwarder must
  **not** approve reads on its own; `Read`/`Grep`/`Glob`/`LS`, like every tool, are sent to Core for
  classification. A hook-side read allowlist would put a policy decision in the untrusted forwarder and
  break the Core-owned-classifier invariant. Any fast-path for cheap project reads is therefore
  **Core-side**: Core may return SAFE immediately for an explicit non-secret project-path allowlist,
  but Core makes that call, on the raw path it received. This matters because an unconditional read is
  a credential-disclosure hole: a plain `Read` of the convenience-mode seed (`master_seed.ts:12`), the
  agent key, a `.env`/secret file, or a raw vault artifact would leak exactly what Core classifies as
  `key_access`/`read_vault`/seed-export → `BLOCKED` (`intent.ts:72,85`). So a read whose path resolves
  to a Dina state directory, keyfile, agent-credential, environment/secret file, or vault artifact
  classifies as `secret_read` HIGH→BLOCKED (§12.3), never SAFE.
- **Both source and destination of a protected path are BLOCKED — for framework-mediated calls
  (NEW-12).** Path protection is **not** read-only, and **not** destination-only. For every tool-call
  the gate sees, the classifier canonicalizes (symlink- and `..`-resolved) each path operand: a
  **protected source** — reading the master seed, wrapped seed, a signing/agent key, a credential, a raw
  vault file, or Dina state — classifies as `secret_read` → **BLOCKED**, and a **protected destination**
  as `secret_write` → **BLOCKED**. This closes both a corrupting write (`Write`/`Edit`/`NotebookEdit`/
  `apply_patch`, or a shell redirect to a protected path) **and** an exfiltrating copy (`cp`/`mv`/
  redirect **from** a protected path — the destination is innocent but the source is a `BRAIN_DENIED`
  secret, `intent.ts:80-94`). **Scope, stated honestly:** this is a **framework-mediated** guarantee —
  it stops the agent's Dina/host **tool-calls**, which all pass the catch-all gate. It does **not** stop
  a same-UID process that has _already_ compromised the agent and calls `open()` directly, outside the
  framework — that is the §16 same-UID limit, whose only real fix is an OS sandbox/keystore or the
  phone-held key. Because static Bash parsing is best-effort (§12.3), an **unparseable or indirect
  path-bearing** shell command is fail-closed to **BLOCKED**, not MODERATE, so a protected operand can't
  slip through an unparsed command. Coverage tests: `Write`/`Edit`/`NotebookEdit`/`apply_patch` and
  shell `cp`/`mv`/redirect — protected→safe and safe→protected — plus variable-expansion, subshell/
  interpreter, and TOCTOU cases, with symlink/`..` aliases on **either** operand.
- **Core owns classification (DPD-001).** The hook sends the **raw** `(tool_name, tool_input)` for
  **every** call, reads included; Core maps it to an action and scores it. The untrusted forwarder
  never chooses the policy entry and never short-circuits a call to allow.
- **Payload-bound permit (DPD-001).** Core returns a single-use permit bound to the payload
  hash/session/tool-call-id/expiry, verified at the execution seam so the executed payload equals the
  approved one. Where a host cannot enforce this, the doc **downgrades the claim** to
  "framework-mediated assurance" — it does not claim compromised-process enforcement it cannot
  deliver.

### 12.2 Decision mapping — one authoritative lifecycle (DPD-009/010)

| Core result                                             | Hook behaviour                                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| SAFE                                                    | allow, silent                                                                                         |
| Local-confirmable                                       | native `ask` via a **classification-only** call that creates **no** Core task                         |
| Sensitive (phone)                                       | held for the phone (§13) → allow on approval, else deny-with-retry                                    |
| Hard-blocked                                            | deny, reason surfaced                                                                                 |
| Core **unreachable** / timeout / malformed reply        | **deny** (exit 2) — fail-closed per §10, **never** `ask`/allow (no verdict exists to locally confirm) |
| Unknown tool / unknown result from a **reachable** Core | `ask`/phone per §12.3 — **never allow**                                                               |

`/v1/agent/validate` today creates a 30-min phone task for MODERATE unless a session approval exists
(`intent.ts:297-374`) — so mapping MODERATE to a local `ask` while calling validate mints orphaned
cards. v1 adds a **classification-only mode** (risk band, no task) for local confirmations, and uses
the task-creating path only for phone-gated actions. HIGH approval returns a **single-use permit
bound to the original call**, not a generic session bypass (`scope='session'` today writes only an
in-memory action approval, `workflow.ts:616-640`).

**Some actions are NON-session-scopable (NEW-03).** A plain MODERATE today auto-approves once an active
session approval for that action exists (`intent.ts:297-306`, `workflow.ts:616-640`), which would let a
first approved `dina_talk` silently release every later message. `d2d_send` (and any action whose whole
point is per-message human sight — outbound Talk) is therefore flagged **non-session-scopable**: each
invocation mints a fresh payload-bound single-use phone approval and never matches a prior
session-scoped approval. Test: a second `dina_talk` still raises a card after a first one was approved.

**Proposal idempotency — "exactly one card" (F-05).** The current validate route mints a fresh random
proposal per request (`intent.ts:309`), so a hook retry, a reconnect, or concurrent delivery would
create duplicate phone cards, and an approval could bind to a stale invocation rather than the one
that runs. v1 keys the phone proposal on a **durable idempotency key** over `(authenticated agent
DID, session, tool-call id, payload hash)` — the same active-idempotency pattern the persona gate
already uses (`access.ts:180`): a matching active task is reused (no second card), a reused tool-call
id with a _changed_ payload is rejected, and the terminal approval is atomically bound to the
single-use permit so it can only release that exact call.

### 12.3 The coding risk taxonomy (a Core-side classifier — DPD-010)

Core's `DEFAULT_POLICY` is money/email-shaped; v1 extends the action keys **in Core** and adds a
classifier mapping the raw call → action, **canonicalizing every path operand** (§12.1): `secret_read`
(any operand that **reads** a protected path — Dina state dir, keyfile, agent credential, `.env`/secret
file, or vault artifact — whether a `Read`/`Grep`/`Glob` or the **source** of a shell `cp`/`mv`/
redirect) HIGH→BLOCKED; `secret_write` (any operand that **writes/targets** a protected path — a
`Write`/`Edit`/`NotebookEdit`/`apply_patch`, or a shell redirect/`cp`/`mv` **destination**)
**BLOCKED**, both mirroring `BRAIN_DENIED`'s `vault_raw_read`/`vault_raw_write`/`seed_export`
(`intent.ts:80-94`) which automated callers must never perform;
`code_edit` SAFE (project files only), `code_edit_external`/`NotebookEdit`
MODERATE; `vcs_local` SAFE, `vcs_push` MODERATE, `vcs_destructive` (`git push --force`, `reset
--hard`) HIGH; `package_install` MODERATE; `network_egress` (`curl` non-allowlisted, `WebFetch`)
MODERATE→HIGH; `fs_destructive` (`rm -rf`, `dd`) HIGH; `system_modify` (`sudo`) HIGH; `deploy`
(`kubectl/terraform apply`, `npm publish`) HIGH. **`read_vault` is NOT here (DPD-010):** it is terminal
`BLOCKED` (`intent.ts:72-76`) — sensitive/locked vault reads are gated by the **separate**
`requireAgentPersonaAccess` (approval without reading, §14), enforced **Core-side on the Ask path**
(NEW-20), not by `/v1/agent/validate`. The hard part is the **Bash classifier**; unparseable →
fail-safe `MODERATE` for its _general_ risk band.

**Protected-path denial must not leak through an unparsed command (NEW-12).** A `MODERATE` fallback is
approvable, and a protected source can enter through shell expansion, a subshell, or an interpreter the
static classifier cannot resolve — so "canonicalize every operand" (§12.1) cannot be the _only_ guard,
or an unparseable `cp $SEED_VAR …` could be approved. Two rules close this **within the framework**: (1)
any **unparseable or indirect path-bearing shell command is fail-closed to `BLOCKED`**, never
`MODERATE`, so a protected operand can't ride through an unparsed command; (2) the `secret_read`/
`secret_write` denials mirror what `BRAIN_DENIED` makes absolute for automated callers —
`seed_export`/`vault_raw_read`/`vault_raw_write` (`intent.ts:80-94`). **This is a framework-mediated
guarantee, not an OS one (§16):** it holds for tool-calls the gate sees, and does **not** stop a
same-UID process that has already compromised the agent from opening the file directly. A true
non-overridable boundary that also stops direct `open()` is an **OS sandbox / non-exportable keystore /
phone-held key** — the §16 hardening, tracked as an open question (§22), not claimed for v1's
laptop-keyholder posture. Tests cover variable expansion, subshells/interpreters, and TOCTOU races
alongside the direct `cp`/`mv`/redirect operand cases.

**The MCP surface needs its own normative classifier (NEW-05).** The `dina_*` tools are not Bash and
are not covered by the coding-action keys above; `PLUGIN_ACTION_FLOORS` (`intent.ts:250-274`) is a
**different** policy — abstract `action_class` floors (`read`/`quote`/`booking`/`write`/`agentic`/
`payment`) for **runner-mode Dina plugins**, not external-agent MCP tool names — so it must not be
cited as the MCP mapping. Core maps each MCP tool (and a payload predicate where the risk depends on
arguments) to an action + minimum risk **in Core**, never trusting a caller-supplied label; any
unknown `mcp__*` tool is fail-closed to `MODERATE`→phone (§12.4):

| MCP tool (+ payload predicate)                                                  | Core action           | Min risk                                            | Gate                                                                                                                                           |
| ------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `dina_session_start`                                                            | `session_open`        | SAFE                                                | **bootstrap-exempt** from prior-session validation (§15); binds the session to the authenticated caller DID; idempotent on the host session id |
| `dina_session_end`                                                              | `session_close`       | SAFE                                                | caller may end **only its own** session (DID + session-id match)                                                                               |
| `dina_recall`/`dina_ask`, `dina_vaults`, `dina_status`, `dina_reminders` (read) | `read`                | SAFE (free personas)                                | `requireAgentPersonaAccess` for sensitive/locked                                                                                               |
| `dina_ask_status`                                                               | `read`                | SAFE                                                | requester-owned (agent must match the ask's `requesterDid` **and** bound session, else 404 — NEW-16)                                           |
| `dina_remember`                                                                 | `mem_write`           | SAFE→MODERATE (sensitive persona)                   | persona gate                                                                                                                                   |
| `dina_find_service`, `dina_peerlens`                                            | `directory_read`      | SAFE                                                | bounded, validated                                                                                                                             |
| `dina_invoke_service`                                                           | `service_query`       | MODERATE                                            | egress gate                                                                                                                                    |
| `dina_publish_service`                                                          | `service_publish`     | MODERATE                                            | own listings                                                                                                                                   |
| `dina_talk`                                                                     | `d2d_send`            | MODERATE (fixed — free text is not auto-classified) | contact gate + sharing policy; phone-confirmed; **no** grant                                                                                   |
| `dina_review`                                                                   | `attestation_publish` | MODERATE                                            | schema-valid; PDS sign                                                                                                                         |
| `dina_delegate`                                                                 | `delegate`            | HIGH                                                | bounded payload + permit                                                                                                                       |
| any other `mcp__*`                                                              | unknown               | MODERATE (fail-closed)                              | phone/deny                                                                                                                                     |

### 12.4 Fail-closed

Core **unreachable**/timeout/malformed → **deny** (exit 2, §10/§12.2); unknown tool or unknown result
from a **reachable** Core → `ask`/phone; anything not explicitly SAFE → `ask`/`deny`. **Never `allow`.**

---

## 13. Approval — the laptop-Core↔phone transport (DPD-011)

Core is loopback-only, but the phone must decide the laptop's approvals — and the existing `dina1:`
code runs the **opposite** direction (it packages the _phone_ node's relay so an agent connects to
the phone, `apps/mobile/src/services/agent_setup_code.ts`). So v1 specifies + versions a
laptop-Core↔phone channel:

- **Transport:** the laptop Core connects outbound to **MsgBox** (same sealed relay the mobile node
  uses), so a loopback-only Core reaches the phone without inbound exposure. Approval is a signed D2D
  proposal→decision, with replay protection, expiry, and offline behaviour (a pending card survives;
  the hook falls back to deny-with-retry, §12.2).
- **Addressing (DPD-019):** MsgBox routes **per-DID** (one WS per DID). In the implemented V1 bridge,
  the mobile Home Node receives at its canonical `did:plc`; the laptop Core creates a separate,
  deterministic approval-client `did:key` and pairs that client to the mobile Home Node. Those relay
  addresses are distinct, so the two sockets do not collide. A future multi-phone design may add
  device-specific mobile routing, but that is not required for the tested one-phone V1 path.
- **Pairing:** the loopback owner console implements the ceremony: it consumes the phone Home Node's
  `dina1:` setup code, pairs the laptop Core's dedicated approval-client `did:key`, and retains only the
  relay URL + phone `did:plc`. `/dina:pair-phone` is a safe guide into that owner-controlled UI; the
  agent command never receives owner enrollment authority.
- **Principals:** the phone approves as **owner** — and the decision must be an **authenticated
  owner/device signature bound to {task, decision, scope, session, expiry}**. The current
  `ownerDecisionGuard` blocks `agent`/`plugin`, and `brainAgentTaskGuard` additionally rejects Brain
  decisions for tasks whose durable origin is `agent`; Brain retains its owner-driven
  `/service_approve` path only for Brain-origin tasks. Thus an agent-raised coding approval can be
  decided only through the authenticated owner/device path. Decisions are signed and applied to the
  laptop workflow repo, then task state syncs.
  This MsgBox work is in scope and in the acceptance criteria. Locally-confirmable actions never touch
  the phone.

### 13.1 Implemented bridge (July 2026)

The first end-to-end substrate is now implemented:

- Phone Core exposes versioned
  `POST /v1/agent/approval-sync/v1/proposals` and
  `GET /v1/agent/approval-sync/v1/proposals/:id/status`.
- The authenticated laptop device DID is bound into a phone-owned workflow
  approval. Replays dedupe on `(source device DID, source task id)` and a
  changed payload hash conflicts instead of replacing the original proposal.
- Only bounded decision metadata crosses the relay; raw tool arguments,
  free-form source descriptions, project/session names, and tool input do not.
  The phone composes its own approval description and renders the authenticated
  paired device as the requester.
- HNL uses a dedicated deterministic child `did:key`, a separate MsgBox socket,
  sealed RPC, signed request/response verification, expiry, and an idempotent
  single-flight polling worker.
- A phone approval is applied to the laptop task through the same Core owner
  transition. The durable workflow receipt, rather than the in-memory permit,
  is the authoritative single-use ledger: an exact approved retry atomically
  redeems it, including after a laptop-Core restart. Relay, signature, parsing,
  storage, or receipt-CAS failure leaves the action blocked.
- Initial pairing accepts the existing mobile `dina1:` code through the
  owner-capability-protected loopback console. After pairing, only relay URL +
  phone DID are retained in encrypted Core storage. The one-time pairing code
  is not stored. `DINA_APPROVAL_PHONE_SETUP_CODE` remains as a legacy first-boot
  fallback only.
- The active WebSocket RPC path signs every response with the phone Core
  identity and binds it to the request id, status, and body before sealing it.
  This prevents the relay from fabricating an approval response.

The hosted two-node regression harness
`cli/claude-plugin/e2e/phone_approval_e2e_msgbox.sh` verifies the complete
boundary against `test-mailbox.dinakernel.com` and
`test-pds.dinakernel.com`: two independently provisioned `did:plc` Home Nodes,
real pairing on both legs, a blocked HIGH-risk coding action, phone-only owner
approval, authenticated decision synchronization, laptop-Core restart without
the setup code, one exact approved retry, and rejection of the second retry.

One product-integration item remains before this is a polished multi-device
feature: define device-specific mobile routing when multiple simultaneous
phones under one `did:plc` are supported. The tested V1 one-phone bridge is
collision-free: mobile receives at its `did:plc`, while the laptop approval
client uses a separately paired `did:key`. Pair/revoke/re-pair and durable
mirror withdrawal are implemented. Pairing records cleanup intent before
remote enrollment, and mirror ids are persisted before proposal transport, so
crashes cannot silently orphan the normal lifecycle path.

---

## 14. The MCP surface — memory, and the other functionalities (DPD-007)

`dina mcp-server --profile coding` is the installed Claude/Codex surface. It
uses dedicated signed Core façades and does not expose raw Brain, PDS, or vault
credentials. Every row below is implemented in the coding profile:

| Tool                                     | Backing (new/existing)                                                                                                                       | Purpose                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `dina_session_start`/`_end`              | durable session registry (§15, implemented)                                                                                                  | scope + revoke grants            |
| `dina_remember`                          | `POST /v1/agent/memory` (P0 implemented)                                                                                                     | write memory as an agent         |
| `dina_recall`/`dina_ask`                 | Core-mediated ask into Brain (P0 implemented), persona-enforced                                                                              | read across permitted vaults     |
| `dina_ask_status`                        | poll an async/approval-gated ask (`GET /api/v1/ask/:id/status`), requester-owned                                                             | fetch a pending answer           |
| `dina_vaults`                            | `POST /v1/agent/vaults`, metadata/access projection only                                                                                     | what memory exists               |
| `dina_reminders`                         | `POST /v1/agent/reminders`, session-derived readable personas only — not mutation/global-pending routes                                      | surface auto-reminders           |
| `dina_publish_service`/`_invoke_service` | existing service-config PUT + `service.query` (§17); **specific** agent authz rows                                                           | publish/call a service           |
| `dina_find_service`                      | Core-owned bounded Brain/AppView-search façade (§17, NEW-01)                                                                                 | discover services                |
| `dina_talk`                              | Core façade that pins type/text/recipient; per-call phone approval; **not** generic `/v1/msg/send`                                           | message another Dina             |
| `dina_review`/`dina_peerlens`            | Core-owned durable PDS-write and bounded AppView-read façades (§18)                                                                          | write/read trust                 |
| `dina_delegate`                          | Core delegation façade that stamps the task envelope; not generic create                                                                    | hand a task to an external agent |
| `dina_status`                            | `/healthz` + local `did`                                                                                                                     | reachability                     |

Sensitive/locked reads pass `requireAgentPersonaAccess` (approval without reading). Reads are
on-demand tools; the context model follows §10 (measure).

**Agent authz is method-and-path-specific, and the plugin adds no new prefix grant (NEW-02).** Today
`authz.ts:143-163` authorizes whole `/v1/service/`, `/v1/reminder*`, and `/v1/msg/` prefixes; adding an
`agent` row to any of those would hand the agent far more than the advertised tools — service config
**DELETE** (`service_config.ts:104`), `respond` (`service_respond.ts:96`), and `offer`
(`service_query.ts:403`), reminder **mutation** + unscoped global-pending reads (`reminders.ts:180-260`),
and arbitrary D2D send. So each tool gets an exact row, and where a prefix cannot express least
privilege a **dedicated façade** carries the authz instead:

**The v1 split is an `agent_scope`, NOT a new caller type (NEW-02).** The plugin and the delegation
runner both keep **`callerType='agent'`** — because every agent security predicate keys on that literal:
the four-tier persona gate returns null (bypass) for any caller `!== 'agent'` (`vault.ts:37`), and
workflow actor/ownership/completion binding, `requireAgentPersonaAccess`, and the NEW-14/NEW-16
`callerType === 'agent'` ownership checks all test it. **Renaming the caller type would silently disable
those `!== 'agent'` guards — a fail-open.** So both keep `callerType='agent'` (persona-gated,
owner-checked, unable to self-approve), and v1 adds an authenticated **`agent_scope`** claim —
`coding` (the plugin) or `runner` (the `dina-agent` delegation runner) — bound at pairing/registration
and carried on every signed request. The authz route matrix reads `agent_scope` as an **additional**
predicate on top of `callerType='agent'`: **coding-scope authority is exactly the MCP table below**;
runner-scope keeps the workflow-task surface (below). `brain`/`admin`/`device`/`plugin`/`connector` are
unchanged. Each row lists its **complete allowed callers** and, for agent callers, the required scope
(the matcher returns the first match's membership, `authz.ts:274-285`, so a partial set on a shared
route would deny a retained principal):

| Tool                        | Exact method + path                                                      | Allowed callers (agent scope)               | Scope / gate                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `dina_remember`             | `POST /v1/agent/memory` (P0 implemented)                                 | agent[coding]                               | session-bound, provenance-stamped; persona-gated                                                              |
| `dina_recall`/`dina_ask`    | `POST /api/v1/ask` (Core-mediated)                                       | agent[coding, runner], device, admin, brain | persona-enforced; no raw Brain                                                                                |
| `dina_ask_status`           | `GET /api/v1/ask/:id/status` (route-template, NEW-16)                    | agent[coding, runner], device, admin, brain | **requester-owned**: an agent caller must match the ask's `requesterDid` **+ bound session** or 404           |
| `dina_vaults`               | `POST /v1/agent/vaults` (**new** scoped route)                           | agent[coding]                               | metadata/access projection only; no contents, descriptions, or runtime-open state                            |
| `dina_reminders`            | `POST /v1/agent/reminders` (**new** scoped route)                        | agent[coding]                               | personas derived **in-handler** from the session, never a caller `?persona=`; **not** `/v1/reminders/pending` |
| `dina_publish_service`      | `PUT /v1/service/config/:rkey` (route-template)                          | agent[coding], brain, admin                 | own listings; **no** DELETE                                                                                   |
| `dina_invoke_service`       | `POST /v1/service/query`                                                 | agent[coding], brain, admin                 | outbound query only                                                                                           |
| `dina_find_service`         | `POST /v1/agent/service/search` (**new** façade)                         | agent[coding]                               | bounded results; validated input                                                                              |
| `dina_talk`                 | `POST /v1/agent/talk` (**new** façade)                                   | agent[coding]                               | pinned type (§17); **not** `/v1/msg/send`                                                                     |
| `dina_review`               | `POST /v1/agent/peerlens/attest` (**new** façade)                        | agent[coding]                               | schema-valid attestation; Core stamps `createdAt`                                                             |
| `dina_peerlens`             | `POST /v1/agent/peerlens/search` (**new** façade)                        | agent[coding]                               | session-bound AppView read proxy with bounded JSON filters                                                     |
| `dina_delegate`             | `POST /v1/agent/delegate` (**new** façade)                               | agent[coding]                               | stamped fields; bounded payload                                                                               |
| `dina_session_start`/`_end` | `POST /v1/session/start`, `POST /v1/session/end` (**new** registry, §15) | agent[coding, runner], brain, admin, device | caller-DID-bound; end only own session                                                                        |
| existing                    | `POST /v1/agent/validate`, `GET /v1/intent/proposals/:id/status`         | agent[coding, runner], brain, admin, device | validate + proposal status (status is caller-owned, NEW-14)                                                   |

`agent[coding]` = a `callerType='agent'` request whose `agent_scope='coding'`; `agent[coding, runner]` =
either scope. Ask, session, validate, and proposal-status are shared by **both** scopes; the plugin-only
MCP surfaces (remember, vaults, reminders, services, façades) admit **coding** scope only. Every shared
row ships **positive** tests for each listed principal (and each allowed scope) plus near-miss denials;
the sets mirror the current prefix rules (`authz.ts:92,163,230,233-234`) minus the broad grants, with
the generic `agent` prefix grants replaced by exact rows, each scoped to `coding` and/or `runner`.

The existing reminder reads are unsafe to authorize directly: `GET /v1/reminders?persona=…` lets the
caller name **any** persona and `GET /v1/reminders/pending` is global (`reminders.ts:199-245`). So
`dina_reminders` gets a **new scoped route** whose handler derives the readable personas from the
authenticated agent/session — the agent never selects the persona.

**The whole `agent`-bearing authz surface must be inventoried, because the plugin uses that caller type
(NEW-02).** The plugin authenticates as `callerType='agent'` (scope `coding`), the same caller type as
the `dina-agent` runner (scope `runner`), so without scoping the plugin's real authority would be
**every** `agent`-bearing rule, not just the MCP table. A full inventory of `authz.ts` (not four rules)
with its v1 disposition (agent rows now carry a required scope):

| Existing `agent`-bearing rule                                                               | Line                | v1 disposition + allowed callers (agent scope)                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/v1/session/` (broad)                                                                      | 221                 | remove broad `agent`; exact `POST /v1/session/start`,`/end` → agent[coding, runner], brain, admin, device                                                                                                                                                                                                                                              |
| `/v1/agent/` (broad)                                                                        | 229                 | remove broad `agent`; exact `POST /v1/agent/validate` → agent[coding, runner], brain, admin, device; façade rows → agent[coding]                                                                                                                                                                                                                       |
| `/v1/intent/` (broad)                                                                       | 230                 | remove broad `agent`; templated `GET /v1/intent/proposals/:id/status` → agent[coding, runner], brain, admin, device                                                                                                                                                                                                                                    |
| `/api/v1/ask` (broad)                                                                       | 233                 | remove broad `agent`; exact `POST /api/v1/ask` + templated status → agent[coding, runner], device, admin, brain                                                                                                                                                                                                                                        |
| `/v1/workflow/tasks/` (broad)                                                               | 212                 | remove broad `agent`; the runner surface below is enumerated exactly                                                                                                                                                                                                                                                                                   |
| `/v1/vault/*` (query, item GET/DELETE, list, subjects)                                      | 78-79               | **remove `agent` from query (NEW-18)** — agents recall via `/api/v1/ask`; **and remove Brain's ambient vault authority (NEW-20/21/22/23)** — see the Brain-facing vault-surface table below: every persona read needs a Core-minted **typed-origin** capability; `DELETE item` denied to Brain without a write capability; owner/device path unchanged |
| runner surface: `POST …/tasks/claim`, `POST …/tasks/:id/{heartbeat,progress,complete,fail}` | 100,101-102,125,197 | agent[runner], brain, admin, plugin — **coding scope DENIED**; single-`:id`-segment templates                                                                                                                                                                                                                                                          |
| runner surface: `GET …/tasks/:id`, `POST …/tasks/:id/running`                               | 98,106              | agent[runner], brain, admin — **coding scope DENIED**; single-`:id`-segment templates (missing today under the broad rule)                                                                                                                                                                                                                             |
| `/healthz`                                                                                  | 239                 | keep (public)                                                                                                                                                                                                                                                                                                                                          |

So the coding scope adds only exact/method/template rows, and v1 **removes the broad `agent` from five
prefixes** (session, agent, intent, ask, workflow/tasks) plus `agent` from vault/query, keeping
`device`/`admin`/`brain`/`plugin` exactly where they already have access. `agent_scope` is set at
pairing (the plugin pairs as `coding`, the runner as `runner`) and is authenticated on every signed
request; it does **not** change `callerType`, so the persona gate and workflow guards keep firing.

**The runner surface is why scoping is a REQUIRED v1 milestone (not optional).** The task rows are the
shipped **delegation runner**'s (`dina-agent`) path, not the coding plugin's — but today both
authenticate as one unscoped `agent`, so the plugin transitively inherits claim/running/complete
authority it should never have. Required: (1) the **coding** scope's authority is **exactly** the MCP
table, so a `coding`-scope caller is **denied** on every workflow-task route (tested); the **runner**
scope keeps them alongside the existing `brain`/`admin`/`plugin`. (2) The retained runner rows become
**method + single-segment
templates**: today `authz.ts:189-210` matches `heartbeat`/`progress`/`complete`/`fail` by `endsWith`
suffix (`authz.ts:283`), so a nested near-miss like `/v1/workflow/tasks/a/b/complete` passes — each must
instead match exactly `/v1/workflow/tasks/{one-id}/…`, and the missing `GET …/tasks/:id` and `POST
…/tasks/:id/running` rows must be added with their complete role sets. Ship **positive** tests for every
listed principal, a **coding-scope-denied** test on every workflow-task route, and nested/dynamic
near-miss denials.

**The scope is an authz predicate, not an identity migration (NEW-02).** Adding `agent_scope` touches
pairing/registration (record the scope), the signed-request context (carry + authenticate it), and the
authz matrix (read it) — it does **not** add a caller type, so `vault.ts:37`'s `!== 'agent'` persona
gate, the workflow actor/ownership/completion guards (`workflow.ts:538-587,838`),
`requireAgentPersonaAccess`, and the NEW-14/NEW-16 `callerType === 'agent'` ownership checks keep firing
for **both** scopes unchanged. Tests must prove both scopes remain persona-gated, owner-check
constrained, and unable to self-approve, and that **only** runner scope passes the workflow ownership
checks.

Two constraints follow from how the matcher works (`authz.ts:274-285`, first match wins):

- **Each narrow rule carries its COMPLETE allowed-caller set** (the two tables above), with the required
  agent scope. A narrow rule placed before the broad rule short-circuits it, so a partial set on a
  shared path (e.g. `/v1/agent/validate`, proposal status) would **deny** a retained principal. Each
  rule therefore lists every legitimate caller for that exact route (validate + proposal status →
  `agent[coding, runner], brain, admin, device`; the new façade routes → `agent[coding]`). Ship
  **positive** tests for every listed principal beside the near-miss denials.
- **Authorization is pre-dispatch, so dynamic paths need a route-template matcher — no in-handler
  substitute.** The check runs before handler dispatch (`router.ts:241-267`), so a handler cannot
  rescue a request authz already denied. The current `exact` matcher is literal equality only
  (`authz.ts:277`) and cannot express `/v1/intent/proposals/:id/status` or `/v1/service/config/:rkey`;
  v1 adds a **route-template matcher to the authz layer itself** (not in-handler enforcement) for those.
  No `agent` row is enabled before its persona/action gate and audit are in place; unknown routes stay
  denied (`authz` default). Negative tests across **all five** narrowed prefixes (`/v1/session/`,
  `/v1/agent/`, `/v1/intent/`, `/api/v1/ask`, `/v1/workflow/tasks/`): wrong method, sibling path, nested
  path, dynamic-path near-misses, and unknown future routes must all 403 for an agent — including the
  `/api/v1/ask` migration, whose broad `agent` grant (`authz.ts:233`) is being removed.

**Object-level ownership on proposal-status reads — agent-scoped (NEW-14).** Narrowing prefix→exact
authz gives route-level isolation but **not record-level**: the status handler loads a proposal by id
and returns its action/target/decision-reason/`agent_did` (`intent.ts:401-419`) without comparing the
caller. So any _agent_ holding another agent's proposal id could read it. The `GET
/v1/intent/proposals/:id/status` handler adds a record-ownership check **only for `callerType ===
'agent'`** — an agent caller must match the proposal's bound `agent_did` or get `404`. Brain, Admin, and
Device keep their existing cross-proposal inspection/orchestration access (`authz.ts:230`) and are
**not** subject to the equality check. Ship regression tests for a cross-agent agent (404) and for each
retained principal (still allowed).

**The async Ask lifecycle needs `dina_ask_status`, and its ownership authority lives in CORE (NEW-16).**
`/api/v1/ask` is async — a call returns `in_flight` or `pending_approval` and the answer is fetched by
polling `GET /api/v1/ask/:id/status` (the pattern the CLI already uses, `mcp_server.py`). So the MCP
surface must expose **`dina_ask_status`**, with the exact route-template rule above. The status route
today calls `handleStatus(id)` **without** the caller (`ask.ts:144-155`), and the ownership metadata
would otherwise live in **Brain's** `AskRecord` (`ask_registry.ts:48-103`) — but **Brain is an untrusted
tenant; Core authorizes every request** (`ARCHITECTURE.md:427`), so a compromised Brain must not be the
authority that decides who may read a completed answer. Therefore:

- At submission (`POST /api/v1/ask`), **Core** durably records the binding `request_id → (authenticated
agent DID, bound Core session)` in its **own** store — not Brain's — as the sole authorization truth.
- On `GET /api/v1/ask/:id/status`, Core verifies that binding **before** delegating to Brain: for
  `callerType === 'agent'` the caller's DID **and** bound session must match Core's record, else `404`;
  Brain is only asked for the result once Core has authorized. Session binding (not DID alone) is
  required so a **different or ended** host session using the same paired-agent credential cannot read
  another session's answer (§15 revokes on session end).
- Brain may still carry `requesterDid`/`sessionId` on its `AskRecord` for lifecycle/execution (it
  should stop dropping `sessionId` at enqueue), but those fields are **not** consulted for
  authorization.
  Device/Admin/Brain keep their existing access and are not subject to the agent check. Ship regression
  tests for cross-agent (404), **same-DID cross-session (404)**, ended-session (404), a **forged/mismatched
  Brain-side `requesterDid`/`sessionId`** (still denied, because Core is authoritative), and each retained
  principal (allowed).

**The persona gate for agent recall is a CORE-owned Ask PEP, not a Brain guard (NEW-20).** Removing
agents from `/v1/vault/query` (they recall via `/api/v1/ask`) moved the read behind Brain — but the
four-tier persona gate `requireAgentPersonaAccess` fires only when Core sees `callerType === 'agent'`
(`vault.ts:37`), and today `/api/v1/ask` authenticates the requester then hands the read to a
**Brain-owned** `persona_guard` (`ask.ts:75-155`, `brain/…/persona_guard.ts`). Since **Brain is
untrusted** (`ARCHITECTURE.md:427`), that guard is defense-in-depth, not the kernel boundary: a
compromised Brain could read any persona under its own `brain` authority, which bypasses the agent
gate. So every persona read performed **for an agent-originated Ask** must reach **Core** carrying an
unforgeable binding to the authenticated **agent DID + Core session** (not Brain's identity), and Core
runs `requireAgentPersonaAccess` **before touching that persona's vault** — approval absent → deny
**without reading** (the same approval-without-reading contract as the direct vault path).

**But an unforgeable agent binding on the Ask path is not enough while Brain keeps ambient vault
authority (NEW-20, deeper).** A compromised Brain need not use the Ask path at all: `brain` is allowed on
`/v1/vault/query` (`authz.ts:78`), the agent gate returns immediately for any non-`agent` caller
(`vault.ts:37-44`), and the handler then reads and returns items (`vault.ts:75-89`) — so Brain simply
queries a sensitive/locked persona under its own identity, no agent context supplied. The full
Brain-facing vault surface, with its **accurate current state** (NEW-21):

| Route                                          | Current authz                                                                       | v1 disposition                                                                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/vault/query`                         | brain (ambient, `authz.ts:78`)                                                      | read capability required                                                                                                                                              |
| `GET /v1/vault/item/:id`                       | brain (ambient, `authz.ts:79` — no method restriction)                              | read capability required                                                                                                                                              |
| `GET /v1/vault/list`                           | **403 today** — handler wired (`vault.ts:123`, `boot.ts:272`) but **no authz rule** | admit brain **only with** a read capability                                                                                                                           |
| `GET /v1/vault/subjects`                       | **403 today** — handler wired (`vault.ts:160`) but **no authz rule**                | admit brain **only with** a read capability                                                                                                                           |
| `DELETE /v1/vault/item/:id`                    | brain (ambient — the `:79` prefix rule is **method-agnostic**, so it covers DELETE) | **deny to brain** unless a distinct Core-authorized **write** capability (NEW-23)                                                                                     |
| `POST /v1/vault/store`                         | brain (ambient, live)                                                               | **write** capability required (same typed-origin, gate-before-mint), so a compromised Brain cannot inject/overwrite persona content — the write counterpart of NEW-23 |
| `POST /v1/vault/store/batch`, `/v1/vault/kv/*` | brain — **dormant: authz rule but NO handler (404 today), `vault.ts:1-9`** (NEW-25) | **remove the dormant authz rule**; if a handler is ever added it is capability-gated from day one                                                                     |

So `query`/`item` are removed from Brain's **ambient** authority and re-admitted **only** with a
capability; `list`/`subjects` are _added_ as capability-only (they must not get an ordinary Brain rule
that recreates ambient access); and the **write** surface is closed the same way — `DELETE item`
(NEW-23) and `POST store`/`store-batch` are denied to Brain unless they carry a **write** capability
(the same typed-origin, gate-before-mint contract as reads), since today `item`'s method-agnostic rule +
the `agentGate` bypass let a compromised Brain soft-delete (`vault.ts:145-155`) or overwrite any
persona's content. Give `GET` and `DELETE` on `/v1/vault/item/:id` **separate method+template rules**.

**The capability binds a typed ORIGIN, not just an Ask (NEW-22).** Ask is not the only out-of-process
Brain read: full-v1 **Tier-1 service execution** runs from a **workflow task** with no Ask id — the
capability route takes `task:{id,payload}` (`brain-server/routes/capability.ts:53`), and the runtime's
read-only, persona-bounded `vault_search` (`capability_runtime.ts:140-476`) reads the Core vault
out-of-process. So the capability binds a **typed origin** — `{origin_kind, origin_id, session?, persona,
operation, target-scope, expiry}` — with `origin_kind ∈ {agent_ask, owner_request, service_task,
staging_item}` and `session` **conditional, per transport** (see below): `agent_ask` carries a host
session; `owner_request` carries one **only for an external device-app request over signed HTTP** — the
**first-party mobile owner Ask runs in-process with no host session** (`agentic_ask.ts:157-176` makes
`sessionId` optional; the mobile chat path has no `askId`; `boot_capabilities.ts:916-933` supplies
`ownerDid` but no session), so enforcing a mandatory session there would **regress the main shipping
client (COLD-8)**. For the in-process mobile owner, the binding is the **verified owner identity +
a Core-issued request/ask origin id**, not a host session; ingestion origins (D2D/connector) carry
neither — see below.

The **`staging_item`** origin (NEW-24) models the staging lifecycle, and its authoritative bindings must
match how the pipeline **actually** works, not an idealized version:

- **Core derives the source-kind from the authenticated ingress route/principal — it must NOT trust
  Brain's `source`.** Today `/v1/staging/ingest` takes `source`/`source_id`/`data` from the request body
  and only stamps `producer_id` from the caller DID (`staging.ts:74-77,120-130`), while
  `OWNER_DIRECT_SOURCES = {'user_remember'}` **bypasses the persona-approval gate** (`service.ts:262-267,
540-545`). So a compromised Brain could POST `source='user_remember'` and get owner-direct,
  approval-skipping treatment on a **locked** persona. v1 fixes this: owner-direct source-kinds are
  admissible **only** when the authenticated ingress principal is the owner/device, never for a `brain`
  or agent caller — the trust flows from the authenticated route, not the body string. Add a test proving
  **Brain cannot forge `user_remember`** or obtain owner-direct treatment.
- **Persona and classified payload are resolve-time PROPOSALS, not ingest-time facts.** The staging
  record starts with empty persona (`service.ts:429-450`); Brain selects persona + classified payload at
  `/v1/staging/resolve` (`staging.ts:150-239`). So Core authorizes the **proposed** persona (the persona
  gate for that persona/source-kind) and **hash-binds** the classified payload **at resolve, before
  minting** the `stage_resolve`/`link_subject` capability — the capability is derived from the Core
  record **as authorized at resolve**, and `link_subject` derives from the same Core source item, never a
  fresh Brain assertion.
- **Session is conditional.** Agent/owner asks carry a host session; **inbound D2D and connector**
  ingestion have **none** (`d2d/receive.ts:132-145` creates staging from sender/message provenance).
  Bind D2D to the **authenticated sender DID + message id**, connectors to their **authenticated device
  identity**; require `session` only for the origins that have one.

**Core runs the origin-appropriate authorization before minting:** `agent_ask` →
`requireAgentPersonaAccess`; `owner_request` → owner check; `service_task` → the listing's **pinned
persona + response policy** (Tier-1 reads only the bound persona, §17); `staging_item` → validation of
the Core staging record **plus** the route-derived source-kind + resolve-time persona/payload
authorization above. The storage seam verifies + consumes the capability before any read/mutation; Brain
can neither mint one nor substitute an owner/producer context. (No such capability exists in Core today —
new work.)

**Enforce at the storage SEAM, and cover indirect mutation paths too (NEW-24).** Per-route allow-listing
is the wrong granularity: Brain reaches the vault not only through `/v1/vault/*` but **indirectly** —
`/v1/staging/ingest`+`/v1/staging/resolve` persist Brain-supplied persona + classified data via
`storeItemInScope` (`authz.ts:83-87`, `staging/service.ts:562,669`), and `/v1/people/apply-extraction`
mutates subject links via `linkSubjectSync` (`authz.ts:123`, `people.ts:125`). So the invariant is
enforced at the **Core storage seam** (`repository`/`storeItemInScope`/`deleteItem`/`linkSubjectSync` —
the choke point every path funnels through): **no out-of-process Brain call reaches the storage layer
for a read or a mutation without a valid Core-minted capability for that exact operation, persona, and
payload.** v1 **audits the complete Brain-authorized surface** (direct vault routes, staging, people,
and any future path) and a **coverage test asserts no Brain-authorized route touches storage without a
capability** — this, not a route list, is the completeness guarantee.

**Two capability contracts, normatively (NEW-23).** A **read capability** binds `{origin_kind,
origin_id, session?, persona, op ∈ read{query|item|list|subjects}, item-id-or-canonical-query hash,
expiry, single-use nonce}`. A **write capability** binds `{origin_kind, origin_id, session?, persona,
op ∈ write{store|delete|stage_resolve|link_subject}, target item-id **or** canonical payload hash,
expiry, **single-use replay state**}`. **`session` is conditional and origin-validated:** it is
**required** for `agent_ask` and for an **external device-app `owner_request`** over signed HTTP;
**absent** for the **in-process mobile `owner_request`** (bound instead to verified owner identity +
a Core-issued request/ask origin, COLD-8) and for `staging_item` derived from inbound D2D/connector
ingestion — those origins carry their own authoritative binding (mobile owner → in-process owner
identity; D2D → authenticated **sender DID + message id**; connector → authenticated **device
identity**), and a supplied `session` can **never substitute** for that binding. Binding the canonical payload/target hash and consuming a single-use nonce is what stops a
compromised Brain **reusing** a valid capability with a **substituted body or item id** to overwrite
arbitrary content (the store handler forwards a caller-controlled body, possibly with a caller-supplied
id, to an `INSERT OR REPLACE`, `vault/crud.ts`, `repository.ts`). Add **positive sessionless
D2D/connector** tests and a **negative** test proving a supplied `session` cannot substitute for the
sender/message or connector-device binding.

**But minting is least-privilege by an explicit origin × operation matrix, not Cartesian (NEW-23).** An
`agent_ask` or a read-only `service_task` must never be able to mint `delete`/`store`; the matrix Core
enforces at mint time:

| origin_kind     | may mint                                                                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent_ask`     | **read only** (`query`/`item`/`list`/`subjects`)                                                                                                                                                                                                                                                 |
| `service_task`  | **read only** by default; a `store`/`delete` **only** for an explicitly operator-approved mutation action, bound to the listing's persona + payload (`capability_runtime.ts:140-155,456-485` gates mutation behind approval; `tier1_runner.ts:38-45,108-115` forbids writes for read/quote work) |
| `owner_request` | read + owner-authorized writes (`store`/`delete`) for the owner's own personas                                                                                                                                                                                                                   |
| `staging_item`  | `stage_resolve` + `link_subject` **only**, derived from the Core staging record — never `query`/arbitrary `store`                                                                                                                                                                                |

Minting is also **mode-checked** against the persona gate's `read`/`write` mode (`access.ts:144-154`).
Replace Cartesian coverage with **positives for each allowed cell** and a **fail-closed negative for
every forbidden cell** (e.g. `agent_ask`+`delete` → denied at mint, never reaches the seam), plus the
missing/invalid/expired/**replayed** and payload/id-**substitution** overwrite tests, and an
**indirect-path** test proving `staging ingest→resolve` and `people` extraction cannot mutate without
valid Core authority.

**Scope of the seam invariant (NEW-24).** The invariant governs **persona-vault content and its indexes**
(items, subjects/links) — the sovereign-memory boundary. Ingestion has a **producer lifecycle** wider
than the four origins above: owner-memory and agent-memory `remember`, connectors, and inbound D2D all
create staging records before publish (`d2d/receive.ts:133`, `chat/orchestrator.ts:442`,
`staging/routes`). v1 does **not** re-specify each of those pipelines here; it **bounds** them with this
contract — every producer path terminates in a Core-created `staging_item` whose resolve/link
capabilities are derived from the Core record — and defers the **per-pipeline minting spec (owner/agent/
connector/D2D → ingest → resolve) to the referenced Core "Brain→vault capability" hardening work**,
which this doc requires as a dependency (§22) rather than enumerating inline. Non-persona-vault stores
(e.g. `kv`, staging spool itself) are dispositioned separately and are out of this invariant's scope.
The Brain-side `persona_guard` may stay as an extra layer but is never the authority.

Do not expose Brain or PDS credentials to the plugin, and do not widen any generic route
(`/v1/msg/send`, generic workflow-create, prefix rules) to agents.

---

## 15. Session, grants, registry (DPD-008/F5)

The durable session registry is implemented: it is authenticated, bound to the caller DID, rejects
unknown/foreign/ended/expired sessions, and revokes session approvals + persona grants on end, with
restart/replay/cross-agent/expiry coverage. Ending a host session revokes its authority; it does not
claim to physically close every sensitive vault, which may also be in use by the owner.

**Host session ↔ Core session binding (F-04).** Every gate decision and grant must belong to a real
Core session; DID-only gate authority is forbidden. Claude's `PreToolUse` payload carries a stable
host `session_id`. The hook sends that id inside the signed gate request, and Core atomically
starts/reuses the corresponding opaque, DID-bound Core session before evaluating the call. This keeps
the gate hot path to one relay round trip while making retries, approvals, and revocation
session-scoped. Calls with neither a live Core `session_id` nor a host `session_id` fail closed.

The installed MCP process does **not** receive Claude's host session id, so v0.1 does not falsely claim
that hook and MCP calls always share one Core session. MCP tools use the explicit
`dina_session_start` token required by their contract and form a separate, independently revocable
scope. A future host adapter may pass the same host id to both paths and thereby reuse one Core
session, but grant isolation does not depend on that optimization.

**The session token must be authenticated, not an unsigned header (COLD-6).** Agent-facing gate,
memory, ask, and status routes carry the host/Core session id in the signed JSON body (or signed query
for status), so tampering invalidates the canonical request signature. Core-issued session ids are
cryptographically random, DID-bound, leased, and rejected after end/expiry. Legacy owner/device routes
may still use `X-Session` for non-agent compatibility; no agent authorization decision may depend on
that unsigned header. Cross-session, foreign-DID, ended-session, and missing-session tests are binding.

**Teardown is per-host, and is NOT `Stop` (F-04).** On
Claude Code, `Stop` fires at the end of **every** agent turn, not at session end — tearing the Core
session down on `Stop` would revoke grants after each turn and destroy cross-turn continuity; use
`SessionEnd`, the actual termination event, to trigger Core end (revoke + cleanup). The Claude plugin
ships a best-effort `SessionEnd` command that maps the host id to the authenticated caller's opaque
Core session and ends it; if cleanup cannot reach Core, the lease is the backstop. Codex exposes **no
`SessionEnd` and no thread-close hook** (only thread-scoped `SessionStart` and turn-scoped `Stop`), so
teardown there cannot depend on a host event. On Codex, session end is defined by two implementable
mechanisms instead: (a) an explicit `dina_session_end` MCP call the host issues on a clean exit, and
(b) an **authenticated lease** — `dina_session_start` mints a session with a bounded TTL that each
subsequent signed call renews (heartbeat); Core runs a reconciliation sweep that ends any session whose
lease has lapsed (default 15 min, configurable), revoking its grants. So a vanished Codex thread is
reaped by lease expiry, not left open. Every host binding ships a test proving that **ordinary turn
completion does not end the Core session** and that a lapsed lease does. Specify this per supported host.

**Grant lifecycle, corrected:** session start mints **no** grant; free (default/standard) vaults need
none (`access.ts:160-171`); a **1-hour** grant keyed on `(agent_did, session_id, persona, mode)`
(write-satisfies-read) is created **only on approval** of a sensitive/locked access
(`access.ts:308-381`); a fresh session id → no match → re-prompt.

---

## 16. Security & the "gate outside the agent" claim (DPD-001/002)

**Holds:** deterministic table-driven gate, no LLM; `BRAIN_DENIED` (seed/vault-raw/DID-sign never);
persona tiers (sensitive/locked never in scope without an approved expiring grant); `PLUGIN_FIRST_N`
carding; signed every call; audit (§20); no telemetry; MIT + auditable. **Three honest limits:**
(1) **same-UID** process separation does not stop a compromised agent/dependency running as you from
reading the convenience-mode seed + agent key — real isolation needs an OS boundary or the
phone-held key; state it, narrow the claim. (2) **The verdict must be payload-bound** — process
separation makes Core's code un-tamperable but does not stop the forwarder labelling a destructive
call SAFE or the host executing a different payload; §12's classifier + permit closes that, and where
a host can't enforce it the assurance is "framework-mediated." (3) **The gate binds only when the host
runs the hook (§10, NEW-27)** — on Claude Code a supervisor that never launches, crashes, or is
cancelled by the host-side hook timeout is non-blocking, so that failure mode is fail-**open** absent an
independent host-level deny; disclosed, not claimed away. The gate-outside-the-agent principle is
necessary and **sufficient only with §12**, and **fail-closed only up to limit (3)**.

---

## 17. Services, D2D, and delegation (the network functionality)

Only **service publish and invoke** are thin wrappers over shipped Core routes (behind a specific
`agent` authz row, §14). **Service discovery, Talk, and delegation each need a dedicated Core
façade** — they are new work, not wrappers.

- **Services — publish is not "published," and find must not make Core do egress (COLD-5/COLD-7).**
  `dina_publish_service` writes a `service-config` listing (surface, discoverability, capabilities,
  per-capability response policy) — the same PUT the mobile My-Services form uses — but that route only
  **persists locally** (`service_config.ts` returns 200 after `setServiceConfigDurable`), while remote
  **PDS publication is detached best-effort**: `wire_publisher.ts:139` calls `void publishOnce(...)`,
  network/PDS failure is only logged, and `ProfileAutoRepublisher` has no production wiring. So the tool
  must **not** report "published + discoverable." v1 either builds a **durable publication lifecycle**
  (outbox, idempotency, retry/backoff, a status id, PDS+AppView confirmation) or returns
  **"saved locally; publication pending"** with a poll-able status; acceptance tests cover PDS failure,
  restart recovery, eventual indexing, and terminal rejection. **First publish is also the moment the
  public handle is needed** (§8): the DID already exists, but discoverability needs a human-readable name,
  so if the owner has none yet, publish prompts **Login-with-Bluesky / pick-a-name** before the PDS
  record can be written — this is the only place the handle step appears.
  `dina_find_service` is a **new agent-facing route + authz + audit + wiring** — but the search client
  is **not** missing: a validated, bounded, tested `com.dinakernel.service.search` xRPC client already
  exists in **core-server** (`core-server/src/appview/service_search_client.ts`, covered by
  `core-server/__tests__/service_search_client.test.ts`); the empty `searchServices`
  (`wire_workflow_plane.ts:226-228`) is just an unwired stub. **Authorization stays in Core, but the
  network I/O does not:** the kernel law is that Core never calls external APIs (`ARCHITECTURE.md:51,55`,
  `AGENTS.md:43-48`), so the xRPC hits AppView through a **keyless network path** (the core-server
  network adapter / Brain) under a **bounded Core-issued capability + validated response** — the pure
  key-holding keeper does no egress. The plugin never touches the AppView origin or Brain directly, and
  PeerLens/Services cannot sidestep AppView (`dina_details.md`).
  `dina_invoke_service` sends a `service.query` D2D to the chosen provider (capability + params +
  `schema_hash`), the provider answers (Tier-1 own-Dina, or a paired agent daemon), and the typed
  result renders. The **provider publishes** the canonical `schema_hash` + freshness; the **requester
  pins** that hash into every query (`service_query_orchestrator.ts:360`, validated
  `service_handler.ts:664-699`), and a **requester-owned watch** must not poll faster than the
  provider's declared freshness (`watch/service.ts:44`) (see `docs/PUSH_SERVICES_ARCHITECTURE.md`).
- **Talk / D2D — a Core façade, not the generic send route (NEW-03).** Inbound D2D is already safe:
  bound to the relay-authenticated `from_did` (never the sender-signed inner body), replay-cached,
  trust-evaluated, staged-or-quarantined. **Outbound is the gap:** the generic `/v1/msg/send`
  (`d2d_msg.ts:39-73`) accepts a caller-chosen recipient/type/body and forwards **no** `dataCategories`,
  so the egress gate checks `[]` and lets it through (`d2d/send.ts:154-160`, `d2d/gates.ts:214-221`) —
  giving an agent that route bypasses sharing policy. `dina_talk` is therefore a **dedicated Core
  façade** with a concrete wire contract.

  **New wire family + protocol bump (NEW-10).** There is no generic text family today — the V1 union
  locks its eleven message types (presence/coordination·request+response/social/safety/trust-vouch·
  request+response/service·query+response+offer+grant-request, `d2d/families.ts:77-89`,
  `protocol/src/constants.ts:79-124`), and `receive_pipeline.ts:217-229` **drops** any type
  `isValidV1Type` rejects. So Talk is a **wire-format change**, handled per `AGENTS.md` (bump the
  protocol major; add conformance vectors): v1 adds a canonical `talk.message.v1` type constant + body
  validator `{ text: string (bounded), in_reply_to?: string }`, classifies it **storable** (a vault
  message item) and maps it to a Talk scenario (`families.ts` storable/scenario tables), and defines
  ingress validation. **Deliverability is honest (NEW-10):** an older peer that lacks the type drops it
  **silently** (`receive_pipeline.ts:217-229` returns transport success to avoid fingerprinting), and
  the send path reports only relay `delivered`/`buffered` (`transport/delivery.ts:221-228`), **not**
  recipient pipeline acceptance. So unless v1 adds authenticated protocol-capability negotiation or a
  signed application-level receipt correlated to the message id, the façade must surface only
  **"transport delivered, recipient support unconfirmed,"** never claim end-to-end delivery. Ship
  cross-version conformance vectors. The façade sets the type (the agent cannot choose it).

  **Egress — one deterministic Core rule, honestly scoped (NEW-03).** Authorization is the **contact
  gate + the contact's sharing policy; there is no service grant** for plain Talk (`service_grants`
  authorize `known_only` _service capabilities_, not messages). Because free text cannot be reliably
  auto-classified and the sharing gate denies only categories **exactly** in a contact's restricted set
  (default `health`/`financial`/`medical_record`, `d2d/gates.ts:40`), a constant label cannot protect
  sensitive content — so the façade stamps a single **disclosed** `message_text` category and gates all
  agent-authored free-text Talk at a **fixed, non-session-scopable MODERATE** (a fresh per-message phone
  approval, never satisfied by a prior session approval — §12.2), surfacing recipient + text to the
  human before send rather than inferring safety from the payload. Agents are **not** authorized for
  generic `/v1/msg/send` (`docs/CONTACT_SERVICES_ARCHITECTURE.md`).

- **Delegation (task) — a Core façade, not the generic create route (F-07 / NEW-04).** `dina_delegate`
  hands work to a paired external agent through the existing `dina-agent` CLI over MsgBox — **never**
  in-process third-party code (kernel rule). The plugin must **not** be given the generic
  workflow-create endpoint, which forwards caller-chosen kind/origin/initial-state/policy/runner/
  payload (`workflow.ts:252`) — an untrusted agent could inject arbitrary control-plane tasks. Instead
  build a **dedicated Core delegation façade** that stamps kind/origin/agent-identity/initial-state in
  Core, validates the runner and a bounded payload, and requires the classifier permit. This bounds
  **what** is delegated. It does **not** deterministically enforce the delegated agent's **downstream**
  side effects: the runner path is cooperative — `dina validate` is voluntary and bypassable
  (`AGENT_CONTROL_PLANE.md:2642-2648`), and the daemon runs the selected runner directly
  (`agent_daemon.py:139-145`). Enforced downstream gating requires a runner-side PEP + payload-bound
  execution permits (new work); until it ships the downstream guarantee is **cooperative-only** and is
  **not** part of the deterministic-gate acceptance (§4).

Publish, invoke, and the three façades are gated exactly like any other agent action (§12) and audited
(§20).

---

## 18. Portability + PeerLens trust

**Integration model — the agent calls in, or the app runs the agent (DPD-020).** Two ways exist to
wire a coding agent to an outside system, and they are inverses. **MCP + hooks (this design):** Dina
is a server the agent calls into; the developer keeps Claude Code / Codex / the CLI as their
environment, and Dina rides underneath as memory, gate, and services. **ACP — the Agent Client
Protocol (Zed's, now spoken by Codex CLI, Gemini CLI, Copilot, Goose, OpenClaw, Pi):** the _app_
spawns the agent as a subprocess and drives it over JSON-RPC on stdio, so the app hosts the agent and
the agent lives inside the app. Block's Buzz picks ACP and ships pre-built harnesses (Goose, Codex,
Claude Code) behind it. (Re-verify — these market facts move fast, per the platform-fact caveat up
top.)

Buzz picks ACP because Buzz _is_ the environment: you go into Buzz. Dina's pitch runs the other way —
"your Dina, inside the agent you already use." Hosting the agent over ACP would pull the developer
into a Dina workspace and break the stay-where-you-are friction that makes the plugin adoptable. So
v0.1 stays MCP + hooks on Claude Code — the richest hook + MCP surface and the fastest path.

**Where the cross-agent story actually lives.** "One Dina, every agent" splits along the two surfaces
this doc already draws, and they port very differently. The **value surface** — memory, services,
ask, PeerLens (§14) — is one MCP server; every MCP-client agent (Claude Code, Codex CLI, Gemini CLI)
calls the _same_ server, so value portability is already a standard: one integration for N agents, no
ACP. The **gate** (§12) is the only host-specific piece — a Claude Code hook, a Codex hook, each its
own interaction map — so "every agent" costs N gate maps here. ACP's one real gain is narrow and
precise: as the app-hosts-agent standard, an ACP-hosted Dina could intercept every tool call of any
ACP-speaking agent through one uniform enforcement seam, collapsing those N maps into one — the single
thing ACP buys that MCP cannot, bought at the price of the hosted model above. Treat ACP as a
deliberate future fork (a "Dina workspace" mode) to weigh on its own merits. An MCP server the agent
calls, plus that agent's own gate hook, already delivers "works with Codex"; ACP is not required for
it.

**Install seam.** Call-into is lighter to install than spawn-and-host, and lighter integrations break
less — Buzz's ACP adapters were failing to install (Windows) the day after launch, and per-agent
adapter install is the fragile part of the hosted model. Dina keeps that edge on the value surface:
one MCP server, no adapter. Honesty check — the gate hook is still a per-host package that carries
host-schema churn; §19's marketplace-CI gate and the "re-verify at build" caveats are exactly that
risk.

**Codex (DPD-014).** An earlier draft's "Codex has no blocking pre-tool hook" is **false** — current
Codex docs describe a PreToolUse hook that can **block** Bash, `apply_patch`, MCP calls, etc. Caveats:
Codex `ask` is unsupported and fails open (route MODERATE to phone/deny instead), and hosted tools
are uncovered (disclose, same catch-all + coverage discipline as §12). So the Codex host ports
**both** memory and the gate, with a host-specific interaction map — not "memory only." Re-verify at
build.

**PeerLens trust — new Core façade work, not a thin wrapper (F-06).** `dina_review`/`dina_peerlens`
deal in `com.dinakernel.peerlens.*` records. The **write target is the owner's PDS**; the deployed
AppView (`appview.dinakernel.com`; test: `test-appview.dinakernel.com`) then **indexes and serves**
them for read — never a direct peer connection, and never a direct "publish to the AppView" (anti-
pattern, `dina_details.md`). The record is the `com.dinakernel.peerlens.attestation` — a **structured
attestation** (`subject`, `category`, `sentiment`, `createdAt`; there is no `rating` field,
`protocol/src/peerlens/types.ts:92-112`), not a free `(subject, rating)`. A **low-level Core
attestation publisher already exists** (`peerlens/pds_publish.ts:374-424` validates + publishes to the
PDS), but there is **no routed, credentialed, durable Core review façade**, the service-profile
publisher excludes review (`brain/src/pds/publisher.ts:25-26`), and search lives in Brain's AppView
client. v1 builds **Core-owned PeerLens façades** over that low-level publisher — `dina_review` calls a
Core write façade that takes the agent's `(subject, category, sentiment)`, **validates the structured
`SubjectRef`, stamps the canonical `createdAt`, and sets `isAgentGenerated: true`** before building and
signing the full `Attestation` (the agent supplies neither the timestamp, the record shape, nor the
provenance flag, and cannot override it). The provenance flag is mandatory because the AppView defaults
an absent value to human-authored (`appview/src/ingester/handlers/attestation.ts`) and feeds it into
reviewer-quality stats (`scorer/jobs/refresh-reviewer-stats.ts`), so an unstamped agent review would
corrupt PeerLens provenance; publication/ingestion tests must prove the flag survives to the AppView.
The façade uses PDS signing/session under the owner's `did:plc` and a durable-retry outbox;
`dina_peerlens` calls a Core read façade that proxies AppView search. The
plugin gets **neither the PDS write credential nor a Brain endpoint** — Core mediates both. Attestations
and trust attach to the one `did:plc`, so a developer building a reputation as a service provider does
so once, across all their agents. The outcome loop + curation sit at the far end of the build order
(§5).

The defensibility argument: portable memory, identity, services, and reputation across competing
agents attack account lock-in, so neither incumbent will build it.

---

## 19. Distribution (DPD-012)

Marketplace schema is version-sensitive — treat any example as illustrative and **CI-gate it**.
Current Claude marketplace docs require `.claude-plugin/marketplace.json` with top-level `name`,
`owner`, `plugins`, sources like `{"source":"github","repo":"owner/repo"}`, and a qualified install
(`plugin@marketplace`). Reference the current docs, ship a release-CI gate validating the
marketplace + plugin manifests against the live schema, and use the qualified install form.
README = the pitch (listing line §1; day-8 acceptance §4; demo). Supply-chain: semver; pin `ref`; no
secrets in config (`$VAR` + `allowedEnvVars`); `${CLAUDE_PLUGIN_ROOT}`, never hardcoded paths. Honesty
gate on every listing claim (the Codex and same-UID caveats especially).

---

## 20. Audit (one normative policy — DPD-013)

Durably record **every non-SAFE decision and every terminal approval result**, **metadata only**
(agent DID, action, risk band, decision, reason, timestamps — never vault content or secret-bearing
arguments), queryable via `/dina:audit`. SAFE is silent. **As built for the coding gate:** Core
persists every non-SAFE `/v1/agent/gate` decision as a `coding_gate:*` audit event. A coding-scoped
agent reads only a projected view of its own events through `GET /v1/agent/audit`; the projection
contains timestamp, action, tool name, risk, outcome, and reason, and never returns the raw audit
detail blob. The general audit API remains owner/admin-only. Terminal phone-approval decisions must
continue to be recorded at their owner-decision seam; the agent projection must not be widened into a
general audit-query capability.

---

## 21. Build sequencing (engineering milestones)

The implementation sequence has completed through the developer-preview
surface:

1. Home Node installer/supervisor, secret-safe first boot, automatic enrollment,
   lifecycle recovery, portable backup/restore, and rollback-safe upgrades.
2. Durable sessions, scoped agent identities, narrow route authorization,
   Core-owned tool classification, payload-bound approvals, and projected audit.
3. Memory ingress, Core-mediated Ask, vault metadata, and reminder projections.
4. Claude Code and Codex catch-all host adapters plus the shared coding MCP
   profile, shared plugin-owned setup engine, and owner-safe foreground-Brain
   selection.
5. Service publish/find/invoke/status, including durable PDS publication.
6. Owner-approved Talk and delegation façades.
7. PeerLens search plus owner-approved durable PDS publication.

Release sequencing is now: publish native Home Node archives, publish
`dina-agent>=0.20.0`, install-test from a machine without the repository,
publish the Claude/Codex marketplace entries, and then add automatic
phone-to-HNL identity/data continuity. Wrapped-seed mode, multi-phone approval,
and OS-level same-UID isolation remain later hardening rather than hidden
prerequisites.

---

## 22. Guards + open questions

**Guards:** the listing says only what the released image/CLI pair proves; no
in-process third-party code; Dina never touches money; no marketplace claim is
enabled before a clean-machine source-free acceptance test.

**Open questions:** (1) automatic continuity with an existing mobile Dina:
phone-authorized seed/data transfer versus the currently supported manual
recovery-phrase + `.dina` archive path; (2) multi-phone
routing for the laptop-Core↔phone approval surface (§13.1); the sealed,
idempotent proposal/decision substrate, owner lifecycle controls, task sync, and mirror cleanup are
implemented; (3) the Bash classifier (§12.3) — safe parsing +
conformance tests; (4) same-UID posture (§16) — OS-keystore/sandbox vs. laptop-keyholder-with-caveat;
(5) **Resolved as a model (§8), leaving one build detail:** identity is foundational — Core mints/uses a
DID at first-run in all three cases, so first-run does **not** block on a handle; only _publishing_
needs the human-readable handle. Today it must be supplied at install with
`--pds-handle`; first-publish prompting remains a UX follow-up (§17). The remaining choice is the
**pairing-time signing key** — copy-to-laptop (simple, v0.1) vs. a phone-authorized **child key**
(safer, revocable); ship the child key eventually; (6) live marketplace
publication and schema validation for the implemented host packages; (7) enforced runner-side downstream
gating for delegation (§17, NEW-04) — the PEP + execution-permit design that would move the downstream
guarantee from cooperative to deterministic; (8) **the Brain→vault capability hardening (§14,
NEW-20…25)** — this plugin depends on it (a compromised Brain must not read/mutate a persona vault), and
this doc **bounds** it (storage-seam invariant, typed-origin + `staging_item` model, origin×operation
matrix, read/write contracts), but the **complete per-pipeline minting spec** (owner/agent/connector/D2D
→ ingest → resolve, and the staging-record lifecycle) is a **separate Core-hardening effort** this doc
requires as a dependency, not an inline enumeration — a genuine scoping boundary for the human to
confirm; (9) release automation for platform-specific native Home Node
archives and the corresponding marketplace versions.

---

*Summary: one Dina, every agent — the plugin is a client, not a takeover, and the control plane is
the product. v1 is the full functionality: memory, a real gate, services, D2D, PeerLens trust, task
delegation, reminders — all under one identity, all gated in Core. The strategy reuses Dina's agent
model and the shipped D2D/services/PeerLens *transport* stacks, but the developer surface is real Core
work: a Core-owned classifier with a payload-bound permit, a catch-all command gate that is fail-closed
once the host runs it (with the honest Claude-Code residual on supervisor-launch/host-timeout disclosed,
§10), an agent-safe memory surface, four new Core façades (find-service, `dina_talk`, PeerLens,
delegation) with
per-tool authz, a durable session registry, PDS-backed bootstrap with a safe enrolment capability, and
a versioned laptop↔phone approval transport. The developer-preview
implementation now contains those façades, both host packages, and the HNL
lifecycle. Release claims remain gated on public native archives, clean-machine
installation, and marketplace acceptance tests.*
