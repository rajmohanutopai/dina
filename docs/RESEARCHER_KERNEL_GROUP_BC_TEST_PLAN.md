# Researcher Kernel — Groups B + C (+ D packs) test plan

Scope: everything built for `docs/RESEARCHER_KERNEL_ARCHITECTURE.md` §5.B (the money line) and §5.C (the plugin substrate) in Iters 8–16 of `implementation-notes.html`, extended (L10–L12) for Iters 21–22 (the shared repo-proof chain on the phone, the §5.D country packs) and L13 for Iter 24 (the dispatch producer and the first khata → rail hook). Group A had its own plan (`RESEARCHER_KERNEL_GROUP_A_TEST_PLAN.md`) and audit (Iter 7). This plan drives a review workflow: each dimension names what must be true, where the code is, and what a finding looks like. A finding needs a file, a line, a concrete failure, and evidence.

The bar for every dimension: find (1) the absolutely correct way and whether the code took it, (2) code smells, poor architecture, and workarounds, (3) test-case problems: tests that encode the implementation instead of the requirement, weakened assertions, skipped cases, and missing coverage.

## Ground truth to hold the code against

- `CLAUDE.md`: Core never calls external APIs; plugins are signed contracts, never in-process code; a runner is a paired device with its own Ed25519 key on a private lane; agents and plugins are gated regardless of transport.
- `docs/PLUGIN_ARCHITECTURE.md` §15.3: for a runner plugin, verification creates a short-lived pending install, Dina shows the setup code, the runner pairs (role `plugin` fixed at initiate), Core binds the exact device that used the code to the exact pending install, and only then may consent activate. A device DID supplied only at the final button is not a valid pairing. Cancel and expiry converge on one cleanup path: pending row removed, paired device revoked.
- `docs/RESEARCHER_KERNEL_ARCHITECTURE.md` §5.B1: the money engine (khata delivery/payment documents, khata fold, revenue share) belongs to the Commerce Pack; the money-free quote-decline slice stays in the kernel with its own store; money-only capabilities return a typed `unavailable` when the pack is absent, paused, or revoked; the decline round trip must work with no money plugin.
- Memory rules: contract tests over scenario tests; never `tsc --build` a package directly; one package per jest run.

## Dimension L1 — the decline slice (B1 Cuts 1, 1b, 2)

Files: `packages/core/src/commerce/decline_documents.ts`, `buyer_response.ts`, `tender.ts`, `trade_ledger.ts` (what remains), `trade_ledger_service.ts` (no decline code left), `storage/schemas.ts` (migration v42 `commerce_decline_documents`), routes `commerce.ts` `/v1/commerce/trade/quote-decline`. Tests: `__tests__/commerce/decline_documents.test.ts`, `quote_decline_lane.test.ts`, `tender.test.ts`, `commerce_trade.test.ts`.

Must be true:
- Both legs (buyer `verifyInboundQuoteDecline`, supplier `authorQuoteDecline`) live in the kernel store and never touch the money store.
- Row-level rehydrate cross-checks the stored `recordDigest`; a tampered row is rejected.
- The `direction` field is written honestly for both legs.
- Migration v42 copies existing declines and an upgraded node still rehydrates them; the old rows left in `commerce_trade_documents` are unread.
- No caller still reaches declines through the money store.

## Dimension L2 — the money line (B1 Cut 3)

Files: `packages/core/src/commerce/runtime.ts` (`CommerceMoneyAccess`, `resolveCommerceMoney`, `money()`), `trade_ingress.ts`, `trade_readers.ts` (`tradeOrientations`), `trade_inbox.ts`, `tally_export.ts`, `server/routes/commerce.ts` (`moneyOrRefusal`, every khata and revenue-share route). Tests: `runtime.test.ts` (money line describe), `commerce_trade.test.ts` (closed-pack describe), `trade_transport.test.ts`, `trade_inbox.test.ts`, `tally_export.test.ts`.

