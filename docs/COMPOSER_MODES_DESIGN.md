# Explicit Composer Modes: Architecture and Design

Status: proposed (design approved, build pending)
Author: Dina mobile/brain
Date: 2026-06-16
Scope: `apps/mobile` composer + `packages/brain` chat pipeline. No AppView, Core route, or protocol wire-format change.

## 1. Summary

The mobile chat composer gains explicit, deterministic mode chips:

```
Ask | Remember | Task | Services | Reviews | Talk
```

`Ask`, `Remember`, `Task` keep today's behaviour. The three new chips remove
the LLM-routing guesswork for the launch:

- **Services** forces the question down the public-service discovery lane
  (`sources = ['provider_services']`).
- **Reviews** forces the question down the Ranked-Reviews lane
  (`sources = ['peerlens']`).
- **Talk** is a navigation shortcut (pick a contact, open the existing D2D
  thread), not a free-text question to your own Dina.

The mechanism is a single per-call override: a mode carries `forcedSources`
that **bypasses the Intent Classifier** and feeds the existing downstream
pipeline unchanged. The agentic loop still discovers the exact capability and
provider dynamically through the AppView. Nothing else in the ask path
changes.

## 2. Motivation

The `/ask` path routes through an LLM `IntentClassifier`
(`packages/brain/src/reasoning/intent_classifier.ts`) that decides which
substrates to consult (`vault` / `peerlens` / `provider_services` /
`general_knowledge`). We recently grounded that classifier in the real
`intent_routable` capability catalog and verified 15/15 real-world queries
route correctly in a live eval (`__tests__/reasoning/intent_classifier.eval.test.ts`).

A classifier is still a heuristic, however, and for a release we want the
user to be able to **guarantee** a lane. A user who knows "I want a service"
or "I want network reviews" should not depend on the model classifying their
phrasing. Explicit modes also make Services, Reviews, and Talk first-class and
discoverable, and they fit Dina's transactional, mode-first composer ethos
(Anti-Her: every interaction is a chosen lane, not open-ended chat).

`Ask` remains the friendly natural-language default and keeps the smart
classifier path. The explicit modes are guarantees, not a replacement for
asking naturally.

## 3. Goals and non-goals

Goals:

- Deterministic routing for Services and Reviews (no classifier dependence).
- Reuse the entire existing downstream (capability discovery, provider
  ranking, PeerLens query, service-query cards). No new backend subsystem.
- Keep `Ask` smart; keep the capability-explicit `/service <capability>`
  command untouched.
- Make Talk reachable from the composer without changing the D2D thread.

Non-goals:

- No change to the AppView, the Core HTTP API, or the `@dina/protocol` wire
  format.
- No change to how a Dina answers a service query (Tier 1 / Tier 2 / Tier 3
  provider execution is unchanged).
- Not removing or weakening the classifier; `Ask` still uses it.
- Talk does not become a "message Dina" mode; it stays contact-to-contact.

## 4. The mode model

| Chip | Input shape | Routing | Underlying command | Determinism |
|------|-------------|---------|--------------------|-------------|
| Ask | free text → your Dina | classifier decides sources | `/ask <text>` | heuristic (smart) |
| Remember | free text → vault | n/a (store) | `/remember <text>` | deterministic |
| Task | free text → agent | delegate to paired agent | `/task <text>` | deterministic |
| **Services** | free text → your Dina | **forced `provider_services`** | `/services <text>` | **deterministic lane**, dynamic capability |
| **Reviews** | free text → your Dina | **forced `peerlens`** | `/reviews <text>` | **deterministic lane** |
| **Talk** | pick a contact | n/a (navigation) | none (router push) | deterministic |

"Deterministic lane" means the LANE is guaranteed; within the Services lane
the agentic loop still discovers the exact capability and provider through the
AppView (`searchCapabilities` then `searchServices`), which remains the
authority on which capabilities have live providers.

Task remains gated on a paired delegation-capable agent
(`useHasActiveAgent`, `apps/mobile/app/index.tsx:205-206`); when absent the
chip is hidden, exactly as today.

