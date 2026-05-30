# CardSpec work — session handoff (2026-05-30)

Status checkpoint for the "card as DATA, not code" service-result card system.
Design: `docs/CARD_SPEC_DESIGN.md` (+ `CARD_SPEC_V2_DESIGN.md`).

## DONE + green (Cards 1–3)

The feature **works now** — the rich card renders via a render-time fallback
even before the brain pre-computes it.

1. **Card-1 — `@dina/protocol` CardSpec** (`packages/protocol/src/services/card-spec.ts`)
   - 15 block kinds: title, section, divider, stat, keyValue, body, badge,
     bar, rating, chips, list, timeline, map, link, media.
   - `validateCardSpec(value, {trusted?})` — forward-compat (unknown blocks
     dropped, unknown top-level fields ignored), badges Dina-only (dropped
     unless `trusted:true`), map = structured coords/query (no URL), link =
     hardened https (no creds/localhost/private-IP/odd-port) + `open_url`
     only, media = blob-CID+DID (no URL). Staleness fields
     (generatedAt/expiresAt/ttlSeconds/sourceLabel). `linkDisplayHost`,
     `isCardStale`.
   - Exported from `packages/protocol/src/index.ts` (`export * from
     './services/card-spec'`).
   - **Tests: 48 pass** (`__tests__/services/card-spec.test.ts`). dep_hygiene green.
   - NOTE: there is NO `CARD_SPEC_VERSION` export (the `version` literal is
     inline `1`). Don't re-add a const without updating callers.

2. **Card-2 — deterministic mapper** (`packages/brain/src/service/result_card_mapper.ts`)
   - `buildResultCardSpec({capability, serviceName, result}) → CardSpec | null`.
   - Field-shape heuristics (name→title, status→TONED keyValue NOT badge,
     numbers→stat/bar/rating, dimensions→bars, coords→map, https→link,
     as_of/ttl→staleness). Output always run through
     `validateCardSpec(..,{trusted:false})`.
   - Exported from `packages/brain/src/index.ts` (after the
     `result_formatter` exports, before `candidate_ranker`).
   - **Tests: 9 pass** (`packages/brain/__tests__/service/result_card_mapper.test.ts`).

3. **Card-3 — mobile renderer + rewire**
   - `apps/mobile/src/components/SafeCardRenderer.tsx` — renders a CardSpec
     with the real theme API (`textStyles`, `colors.{success,warning,error,
     accent,textPrimary,…}`). media → shows alt text (render deferred).
   - `apps/mobile/src/components/InlineServiceQueryCard.tsx` — removed the
     hard-coded inline `EtaResultBody` + `labelForCapability`; resolved
     branch now: `const spec = lc.cardSpec ?? (result ? buildResultCardSpec(
     {capability, serviceName, result}) : null)` → `<SafeCardRenderer/>` +
     ProviderAttribution, else generic text fallback. (Dropped unused
     `Linking`, `safeHttpsUrl` imports.)
   - `packages/brain/src/chat/thread.ts` — `ServiceQueryLifecycle` gained
     `cardSpec?: CardSpec` (import `type { CardSpec } from '@dina/protocol'`).
   - Mobile card files typecheck clean; brain chat tests 187 pass;
     orchestrator 69 pass; brain tsc clean.

## LEFT TO DO (next session, healthy channel)

- **Card-4 — pre-compute cardSpec brain-side** (#176). Wire
  `buildResultCardSpec` into the `deliver` callback that builds the resolved
  `service_query` lifecycle patch, setting `cardSpec` on it so the renderer
  uses the persisted spec instead of recomputing.
  - The deliver callback lives in **`packages/home-node/src/service_runtime.ts`**
    (`buildHomeNodeServiceRuntime`, `deliver: options.deliver`). The actual
    patch that calls `updateMessageLifecycle`/`addLifecycleMessage` with
    `{status, serviceName, result}` is the `deliver` impl passed in by
    `createNode` (see the minified `node.ts` runtime — search the source for
    where `deliver:` constructs the `service_query` lifecycle). Add
    `cardSpec: buildResultCardSpec({capability, serviceName, result})` on the
    success branch (only when `result` present). Add a contract test.
  - Lower priority than it looks: Card-3's render-time fallback already
    produces the same card, so Card-4 is an optimization (compute once,
    persist) + makes the LLM path (Card-5) have a slot to write into.

- **Card-5 — LLM-authored CardSpec** (#177). At service-response formatting,
  let the requester's agentic LLM emit a CardSpec; `validateCardSpec(..,
  {trusted:false})`; on success use it, else fall back to the deterministic
  mapper. Test with a fake LLM.

- **Svc3 — live 3rd-service E2E** (#178–180). Add `price_check` to the
  canonical registry (`packages/protocol/src/services/capability-registry.ts`
  + the byte-identical appview copy `appview/src/shared/capability-registry.ts`
  — drift gate). Stand up a `price_check` stub on a WARM repo (reuse bus42 to
  avoid the new-repo relay lag — see `docs/INGEST_LATENCY_INSTRUMENTATION.md`),
  publish, confirm discovery, drive in-app, screenshot the rich card.

## Test commands (per-package, foreground, one at a time)

```
cd packages/protocol && npx jest card-spec --runInBand
cd packages/brain   && npx jest result_card_mapper --runInBand
cd packages/brain   && npx jest chat --runInBand
cd apps/mobile      && npx tsc --noEmit -p tsconfig.json
```

## Process notes (what went wrong this session)

- **Do NOT batch many tool calls.** Large parallel batches cascaded: one
  failed call (or one stale-cache misread) cancelled the rest → walls of
  "cancelled". Go ONE call at a time; re-read before each Edit.
- The mobile theme is **`apps/mobile/src/theme.ts`** (single file) exporting
  `colors / spacing / radius / fonts / textStyles / navTitle / shadows`.
  There is NO `typography`, no `colors.danger/info/primary/textInverse/
  surfaceElevated`. Use `textStyles.*` + the real color tokens.
- `EtaResultBody` was an INLINE function in `InlineServiceQueryCard.tsx`, not
  a separate file. It's now removed.

## Uncommitted working tree (nothing committed — user controls git)

New: card-spec.ts (+test), result_card_mapper.ts (+test), SafeCardRenderer.tsx,
docs/CARD_SPEC_DESIGN.md, CARD_SPEC_V2_DESIGN.md, CARD_SPEC_HANDOFF.md, plus the
earlier Dr-Carl rig files + ingest-latency harness/doc. Modified: protocol
index.ts, brain index.ts, brain/chat/thread.ts, mobile InlineServiceQueryCard.tsx,
.gitignore (drcarl secrets), several implementation-notes + results docs.