Must be true:
- `money()` is resolved per call from the plugin registry, with no cache to invalidate; an uninstall, pause, or revoke closes the line on the next request.
- Only an `active` first-party pack (buyer or supplier id) opens the line; every closed state has a typed reason; a closed second pack does not shut an active one.
- Every reader of the money stores goes through `money()`; grep for any remaining direct field.
- Refusals are one shape (409 `commerce_pack_inactive` with reason and detail); the inbox still answers and marks `money_available`; the Tally export refuses whole.
- The D2D ingress SPOOLS a document that arrives while the line is closed (unverified, exactly as it arrived, bounded, insertion-ordered) and replays it through the verifiers before any newer document once the line opens; the inbox and every money route drain the spool too. Nothing re-sends a receipt or an ack, so dropping would lose the counterparty's answer for good.
- The money-free path never asks `money()`: tender, quote-decline, orders, catalogs, drafts. The `tender` and `quote_decline_lane` suites run with the line closed.

Findings to look for: a route that checks the money line after doing side effects; a code path where an `unavailable` becomes a throw or a 500; a reader that resolves `money()` twice in one request and could see two states; a test that only asserts the happy path.

## Dimension L3 — money-free independence (B2)

Files: `__tests__/commerce/money_free_research_deps.test.ts`, the research modules it lists, `commerce/index.ts` exports. Must be true: the guard covers every module the research loop and the tender path import; the guard cannot pass by accident (a renamed module must fail loudly); nothing in Groups B and C re-coupled a research module to `trade_ledger`, `revshare_ledger`, `trade_ledger_service`, or the money wire.

## Dimension L4 — the repo-proof verifier (C1, server)

Files: `packages/net-node/src/repo_proof_verifier.ts`, `packages/protocol/src/plugins/verifier.ts`, `apps/home-node-lite/core-server/src/storage/init.ts` (wiring), `packages/net-node/jest.esm.config.js`, tests `packages/net-node/__tests__/repo_proof_verifier.test.ts`.

Must be true:
- Core stays pure: only the injected callback fetches; the verifier lives in the net adapter.
- The proof chain is complete: DID resolution to key and PDS, CAR read with root, commit signature against the DID key, MST inclusion of the record, `rkey = f(cid)`; each failure maps to the right `RepoProofFailureCode` with correct `transient`.
- The ESM loads are lazy (first verify) and memoized; construction at boot never runs `import()`; the CJS jest boot tests of core-server pass without `--experimental-vm-modules`.
- The `new Function` body is a fixed string (no interpolation).
- Tests mint real signed repos through the library write path; negatives are real (wrong key, wrong rkey, malformed CAR, 404, transport error).

## Dimension L5 — general install routes (C2, server)

Files: `packages/core/src/server/routes/plugin_install.ts`, `plugins/install_service.ts` (`beginInstall`, `confirmConsent`, `declineConsent`, `uninstall`, `startAbandonedInstallSweeper`), `devices/registry.ts` (`revokePluginDeviceForTeardown`), `core_server.ts`. Tests: `__tests__/server/routes/plugin_install.test.ts`, `__tests__/plugins/install_service.test.ts` (sweeper describe).

Must be true:
- Owner-only on every route; the trust anchor is fixed to `repo_proof` and never taken from the request.
- `begin` fails closed with no verifier (503, never trust-on-first-use); a verifier rejection is a permanent 409.
- `confirm` for a runner requires the pre-bound device and a real, unrevoked, role `plugin` registry entry (fail-closed verifier); an interpreted install refuses any device DID.
- Decline and uninstall pass a durable device revoker by default; `removed: false` is a 409 `teardown_incomplete`, not a 200; open commerce obligations are a 409 `obligations_open`, not a 500. A failed device revoke on an ACTIVE install tombstones the row (`revoked`, expiry stamped) so the sweep can finish it; the setup-code route replaces the caller-named `bind_device`.
- The not-found-counts-as-durable rule applies only to a device the registry never knew; a known device whose revoke failed keeps the row as the retry anchor.
- The sweeper runs once at start and on its cadence, skips overlapping ticks, never throws, and does not hold the event loop.

## Dimension L6 — the phone's ceremony (C2, mobile service)

Files: `apps/mobile/src/services/plugin_install.ts`, `packages/core/src/pairing/ceremony.ts` (`getPairingOutcome`), `packages/core/devices.ts` exports, `apps/mobile/src/services/boot_capabilities.ts` (verifier and sweeper wiring). Tests: `apps/mobile/__tests__/services/plugin_install.test.ts`, `packages/core/__tests__/pairing/ceremony.test.ts`.

