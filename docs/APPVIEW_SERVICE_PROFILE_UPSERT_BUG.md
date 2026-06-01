# AppView ingester — service-profile upsert race (duplicate_key)

**Status:** FIXED + verified live (2026-05-30, commit `aa22b3b`). Surfaced while
standing up the `price_check` 3rd-service E2E. Pre-existing bug, not introduced by
the CardSpec work.

**Verification (live test-appview):** after deploying the `onConflictDoUpdate`
fix and force-recreating the appview containers, re-publishing "Corner Market"
made `service.search?capability=price_check` return the provider **immediately**
(`[{name:"Corner Market", capabilities:["price_check"]}]`), and the
appview-ingester log shows `Record processed` with **zero `duplicate key`**
errors (was 24× in 8 min before the fix). The unit suite
(`service_profile_handler.test.ts`) is 13/13 green, including two regression
tests that drive concurrent same-uri creates and assert one row + no
`duplicate_key`.

## Symptom

`price_check` provider ("Corner Market", `did:plc:uib44…`) publishes its
`com.dinakernel.service.profile/self` correctly (confirmed on test-pds), the deployed
test-appview *accepts* the `price_check` capability, but
`service.search?capability=price_check` keeps returning `{"services":[]}`.

The appview-ingester log shows, repeatedly (24× in 8 min):

```
DrizzleQueryError: Failed query: insert into "services" (...)
  duplicate key value violates unique constraint "services_pkey"
[Queue] Failed to process item — requeued for retry
```

So the profile never lands in the `services` table → never discoverable.

## Root cause (a real concurrency bug)

`appview/src/ingester/handlers/service-profile.ts` `handleCreate` does, in a
transaction:

```ts
const prior = await tx.select({createdAt}).from(services).where(eq(operatorDid, op.did)).limit(1)
const createdAt = prior[0]?.createdAt ?? now
await tx.delete(services).where(eq(services.operatorDid, op.did))   // delete ALL by operator
await tx.insert(services).values({ uri: op.uri, ... })             // plain INSERT, NO onConflict
```

The code comment explicitly assumes *"the preceding DELETE guarantees no row at
this URI, so a conflict on `uri` cannot arise."* **That guarantee is false under
concurrency.**

