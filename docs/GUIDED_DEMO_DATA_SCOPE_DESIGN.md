# Guided Demo Data Scope Design

## Status

Proposed V1 implementation plan.

This document specifies the product behavior and technical architecture for
Dina's first-run guided demo. The goal is to let a new user experience Dina's
core value in a few minutes without leaving fake data behind.

## Summary

Dina should offer an optional first-run guided demo:

```text
See Dina in action
A 3-minute guided demo using sample data. Nothing from the demo is kept.

Start demo    Start empty
```

If the user starts the demo, Dina enters a temporary data scope:

```text
guided_demo:<run_id>
```

All normal app code continues to use the normal vaults, normal personas, normal
prompts, normal people graph, normal reminder service, normal PeerLens/service
flows, and normal approval cards. The only difference is that reads and writes
are scoped to the demo run.

When the user finishes or skips the demo, Dina deletes everything in that demo
scope and switches back to:

```text
user
```

This gives a real product experience without a separate fake account, separate
demo personas, or prompt-specific demo hacks.

## Product Goal

The guided demo must transmit Dina's product story as one coherent path:

```text
Dina remembers -> uses private context -> checks peer/service network ->
protects sensitive data from agents -> lets users publish services.
```

This is not a passive tour of tabs. It is a live first-success flow.

## Non-Goals

- Do not create a separate demo user account.
- Do not create fake `demo_general` or `demo_health` personas unless the
  data-scope approach proves too expensive.
- Do not mutate the user's real data scope during the demo.
- Do not rely on timestamp cleanup as the primary cleanup mechanism.
- Do not fake approval cards. Agent-safety cards must use the real approval
  mechanism.
- Do not public-publish a service listing without explicit user action.
- Do not include D2D Talk in the primary guided demo unless it remains simple.
  D2D can be an optional second demo.

## Functional Flow

### Entry

After onboarding completes and before the user lands in normal Chat, show:

```text
See Dina in action
A 3-minute guided demo using sample data. Nothing from the demo is kept.

Start demo    Start empty
```

Rules:

- `Start empty` switches to the normal `user` scope and opens Chat.
- `Start demo` creates a new demo run and sets the current scope to
  `guided_demo:<run_id>`.
- The demo is optional. Do not nag the user after they skip.
- A future "Run guided demo again" entry may live under Help/Settings, but V1
  can be first-run only.

### Demo Banner

While demo scope is active, show a small persistent indicator:

```text
Guided demo - sample data only
```

The banner should be subtle but clear. The user must understand that the sample
data will be deleted.

### Step 1: Remember A Person

Use Emma because she clearly demonstrates that Dina is personal, not just a
generic assistant.

Demo input:

```text
Emma is my daughter. Emma loves dinosaurs. Emma's birthday is on Nov 7.
```

Expected behavior:

- Store the memory through the normal `/remember` path.
- Create a people-graph person:
  - canonical name: `Emma`
  - relationship hint: `daughter`
  - surfaces include `Emma` and role phrase if extracted.
- Emma appears under People/Relations, not Contacts.
- Schedule birthday reminder(s).
- Enrich the reminder with the dinosaur preference.

Expected visible confirmation:

```text
Saved. I'll remind you before Emma's birthday.
```

Expected reminder card:

```text
Emma's birthday - Nov 7
Remember: Emma loves dinosaurs.
```

Implementation note:

The birthday date must resolve to the next upcoming November 7 from the current
date. Do not hardcode the year in copy. Internally store the concrete due date.

### Step 2: Show People/Relations

After Step 1, briefly point at People:

```text
Emma now appears under People because Dina understands people in your life.
```

Expected People row:

```text
Emma
daughter
From your memories
```

Important:

- Emma is not a D2D contact.
- Emma has no DID.
- Emma should not be trusted for D2D.
- No contact policy should be created unless the user later adds a DID/contact.

### Step 3: Remember User Context

Demo input:

```text
I have quite a bit of lower back pain.
I do not want to spend more than $500 on an office chair.
```

Expected behavior:

- The health-related memory routes to the Health persona/vault.
- The budget memory routes to General or Finance depending on current routing
  behavior. The exact persona is less important than successful recall.
- No approval card appears. The owner is telling Dina directly.

Expected visible confirmation:

```text
Saved.
```

### Step 4: Ask With Context Enrichment

Demo input:

```text
Find me a good office chair.
```

Expected behavior:

Dina should use the user's private context without the user restating it:

- lower back pain -> infer ergonomic/lumbar support matters
- $500 budget -> reject over-budget options
- PeerLens reviews -> prefer trusted peer-reviewed options
- product/service provider -> check price/availability if available