Must be true (§15.3):
- The phone never mints a runner key. `issueRunnerSetupCode` fixes role `plugin` and scope `runner` at initiate; the `dina1:` string carries the relay, the node DID, and the code.
- Core binds the exact device that consumed the code inside `completePairing` (the code carries the install id); a code whose install is gone, expired, active, or already bound to another runner refuses to pair and registers nothing; `checkRunnerPairing` only READS the install row; confirm never names a device; an expired or unknown code is reported so the screen issues a new one.
- `getPairingOutcome` survives the eager purge of used codes, forgets on its own TTL, and clears with pairing state.
- Decline and uninstall revoke the paired device durably (device repository wired) and remove the row; a refused uninstall names why (`unknown_install`, `obligations_open`, `teardown_incomplete`).
- The first-party buyer pack's throwaway key remains a first-party quirk and is not reachable from the marketplace path.

Findings to look for: the outcome map growing without bound; a race between the poll and decline; a test that fakes the pairing instead of running `completePairing`.

## Dimension L7 — the phone's screens (C2, mobile UI)

Files: `apps/mobile/src/components/PluginConsentCard.tsx`, `apps/mobile/app/plugins.tsx`, `apps/mobile/app/_layout.tsx` (route registered, hidden from the tab bar), `apps/mobile/app/settings.tsx` (row). Tests: `plugin_consent_card.test.tsx`, `plugins.render.test.tsx`.

Must be true:
- Install stays disabled until Core reports bound; the confirmed device is the bound one; interpreted installs skip pairing.
- Progress reads Waiting, then Identity bound; expiry offers a new code; a refused bind tells the owner to decline and start over.
- Cancel, Decline, a failed confirm, and leaving all tear the pending install down; nothing lingers with no card to act on it.
- The manage list does not repeat the install on the card; an older abandoned pending stays removable.
- Effects clean up on unmount (no interval leaks); the setup code is never logged.
- The tests mock the service module completely (every export the card imports) so a missing mock cannot pass as a real failure.

## Dimension L8 — teardown and abandoned installs, both hosts

Files: `apps/mobile/src/services/boot_capabilities.ts`, `apps/home-node-lite/core-server/src/storage/init.ts`, `packages/core/src/plugins/install_service.ts` (`sweepAbandonedInstalls`, `startAbandonedInstallSweeper`), `packages/core/src/server/routes/commerce.ts` (retire route now on the shared revoker).

Must be true: both boots start the sweeper with the durable revoker and restart-guard it; the retire route and the plugin routes share one definition of the revoker; a pending install whose device was paired but never consented is swept with its device revoked.

## Dimension L9 — cross-cutting

- Security: no path lets a caller name the trust anchor, the bound device, or the role; the pairing code is the only secret and is never logged; `revokePluginDeviceForTeardown` cannot be used to mark an unknown DID as revoked in a way that hides a real device.
- Architecture: no import cycle introduced (`runtime.ts` now imports the plugin registry and the reference manifests; the registry imports no commerce code); Core stays transport-free; the mobile service reaches Core only through the barrels or the documented subpath.
- Docs honesty: every claim in `implementation-notes.html` Iters 8–16 matches the code; the memo `COMMERCE_PLUGIN_DECISION_MEMO.md` banner still matches the money line.
- Test hygiene: no `import type` folded over a value import; no non-null assertions added; every new test runs in one package's jest config; the mobile screen "Cancel" test that failed once is either deterministic or explained.

## Dimension L10 — the shared repo-proof chain (C1, both hosts; Iter 21)