## 5. Routing architecture and data flow

### 5.1 Ask (unchanged, smart)

```
composer (mode=Ask) → send("/ask <q>")
  → useLiveThread('main').send  (apps/mobile/src/hooks/useChatThread.ts)
  → orchestrator handleChat     (packages/brain/src/chat/orchestrator.ts)
  → AskCommandHandler(query)    (no forcedSources)
      → IntentClassifier.classify(q)         ← LLM heuristic
      → formatIntentHintBlock(hint)          ← appends routing block(s)
      → runAgenticTurn(tools, systemPrompt)  ← loop picks tools
```

### 5.2 Services (new, forced provider_services)

```
composer (mode=Services) → send("/services <q>")
  → orchestrator parses /services
  → AskCommandHandler(query, { threadId, forcedSources: ['provider_services'] })
      → classifier SKIPPED; hint.sources = ['provider_services'], temporal='live_state'
      → PROVIDER_SERVICES_ROUTING_BLOCK appended (existing)
      → agentic loop: searchCapabilities(q) → searchServices(cap, lat, lng, q)
                       → query_service (D2D) → service_query card
```

The capability is NOT chosen by the composer or the classifier; the AppView
resolves it from the free-text intent. So "price of kebab at a Turkish
restaurant" still resolves to `price_check` server-side and finds a published
provider, with the lane now guaranteed.

### 5.3 Reviews (new, forced peerlens)

```
composer (mode=Reviews) → send("/reviews <q>")
  → orchestrator parses /reviews
  → AskCommandHandler(query, { threadId, forcedSources: ['peerlens'] })
      → classifier SKIPPED; hint.sources = ['peerlens']
      → PEERLENS_ROUTING_BLOCK appended (NEW, mirrors the provider block)
      → agentic loop: search_peerlens(...)  (packages/brain/src/reasoning/peerlens_tool.ts)
```

### 5.4 Talk (new, navigation)

```
composer (mode=Talk tapped)
  → router.push('/people?pick=talk')  (contact picker, reuse People → Contacts)
  → user taps a contact row
  → router.push('/chat/<did>')        (existing per-contact D2D thread, app/chat/[did].tsx)
```

Talk does not enter the ask pipeline at all. It is a pure UI navigation into
the already-shipping D2D Talk surface (`app/people.tsx:174-179` already routes
a contact row to `/chat/<did>`).

## 6. The forced-sources mechanism (core change)

### 6.1 Force at the `sources` layer, not with a prompt directive

A mode could prepend a natural-language directive ("you must use a service")
to the query, but that is still LLM-interpreted and non-deterministic. Forcing
the `sources` array is deterministic: the existing
`formatIntentHintBlock(hint)` (`packages/brain/src/reasoning/ask_handler.ts:158-204`)
already turns `sources` into the routing block the agentic loop obeys. We
reuse that exact machinery and only change WHERE `sources` comes from.

### 6.2 Per-call, not per-handler

There is one installed `AskCommandHandler`
(`setAskCommandHandler`, `orchestrator.ts:570`) shared by Ask, Services, and
Reviews. The override must therefore be **per call**, carried on the existing
per-call context object:

```ts
// orchestrator.ts: AskCommandContext (line 530), extended:
export interface AskCommandContext {
  threadId: string;
  /** When set, the ask handler uses these sources verbatim and SKIPS the
   *  Intent Classifier (explicit Services/Reviews composer modes). */
  forcedSources?: IntentSource[];
}
```

The orchestrator passes `forcedSources` when it parsed a `/services` or
`/reviews` command; it omits it for `/ask`. No second handler, no construction-
time flag.

### 6.3 Where the classifier is bypassed

`packages/brain/src/reasoning/ask_handler.ts`, in the handler returned by
`makeAgenticAskHandler` (around line 286, where it currently calls
`intentClassifier.classify`):