Expected answer shape:

```text
I looked for chairs that fit your $500 budget and are better for lower-back
support.
```

Expected card shape:

```text
Recommended: ErgoFlex Study Chair
$420
Why: within budget + PeerLens reviewers mention back support.

Rejected:
- BudgetLite Chair: under budget, but poor back-support reviews.
- SpinePro Chair: strong reviews, but $850.
```

### Step 5: Network Service With Minimal Disclosure

The service query should reinforce Dina's privacy boundary.

User/demo query can be part of Step 4 or a follow-up:

```text
Is the ErgoFlex chair available near me?
```

Expected service path:

```text
Asked Dina service directory
Found Demo Furniture Availability Provider
Sent query
Provider replied
```

Provider should receive only necessary service params, for example:

```json
{
  "product": "ErgoFlex Study Chair",
  "location": "San Francisco"
}
```

Provider must not receive:

```text
I have lower back pain.
My budget is $500.
Emma is my daughter.
Emma loves dinosaurs.
```

Dina uses private context locally to choose and interpret service results. The
external service receives only the minimal typed request.

### Step 6: Agent Safety

This is separate from the owner asking Dina.

Correct rule:

- Owner asks Dina -> no approval card just because Health is relevant.
- External/local agent asks Dina -> approval card if sensitive/locked context is
  requested.

Demo event:

```text
Demo Shopping Agent wants to read Health to compare ergonomic fit.
```

Approval card:

```text
Shopping Agent wants Health access
Reason: compare ergonomic fit for office chairs
Access: read, this task only

Allow once    Deny
```

If allowed:

```text
Shopping Agent used approved Health context and recommended ErgoFlex.
```

If denied:

```text
Shopping Agent continued without Health and could only rank by price and reviews.
```

Implementation rule:

Use the real approval/agent-persona-grant mechanism. The agent can be a demo
runner, but the approval object and card must be real.

### Step 7: Publish Your Own Service

End by showing the developer/provider path.

Copy:

```text
Dina can also publish what this home node can do.
```

Show a draft service listing:

```text
Chair availability checker
Capability: product_availability
Visibility: Unlisted
Response policy: Review
```

Rules:

- Do not public-publish silently.
- It is acceptable to create a demo draft in the demo scope.
- If the user explicitly chooses to publish for real, that must switch out of
  demo scope and require a clear confirmation.

### Exit

End screen:

```text
You've seen the basics:
- Remember
- Smart reminders
- People/Relations
- Private context
- PeerLens/services
- Agent safety
- Publishing services

Finish demo and start with an empty Dina
```

On finish:

1. Delete all data for `guided_demo:<run_id>`.
2. Clear active demo run.
3. Set current scope to `user`.
4. Open normal Chat.

Normal Chat should be empty after demo cleanup.

### Skip / Abort

If user exits early:

```text
Leave guided demo?
Sample data will be deleted.

Delete demo and start empty    Continue demo
```

On delete, run the same cleanup.

### Crash / Restart Recovery

If the app starts and finds an active demo run:

```text
You were in the guided demo.

Continue demo    Delete demo and start empty
```

The app must never silently merge demo data into the normal user scope.

## Core Data Model

### DataScope

Introduce a first-class data scope:

```ts
type DataScope = 'user' | `guided_demo:${string}`;
```

Normal data:

```text
data_scope = 'user'
```

Guided demo data:

```text
data_scope = 'guided_demo:<run_id>'
```

Use `data_scope`, not `source`.

Reason:

- `source` means provenance: `manual`, `d2d`, `reminder_planner`,
  `service_response`, etc.
- Demo is not the producer. Demo is the container/scope for the row.

### Runtime Scope Manager

Create a small shared scope module in Core:

```ts
export type DataScope = 'user' | `guided_demo:${string}`;

export function currentDataScope(): DataScope;
export function setCurrentDataScope(scope: DataScope): void;
export function isGuidedDemoScope(scope: DataScope): boolean;
export function newGuidedDemoScope(): DataScope;
export function runInDataScope<T>(scope: DataScope, fn: () => T): T;
```

Guidance:

- V1 can use a singleton runtime scope because the mobile app is local and
  mostly single-user.
- Repositories must default inserts/queries to `currentDataScope()`.
- Long-term server/multi-actor paths should pass scope explicitly or use a
  request context to avoid global-state ambiguity.

### Persistent Active Demo State

Store active demo run metadata in `kv_store` or equivalent app state:

```json
{
  "activeDemoScope": "guided_demo:abc123",
  "startedAt": 1780000000000,
  "step": "remember_emma"
}
```

This is not user content. It is boot recovery state.

On boot:

- If active demo exists, show Continue/Delete prompt.
- If no active demo exists, current scope defaults to `user`.

## Scoped Tables

Add `data_scope TEXT NOT NULL DEFAULT 'user'` to tables that hold user content
or user-visible state.

### Must Scope

Identity DB / shared state:

- `reminders`
- notifications / notification inbox rows
- chat thread/message rows
- staging inbox rows if demo writes through staging
- people
- person_surfaces
- person_identities only if demo creates identities; for V1 Emma should not
  create an identity
- contacts only if demo creates demo contacts; primary V1 should avoid this
- service config/listing drafts if demo creates a draft service
- PeerLens local drafts/outbox if demo creates local review drafts

Persona vault DBs:

- `vault_items`
- `vault_item_subjects`
- any vault item metadata/topic tables that are created from demo memories

### Should Not Scope

Do not add `data_scope` to infrastructure/security tables:

- root seed / wrapped seed
- PDS credentials
- DID / PLC identity rows
- paired devices
- auth nonces
- migrations
- low-level system config
- service grants, unless a demo explicitly creates fake grants
- agent persona grants, unless a demo explicitly creates fake grants

Audit log:

- Do not filter audit logs by normal app scope.
- If useful, include `data_scope` as metadata only.
- Do not delete real audit rows as part of demo cleanup unless they are purely
  local demo telemetry and product explicitly wants that.

## Repository Enforcement

This must not be implemented as ad-hoc `WHERE data_scope = ...` sprinkled
through screens.

Create shared helpers for scoped repositories.

Example:

```ts
export function scopedInsertFields(scope = currentDataScope()) {
  return { data_scope: scope };
}

export function scopedWhere(alias?: string, scope = currentDataScope()) {
  return `${alias ? `${alias}.` : ''}data_scope = ?`;
}

export function scopedParams(scope = currentDataScope()) {
  return [scope];
}
```

Every scoped repository must follow these rules:

- Inserts set `data_scope = currentDataScope()` unless explicitly supplied.
- Reads filter to `currentDataScope()` by default.
- Updates/deletes filter to `currentDataScope()` unless operating on an exact
  scoped ID.
- Cross-table joins include scope on both sides where both tables are scoped.
- List APIs do not return rows from other scopes.
- Export includes only `data_scope = 'user'`.
- Cleanup deletes by exact scope, not by timestamp.

### Exact-ID Safety

Even when an API updates/deletes by ID, include scope where possible:

```sql
DELETE FROM reminders
WHERE id = ? AND data_scope = ?
```

This prevents a demo ID from accidentally touching user data and vice versa.

### Scope Leak Tests

Each scoped repository needs tests like:

1. Insert user row and demo row with same logical content.
2. In user scope, list returns only user row.
3. In demo scope, list returns only demo row.
4. Delete demo scope.
5. User row remains.

## Cleanup

Add one cleanup API:

```ts
deleteDataScope(scope: DataScope): Promise<DeleteDataScopeResult>
```

Result shape:

```ts
interface DeleteDataScopeResult {
  scope: DataScope;
  deleted: Record<string, number>;
  errors: Array<{ table: string; error: string }>;
}
```

Rules:

- Delete all scoped rows with the exact demo scope.
- Do not delete `user` scope.
- Do not allow cleanup of `user` through this API.
- Cleanup should be idempotent.
- Cleanup should be safe to run after a crash.
- If one table fails, report error and continue where safe.
- After cleanup succeeds, clear active demo state and set scope to `user`.

Suggested order:

1. Stop demo timers/watchers.
2. Delete child tables first:
   - vault subject links
   - notification rows
   - chat messages
   - staging rows
3. Delete parent rows:
   - vault items
   - reminders
   - people surfaces
   - people
   - service drafts
4. Clear runtime in-memory caches for scoped tables.
5. Rehydrate user scope if needed.
6. Switch to `user`.

## Brain / Core Boundary

The guided demo should use normal prompts. The scope should be invisible to the
LLM.

### Mobile In-Process

If Brain and Core run in the same JS runtime:

- `currentDataScope()` can be read by repositories.
- The remember/ask paths do not need prompt changes.
- Reminder creation, people extraction, subject linking, and vault writes all
  inherit scope from repositories.

### Out-Of-Process / Lite

If Brain calls Core over HTTP:

- Core should be the authority for data scope.
- Internal Core routes may accept an internal `data_scope` field/header only
  from trusted local callers, or derive it from Core's active demo state.
