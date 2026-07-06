# Dina Plugins — Architecture (v2)

*A plugin is a signed, content-addressed contract. It executes as either data interpreted by a trusted runtime, or code paired as a device. It is never trusted, and it never runs inside Dina's trust boundary.*

Status: design. Grounded against the shipping TypeScript stack (`packages/core`, `packages/brain`, `packages/protocol`, `appview/`, `apps/mobile`). Every "exists today" claim carries a file reference.

---

## 1. The one-sentence idea

The services architecture already contains a plugin system in embryo, disguised as four other features:

- the **custom-capability lane** (reverse-DNS ids, reached by reference, deliberately excluded from intent routing, `packages/protocol/src/services/capability-registry.ts:334`, `appview/src/api/xrpc/search-capabilities.ts`) is a plugin capability namespace;
- **Tier 1**, where `capability_runtime` interprets an instruction plus config (`packages/brain/src/service/capability_runtime.ts`), is an embryonic plugin runtime in which the plugin is *data, not code*;
- **Tier 2 delegated runners** (`requested_runner` lanes, claim/complete over MsgBox, `packages/core/src/workflow/repository.ts:557`) already are a developer plugin mechanism at the wire level;
- and the **offer/grant handshake**, the **card-spec renderer**, and **per-vault isolation** are plugin invitations, plugin UI, and plugin sandboxing respectively.

The plugin model is therefore mostly the promotion of existing seams into a contract. One manifest, two execution modes:

| | **interpreted** | **runner** |
|---|---|---|
| The plugin is | data: a declarative state machine + deterministic ops + optional instructions | code: a process the developer runs, paired as a device |
| Executes | inside a hardened first-party interpreter (generalized `capability_runtime`) | out of process, anywhere, claiming tasks on a private lane |
| Best for | games, structured peer exchanges, symmetric protocols between Dinas | anything that touches the outside world (APIs, devices, connectors) |
| Third-party compute needed | none | a daemon somewhere (owner's box or vendor-hosted) |
| Runtime identity | none: nothing to pair, nothing to revoke at device level | per-install Ed25519 device key |

The delta over what exists: one new artifact (the manifest), one new wire primitive (the session), one new registry layer (dynamic, per-node), one new runtime (the interpreter with its ops library), and the product surface (consent, marketplace, lifecycle). Smaller than it sounds; not as small as "one artifact, one primitive, one registry" — the interpreter is a real build, and this doc treats it as one (§10, §17).

## 2. The trust algebra, stated honestly

- **Runner mode** keeps untrusted *code* fully outside the process. Dina controls what data reaches it (§11), what actions it can trigger through Dina (§8), and can kill it in one tap. What it does on its own servers is outside the TCB, priced by PeerLens.
- **Interpreted mode** moves untrusted *data* inside the process, as input to trusted code. That is far safer than code, but it is the historically dangerous pattern (every parser CVE lives there). "No untrusted code in the process" becomes "untrusted data interpreted in the process," and the interpreter therefore gets the security-critical treatment: install-time caps, runtime budgets, total-function transitions, and a fuzz gate (§10.4). This is said out loud here so it never gets waved away later.

## 3. Vocabulary

- **Publisher**: the author. A `did:plc` (any PDS account). Signs and publishes the manifest into their own AT repo. PeerLens trust attaches here.
- **Manifest**: the plugin's contract. A content-addressed AT Protocol record (`com.dinakernel.plugin.manifest`); the record CID *is* the hash, so content addressing comes free from ATProto. The CID pins a *version's content* and nothing more: identity is the versionless pair `(publisherDid, plugin_id)`, and authenticity is a repo proof (§5, rule 5). Nothing ever validates against a live record.
- **Install**: the stable local anchor. Installing mints an opaque `install_id`, the primary key everything else hangs off (lane, vault, grants, config, decision log), with `current_cid` as mutable version state. `(publisherDid, plugin_id)` is the plugin's *identity* — what updates, advisories, and trust attach to — and deliberately NOT a uniqueness constraint: two homes, two stores, or two vendor tenants are legitimate second installs of the same plugin. Multi-install carries two UI obligations (§15): an owner label when count > 1, and a per-capability default install for routing. `plugin_id` alone is publisher-chosen and globally ambiguous: two publishers can ship the same reverse-DNS-looking id, so it is never used as a key, a lane, or a vault name.
- **Instance** (runner mode only): one installation's paired device, role `plugin`, its own Ed25519 keypair, revocable via `revokeDeviceDurable` (`packages/core/src/devices/registry.ts:262`).
- **Capability**: one typed function, described with the catalog's own vocabulary: `action_class`, `privacy_class`, `params_schema`, `result_schema` (`packages/protocol/src/types/catalog.ts`). Plugin capability ids live in the custom reverse-DNS lane.
- **Interaction**: `query` (asymmetric request/response, like services today) or `session` (symmetric, stateful, multi-move; §10).
- **Kind** (runner mode): which lanes the code may serve: `tool`, `provider`, `ingest`, `notify` (§9).
- **Lane** (runner mode): `requested_runner = "plugin:<install_id>"`, following the reserved-lane precedent of `dina.local` (`packages/protocol/src/types/capability.ts:56`). Keyed on the install, never the publisher-chosen id, so same-named plugins from different publishers cannot collide.
- **Session**: a mutual, pairwise grant pinned on the wire to `(publisherDid, plugin_id, manifest_cid, capability_id, session_id, peer_did, ttl)`; each node anchors it locally to its own `install_id`. Typed move bodies flow under it. The publisher fields are load-bearing, not decoration: byte-identical manifests from two different publishers produce the *same CID*, so a CID-only pin cannot tell "Battleship by Acme" from "Battleship by EvilCo" — and trust, advisories, and identity all attach to `(publisherDid, plugin_id)`.

## 4. What this enables

Alonso is the owner; Sancho a trusted contact; ChairMaker a vendor-publisher.

| Use case | Mode | Interaction / kind | Notes |
|---|---|---|---|
| Battleship between Alonso and Sancho | interpreted | session | commit/reveal fog-of-war, provably identical rules (§10.3) |
| "Guess my favorite…" trivia between friends | interpreted | session | vault-blind verification: facts never leave the vault (§10.5) |
| Structured splitwise-style tally between contacts | interpreted | session | deterministic `tally` op; no third-party server |
| "Turn off the studio lights" | runner | tool, write | HIGH card first N times, then standing approval |
| "Watch BA117 for delays" | runner | tool + notify, read | custom id → MODERATE until standing-approved (§8); delay events clamped by the silence classifier |
| ChairMaker's order-status backend | runner | provider, read | plugin sits behind Alonso's own listing; peers never see it |
| Wearable/fitness sync | runner | ingest | store-only, provenance-tagged, weekly digest |
| Restaurant booking | runner | tool, booking | HIGH → approval card with params preview |
| Grocery cart builder | runner | tool, quote | assembles cart; handoff via the Open-link action card (§15); payment BLOCKED forever |
| "Trade stocks for me" | — | — | no Dina-mediated path at any trust level (`payment` floor, §8); credentials handed to external code are outside Dina's control and the UI says so |

The phone story falls out for free in both modes. Interpreted plugins need no third-party compute at all. Runner plugins are runners over MsgBox, so a phone-only owner's plugins run on their home-node-lite box, any always-on machine, or the vendor's host. Execution location is orthogonal to safety because safety was never about where code runs, only about what crosses the wire.

## 5. The manifest: `com.dinakernel.plugin.manifest`

Published into the publisher's repo, rkey = plugin id (multi-plugin publishers follow the multi-listing rkey precedent, `packages/brain/src/service/service_publisher.ts:31-42`).

```jsonc
{
  "$type": "com.dinakernel.plugin.manifest",
  "plugin_id": "com.acme.battleship",        // rkey within the publisher's repo; identity is
                                              // (publisherDid, plugin_id), never this string alone
  "version": "1.2.0",                         // semver; the CID is the real pin
  "display_name": "Battleship",
  "short_description": "...",                 // capped + sanitized at ingest
  "icon": { "$blob": "..." },
  "homepage": "...", "source_url": "...",
  "min_interpreter": 1,                       // node refuses constructs it doesn't know

  "execution": { "mode": "interpreted" },     // or {"mode":"runner","runtime":{
                                              //   "hosted_endpoint": "...",
                                              //   "self_host": {"npm":"...","docker":"..."}}}

  "capabilities": [{
    "id": "com.acme.battleship.play",
    "display_name": "Play Battleship",
    "interaction": "session",                 // or "query"
    "action_class": "read",                   // read|quote|booking|write|payment|agentic
    "privacy_class": "public",
    "params_schema": { ... },                 // JSON Schema, depth-capped
    "result_schema": { ... },
    "card": { ... },                          // card-spec hints for renders

    // interpreted + session only:
    "machine": {
      "initial": "placing",
      "states": ["placing", "battle", "won", "lost", "abandoned"],
      "moves": { "place": {"$schema": ...}, "fire": {"$schema": ...} },
      "transitions": [
        { "from": "placing", "move": "place", "ops": ["commit"], "to": "battle_when_both" },
        { "from": "battle",  "move": "fire",  "ops": ["verifyCommit","compare"], "to": "..." }
      ],
      "turn": "alternate",
      "timeouts": { "move_sec": 86400, "session_ttl_sec": 604800 },
      "terminal": ["won", "lost", "abandoned"]
    },
    "ops_used": ["commit", "verifyCommit", "compare"],   // closed set, §10.2
    "verify_budget": 0,                                   // vault-blind checks per session, §10.5
    "instructions": null,                                 // optional LLM step text (isolated, §10.4)

    // runner mode only:
    "intent_phrases": ["..."],                 // owner-local routing hints, capped + sanitized
    "data_scope": { "categories": ["travel"], "max_context_items": 5 },
    "network_domains": ["api.acme.com"]        // transparency for the consent card, not a firewall
  }],

  "config_schema": { ... }                     // owner-facing settings form; NON-SECRET
                                               // preferences only (rule 6)
}
```

Six rules keep the manifest honest:

1. **Classification is derived, never trusted.** Capability-id kind (`official`/`custom`/`unknown`) is computed locally (`classifyCatalogCapability`, `capability-catalog.ts:763`). A canonical id inherits the catalog's own `action_class`/`privacy_class`; a manifest cannot override them downward. Declared risk anywhere in the manifest may only *raise* the locally computed floor (§8).
2. **The CID pins content; it is not identity and not authenticity.** Install records the CID as `current_cid` on the install row (the `schema_snapshot` discipline generalized, `packages/brain/src/service/service_handler.ts:473-485`); session acceptance pins it again per session, which is what makes "both players provably run identical rules" a property, not a promise. Identity is `(publisherDid, plugin_id)` plus the local `install_id` (§3); authenticity is rule 5. Updates are new CIDs *on the same install row* and apply only per §14.
3. **Ingest revalidates at the trust boundary.** The AppView handler re-derives classes, caps sizes, and rejects banned categories, mirroring `appview/src/ingester/handlers/service-profile.ts:106-125`. Companionship/emotional-intimacy capabilities are banned at ingest AND at install (Anti-Her, enforced twice). Single-"player" session capabilities are rejected: a session requires a peer DID that is an owner-selected known contact, explicitly accepted (§17.2).
4. **Install-time structural caps** (schema bombs are a real vector): manifest ≤ 256 KB, schema depth ≤ 8, no recursive `$ref`, ≤ 64 states, ≤ 32 move types, ≤ 16 transitions per state, ≤ 32 ops per transition. Numbers tunable; the existence of hard caps is not.
5. **Authenticity is a repo proof, not a CID.** A CID proves integrity of what you fetched, not who published it; a CID handed over by an untrusted or compromised index proves nothing. Install-time verification is: resolve the publisher's DID document → fetch a *proof-carrying CAR* (the MST inclusion path plus the signed commit) → verify the commit signature against the DID's registered signing key → only then pin the CID. The invariant is the proof, not the endpoint: `com.atproto.sync.getRecord` is the candidate, `com.atproto.sync.getRepo` the conservative fallback if record-level proof semantics prove insufficient — implementation verifies which, and the invariant doesn't move. AppView is discovery only, never an authenticity authority. The verifier is a concrete contract, not a concept: a pure module in `@dina/protocol` (beside the PLC-document code, so it gets frozen conformance vectors like the rest of the wire contract) with inputs `(did, collection, rkey)`, the steps above, and output `(cid, rev)` or a typed failure. It runs on-node; delegating it to AppView would make this rule circular. Failure UX: integrity failure = hard refusal with a plain-words explanation, no "install anyway", no trust-on-first-use fallback; transient failure (network, DID resolution) = retry affordance, still no bypass.
6. **`config_schema` is non-secret preferences only.** The validator rejects secret-typed fields; credentials (API keys, payment instruments, logins) are configured on the plugin's own surface, never through Dina's form. Dina refuses to be the credential intake for third parties. Because a hostile manifest can mislabel a secret as plain text, the config form carries a second, heuristic layer: paste-pattern warnings plus standing copy ("anything you enter here goes to the plugin; Dina cannot limit what the plugin's own code does with it"). Even though config is non-secret by policy, the *values* still deserve classification, because owners will type sensitive preferences (dietary needs, a home address): config values are stored **encrypted** (in the plugin's own store, same at-rest treatment as any vault), are **never owner-retrieval content** (Ask/search/enrichment never read them — they are plugin runtime configuration, not owner knowledge, the same rule as plugin vaults §11), are **disclosed in export/restore** (the owner sees what config travels), and are **sent only to that plugin's own runner**, never to another plugin or any third party.

A companion record, `com.dinakernel.plugin.advisory`, lets a publisher flag releases as compromised or withdrawn (§14). Its shape is `(plugin_id, version_range, affected_cids[], severity, note)` with the publisher implicit in the repo DID: CIDs are unordered hashes, so the range is expressed over semver with an explicit CID list, never over CIDs.

## 6. The two registries, and where plugins may never appear

**The canonical catalog stays exactly as it is**: compiled-in, small on purpose, byte-identical in AppView, guarded by the drift test (`appview/tests/unit/capability_registry_drift.test.ts`). Plugins never join the 3-way sync; that sync discipline is precisely what would make plugins a bottleneck if they touched it.

**The dynamic registry is per-node**: one row per install, keyed by `install_id`, carrying its identity `(publisherDid, plugin_id)` (indexed, not unique — multi-install is legitimate, §3), an owner label, `current_cid`, the pinned manifest (schemas, machine definitions), consent state, the approved-scope hash and current `behavior_hash` (§8.1), any pending update (`pending_cid`, `pending_behavior_hash`, decision state — the §14 policy has to be persistable, not just conceptual), and (runner mode) the lane binding. The CID is version state on the row, never the key: an update must not orphan grants, config, or the vault, and under this keying it structurally cannot.

**Routing surfaces, by privacy stance:**

- **AppView generic intent search never includes plugin ids.** `searchCapabilities` already excludes the custom lane by construction (`search-capabilities.ts`); plugin ids are custom-lane ids, so no stranger's chat prompt ever routes into your plugin. This is inherited, not built.
- **Reach is by reference**: marketplace link, session invite, QR, or contact recommendation. AppView indexes manifests as opaque, CID-addressed records with display metadata for search; it never ingests plugin capabilities into the capability registry.
- **Owner-local routing is opt-in**: with consent, a runner-mode tool capability's `intent_phrases` join the classifier's injected list, the same mechanism as `ROUTABLE_CAPABILITY_LINES` (`packages/brain/src/reasoning/intent_classifier.ts:89-91`), as a runtime-sourced second list with a new source value `installed_plugins`. The toggle lives on the consent screen; off by default for HIGH capabilities.

## 7. Identity

**Publisher identity** is the manifest repo's DID. It accrues PeerLens verification, reviews, and ring status. It signs nothing at runtime.

**Interpreted plugins have no runtime identity.** There is no process, so there is nothing to pair and no device to revoke. Uninstall = dynamic-registry removal + plugin-vault deletion + active-session termination. Sessions authenticate as the *peers'* DIDs on the existing envelope binding; the plugin itself is never a wire actor.

**Runner instances** pair exactly like `dina-agent`: `POST /v1/pair/initiate` with role fixed at initiate time (the anti-escalation boundary, `packages/core/src/server/routes/pair.ts:119-127`), `dina1:` setup codes (`apps/mobile/src/services/agent_setup_code.ts:70`), one new `DeviceRole` value `'plugin'` (`registry.ts:28`) mapping to `'plugin'` in **both** caller-type unions — the resolution union (`packages/core/src/auth/caller_type.ts:20`) and the authorization union (`packages/core/src/auth/authz.ts:20`) are separate types today, and both must change together. The dangerous failure is silent fallthrough: a `plugin` role that `resolveCallerType` maps to `device` inherits the much wider device surface, which is privilege escalation by default-case — so the role→callerType mapping is explicit, and a test pins that a plugin-role device never resolves to `device`. The authz surface itself is phase-defined and minimal (§9.0). A vendor hosting for a thousand owners holds a thousand instance keys, one per customer, each revocable by that customer alone. Two instances sharing a DID is self-defeating: one WS per DID at the relay (`packages/core/src/relay/msgbox_ws.ts:148`), per-DID nonce and rate buckets, and DID-gated completion (`routes/workflow.ts:388-409`).

**Why not the D2D peer lane for runner instances**: a plugin does not deserve peer standing. Device pairing gives per-install revocation (one SQL tombstone vs PLC operations), per-DID rate limiting, and relay routing for free; quarantine semantics stay reserved for actual strangers.

## 8. The risk model

**Self-declared risk is an attack, so risk is computed locally, and declarations may only raise it.**

For **runner-mode** capabilities, the floor keys off `action_class`:

```
read → SAFE      quote → SAFE      booking → HIGH
write → HIGH     agentic → HIGH    payment → BLOCKED (every ring, forever)
```

Three amendments for honesty about what Dina can actually know:

- **For canonical ids the class is catalog-owned** (the id folds through `classifyCatalogCapability` and the catalog's own `action_class` wins), so the floor is genuinely derived.
- **For custom ids the declared class is a consent label, not proof.** Dina cannot verify that runner code labeled `read` doesn't book, write, or spend on its own backend. Therefore **custom runner capabilities never floor below MODERATE**: SAFE silence is reserved for catalog-canonical capabilities whose semantics Dina knows. A custom `read` capability runs silently only after the owner grants a standing approval, which is an explicit human decision, not a manifest claim. What stays genuinely local regardless of any lie is the egress side (§11): a mislabeled capability still cannot receive more data than its consented scope.
- **`payment` means Dina-mediated payment.** The BLOCKED floor governs every action flowing through Dina. What external code does with credentials an owner hands it directly is outside Dina's control, which is why §5's rule 6 exists and why the consent surface says so in plain words rather than implying a guarantee Dina cannot make.

For **interpreted-mode** transitions, the substrate is better and the rule is finer: risk derives from the *ops and egress a transition actually uses*. A transition that only calls `commit`/`verifyCommit`/`compare` is structurally SAFE (it cannot do anything else; the ops set is closed and first-party). A transition that writes the plugin vault is SAFE-with-quota. Vault-blind verification carries its budget gate (§10.5). Any op that would emit an owner-visible action beyond the session (none exist in v1's ops library) would carry the runner-mode floor for its class.

Then, in `evaluateIntent` ordering style (`packages/core/src/gatekeeper/intent.ts:125-180`; same file gains `evaluatePluginIntent`, table-driven, no LLM, fail-safe `?? 'MODERATE'`):

```
declared:          manifest hints may only RAISE the computed floor
trust-ring clamp:  publisher not Verified → nothing runs silent (min MODERATE)
privacy clamp:     runner data_scope touching a sensitive persona → every
                   invocation carded; locked personas NEVER in scope (v1)
first-N rule:      HIGH capabilities card the first 3 invocations even after
                   a standing approval exists
```

**Standing approvals** clone the `service_grants` shape (`packages/core/src/service/service_grant_repository.ts:20-38`) into `plugin_grants`, keyed `(install_id, capability, approved_scope_hash)`, with *Once / 24 hours / Until revoked* offered on the card (the vault-read card's approve vs approve-once split, generalized). The scope hash is a canonical digest of the capability's consent-relevant fields, specified field-by-field in §8.1. Keying on it makes update policy self-enforcing: a same-scope update leaves the hash unchanged and grants survive; scope growth changes the hash, nothing matches, and re-consent happens structurally rather than because a rule remembered to fire. Execution always validates against `current_cid`, pinned separately on the install row. Uninstall and device-revoke cascade grants (`revokeForAgent` precedent, `registry.ts:288-297`).

**What no plugin can ever do**, in either mode: everything in `BRAIN_DENIED` (`intent.ts:85-94`) — sign, rotate, export, raw vault access — because those checks run before risk lookup and both modes enter through the same gate.

### 8.1 The approved-scope hash (launch-gate spec, frozen before P0)

The hash IS the re-consent boundary, so its contents are a launch gate, not an open decision. Per capability, the digest is SHA-256 over JCS-style canonical JSON (sorted keys, no insignificant whitespace) of:

**In the hash** — anything that changes what the owner agreed to:

- execution mode; capability id; `action_class`; `privacy_class`
- `params_schema` and `result_schema`
- `data_scope` (categories, personas, `max_context_items`)
- `network_domains` and the runtime endpoint identity (`hosted_endpoint`)
- `config_schema` (a new field asking the owner for more input is consent-relevant)
- `intent_phrases` (they change *when* the plugin gets invoked)
- machine **interface** (move types + their schemas), `ops_used`, `verify_budget`

**Out of the hash, deliberately:**

- internal transition wiring: it cannot raise risk (transitions can only use the closed ops set, §8) and inter-peer rules-fairness is guaranteed by per-session CID pinning, not by consent — hashing it would turn every game-balance tweak into consent fatigue. It is instead covered by a second digest, the `behavior_hash`, which never touches grants but gates *silent update application* (§14): wiring changes become visible without becoming consent events;
- `display_name`, description strings, and the plugin-authored `instructions` (the LLM step text): none of these change what data flows or what actions run, so they must not invalidate grants — but all three are user-*visible* and socially exploitable (a deceptive rename; an instruction rewrite that changes the tone or framing of every generated card), so they cannot apply silently either. They are covered by a third digest, the `presentation_hash` (below), which gates surfacing, not grants.

**Three digests, three jobs** (all SHA-256 over canonical JSON):

- `approved_scope_hash` (the fields above) — gates **grants**. Changes → re-consent.
- `behavior_hash` — over everything machine-behavioral that consent excludes: transitions, turn rules, and timeouts (`move_sec`, `session_ttl_sec`, pressure- and spam-relevant). Gates **silent functional application** (§14); never gates grants. Timeout changes render as plain words ("moves now expire in 1 hour, was 24").
- `presentation_hash` — over `display_name`, description, and `instructions`. Gates **neither grants nor application**, but a change here always **surfaces in Activity before/after** the update lands (§14). This is where the deceptive-rename and instruction-drift risks are caught: they can never be silent, even though they never block a functional update.

## 9. Runner mode: the four lanes

### 9.0 The authz surface, by phase

`authz.ts` is a static per-callerType path-prefix matrix (`packages/core/src/auth/authz.ts:28-147`), so it expresses the *phase superset*; per-install kind consent is enforced in-handler (the `ownerDecisionGuard` precedent, `routes/workflow.ts:548`). Today no `plugin` caller exists at all (`authz.ts:20`), which is correct: the matrix grows only when the phase ships.

| Phase | Matrix entries for callerType `plugin` | In-handler check |
|---|---|---|
| P0 | `/v1/workflow/tasks/claim`, `/:id/heartbeat`, `/:id/progress`, `/:id/complete`, `/:id/fail`, `/healthz` | the five claim-time checks (§9.1): lane, active, kind, non-revoked, current scope hash |
| P3 | + `/v1/ingest` | install has consented `ingest` kind; persona + quota checks |
| P3 | + `/v1/plugin/notify` | install has consented `notify` kind; classifier clamp (§9.4) |

Nothing else, in any phase: no vault query, no ask, no sessions with Core, no approve/deny. "Claim-only" is the P0 truth; ingest and notify are later, narrow, handler-gated additions, never a widening of the claim surface.

### 9.1 `tool` — the owner asks, the code acts

Intent classifier (opt-in injection, §6) → `evaluatePluginIntent` → SAFE runs silent *only if the params clear egress* (§11 point 5), MODERATE/HIGH raises `InlinePluginApprovalCard` → brain assembles minimal context (§11), egress-checked → `WorkflowTask{kind: delegation, requested_runner: "plugin:<install_id>", payload: {install_id, capability_id, params, context, manifest_cid, approved_scope_hash, schema_snapshot}}` — the pinned plugin envelope fields are immutable, set at enqueue, and are what the five claim-time checks verify against; without them persisted on the task, the stale-authority guard is unimplementable → instance claims over signed MsgBox RPC (`msgbox_handlers.ts:245`), executes, completes → result validated against the **pinned** result schema (nonconforming = task failure, counted against plugin health) → CardSpec render in untrusted mode (badge blocks stripped, no external URLs — the sole sanctioned exit is the first-party Open-link card, §15; `card-spec.ts:281`).

**Claim-lane hardening (required before any third-party runner exists):** today's claim SQL lets a named filter also take *untagged* tasks (back-compat clause, `repository.ts:582-588`). For `plugin` callers the server ignores the client-sent `runner_filter` entirely and forces exact-match on the lane registered to that instance DID, the way `dina.local` is exact-match-only and HTTP-claim-forbidden (`routes/workflow.ts:216-220`). Lane assignment derives from the dynamic registry row, never from the caller. And the lane match is only the first of five claim-time checks, all server-side: exact lane; `install.status === active`; the capability's kind is consented; the device is non-revoked; and the task's pinned scope hash equals the install's *current* approved hash — closing the stale-authority hole where a task queued under old consent gets claimed after the owner changed it. Pause therefore needs no producer-side cooperation: in-flight leases may complete, new claims stop at the guard. This is a **launch gate, enforced in Core**: no third-party runner pairs until it ships server-side. SDK behavior is irrelevant to the invariant; a malicious runner is assumed to speak raw RPC.

### 9.2 `provider` — the plugin backs the owner's own listings

Exists today under another name: service capabilities already route by `requestedRunner = mcpServer || 'dina.local'` (`service_handler.ts:494-500`). A provider-kind plugin registers `plugin:<install_id>` as the binding for chosen capabilities in the owner's listing config (`service-settings.tsx` gains a "Backed by" picker). Inbound `service.query` → ServiceHandler (auto/review unchanged) → plugin lane → Response Bridge returns the schema-validated `service.response` (`workflow/service.ts:443-447`). ChairMaker ships one plugin; every customer gets an order-status service without writing code. All existing gates apply because the plugin sits *behind* the listing, invisible to peers — **and the provider task carries the identical pinned plugin envelope as a tool task** (`install_id, capability_id, manifest_cid, approved_scope_hash, schema_snapshot`, §9.1), verified by the same five claim-time checks (§9.0). Stated explicitly because "all existing gates apply" would otherwise make the provider lane the soft path: a provider task with no pinned envelope would skip the stale-authority and active-install checks that the tool lane enforces. Same envelope, same guard, no exceptions.

### 9.3 `ingest` — store-only, provenance-tagged

Modeled on the legacy connector allowlist, but through a dedicated endpoint, non-negotiably: CallerType `plugin` with ingest consent gets exactly one write path, `POST /v1/ingest`, which stamps `source: "plugin:<install_id>"` server-side from the authenticated DID (never from the body), enforces per-install daily item quotas, and restricts writes to the consented personas. `/v1/vault/store` stays brain-only, the boundary the authz matrix draws today (`packages/core/src/auth/authz.ts:30`); widening an existing brain-only path for a new caller type would weaken it for no gain.

The full write contract, pinned before P3 (a permissive ingest is how a plugin quietly poisons the vault):

- **Schema-validated**: each item validates against the capability's declared ingest schema (frozen at consent like every other plugin schema); malformed items are rejected, not coerced.
- **Size + shape caps**: per-item byte cap, per-item field cap, and the per-install daily quota; over-quota fails with a typed error and an Activity note, never silent truncation.
- **Conflict behavior is explicit**: ingest is append-with-provenance, not upsert — a plugin cannot overwrite an owner's own items or another plugin's, only add its own `source`-tagged rows. Re-ingesting a logically-identical item dedups on a plugin-supplied stable key within that plugin's provenance scope.
- **Delete/purge semantics**: the plugin may retract its own items by key; the owner may purge all of a plugin's items by provenance (offered at uninstall). Purge is real deletion of plugin-sourced rows, never the owner's.
- **External assertion, never owner truth**: ingested items enter enrichment tagged as external provenance — they inform retrieval and can be cited, but are never treated as the owner's own assertions, and the Ask/reasoning path surfaces the source rather than speaking them as fact.

Activity shows per-plugin digests; uninstall offers purge-by-provenance.

### 9.4 `notify` — only through the classifier

The plugin submits events with a priority *hint*; the silence classifier classifies independently; effective tier = **min** of the two. A plugin can demote itself, never promote. Fiduciary interrupts happen only when Dina's own classification agrees. Engagement lands in the daily briefing. Over-claiming is logged, surfaced ("Acme marked 14 routine events urgent this month. Mute?"), and available as owner-authored PeerLens evidence.

Priority is only half the safety story; the **payload** is plugin-authored text and gets its own contract: notification bodies are schema-capped (length + shape), rendered as visibly plugin-authored (never as Dina's own voice, and never fed back into any prompt as system instructions — the §10.4 isolation rule extends here), and **cannot embed action links or buttons** except through the first-party Open-link / action card (§15). A notification can say "your order shipped"; it cannot render its own tappable "pay now" or an inline URL. The plugin supplies words; Dina owns every affordance.

## 10. Interpreted mode and the session

### 10.1 The session primitive (the one genuinely new wire concept)

Services are asymmetric query/response; a game is symmetric and stateful. Both roles already live in every node, so it lands softly:

- **Invite** rides the existing offer/grant machinery (`service_offer_events.ts`, `grant_request_events.ts`). Alonso picks a contact and a plugin; Sancho receives an invite card. The invite carries `(publisherDid, plugin_id, manifest_cid)`, which makes it the third reach-by-reference channel (§6) — it must work when Sancho has never seen the plugin. Not-installed path: repo-proof verification of that exact snapshot → a combined install-consent + session-accept card ("Alonso invited you to Battleship — install and play?") → grant minted only after both. Already-installed path: if Sancho's `current_cid` differs from the invite's pin, the accept card says so and the session runs the pinned snapshot on both sides — verified and consented locally like any install — so version alignment falls out of the pin instead of being negotiated.
- **Accept is always explicit.** Never closeness-defaulted, even for family: `contact_grant_policy` is deliberately bypassed here. Accept mints a mutual, pairwise session grant on both nodes, pinned on the wire to `(publisherDid, plugin_id, manifest_cid, capability_id, session_id, peer_did, ttl)` (§3 explains why the publisher fields are load-bearing) and anchored locally to each side's own `install_id`. When more than one local install matches `(publisherDid, plugin_id)`, the accept card carries an install selector defaulting to the per-capability default install (§15); the chosen `install_id` is recorded in the local grant row.
- **Moves** are typed bodies in a `plugin.session.*` D2D family under that grant.
- **`receive_pipeline` keeps its exact spine** and adds one gate after known-sender (the shape of the known_only gate, `packages/core/src/d2d/receive_pipeline.ts:313-336`): the session's pinned `(publisherDid, plugin_id, manifest_cid)` matches an installed plugin → grant valid and unexpired → payload validates against the pinned move schema for the pinned `capability_id`. Authz binds to the envelope `from_did`, never the inner body; quarantine, the confused-deputy defense, and MsgBox blindness are unchanged.
- **End**: terminal state, TTL expiry, or either side's unilateral end. State is swept per the manifest's `session_ttl_sec`.

Version skew is impossible by construction: the session pinned one CID at accept; a peer running a different version fails the hash gate and the session surfaces "rules mismatch, restart to update" rather than diverging silently.

### 10.2 The deterministic ops library (the key unlock)

Tiny, first-party, versioned, closed:

```
commit(value, salt) / verifyCommit     hidden information (fog-of-war, sealed bids)
sharedRng                              both sides commit seeds → reveal → XOR:
                                       neither party can bias the roll
compare / tally / counter              scoring, vote counting, turn accounting
timeout assertion                      deadlines are MOVES, not clock reads: one side
                                       asserts "timeout at T", validated against the last
                                       logged move + move_sec with bounded skew, and the
                                       assertion joins the log (§10.3)
verifyFact(guess, fact_ref)            vault-blind check, §10.5
```

This is what makes fog-of-war expressible as manifest *data* instead of shipped code. The library grows by protocol revision only (`min_interpreter` gates), never by manifest request.

### 10.3 The move pipeline

Per inbound move: envelope gate (§10.1) → machine legality (state, turn, move type) → ops execute under budget → state persisted to the plugin vault under quota → card rendered (with an optional LLM step for presentation only, §10.4) → response move sent. Transitions are **total functions**: anything unrecognized rejects the move with a typed error; the interpreter never guesses and never crashes on input. Every move appends to a session log, so any dispute reduces to: identical CID + identical log ⇒ identical state, replayable by either side.

That replay claim only holds under one discipline, so it is a rule: **nondeterminism enters a session only as logged move data, never as replay-time computation.** Canonical state is a pure function of the pinned machine and the move log. The three nondeterministic sources are each forced through the log:

- **Randomness**: `sharedRng` derives from both parties' committed-then-revealed seeds, all of which are moves in the log.
- **Time**: no transition reads a clock. A timeout is an *asserted move* ("timeout at T"), validated against the last logged move plus the machine's `move_sec` with bounded skew tolerance; the assertion itself joins the log.
- **LLM output**: never computed inside a transition. It is presentation-only (§10.4), or, where generated content must enter the game (say, trivia questions), one side's LLM output enters *as that side's move body*, schema-validated like any move: the content lives in the log, and nothing is re-derived at replay. Without this rule two honest Dinas diverge; with it, divergence is proof of a dishonest peer.

### 10.4 Two hard runtime rules, plus the interpreter's own discipline

1. **LLM steps run in an isolated context, and their output never touches canonical state.** A plugin's `instructions` field is attacker-authored prompt text. It never executes in the real Brain context: no personal vaults, no tools, session state in, schema-validated JSON out. This is deliberately *stricter than Tier 1* (`capability_runtime.ts` grants `vault_search` because the Tier-1 instruction is **owner**-authored; a plugin instruction is third-party-authored, and the authorship difference is the whole threat model). The containment is double: contextual (what the LLM can see and do) and *causal* (what its output can affect) — output renders cards, or becomes a logged move body validated like any other input (§10.3); it never writes state during a transition.
2. **Approval cards are system-generated.** When a manifest action pauses at approval (`approval_reconciliation` path, exactly like service answers), the card text is composed by Dina from the declared action; any plugin-authored string appears visibly quoted ("The plugin says: '…'"). A plugin cannot social-engineer through the owner's own consent surface.

And the interpreter itself, per §2's honesty clause: install-time caps (§5, rule 4), per-move op budget (≤ 32), per-session state quota (≤ 64 KB), move-rate limits, `min_interpreter` refusal of unknown constructs, and a fuzz-corpus CI gate over the machine engine + validators. The interpreter ships as a pure package (`@dina/plugin-interpreter`), no I/O, so the fuzz target is the real code.

### 10.5 Vault-blind verification

For personal-fact play ("guess my favorite color"), the plugin never reads the vault. It submits `(guess, fact_ref)`; trusted code compares **inside the vault boundary**; the plugin and the peer receive one boolean. Three constraints make enumeration uneconomical rather than merely priced:

- **`fact_ref` is never plugin-authored.** Refs come from a small first-party fact namespace (favorites, dates, preferences), and the *owner selects* which facts are playable on the accept card ("This game may check guesses against: favorites, birthday"). A manifest cannot point into the vault; it can only request categories the owner then narrows.
- **Budgets are layered across sessions.** `verify_budget` caps one session; per-`(peer, plugin)` rolling counters with cooldowns cap the campaign, so a peer who churns sessions to reset the budget hits the historical counter instead.
- **Every check is visible.** Rate-limited, logged to the decision log, and surfaced as owner-visible counters ("Sancho's Dina has checked 11 guesses this month").

This primitive is quietly the most UTOPAI piece of the design: it makes trivia-about-each-other playable between two humans' Dinas without a single fact leaving either vault. Games here are human-to-human glue, which is the Anti-Her law expressed as a feature.

## 11. Data boundaries

**Interpreted plugins see nothing personal, ever.** Inputs are: move params, session state, plugin-vault contents, ops results. Owner data enters only as vault-blind booleans (§10.5) or text the owner explicitly types into a move. There is no push-context, no vault_search, no exceptions.

**Runner plugins are push-only.** No pull path at all: no `/v1/vault/query`, no `/api/v1/ask`, no sessions with Core. Context reaches an instance only inside task payloads, assembled per invocation:

1. Scope = intersection of (manifest `data_scope` ceiling, consent selections, persona tiers). Sensitive personas card each invocation; **locked personas are never in scope**, stricter than agents (whose approved grants can reach locked vaults, `packages/core/src/agent/access.ts`). Rationale: an agent is the owner's hands with per-request human approval; a plugin is ambient automation, and ambient automation never touches the locked ring.
2. Egress consent is **capability-scoped, and the capability's scope is authoritative**: payload assembly for capability X intersects against X's own consented `data_scope`, stored per `(install_id, capability, categories)` — the same per-capability record the scope hash covers (§8.1). A two-capability instance never receives the union of both scopes; each invocation gets only its own capability's slice. The instance DID additionally gets sharing-policy rows like any contact (default-deny `'none'`, `gatekeeper/sharing.ts:45,154`) as the coarse outer backstop — the union bound — so the existing `checkEgress` path stays load-bearing (point 3 explains why its input contract holds). Inner capability gate authoritative, outer DID gate structural.
3. **Context is a flat projection, then scrubbed.** `checkEgress` scrubs `text`/`body` strings (`gatekeeper/egress.ts:43`); it does not deep-scrub arbitrary JSON, and no gate should pretend to — every miss in a nested structure is a leak. So plugin context is built by projection through **Dina-owned templates**: the manifest declares only categories and limits (`data_scope`); which fields exist per category and action class (kind, text, date-class scalars) is first-party and versioned, like the ops library — a manifest cannot request the fields it wants to exfiltrate. Every string field passes the scrub before enqueue; raw vault rows and metadata objects never enter a payload, structurally. `checkEgress` stays load-bearing because its input contract is met by construction, not by claiming it handles shapes it doesn't.
4. `max_context_items` caps volume; payload hash + categories go to the audit log (metadata only, never content).
5. **Params are egress too.** They are user-derived free text ("find a chair because my back pain is worse" carries health content into a shopping capability), so they get the same treatment as context: scrubbed, and category-classified against the capability's consented scope. Content outside that scope — or anything sensitive/regulated — means the invocation is **never silent**, whatever the floor says: it escalates to a card showing the exact params, and uncertainty fails toward the card. The owner seeing the literal outbound text is the final gate.

**Plugin state lives in a per-plugin vault derived from the install: `plugin:<install_id>`.** Its own HKDF-derived DEK (the per-persona derivation pattern), its own file, a storage quota, TTL sweeping for session rows. A manifest cannot name any other vault because there is no field for it: the vault name is *derived from the local install id*, which makes cross-plugin reach structurally impossible rather than policy-forbidden, keeps two publishers' same-named plugins apart, and gives a reinstall fresh state by construction. Structure beats policy; that is the Absolute Loyalty pattern (enforced by math, not by review). Two scope invariants complete the picture: plugin vaults are **never in owner-facing retrieval scope**, active or not — Ask, enrichment, search, and services never enumerate them, because they are plugin runtime state, not owner knowledge; and a non-active install's vault stays unmounted entirely, its DEK never derived while the install is pending, paused, or restored-awaiting-re-consent.

Results returning into context are the mirror risk (injection). Three layers: pinned-schema validation; CardSpec untrusted rendering (unknown blocks dropped, badges stripped, no URLs); and the structural guarantee that any *action* derived from a result re-enters the deterministic gatekeeper. Injected text can steer prose; it cannot skip a card. `intent_phrases` (the classifier-prompt surface) are capped, charset-restricted at ingest, and can at worst misroute into the same gates.

## 12. Publishing a plugin

```
1  npx create-dina-plugin            scaffold: manifest.json (+ handler stub if runner mode)
2  dina-plugin sim                   interpreted mode: local two-node simulator runs the
                                     state machine + ops against scripted peers, no device
   dina-plugin dev                   runner mode: pair to YOUR OWN Dina (dina1: setup code)
                                     and iterate against real cards. Debug builds only:
                                     unsigned local manifests never install in production
3  dina-plugin validate              schema lint + caps check + floor-table dry run:
                                     "book_table is action_class=booking → every call needs
                                     approval until standing-approved. Expected?"
4  publisher identity                any PDS account (did:plc). Verify a handle. Optional
                                     but ranked: PeerLens verification record
5  dina-plugin publish               putRecord com.dinakernel.plugin.manifest rkey=<id>
                                     → Jetstream → AppView ingest-validates (§5.3) →
                                     marketplace-searchable. The record CID is the release;
                                     installers verify authorship by repo proof (§5 rule 5),
                                     never by index say-so
6  earn trust                        owner-opt-in install attestations, reviews via the
                                     existing PeerLens write flow, schema-violation and
                                     over-notify counts as owner-visible evidence.
                                     Unverified → Verified → Verified+Actioned
7  ship an update                    new putRecord, new CID. Installed Dinas see the diff;
                                     §14 governs application
8  emergency                         publish plugin.advisory {plugin_id, version_range,
                                     affected_cids[], severity, note} → AppView flags →
                                     installed Dinas raise a Fiduciary-class notice with
                                     one-tap disable
```

Dina distributes and verifies the **contract**, never the binary. For interpreted plugins the contract is the whole plugin, so distribution is complete and trustless. For runner plugins the code travels out of band (npm/pip/docker/vendor-hosted, declared in `runtime`); its behavior on its own servers is outside the TCB either way, so pretending to vet it would be theater. PeerLens carries that weight, which is the Verified Truth law doing its job.

## 13. Distribution and trust: the marketplace is PeerLens

- **Search/browse**: xRPC pair `com.dinakernel.plugin.search` / `plugin.getByUri`, clones of the service pair (`appview/src/api/xrpc/service-search.ts`), same composite ranking, same `didProfiles.overallTrustScore` join. Trust ranks; ad spend cannot.
- **Ratings**: plugins are PeerLens subjects, but the *subject identity* splits by record purpose — "all 19 types apply unmodified" was too broad. Product reputation (reviews, vouches, endorsements) attaches to the **versionless plugin** `(publisherDid, plugin_id)` / the manifest AT-URI, so a good review survives a benign update. Version-specific safety signals (security advisories, schema-violation reports, version-pinned failures) attach to the **concrete `manifest_cid`**, so "1.3.0 leaks data" flags exactly that build and clears when the owner moves off it. The split matters: without it, a single bad version tanks a plugin's lifetime reputation, or an advisory against one build silently taints every future one.
- **Rings gate silence, not visibility**: anyone can be found; the ring changes §8's clamp (Unverified runs nothing silently). Discovery stays open; silent automation is earned.
- **Dead-internet filter**: review-farming a plugin is the same attack as review-farming a chair, with the same defenses.

## 14. Install, lifecycle, and the owner's exits

**Install, interpreted**: marketplace/invite → fetch by reference → authenticity check (repo proof, §5 rule 5) → **consent card** (§15) → install row minted (`install_id`, identity `(publisherDid, plugin_id)`, `current_cid`, scope hash) + plugin vault provisioned. No pairing leg at all.

**Install, runner (self-host)**: detail → *Install* mints a `pending` install row with an expiry → Dina shows the setup code → `dina-plugin serve --setup-code dina1:…` → pairing (role `plugin` fixed at initiate) → consent → **activation, the single atomic commit point**: the device attaches to the install, per-capability egress scopes + sharing-policy backstop rows + lane registration land, status flips to active. Everything before activation is reversible: a cancelled consent auto-revokes any device paired during the ceremony, and the abandoned-install sweeper expires stale pendings **and revokes their devices too** — the dangerous case is a pairing that completed but whose consent was never confirmed, leaving a paired-but-not-activated device; the sweeper must `revokeDeviceDurable` that device, not just delete the pending row, or a live plugin device outlives the abandoned install. No orphan plugin devices survive, whether the install was cancelled or simply abandoned. Hosted path: the handshake must *bind* the instance to the plugin AND to this owner's install, not merely name a key. At install start the owner's Dina mints a single-use `install_nonce` and passes it through the handshake; the publisher signs an **instance certificate** over `(instance_pubkey, plugin_id, manifest CID, owner_did, install_nonce, expiry)`; the instance proves possession of the key through the pairing challenge; Dina completes pairing only if all six fields verify and the certificate's signer equals the installed manifest's repo DID. Without the owner/nonce binding, a certificate minted for tenant A could complete a pairing with owner B and silently route B's payloads to what the vendor considers A's account. A deep link that merely carries a pubkey proves nothing and pairs nothing. Self-host keeps its human binding: the owner ran the process and typed the code, which remains the only secret.

**Configure**: `config_schema` renders the form; values stored via the per-rkey config pattern (`service_config_repository.ts`), hot-reloaded through a `config_changed`-style event (`config_event_channel.ts`).

**Update**: a new CID on the same install row, governed by two separate boundaries. The approved-scope hash (§8.1) decides **grant survival**: unchanged hash → standing approvals survive untouched; changed hash → a re-consent card shows only the diff, the old pin stays live, and no grant matches the new scope until the owner approves. Grant continuity is structural, not remembered. **Application** of the new CID is a separate policy, because the scope hash guards consent, not behavioral trust — a same-scope interpreted update can still rewrite how a game behaves. The `behavior_hash` (over the machine wiring §8.1 keeps out of consent) makes functional changes visible: unchanged behavior + unchanged scope → applies silently on next instance restart (runner) or next new session (interpreted; in-flight sessions always finish on their pinned CID); changed behavior hash → application follows the owner's auto-update preference with a trust-ring default (Verified+Actioned auto-applies; below that, a low-key Activity prompt), and every application lands in the Activity digest with version and what changed. A third boundary handles cosmetics: a changed **`presentation_hash`** (display name, description, instructions — §8.1) never blocks a functional update and never gates grants, but a before/after entry **always** appears in Activity when it lands, so a "silent" update is never silent about a rename or an instruction rewrite. "Silent application" means silent to the *machinery*, never invisible in the log. **Trust ring is not sufficient on its own, though:** a behavior change to any capability whose `action_class` is `booking`, `write`, or `agentic`, or whose `privacy_class` is `sensitive`/`regulated`, **always requires explicit approval** — even from a Verified+Actioned publisher. Auto-apply is reserved for behavior changes on read/quote, public/personal capabilities, where a silent rules tweak cannot spend money, mutate the world, or touch sensitive data. High-consequence capabilities never move behavior silently, whatever the ring. Runner mode carries the honest asterisk: its code lives out of band, so a vendor can change server behavior with no manifest update at all — update policy governs the contract there; PeerLens governs the behavior.

**Pause**: lane stops accepting / invites stop; pairing, config, vault survive.

**Uninstall / revoke**: interpreted → registry removal + plugin-vault deletion + session termination + grant cascade. Runner → `revokeDeviceDurable` (durable-first, cascades grants, idempotent, audits `device_revoked`, `registry.ts:262-300`) + the same cleanup + optional ingest purge. One tap, immediate, no publisher cooperation. **Immediate means immediate, including in-flight** (this is the distinction from pause, §9.1, where running leases finish): revoke fails any running task for that instance at once, and a completion posted by a revoked instance is *rejected* by the claim-ownership guard — a revoked device's work is never accepted, because revoke is the emergency stop, not a graceful drain.

**Advisory**: Fiduciary-class notice + one-tap disable, the one plugin event allowed to interrupt, because silence would cause harm.

**Backup and restore** follow the archive's existing stance that active authority is never exported (service grants are already excluded as live authority, `packages/core/__tests__/export/archive_real.test.ts:83`). The archive **includes**: install records (identity, label, version, consent snapshot, config values), plugin vaults (encrypted like any vault), and decision logs (records of the past, not authority). It **excludes**: instance device pairings and `plugin_grants`. Restore brings every install back **paused**, config and vault intact, requiring re-pair (runner) and re-consent before anything runs. A restored archive on a second machine must not silently become a second live authority holding standing approvals. Restored vaults follow §11's invariant: unmounted, DEK underived, invisible to every owner-facing flow until the install is active again. Previously *ingested* items are different — they live in owner personas, were accepted under consent that was valid at the time, and remain owner data across restore; provenance tags and per-plugin purge stay the controls there.

Every decision lands in an owner-private `plugin_decisions` log (clone of `contact_service_decisions`, v16 pattern: owner-visible, never brain/LLM-readable, `authz.ts:85-92`), surfaced in Activity.

## 15. UI specification

Grounded in the real navigation (`apps/mobile/app/_layout.tsx`: tabs Chat / People / Network / Activity).

**Marketplace** (Network tab, sibling of PeerLens search): `peerlens/plugins/index.tsx` (browse/search: `plugin-search-input`, `plugin-results`, `plugin-empty`) and `peerlens/plugins/[pluginId].tsx` (detail: **What it can do** capability cards with *locally computed* risk badges, never the manifest's claims; **What it can see** in plain words: "Nothing from your vaults. Up to 5 guess-checks per game against categories you approve." / "Travel notes, up to 5 items per request. Never health, never finance."; publisher ring panel; reviews; `plugin-install-cta`).

**Consent** (`plugin-consent.tsx`): one card per capability with risk badge and toggle (`consent-cap-toggle-<capId>`); persona/category scope chips (runner); verify-budget statement (interpreted sessions); "Will always ask the first 3 times" copy on HIGH; owner-local routing toggle (§6); `consent-confirm` triggers activation, the single atomic commit point (§14); `consent-cancel` unwinds the pending install, auto-revoking any device paired during the ceremony.

**Sessions in chat**: the invite is an explicit-accept card in the Talk thread (`plugin-invite-accept-<sessionId>` / `-decline-`), the grant-prompt pattern (`InlineGrantRequestCard.tsx`) reused. An active session renders as a pinned thread artifact: state card (CardSpec) + move input scoped to the machine's legal moves, updating in place like `InlineServiceQueryCard`'s staged lifecycle. Turn/timeout chips come from the machine, not from plugin text.

**Third-party UI is card-spec only.** Minimal `grid` and `choices` blocks ship *with* the marketplace (P2): a marketplace whose flagship interpreted class is unplayable for third parties would be a self-inflicted dud, and `SafeCardRenderer` already switch-dispatches and drops unknown kinds forward-compatibly, so two new blocks are a small, safe addition. The full composable widget vocabulary (layout, nesting; `CARD_SPEC_V2_DESIGN.md` is the natural home) stays the later upgrade (P3).

**The Open-link action card is the one sanctioned exit.** Cart handover requires a link handoff, so "no external URLs in untrusted cards" cannot be the whole story. A first-party card renders it: the domain must be in the capability's consented `network_domains`, the full URL is displayed unmasked (no label masking), opening requires an explicit tap through a leaving-Dina interstitial, and it never renders as an inline content link. URL hygiene is hard rules, not judgment: HTTPS only, no custom schemes, no userinfo section, origin compared after punycode/IDN normalization, no label masking anywhere — domain consent alone is not enough, because redirects and deceptive URLs are exactly how allowlists get abused. **On redirects, the interstitial does not overpromise:** it shows the *exact URL Dina will hand to the browser* — the literal href, which is all Dina can honestly vouch for, since a server-side redirect after handoff is outside Dina's control. Optionally (a P3 refinement) a first-party resolver may pre-follow redirects with a short timeout and fail closed on timeout or an off-allowlist hop, showing the resolved destination; absent that, the honest claim is "this is the link, it may redirect," never a false "final destination." The plugin supplies the data; the chrome and the gate are Dina's. **First-party plugins ship real React screens** in `apps/mobile` (Battleship gets an actual board), which is honest because they are in-repo trusted code, while their protocol and state ride the plugin lane like anyone else's. First-party dogfooding of the lane is a feature: the lane's gaps get found by us first.

**Settings** (`settings.tsx` gains `settings-row-plugins` beside `settings-row-agents`): `plugins.tsx` list (icon, version, status dot from `lastSeen`, update badge) → `plugins/[id].tsx` detail (standing approvals with per-cap revoke, config form from `config_schema`, decision-log excerpt, storage-quota usage for the plugin vault, `plugin-pause`, `plugin-uninstall` with destructive confirm + purge option). A capability auto-paused by a stale advisory check (§20) shows an explicit **"paused — advisory check is stale"** banner with the last-checked timestamp and a retry-now button, so a plugin that stops working is never a silent mystery; the owner sees why and can re-check on demand. A second install of the same plugin prompts for an owner label at install time and shows it everywhere the plugin is named ("Acme Shop (Downtown)"); routing for a capability with multiple installs uses a per-capability default install, editable here (the `preferred_for` disambiguation pattern). **The fail-safe is stop-and-ask, never silent-choose:** if two installs match a capability and no default is set, routing halts and prompts the owner to pick (and offers to remember the choice) rather than guessing. Silently choosing an install is a data-routing decision the owner must own — the wrong pick could send a "downtown store" query to the "home store" install.

**Chat approvals**: `InlinePluginApprovalCard.tsx` modeled on `InlineApprovalCard.tsx`: plugin chip, capability, risk badge, params preview, Approve / Approve-24h / Always / Deny (`plugin-approve-<taskId>` etc.), dispatched from the `displayType` mapper in `app/index.tsx`. Plugin-authored strings visibly quoted per §10.4.

**Activity** (`notifications.tsx`): re-consent diffs, advisories, ingest digests, session invites you missed, `decision-row-*` entries. Approvals remain an action bucket inside Activity, not a new tab.

## 16. SDK and authoring

**Interpreted authoring** is manifest authoring: `create-dina-plugin --interpreted` scaffolds a manifest with a machine skeleton; `dina-plugin sim` runs a local two-node simulation (scripted peer, deterministic seeds) so a game is playable end-to-end before anything is published; `validate` runs the §5 rule-4 caps and the floor dry-run.

**Runner SDK** (`@dina/plugin-sdk`, TS-first; the Python daemon precedent shows ports are small: claim → execute → complete, `cli/src/dina_cli/agent_daemon.py:92-153`):

```ts
import { servePlugin } from '@dina/plugin-sdk'

servePlugin({
  manifest: './manifest.json',
  handlers: {
    'com.acme.flight_watch': async (params, ctx) => {
      // ctx.context  – scrubbed, minimized payload context (read-only)
      // ctx.config   – owner's config (hot-reloaded)
      // ctx.progress – task progress updates
      return { status: 'watching', flight: params.flight }  // schema-validated locally first
    },
  },
})
```

The SDK makes correct behavior easy; **Core enforces every security invariant**, and a malicious runner is assumed to skip the SDK entirely (the claim guard, DID-gated completion, and pinned-schema validation all live server-side, §9.1). What the SDK handles for honest developers: keypair + setup-code pairing, the single MsgBox WS (this DID only, `compression=None` handled), claim loop with heartbeats and lease clamps (`routes/workflow.ts:605-622`), local result validation *before* submission (fail on the developer's machine, not in the owner's chat), config hot-reload, pause handling. Multi-instance hosting via per-instance config dirs (`DINA_CONFIG_DIR` pattern, `cli/src/dina_cli/config.py:20-24`).

CLI verbs: `init`, `sim`, `dev`, `validate`, `serve`, `publish`, `advise`.

## 17. Threat model

### 17.1 The table

| Attack | Defense | Status |
|---|---|---|
| Manifest under-declares risk | Locally derived floors (action_class / ops-used); declarations only raise (§8) | net-new table, existing philosophy (`intent.ts:141`) |
| Hostile manifest as interpreter input (schema bombs, state explosion) | §5.4 install caps, per-move op budget, state quota, total-function transitions, `min_interpreter` refusal, fuzz CI gate on a pure interpreter package | net-new, named as security-critical (§2) |
| Session peer cheats (out-of-turn, illegal move, replay) | Both sides validate against the same pinned CID; envelope `from_did` binding; machine legality; commit/reveal for hidden info; append-only move log ⇒ deterministic replay | net-new gate in existing spine (`receive_pipeline.ts:313`) |
| Version skew / rules divergence mid-session | Session pins the CID at accept; mismatch fails the hash gate | free from content addressing |
| Honest divergence between peers (clock/LLM nondeterminism) | Nondeterminism enters only as logged move data; timeouts are asserted moves; LLM output is presentation or a move body (§10.3) | net-new discipline |
| Forged or spoofed manifest from a hostile index | Repo-proof verification (CAR/MST inclusion + commit signature vs the DID doc) before pinning; AppView is discovery-only (§5 rule 5) | net-new install step |
| Wrong runner paired via hosted deep link / cross-tenant confusion | Instance certificate bound to owner + install: (instance_pubkey, plugin_id, CID, owner_did, install_nonce, expiry), single-use nonce; signer must equal the installed manifest's repo DID (§14) | net-new binding |
| Credential capture via config forms | Secret-typed fields rejected from `config_schema`; credentials stay plugin-side; paste heuristics + "outside Dina's control" copy (§5 rule 6) | net-new validator + copy |
| Identity collision / update orphaning | `install_id` keying, `(publisherDid, plugin_id)` as identity, `current_cid` as version state, scope-hash grant keying (§3, §8.1) | net-new keying |
| Restored archive becomes a second live authority | Pairings + `plugin_grants` excluded from export; restore comes back paused pending re-pair/re-consent (§14) | policy, aligned with the existing archive stance |
| Cross-capability context bleed inside one instance | Capability-scoped egress is authoritative; DID-level sharing rows are only the outer union bound (§11) | net-new inner gate |
| Sensitive data smuggled through params ("…because my back pain is worse") | Params scrubbed + category-classified as egress; out-of-scope or sensitive content forces a card showing the exact params — never silent (§11 point 5) | net-new gate |
| Prompt injection via `instructions` | Isolated LLM context: no vaults, no tools, schema-validated JSON out (§10.4) | net-new rule, stricter than Tier 1 |
| Social engineering via the approval card | System-generated card text; plugin strings visibly quoted (§10.4) | net-new rule |
| Vault probing via verify spam | Owner-selected first-party fact refs; per-session budgets + per-(peer, plugin) rolling counters and cooldowns; rate limits; visible counters (§10.5) | net-new budgets, existing decision-log surface |
| Plugin claims work not addressed to it | Server-forced exact-match lane from the registry; DID-gated completion | hardening of `repository.ts:582` + existing `routes/workflow.ts:388` |
| Prompt injection via results / `intent_phrases` | Pinned-schema validation; CardSpec untrusted render; actions re-enter the gatekeeper; phrase caps + charset | exists (`card-spec.ts:281`) + net-new sanitizer |
| Data exfiltration via broad context | Interpreted: no personal data path exists. Runner: push-only, capability-scoped egress (inner gate) + per-DID sharing tiers (outer bound), egress scrub, item caps, audit | exists (`egress.ts`, `sharing.ts:154`), new call site + inner gate |
| Cross-plugin data reach | Vault name derived from plugin id; no manifest field can name another vault | structural (§11) |
| Instance key theft | Signed requests + nonce cache + 5-min window; durable revoke with cascade | exists (`msgbox_handlers.ts`, `registry.ts:262`) |
| Publisher key compromise / rug pull | CID pinning + §14 update policy (behavior changes on booking/write/agentic/sensitive caps always need approval, any ring); advisory → Fiduciary notice + one-tap disable; HIGH caps auto-pause on stale advisory checks (§20) | net-new lexicon + policy, existing notify path |
| Malicious update via the provider lane | Provider tasks carry the identical pinned envelope + five claim-time checks as tool tasks (§9.2) — no soft path | net-new, closes the bypass |
| Vault poisoning via ingest | Schema-validated, size/quota-capped, append-only with provenance (no owner-item overwrite), purge-by-provenance, external-assertion-never-truth in enrichment (§9.3) | net-new write contract |
| Notification payload as injection / phishing | Bodies schema-capped, rendered as plugin-authored, never used as system instructions, no embedded action links except first-party cards (§9.4) | net-new payload contract |
| Open-link redirect deception | Interstitial shows the exact href Dina will open (no false "final destination"); optional P3 fail-closed redirect resolver (§15) | net-new honesty rule |
| Silent wrong-install routing (multi-install) | Stop-and-ask when >1 install matches and no default set — never silent-choose (§15) | net-new fail-safe |
| Deceptive rename / instruction drift via "silent" update | `presentation_hash` (name + description + instructions): never gates grants/application, but any change always surfaces in Activity before/after — silent-to-machinery, never invisible (§8.1, §14) | net-new digest |
| Orphan plugin device from abandoned install | Sweeper revokes paired-but-not-activated devices, not just the pending row (§14) | net-new sweeper rule |
| Config value leakage | Config encrypted at rest, never owner-retrieval content, disclosed in export/restore, sent only to that plugin's runner (§5 rule 6) | net-new classification |
| Typosquatting / impersonation | Publisher DID identity, handle verification, ring badges, trust-ranked search | exists (PeerLens) |
| Notification spam / priority inflation | Classifier clamp (min of hint and classification), per-plugin rate limits, over-claim surfacing | exists (classifier) + new clamp rule |
| Escalation via pairing | Role fixed at initiate; `/complete` role ignored | exists (`pair.ts:119-127`) |
| Money movement through Dina | `payment` → BLOCKED at every ring; `BRAIN_DENIED` untouched; cart handover unchanged | exists (`intent.ts:85-108`) |

**Honesty clause**: Dina cannot control what runner-mode code does on its own infrastructure with data it legitimately received. The guarantees are: minimal (or zero) data in, gated actions out, injected text cannot become ungated action, misbehavior attributable (audit + decision log) and punishable (revoke + PeerLens). `network_domains` is consent-screen transparency, not a firewall. The same honesty applies to credentials: §5's rule 6 keeps Dina from being the intake, but a credential the owner hands to plugin code on the plugin's own surface is beyond Dina's reach, and the UI says so rather than implying a guarantee that doesn't exist. Interpreted mode removes this residual entirely, which is why the design pushes everything expressible as data into interpreted mode.

### 17.2 Four Laws audit

- **Silence First**: plugins cannot push. Notify goes through the classifier clamp; session moves are Solicited-class (the owner accepted the session); the only interrupt is the advisory, where silence would cause harm.
- **Verified Truth**: publishers are trust-ranked, results carry provenance, marketplace ranking is the PeerLens composite. No paid placement surface exists to buy.
- **Absolute Loyalty**: keys and DEKs never leave; interpreted plugins see no personal data; runner egress is minimized and scrubbed; cross-plugin reach is structurally impossible.
- **Never Replace a Human**: companionship capabilities banned at ingest and install; sessions exist only with owner-selected known contacts, explicitly accepted. A DID proves a key, not humanity — what Dina actually guarantees is that *she* never plays the companion and that the far end is a contact the owner chose; whether that contact is human is the dead-internet problem, priced by PeerLens, not proven by protocol. Vault-blind trivia stays social glue between people, with Dina as referee, never as the companion.

## 18. Reuse vs net-new

| Piece | Verdict |
|---|---|
| Pairing, setup codes, device registry, durable revoke | reuse; +1 role value |
| Signed RPC over MsgBox, nonce cache, one WS per DID | reuse, unchanged |
| WorkflowTask, claim/complete, sweepers, Response Bridge | reuse; + exact-match claim guard |
| `capability_runtime` | generalize → the interpreter's LLM step (isolated variant) |
| offer/grant machinery | reuse → session invites |
| `receive_pipeline` | reuse; +1 gate (installed/CID/grant/schema) |
| Gatekeeper | extend: `evaluatePluginIntent` + floors (action_class and ops-derived) |
| Egress + sharing tiers + PII scrub | reuse; instances become sharing-policy subjects |
| Catalog types (`action_class`, `privacy_class`, custom-id lane) | reuse verbatim; canonical catalog and its 3-way sync untouched |
| Content addressing | free (ATProto record CIDs); integrity pin only — authenticity needs the repo proof (§5 rule 5), identity needs the install key (§3) |
| `service_grants` / `contact_service_decisions` shapes | clone → `plugin_grants` / `plugin_decisions` |
| Per-rkey config + hot reload | reuse for plugin config |
| Per-persona vault derivation (HKDF DEKs) | reuse → `plugin:<install_id>` vaults + quota + TTL sweep |
| AppView ingest guardrails, xRPC ranking, PeerLens machinery | reuse; +1 handler, +2 xRPC clones, +2 lexicons |
| Intent-classifier injection | reuse mechanism; runtime-sourced second list, opt-in |
| CardSpec + SafeCardRenderer untrusted mode | reuse; widget vocabulary later |
| **Net-new builds** | the interpreter package (machine engine + ops library + budgets + fuzz gate), the session wire family, the dynamic registry, consent/marketplace/settings/session UI, `InlinePluginApprovalCard`, the SDK + CLI |

## 19. Non-goals (v1)

- **No pull path for runner plugins**; workloads needing interactive data access should pair as agents, under agent rules.
- **No plugin-to-plugin invocation or chaining.** Every invocation is owner-rooted; every session is human-peer-rooted.
- **No mixed-mode manifests** (one mode per plugin) until a concrete need appears.
- **No third-party React / custom rendering.** Card-spec only; widget vocabulary is the upgrade path.
- **No new ops by manifest request.** The ops library grows by protocol revision only.
- **No payment rails, no monetization**; `payment` stays BLOCKED, billing is vendor-side.
- **No locked-persona access**, even with approval.
- **No automatic telemetry** to publishers or infrastructure; outcome signals are owner-opt-in attestations.
- **No in-process third-party code, ever.** This is a law, not a limitation.

## 20. Phased build plan

**P0 — the substrate + runner mode (prove the box).** The `plugin.manifest` + `plugin.advisory` lexicons and their validators — install-by-AT-URI requires the record type on day one, and advisories protect P0 installs via direct publisher-repo polling until AppView flags them at scale (P2) — with defined semantics, not a vague "we'll poll": each install's publisher repo is checked for `plugin.advisory` records on a fixed cadence (proposed daily + on app foreground), offline simply means the last-known advisory state stands, and **HIGH-consequence capabilities (booking/write/agentic, sensitive/regulated) auto-pause once their advisory check has been stale beyond a threshold** (proposed 7 days), failing safe rather than running blind; read/quote capabilities keep running on stale checks. Advisory state is persisted so a fresh boot doesn't reset it; dynamic registry (`install_id` keying, `(publisherDid, plugin_id)` identity, `current_cid`, the frozen §8.1 scope-hash spec) + repo-proof verification with **install-by-AT-URI** — no marketplace, because discovery comes later but authenticity does not; unsigned local manifests exist only via `dina-plugin dev` in debug builds and cannot install in production; `plugin` role/callerType with the §9.0 P0 matrix; exact-match claim guard; `plugin_grants` + `plugin_decisions`; `evaluatePluginIntent` + floors; capability-scoped egress + sharing backstop; tool kind end-to-end with `InlinePluginApprovalCard`; SDK `serve`/`dev`/`validate`. Exit: a hand-installed weather plugin answers in chat; a booking plugin cannot act without a card; a hostile result cannot escape the pinned schema; a plugin cannot claim an untagged task.

**P1 — interpreted mode + the session (prove the new primitive, first-party).** `@dina/plugin-interpreter` (machine engine, ops library, budgets, fuzz gate); `plugin.session.*` family + the receive_pipeline gate; per-plugin vaults; session invite/accept cards + session thread UI; vault-blind verify with budgets; `dina-plugin sim`. Dogfood: **Battleship ships first-party** (in-repo manifest, real React board, protocol on the lane) between two real Dinas over the real relay. No marketplace needed for any of this, which is exactly why it comes before distribution.

**P2 — distribution (open the doors).** AppView manifest ingestion + advisory flagging + xRPC search; marketplace, consent, Settings screens; publish/update/re-consent/advisory lifecycle; PeerLens subject wiring; provider kind ("Backed by" picker); `dina-plugin publish`; minimal `grid` + `choices` card blocks so third-party session UI is viable at marketplace launch (§15).

**P3 — the quiet kinds + scale.** ingest (dedicated `/v1/ingest`: provenance + quotas + digests + purge); notify (clamp + rate limits + over-claim surfacing); hosted-vendor handshake with instance certificates; the full composable widget vocabulary (layout, nesting) for third-party session UI; custom→canonical promotion for capabilities many publishers converge on (the existing two-stage path).

Each phase ends with the MRS treatment: Maestro flows for every card and consent surface, a headless harness driving a real plugin (and a real session peer) over the real relay, and the log-hygiene gate confirming no payload content ever reaches stdout.

## 21. Open decisions

1. **First-N constant for HIGH** (proposed 3): fixed, or per-capability in the floor table?
2. **Interpreter budget numbers** (§5.4, §10.4): the caps need empirical tuning against a real Battleship manifest before freezing.
3. **Session concurrency**: per-plugin and per-peer caps on simultaneous sessions (spam surface); proposed 4 per plugin, 16 total.
4. **`verify_budget` default and ceiling** (proposed default 0, ceiling 8 per session).
5. **Multi-install UI exposure in v1**: the schema permits multiple installs of one plugin (§3); does v1 UI expose it, or defer the labeling/default-install surfaces while keeping the schema ready?
6. **Update auto-apply window** for same-scope updates: immediate on restart/new-session vs a weekly "plugins updated" digest.
7. **Marketplace curation floor**: refuse to index Unverified publishers' `write`/`booking` capabilities, or index-with-clamp (leaning index-with-clamp: visibility is not authorization, per the taxonomy).
8. **Web thin-client parity**: revoke parity at minimum; consent likely needs the phone for the pairing leg (runner) but could be web-complete for interpreted installs.
9. **Presentation-hash granularity**: does an instruction rewrite deserve a stronger surface than a display-name tweak (both are in `presentation_hash`, §8.1)? A rename is a glance; an instruction rewrite changes every generated card. Possibly split into `label_hash` vs `instruction_hash` so the latter can prompt rather than just log — TBD against real abuse patterns. (Resolved this round: in-flight revoke fails immediately and rejects revoked-instance completions, §14.)