```ts
let hint: IntentClassification;
if (context?.forcedSources !== undefined && context.forcedSources.length > 0) {
  hint = {
    ...IntentClassifier.default(),
    sources: context.forcedSources,
    temporal: context.forcedSources.includes('provider_services') ? 'live_state' : '',
  };
} else if (options.intentClassifier !== undefined) {
  hint = await options.intentClassifier.classify(query);
} else {
  hint = IntentClassifier.default();
}
```

Everything after this line (`formatIntentHintBlock`, the routing block, the
agentic loop) is unchanged. The classifier call is simply skipped on the
forced path, which also saves one LLM round-trip for Services/Reviews.

### 6.4 New PeerLens routing block

`formatIntentHintBlock` already appends `PROVIDER_SERVICES_ROUTING_BLOCK` when
`sources` includes `provider_services` (`ask_handler.ts:197-199`). For Reviews
to be a guaranteed lane we add a symmetric `PEERLENS_ROUTING_BLOCK` appended
when `sources` includes `peerlens`, instructing the loop to use
`search_peerlens` rather than `vault_search` for product/vendor reputation.
This also strengthens the classifier-driven `Ask` path when it independently
chooses `peerlens`.

## 7. Component design

### 7.1 Composer (`apps/mobile/app/index.tsx`)

- Extend `ACTIONS` (line 160) with `services`, `reviews`, `talk`. Each new
  entry carries its prefix (`/services `, `/reviews `, and `''` for talk) and a
  placeholder.
- `talk` is marked as a navigation action (e.g. `nav: true`). `handleAction`
  (line 262): when `action.nav`, do NOT set text mode; instead
  `router.push` the contact picker. All other modes keep the existing
  text-input behaviour.
- Wrap the chip row (`styles.modeChips`, line 622) in a horizontal
  `ScrollView` (`showsHorizontalScrollIndicator={false}`) so six chips scroll
  rather than wrap/overflow.
- `sendMessage` (line 232) is unchanged in shape: `fullText = prefix + content`
  already produces `/services <q>` / `/reviews <q>` for the new text modes.
- Testability seam: the composer needs to communicate the lane to the brain.
  Two equivalent options, decided in section 13:
  (a) **prefix-only** (`/services`, `/reviews`) parsed by the brain, or
  (b) the prefix plus a `forcedSources` option threaded through
  `useLiveThread().send`. Prefix-only keeps the composer dumb and the routing
  in one place (the parser); it is the recommended option.

### 7.2 Command parser (`packages/brain/src/chat/command_parser.ts`)

- Recognise `/services <text>` and `/reviews <text>` (mirror the existing
  `/ask` parse at line 86+). Each yields a parsed command tagged with the lane
  so the orchestrator can set `forcedSources`. Free text is required (a bare
  `/services` returns the usage hint, like `/service`).
- Add both to the `getAvailableCommands` listing (line 277+) so `/help`
  documents them.
- Note the naming collision risk: the existing capability-explicit command is
  `/service` (singular). The new free-text lane is `/services` (plural). The
  parser must match the longer/plural token first, or disambiguate explicitly,
  so `/services bus 42` is not mis-parsed as `/service` with capability
  `s` (or similar). This is the single highest-risk parsing detail.

### 7.3 Orchestrator (`packages/brain/src/chat/orchestrator.ts`)

- For a parsed `/services` or `/reviews` command, call the installed
  `askHandler(query, { threadId, forcedSources })` with
  `['provider_services']` or `['peerlens']` respectively.
- The synchronous return shape (`{ response, sources, serviceQueries?,
  missingCapabilities? }`, line 543-566) is unchanged, so service-query cards
  and missing-capability cards work identically to a classifier-routed `/ask`.

### 7.4 Agentic ask handler + intent (`reasoning/ask_handler.ts`, `composition/agentic_ask.ts`)

- `AskCommandContext` gains `forcedSources?` (section 6.2).
- The handler bypasses the classifier when `forcedSources` is present
  (section 6.3).
- `agentic_ask.ts` already wires `createSearchPeerlensTool` (line 61) and the
  service tools (line 275-280), so both lanes have their tools available;
  forcing `sources` only changes which routing block is in the system prompt,
  not which tools exist.

### 7.5 Services lane