Files: `packages/home-node/src/repo_proof_chain.ts`, `repo_proof_selfcheck.ts`, `repo_proof_fixture.ts` (+ `scripts/mint_repo_proof_fixture.mjs`) + `packages/home-node/repo_proof_chain.ts` (subpath entry) + `packages/home-node/package.json` exports; `packages/net-node/src/repo_proof_verifier.ts` (lazy loaders + chain); `packages/net-expo/src/repo_proof_verifier.ts` (static imports), `packages/net-expo/package.json`, `jest.config.js`, `tsconfig.jest.json`; `apps/mobile/metro.config.js` (`SHIMS`, `resolveRequest`), `apps/mobile/src/shims/*.js`; `packages/crypto-expo/src/polyfills.ts` (`Buffer`); `apps/mobile/src/services/repo_proof_wiring.ts`, `boot_capabilities.ts`, `apps/mobile/jest.config.js` (mock map), `__mocks__/dina-net-expo-repo-proof.ts`. Tests: `packages/net-node/__tests__/repo_proof_verifier.test.ts` (+ `lazy_module.test.ts`), `packages/net-expo/__tests__/repo_proof_verifier.test.ts`, `apps/mobile/__tests__/services/boot_capabilities.test.ts`, `repo_proof_wiring.test.ts`, `apps/mobile/__tests__/polyfills_buffer.test.ts`.

Must be true:
- The chain is byte-for-byte the server's chain: DID → key + PDS through the library (`getKey`/`getPds`), fetch with AbortController deadline and `redirect:'error'`, body cap enforced WHILE streaming, CAR read with root, `repo.did === req.did`, `verifyCommitSig` against the DID key, MST inclusion, `rkey = f(cid)`; each failure maps to the right `RepoProofFailureCode` and `transient`.
- The server still loads the ESM libraries lazily (first verify) — no `import()` at construction; core-server CJS boot tests pass without `--experimental-vm-modules`.
- The subpath entry is a root-level file (like `ask-runtime.ts`) so a CJS consumer never imports the ESM barrel; `@dina/home-node` gained no new runtime dependency that Core would inherit.
- The Metro shims replace ONLY what the audited libraries need (`setTimeout`-based `timers/promises`, a `dns/promises` that fails closed — handle resolution must return a typed failure, never resolve a handle to a guessed DID; `@atproto/common` surface actually used), and nothing in the shims weakens a check the chain relies on.
- The `Buffer` polyfill is guarded (never overrides a real global) and lives in the module the app REALLY evaluates first (`apps/mobile/src/polyfills.ts`, imported by `app/_layout.tsx`) — not in a package the app never imports — on every platform (RN-web lacks Buffer too).
- The phone wires the verifier only after `selfCheckRepoProofVerifier()` runs the whole chain on the device over the shipped fixture repo (`packages/home-node/src/repo_proof_selfcheck.ts`, `repo_proof_fixture.ts`); a failed or throwing self-check leaves the door closed (`pluginInstallAvailable() === false`) and logs only the fault class or code.
- Boot wiring is fault-guarded: a throw from the verifier becomes a typed `did_resolution_failed`; the log carries only the error class name (no URL, no DID, no body); the verifier is set once and reset per test.
- The mobile jest mock stands in for the real module completely and fails closed (a call returns a typed refusal, never `ok:true`).
- Honesty: the notes say bundle-proven, not device-proven; nothing claims a live verify on Hermes.

Findings to look for: a shim that returns a fabricated success; a `dns/promises` stub that lets `@atproto/identity` resolve a handle to an attacker-chosen DID; a chain path where the body cap is checked after the whole body is read; the phone's static import pulling `pino` or `node:stream` into the bundle; a test that mocks the chain instead of running it.

## Dimension L11 — the country packs (D1 / D2 / D5; Iter 22)

Files: `packages/core/src/commerce/country_packs.ts`, `reference_install.ts` (`beginFirstPartyInstall`), `packages/core/src/index.ts` exports, `server/routes/plugin_install.ts` (`country_pack` route), `apps/mobile/src/services/plugin_install.ts` (`beginCountryPackInstall`), `apps/mobile/app/plugins.tsx` (COUNTRY PACKS section). Tests: `core/__tests__/commerce/country_packs.test.ts`, `reference_pack_install.test.ts` (four-manifest table), `server/routes/plugin_install.test.ts` (country_pack describe), mobile `services/plugin_install.test.ts` (country packs describe), `screens/plugins.render.test.tsx` (country packs describe).