- The ingester's `BoundedIngestionQueue` runs with `maxConcurrency =
  DATABASE_POOL_MAX` (≈20).
- The Jetstream connection drops (`code:1006`) roughly every ~10 min; on each
  reconnect the consumer **replays its spool** — a backlog of events for the
  SAME `…/self` URI (old appointment_status CIDs + new price_check CIDs, since
  drcarl's node was repurposed across capabilities and re-published several
  times).
- Two events for the same `uri` get processed concurrently: both pass the
  `delete`, both attempt `insert(uri)`, the second violates `services_pkey`.
- The failed item requeues → replays again → never drains → the row is never
  committed.

`primary key = uri` (the error is `services_pkey`).

## The fix (idempotent upsert — closes the bug class)

Make the per-URI write idempotent so it's correct regardless of concurrency.
Keep the "at most one indexed profile per operator" convention by deleting only
the operator's OTHER uris, then UPSERT the current uri.

In `appview/src/ingester/handlers/service-profile.ts`:

1. Add `ne` to the drizzle import:
   ```ts
   import { eq, ne, and } from 'drizzle-orm'
   ```
2. Replace the `delete(operatorDid)` + plain `insert` with:
   ```ts
   // Drop the operator's OTHER profile rows (different rkey/uri), NOT the one
   // we're about to write — so the upsert below owns the current uri.
   await tx.delete(services).where(and(eq(services.operatorDid, op.did), ne(services.uri, op.uri)))
   await tx
     .insert(services)
     .values({ uri: op.uri, operatorDid: op.did, cid: op.cid!, /* …all fields… */,
               createdAt, updatedAt: record.updatedAt ? new Date(record.updatedAt) : now,
               indexedAt: now })
     .onConflictDoUpdate({
       target: services.uri,
       set: {
         cid: op.cid!, name: record.name, description: record.description ?? null,
         capabilitiesJson: normalizedCapabilities, lat: latFloat, lng: lngFloat, radiusKm,
         hoursJson: record.hours ?? null, responsePolicyJson: canon.responsePolicy,
         capabilitySchemasJson: Object.keys(canon.capabilitySchemas).length > 0 ? canon.capabilitySchemas : null,
         isDiscoverable: record.isDiscoverable, searchContent,
         updatedAt: record.updatedAt ? new Date(record.updatedAt) : now, indexedAt: now,
         // NOTE: do NOT overwrite createdAt on conflict — preserve the original.
       },
     })
   ```
   (Reference: `appview/src/ingester/handlers/subject.ts` already uses
   `onConflictDoUpdate`.)
3. Update the now-stale comment block (the "NO ON CONFLICT" paragraph).

## Regression test (close the class, per feedback_test_strategy)

Add an ingester test that drives TWO `handleCreate` calls for the **same uri**
concurrently (or back-to-back without the delete clearing between) and asserts:
no throw, exactly one `services` row for that operator, `createdAt` preserved
from the first, `updatedAt`/`cid` from the last. This is the contract the
delete-then-insert silently violated.

## Then finish the E2E (Svc3-3)

1. `cd appview && npx tsc --noEmit` + `npx vitest run` (ingester suite green).
2. Commit + push.
3. Redeploy: `./deploy/managed/infra/deploy_shared_infra.sh update test`
   **BUT NOTE:** plain `update` did NOT recreate the appview containers (image
   build cached → `up -d` saw no change). Force it:
   `ssh dina-test-infra "cd /opt/dina-test-infra/deploy && COMPOSE_PROJECT_NAME=dina-infra-test docker compose -f docker-compose.infra.yml up -d --force-recreate --build appview-web appview-ingester appview-scorer"`
4. Re-publish Corner Market:
   `cd dina-services-demo && DINA_CORE_URL=http://127.0.0.1:18299 DINA_SERVICE_KEY_DIR=/tmp/drcarl-key-dir DINA_SERVICE_NAME="Corner Market" npx tsx put_service_config_price.ts`
5. Poll `service.search?capability=price_check` → should now return Corner
   Market (and `?capability=price_lookup` via alias canonicalization).
6. Re-pair the price daemon (config was lost):
   `npx tsx pair_initiate_drcarl.ts` → take the FRESH code →
   `./venv/bin/dina configure --headless --core-url http://127.0.0.1:18299
   --pairing-code <CODE> --device-name price-agent --role agent --transport
   msgbox --msgbox-url wss://test-mailbox.dinakernel.com/ws --homenode-did
   did:plc:uib44xwkcqkosr2hli6exsww --config-dir "$PWD/drcarl-agent/.dina/cli"`
   then `DINA_CONFIG_DIR="$PWD/drcarl-agent/.dina/cli" ./venv/bin/python run_daemon_price.py`.
7. In-app `/ask "How much are organic bananas at Corner Market?"` → rich price
   CardSpec card (title / $0.79 stat / In-stock toned keyValue / store / link) →
   screenshot. NO AppView bypass — full discovery path only.

## What IS done + green + pushed (this session)

- Cards 1–5 (CardSpec system) — commits `e1a9e49`, `3c891fa`. Feature works
  (proven by unit tests + the live Dr Carl appointment card).
- `price_check` registry (+ byte-identical appview copy) — commit `8f39174`.
  Deployed; appview canonicalizes it.
- price rig scripts (`stub_price_runner.py`, `run_daemon_price.py`,
  `put_service_config_price.ts`) + this session's other untracked files are in
  the working tree (uncommitted unless a later commit picked them up).

## Process note

The interactive tool channel degraded badly at the end of this session
(commands returning `report report` garbage; Read returning stale image hooks),
which is why the fix above is documented rather than applied — applying edits
blind, unable to verify reads, risked corrupting the file. Resume in a fresh
session.