Reuses the full discovery chain already covered by
`docs/BUSDRIVER_SERVICES_SCENARIO.md` and
`docs/PUBLIC_SERVICES_TAXONOMY.md`: `searchCapabilities(intent)` then
`searchServices(capability, lat, lng, q)` then `query_service` D2D. The AppView
stays authoritative on which capabilities are intent-routable and which have
live providers. The composer never names a capability.

### 7.6 Reviews lane

Reuses `search_peerlens` (`packages/brain/src/reasoning/peerlens_tool.ts`),
which resolves the subject and queries the AppView PeerLens index. The
user-facing name is "Ranked Reviews"; "PeerLens" stays internal (see
`apps/mobile/src/features.tsx` naming note). Writing a review is a separate
flow (`app/peerlens/write.tsx`) and is intentionally not part of this mode.

### 7.7 Talk lane

Reuses `app/people.tsx` (contacts) and `app/chat/[did].tsx` (D2D thread). A
small addition: the People screen accepts a "pick" intent so that, when
reached from the Talk chip, tapping a contact returns into the chat thread
(it already navigates to `/chat/<did>` on row tap, so the change is mostly the
entry point and any "pick mode" affordance/title).

## 8. Backward compatibility and invariants

- `Ask`, `Remember`, `Task` behaviour is byte-for-byte unchanged.
- The classifier still runs for `Ask`; the catalog-grounded routing we shipped
  stays the smart default.
- The capability-explicit `/service <capability>` command is untouched.
- The async `/api/v1/ask` API (CLI/agents over MsgBox) is untouched; this
  change lives entirely in the in-process owner chat path, which is the correct
  layer (owner-in-app `/ask` runs through the orchestrator, not the async
  submit/poll API).
- Wire format, AppView, and Core routes are unchanged.

## 9. Edge cases and failure modes

- **Same-Dina self-query.** Service discovery excludes the caller's own DID
  (`rankCandidates` `excludeDid`, `packages/brain/src/reasoning/service_tools.ts`).
  A user testing Services against their OWN published listing on the SAME Dina
  will get "no provider"; that is by design (you cannot D2D-query yourself).
  Test cross-Dina. The mode does not change this; the empty-result UX is the
  existing `missing_capability` card.
- **No provider found.** Services lane with no live provider yields the
  existing `missing_capability` card, not a generic LLM guess (the forced
  routing block tells the loop not to fabricate).
- **Empty input.** `/services` / `/reviews` with no text returns the usage hint
  (parser), matching `/service`.
- **Reviews with no network data.** `search_peerlens` returns empty; the loop
  reports no verified reviews rather than inventing them.
- **Talk with no contacts.** Contact picker shows the empty state; no thread is
  opened.
- **Guided demo / credits.** Modes inherit the existing send path, so the demo
  scope and Starter-Credits gating apply unchanged.

## 10. Security and the Four Laws

- No new external surface. Services/Reviews still go through the AppView and
  D2D exactly as today; the only change is which lane the owner picked.
- Loyalty/privacy unchanged: the vault is consulted under the same guard; the
  forced sources only widen/narrow which substrates the loop reads.
- Talk remains contact-gated (the D2D receive pipeline already gates inbound on
  contact/quarantine; outbound is to a chosen contact).

## 11. Testing strategy

- **Composer render (`apps/mobile/__tests__/...`):** six chips render in a
  scrollable row; selecting Services/Reviews sets the mode and produces
  `/services <q>` / `/reviews <q>` on send; tapping Talk navigates to the
  contact picker and does NOT enter text mode; Task chip still hidden without a
  paired agent.
- **Parser (`packages/brain/__tests__/chat/command_parser.test.ts`):**
  `/services` and `/reviews` parse to the right lane; `/service` (singular,
  capability-explicit) still parses as before (the collision guard).
- **Forced-sources bypass (`reasoning/ask_handler` tests):** with
  `forcedSources` the classifier is NOT called and the right routing block is
  present; without it the classifier runs as today.