Must be true:
- Every manifest passes the ingest-identical validator and installs through `beginInstallVerified` under `local_publisher_key` with the kernel reference key; no capability declares `payment`, `agentic`, or `booking`; status lookups are `read` + `regulated`; filings and outward messages are `write`; every capability declares `effects.idempotency: 'supported'`; every `kinds` value is in `NODE_SUPPORTED_FEATURES` (else `needs_newer_dina`).
- The reserved-namespace rule holds for the new ids at the repo-proof door (a stranger's verbatim copy is refused; a renamed copy installs).
- The money line does NOT open for an active country pack (`resolveCommerceMoney` filters on the two commerce ids), pinned by a test that activates a pack and asserts `unavailable`.
- Route: owner-only; `pack` validated (`'in'|'us'`); no manifest from the request; idempotent on an ACTIVE install (200 with the existing id); a pending install is NOT reused (each begin is a new consent — consistent with `begin` and `/v1/commerce/install/begin`); the same `BeginInstallResult` shape and `statusForBegin` mapping as `begin`.
- Phone: `beginCountryPackInstall` needs no verifier (works with `pluginInstallAvailable() === false`); `already_active` and `refused` are typed; a `refused` with no node identity is `transient: true`; the staged consent feeds the SAME `PluginConsentCard` (setup code → runner pairs → confirm on the bound device); Cancel / blur / failed confirm tear it down like any pending.
- Screen: the COUNTRY PACKS section renders from the manifests (no hand-typed copy that can drift); it hides while a consent is undecided; the module mock in the render test lists every export the screen imports.
- Docs honesty: the architecture doc, CLAUDE.md, PLUGIN_ARCHITECTURE status line, and Iter 22 all say the packs are installed contracts with nothing invoking them yet (the substrate's dispatch producer is unbuilt); nothing claims a settled payment or a sent reminder.

Findings to look for: a capability whose `params_schema` would let a runner return free text the owner sees as a message (the `subject_digest` binding must be required on every notice); a `write` rail whose schema omits the khata digest that binds the filing to a retained document; the route accepting a manifest or publisher from the body; `beginFirstPartyInstall` reachable with a non-first-party id; a test that asserts the implementation's ordering instead of the requirement.

## Dimension L12 — cross-cutting for Iters 21–22

- No import cycle: `commerce/country_packs.ts` imports only `@dina/protocol`; `reference_install.ts` imports no route code; `server/routes/plugin_install.ts` → `commerce/*` is the same direction `routes/commerce.ts` already takes.
- Barrel hygiene: every new symbol the phone imports from `@dina/core` is exported from `packages/core/src/index.ts`; nothing new reaches Core through a donor mapper in production code.
- Lint on touched files; no `import type` folded over a value import; no non-null assertions; the four-manifest table did not weaken any assertion in `reference_pack_install.test.ts`.

## Dimension L13 — the dispatch producer and the first khata → rail hook (Iter 24)

Files: `packages/core/src/plugins/invoke.ts`, `server/routes/plugin_invoke.ts`, `server/routes/workflow.ts` (`approveTask` / `cancelTask` plugin branches), `server/core_server.ts` (registration), `plugins/index.ts` (exports), `commerce/country_rails.ts`, `commerce/trade_ingress.ts` (the hook call), `commerce/country_packs.ts` (`data_scope`). Phone: `apps/mobile/src/hooks/useServiceInbox.ts` (listing, `toEntry`, deny path), `components/approval_inbox.tsx` (the card, `pluginEffectStatement`). Tests: `core/__tests__/plugins/invoke.test.ts`, `server/routes/plugin_invoke.test.ts`, `commerce/country_rails.test.ts`, mobile `hooks/useServiceInbox.test.ts`, `components/approval_inbox.test.tsx`.

Must be true (PLUGIN_ARCHITECTURE §8, §9.1, §11.5, §15.5):
- The consented capability comes from the pinned manifest AND the consent hash (`consentedCapability`), never from the caller; `kinds` must include `tool`; a paused, revoked, pending or unknown install is a typed refusal.
- The gate is `evaluatePluginIntent` × `assessParamsEgress` → `decideDispatch`, with STRICTEST defaults (custom / unverified / zero prior / no persona touch) unless a root injects resolvers; `payment` is blocked at every ring; a custom id never floors below MODERATE; `sensitive`/`regulated` card every time, grant or not.
- A card task is created `pending_approval` and NEVER `queued`; `authorization_kind: 'card'`; the claim SQL cannot select it; the owner's approve moves the SAME task to `queued`; deny cancels it; both record the decision (`invocation_approved` / `invocation_denied`) and the first-N counter reads that log.
- A silent task under a grant CHARGES the grant (`authorizeAndConsume`) and pins `grant_id` + `invocation_digest` (+ resource/value) so the claim guard's check 7/7b passes; a SAFE floor runs with NO grant and no provenance; a grant whose constraints refuse cards (never fails, never runs).
- `buildPluginEnvelope` failures (params outside the consented schema, oversized params, context outside `data_scope`) are typed `params_invalid` refusals and a reserved grant use is released; an idempotency conflict answers with the live task and releases the use.
- `plugin_grant` on approve: `window` ≤ 24 h; `standing` must be bounded (an expiry or a meaningful constraint) for any custom capability or HIGH class — every installable id is custom today, so every rail (the repository refuses unbounded); created BEFORE the approve CAS and revoked if the transition fails; a malformed block is a 400 with the task untouched; `grant_created` is logged; a `brain` caller cannot approve or cancel a plugin invocation (403), and a long or multi-line deny reason still lands as one bounded line.
- Identity fields (`idempotency_key`, `resource`, `value`) the envelope parser would quarantine at claim are refused as `params_invalid` before any grant use is charged; a faulting `create` releases the use when no row landed.
- The card's risk and reasons are Core-owned (`policy: plugin_invocation_card`); the task description names the capability by id only; a carded plugin invocation wakes the approval inbox (`isOwnerDecisionTask`).
- The hook uses the WALL clock for the ask (`askAtMs`), the arrival clock for the ledger row; with both packs active the note's method picks the rail; the whole hook body is guarded.
- Route: owner-only; `params` required; `param_categories` a string list; the same `statusForBegin`-style mapping (404 unknown install, 400 params_invalid, 403 blocked, 409 otherwise, 503 no registry/workflow); 202 for both dispatched and approval_required; snake_case body.
- Hook: only an ACCEPTED note asks (not duplicate/refused/unreadable); `upi` → India `upi-payment-status {utr, expected_amount}`, `transfer` → USA `settlement-status {payment_ref, rail:'ach', expected_amount}`; no `external_ref` / cash / no active pack / no workflow → typed no-ask; idempotency key = note digest so D2D route, inbox drain and spool replay ask once; correlation id = note digest; origin `system`; the hook never throws into the ingress and never writes an ack.
- Manifests: every rail declares a sorted `data_scope.categories` (the validator refuses the un-normalized form); the hook's `paramCategories: ['payment']` is inside the status rails' scope.
- Phone: the inbox lists `delegation` tasks `pending_approval` that carry the plugin envelope (and only those); the card shows the capability, Core's reason, the effect/retry statement from the PINNED action class + idempotency, and the exact params unclipped; Deny is a plain cancel (never `sendServiceRespond`); Approve is a plain approve (once); the resolved list reads both kinds per state and drops non-plugin delegations; the confirm dialog names the capability.
- Docs honesty: Iter 24, the architecture doc (§4 banner, §5.D rows, §8), CLAUDE.md and the PLUGIN_ARCHITECTURE status line say the producer exists, the context projector / chat routing / CardSpec rendering / "Allow 24h" affordance / other khata hooks / operator runners do not.

Findings to look for: a path where a card task can become `queued` without `approve`; a silent dispatch that skipped `authorizeAndConsume`; the hook asking on a `duplicate` verdict or before the note is stored; a grant created and left live after a failed approve; a test that asserts the implementation's reason text instead of the requirement; the inbox rendering anything from the plugin (display names, rationale) as trusted chrome.

## Dimension L14 — `/ask` into plugins and the 24-hour grant (Iters 26–27)

Files: `packages/core/src/server/routes/plugin_invoke.ts` (`tool-capabilities`, `tool-invoke`, `brainOrOwner`), `packages/core/src/auth/authz.ts` (the two Brain rules), `packages/core/src/client/{core-client,http-transport,in-process-transport}.ts` (`listPluginToolCapabilities`, `invokePluginTool`, `ApproveWorkflowTaskOptions.pluginGrant`), `packages/test-harness/src/mocks/core_client.ts`, `packages/brain/src/reasoning/plugin_tools.ts`, `composition/agentic_ask.ts`, `packages/core/src/plugins/invoke.ts` (`grant_can_silence`), `server/routes/workflow.ts` (`plugin_grant` on a non-plugin task), phone `useServiceInbox.ts` / `approval_inbox.tsx` (`supportsAllow24h`), `boot_capabilities.ts` (lazy client). Tests: `core/__tests__/server/routes/plugin_invoke.test.ts` (Brain verbs describe), `auth/authz_matrix.test.ts`, `client/*_transport.test.ts`, `brain/__tests__/reasoning/plugin_tools.test.ts`, `composition/agentic_ask.test.ts` (17 tools), mobile inbox suites.

Must be true:
- Brain reaches exactly two verbs under `/v1/plugins/`; every other path there is denied to Brain by the matrix AND owner-only in-handler; agent/plugin/connector reach neither verb.
- `tool-invoke` takes install, capability, params, categories only — resource/value/idempotency key in its body are ignored, so a caller cannot fit an ask to a grant's constraints; origin is `system` for Brain.
- In-process Brain calls (no caller type) pass `brainOrOwner`; no HTTP caller can forge that (the server strips `trustedInProcess`).
- `invoke_plugin` is terminal, relays Core's three answers as values, never logs params, refuses malformed args before Core; `list_plugin_capabilities` passes Core's list through.
- Core's card policy carries `grant_can_silence` (false for sensitive/regulated privacy or a sensitive persona); the phone's `supportsAllow24h` reads it and nothing else; a card with no policy offers no window.
- A `plugin_grant` on a pending task that is not a plugin invocation is a 400 with the task untouched; both transports map `pluginGrant` → `plugin_grant` (+ `hours`) and send `undefined` when no options are given.
- Docs: no claim that HIGH cards every invocation; dues and the people-graph phone slot are described as they exist.

## Dimension L15 — the rail's answer reaches the owner (Iter 29)

Files: `packages/core/src/commerce/country_rails.ts` (`paymentRailCheck`), `money_rehydrate.ts` (`rehydratePaymentRailAnswer`), `trade_inbox.ts` (`railCheck` on `unacknowledged_payment`), `server/routes/commerce.ts` (`rail_check`), `client/owner-commerce-client.ts` (DTO), `apps/mobile/app/trade.tsx` (`railCheckLabel`), `apps/mobile/src/hooks/useServiceInbox.ts` (`pluginResultLines`, `resultLines`), `components/approval_inbox.tsx` (resolved plugin row). Tests: `country_rails.test.ts` (rail check describe), mobile inbox suites.

Must be true:
- The inbox row's check is METADATA: a state name and the pinned schema's enum; no string from the runner ever reaches the row (the `memo` test); inbound notes only; the most recent correlated plugin-invocation task wins; a correlated non-plugin task is not a check; no workflow store → no check; the row still says the payment is unacknowledged.
- State mapping: `pending_approval` → awaiting_owner; `queued`/`running` → asked; `completed` → answered with the enum (anything else → unknown); every other state → closed.
- The phone's resolved card renders a completed plugin result as `label: value` lines: scalars shown, arrays counted, objects named, nulls as a dash; 12 field lines plus an ellipsis row; keys cut at 40 characters and values at 120, control/bidi characters dropped from both; no link or layout from the result; only on `completed` plugin tasks.
- The inbox route serializes the check as snake_case `rail_check {state, task_id, answer?}` (no `answer` key while pending) and the phone's `railCheckLabel` has words for every state and answer; the check reads only the two status-rail capabilities.
- `JSON.parse` of a stored result lives in the rehydration module (the commerce boundary guard).

## Verification protocol

Every finding is handed to independent skeptics who try to refute it against the code. A finding survives only when it names a file and line, describes a concrete failing input or state, and the skeptics cannot show the code already handles it. Confirmed findings are fixed in the main session, one deep review per fix, suites re-run per package.