- Never accept arbitrary external D2D/service traffic that sets data scope.
- D2D inbound should default to `user` unless the guided demo explicitly injects
  a local demo event.

## Demo Data Providers

### PeerLens Demo Data

Seed deterministic PeerLens chair data in demo scope.

Minimum dataset:

```text
ErgoFlex Study Chair
- price: $420
- review: good lower-back support
- trust: high

BudgetLite Chair
- price: $350
- review: poor back support after long sessions
- trust: medium

SpinePro Chair
- price: $850
- review: excellent support
- trust: high
```

Expected recommendation:

- Recommend ErgoFlex.
- Reject BudgetLite because of back support.
- Reject SpinePro because it exceeds budget.

### Service Demo Data

Provide a deterministic demo service provider:

```text
Demo Furniture Availability Provider
capability: product_availability or price_check
```

The service should answer:

```json
{
  "product": "ErgoFlex Study Chair",
  "available": true,
  "price": 420,
  "nearby": "San Francisco",
  "delivery": "2 days"
}
```

Use the real service/card/result rendering path where feasible.

If using a local demo service instead of public AppView:

- Label it as demo provider.
- Still exercise typed schema/result validation.
- Still show the service path card.

### Agent Safety Demo

Use a deterministic local demo agent:

```text
Demo Shopping Agent
```

It should request Health read access through the real approval mechanism.

Do not fake the approval card.

## UI Surfaces

### Chat

Chat is the primary guided demo surface.

Requirements:

- Use normal Chat UI.
- Show demo banner.
- Scripted steps may pre-fill/send messages, but cards/results should come from
  real paths.
- After cleanup, normal Chat is empty.

### People

People must show demo-scope people during the demo.

Requirements:

- Emma appears in Relations.
- Emma does not appear as a D2D Contact.
- After cleanup, Emma disappears.

### Reminders

Reminders must show demo-scope reminder during the demo.

Requirements:

- Emma birthday reminder appears.
- Reminder is enriched with dinosaur context.
- After cleanup, reminder disappears.

### Network

Network may show:

- service query path/result
- PeerLens card/reviews
- publish service draft

Avoid overwhelming the user with the full Network screen during the demo.

### Activity

Activity may show:

- reminder notification
- approval request

After cleanup, demo notifications disappear.

## Functional Invariants

These are non-negotiable:

1. Demo data must not appear in normal user scope after cleanup.
2. User data must not appear inside demo scope.
3. Export/backup must not include demo data.
4. Demo must not create a real D2D contact unless explicitly part of a D2D
   demo.
5. Owner Ask must not show Health approval merely because Health context is
   useful.
6. Agent access to Health must show approval.
7. External service provider must not receive private health/budget/person
   facts unless explicitly approved by the user.
8. Cleanup must be idempotent.
9. Crash during demo must recover cleanly.
10. Demo must be skippable.

## Technical Acceptance Criteria

### Scope Infrastructure

- `DataScope` type exists.
- Runtime defaults to `user`.
- Guided demo creates `guided_demo:<run_id>`.
- Active demo state survives app restart.
- Cleanup deletes exact demo scope.
- Cleanup refuses to delete `user`.

### Repository Coverage

At minimum, scope enforcement must cover:

- vault item writes/reads
- vault subject links
- reminders
- people graph
- chat messages/thread rows
- notifications
- service draft if demo creates one
- PeerLens demo rows if stored locally

### Demo Flow

- User can start demo.
- Emma memory creates relation/person.
- Emma birthday creates enriched reminder.
- Chair ask uses back-pain + budget context.
- PeerLens/service result appears.
- Demo agent approval appears for Health access.
- Publish-service draft appears.
- Finish/skip deletes demo data.
- User lands in empty normal Chat.

## Test Plan

### Unit Tests

Data scope:

- default scope is `user`
- new demo scope has `guided_demo:<id>` shape
- `setCurrentDataScope` changes scope
- `runInDataScope` restores prior scope after success
- `runInDataScope` restores prior scope after throw
- cleanup refuses `user`

Repository tests for each scoped table:

- user and demo rows are isolated
- inserts stamp current scope
- list reads current scope only
- update/delete cannot affect other scope
- cleanup deletes demo row only

Reminder tests:

- reminder created in demo scope is listed only in demo scope
- reminder fire watcher does not fire user reminders while demo scope active
- cleanup removes demo reminder

People tests:

- Emma relation created in demo scope only
- Emma does not appear in user scope after cleanup
- Emma is not a contact unless a DID/contact is explicitly added

Vault tests:

- demo vault items use normal `general`/`health` personas with demo scope
- user `general`/`health` items are invisible during demo
- demo subject links are deleted on cleanup

Export tests:

- export excludes `guided_demo:*`
- clean-install guard ignores completed demo scope or requires cleanup first

### Integration Tests

Guided demo happy path:

1. Start demo.
2. Remember Emma/dinosaur/birthday.
3. Assert people relation.
4. Assert reminder exists and is enriched.
5. Remember user health/budget.
6. Ask chair question.
7. Assert answer references budget/back support.
8. Assert PeerLens/service card.
9. Trigger demo agent Health request.
10. Approve.
11. Assert agent continues.
12. Finish demo.
13. Assert user Chat/People/Reminders are empty.

Skip path:

1. Start demo.
2. Create some demo data.
3. Skip.
4. Assert cleanup.

Crash recovery path:

1. Start demo.
2. Create data.
3. Simulate app restart.
4. Assert Continue/Delete prompt.
5. Delete.
6. Assert cleanup.

Leak test:

1. Create real user memory.
2. Start demo.
3. Assert real memory is not visible in demo.
4. Create demo memory.
5. Exit demo.
6. Assert real memory remains and demo memory is gone.

### Manual Release Test

Add a guided demo release test:

```text
MRS-GD-01 Guided demo path
- On a clean install, tap "See Dina in action".
- Complete Emma memory.
- Confirm Emma appears under People/Relations.
- Confirm Emma birthday reminder appears and mentions dinosaurs.
- Complete chair query.
- Confirm recommendation uses lower-back pain + $500 budget.
- Confirm service/PeerLens result card appears.
- Confirm agent Health approval appears only for demo agent.
- Finish demo.
- Confirm normal Chat, People, Reminders are empty.
```

## Implementation Phases

### Phase 1: Scope Infrastructure

- Add `DataScope` type and runtime manager.
- Add active demo state persistence.
- Add cleanup service skeleton.
- Add unit tests.

### Phase 2: Schema

- Add `data_scope TEXT NOT NULL DEFAULT 'user'` to scoped tables.
- Update schema validators/tests.
- Greenfield release: no compatibility migration complexity is required beyond
  normal schema initialization.

### Phase 3: Repository Enforcement

- Add scoped query helpers.
- Update scoped repositories.
- Add leak/isolation tests per repository.
- Ensure export excludes demo scope.

### Phase 4: Guided Demo Orchestrator

- Add mobile guided demo entry screen.
- Add demo banner.
- Add start/skip/finish/recover flows.
- Add cleanup call.

### Phase 5: Demo Content

- Add Emma memory step.
- Add chair context step.
- Add PeerLens/service demo data.
- Add demo agent approval event.
- Add publish-service draft.

### Phase 6: End-To-End Tests

- Add unit, integration, and manual release coverage.
- Add Maestro flow if stable enough.

## Risks And Mitigations

### Risk: Missed Query Leaks Demo/User Data

Mitigation:

- Repository-level helpers.
- Tests for every scoped table.
- Architecture test that scoped table queries include `data_scope`.

### Risk: Global Runtime Scope Causes Cross-Request Bugs

Mitigation:

- V1 mobile is local/exclusive during demo.
- For server/lite, derive scope from Core active demo state or trusted request
  context.
- Do not allow external D2D/service callers to choose scope.

### Risk: Demo Feels Fake

Mitigation:

- Use real remember, reminder, people, approval, and card paths.
- Demo data/provider can be seeded, but cards should come from real renderers.
- Label providers as demo providers when applicable.

### Risk: Demo Becomes Too Large

Mitigation:

- Keep primary guided demo to one chair story + Emma reminder + agent approval.
- Leave D2D Talk as optional future demo.
- Do not build a full marketplace UI for the demo.

### Risk: Cleanup Deletes Real Data

Mitigation:

- Delete by exact `data_scope`, never timestamp.
- Cleanup refuses `user`.
- Demo runs in exclusive scope.

## Final Recommendation

Implement first-class `data_scope`.

This is better than timestamp cleanup and cleaner than separate demo personas.
It lets Dina use normal prompts, normal personas, normal repository paths, and
normal UI while keeping demo data perfectly removable.

The first guided demo should be:

```text
Emma relation + dinosaur birthday reminder
-> user back-pain/budget chair recommendation
-> PeerLens/service result
-> demo agent asks for Health access
-> publish-service draft
-> cleanup and start empty
```

This is the smallest path that shows Dina's core product: private memory,
personal context, peer/service network, agent safety, and provider publishing.