- **PeerLens routing block:** present iff `sources` includes `peerlens`.
- **Live eval (extend `intent_classifier.eval.test.ts` or a new
  `ask_routing.eval.test.ts`, gated off by default):** Services/Reviews modes
  reach the intended tool. Optional, paid, opt-in.

## 12. File-level change list

| File | Change | Size |
|------|--------|------|
| `apps/mobile/app/index.tsx` | ACTIONS + scrollable chip row + Talk nav action | M |
| `apps/mobile/app/people.tsx` | accept a "pick" entry for Talk (return to chat) | S |
| `packages/brain/src/chat/command_parser.ts` | parse `/services`, `/reviews` (collision guard vs `/service`) | S |
| `packages/brain/src/chat/orchestrator.ts` | route new commands → ask handler with `forcedSources`; extend `AskCommandContext` | S |
| `packages/brain/src/reasoning/ask_handler.ts` | classifier bypass on `forcedSources`; `PEERLENS_ROUTING_BLOCK` | S |
| `packages/brain/src/composition/agentic_ask.ts` | thread context through (if needed) | S |
| tests (composer + parser + ask_handler) | per section 11 | M |

Total: M. No migration, no protocol bump.

## 13. Decisions and open questions

Decided (this design):

- Six chips including Task (Task stays as the 6th chip, scrollable row).
- Talk is a contact-picker navigation, not a text mode.
- Reviews queries the network (forced PeerLens); writing a review stays its own
  flow.
- Ask stays smart (classifier retained).

Open:

- **O1 (recommended: prefix-only).** Signal the lane via the `/services` /
  `/reviews` prefix parsed by the brain, vs threading a `forcedSources` option
  through `useLiveThread().send`. Prefix-only keeps routing in one place (the
  parser) and the composer dumb.
- **O2.** `/service` (singular, capability-explicit) vs `/services` (plural,
  free-text lane) collision. Resolve in the parser by matching the plural token
  first or by an explicit longest-match rule. Must have a test.
- **O3.** Chip overflow UX: horizontal scroll (proposed) vs a "More" overflow
  vs two rows. Scroll is the lightest.

## 14. Future work

- Optional hard fallback in `Ask`: when the vault answer is thin, always run
  `searchCapabilities` so even the smart path never misses a live provider
  (discussed; deferred). With explicit Services this is less urgent.
- A capability-aware Services sub-picker (pick a category) if the catalog grows
  large; not needed at single-digit capability counts.

## 15. Appendix: code anchors

- Composer: `apps/mobile/app/index.tsx`: `ACTIONS` (160), `activeAction`
  (213), `sendMessage`/prefix (232/240), `handleAction` (262), chip row (622).
- Send path: `apps/mobile/src/hooks/useChatThread.ts` (`useLiveThread('main').send`).
- Orchestrator: `packages/brain/src/chat/orchestrator.ts`: `AskCommandContext`
  (530), `AskCommandHandler` (543), `setAskCommandHandler` (570),
  `/service` handler (605-675).
- Parser: `packages/brain/src/chat/command_parser.ts`: slash dispatch (86),
  `/service` parse (135), command list (277).
- Ask handler/intent: `packages/brain/src/reasoning/ask_handler.ts`:  `makeAgenticAskHandler` (272), classifier call (286), `formatIntentHintBlock`
  (158), `PROVIDER_SERVICES_ROUTING_BLOCK` (153).
- Classifier: `packages/brain/src/reasoning/intent_classifier.ts`:  `INTENT_SOURCES`, `classify`, catalog injection (the `intent_routable`
  rendering).
- Tools: `packages/brain/src/reasoning/peerlens_tool.ts` (`search_peerlens`),
  `service_tools.ts` (`searchProviderServices`, `rankCandidates` `excludeDid`).
- Talk: `apps/mobile/app/people.tsx:174-179` (contact row → `/chat/<did>`),
  `apps/mobile/app/chat/[did].tsx:37-40` (peer thread).
- Catalog (capability vocabulary): `packages/protocol/src/services/capability-catalog.ts`
  (`CATALOG_CAPABILITIES`, `intent_routable`).
```
