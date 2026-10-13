# Fixes for part 2 of the real-life scenarios

> **Status:** revision 4 (2026-10-09), after three rounds of dual review
> (45 findings, all taken; round 3's six folded in; see §17). Built on
> 2026-10-09, steps 0–10 of §13; where the build differs from the design,
> §18 says so.
>
> **Source:** the findings table in `docs/REAL_LIFE_SCENARIOS_2.md` (first
> run, 2026-10-09: 13 findings over 18 failing stories and 2 confirmed
> gaps), plus one access problem found while tracing W4 (§7).
>
> **Order of authority:** `dina_details.md` (the owner's spec) first, then
> `README.md` and `ARCHITECTURE.md`, then the design docs under `docs/`, then
> the code.
>
> **Owner decisions (2026-10-09):** agent spending limits are built as owner
> pre-approval of a budget (§15). Dina still never holds or moves money.
> Purchases within a budget are logged quietly, not announced one by one
> (the owner chose this over a notice per purchase).

## 0. Rules every fix follows

The rules of `docs/REAL_LIFE_FIXES.md` §0 hold unchanged:

1. **General, not test-shaped.** No fix keys on a scenario's wording, names
   or numbers, and each fix's tests use inputs the scenario suite never uses.
2. **Both hosts.** The phone (Core and Brain in one VM) and the server (two
   processes, signed HTTP) behave the same.
3. **Core enforces, Brain proposes.** Access, consent, deletion, egress and
   spending decisions live in Core, in compiled code, with no model in the
   decision. Brain is an untrusted tenant. A defence that only stops an
   honest Brain being misled (and not a compromised one) says so.
4. **Personas are user-configurable.** No hard-coded persona list.
5. **No PII in logs.** Metadata only.
6. **`legacy/` stays untouched.**
7. **Fail honestly and fail closed.** Dina never reports an action that did
   not happen; an error in an access check denies.

Two building blocks from part 1 are reused:

- **Owner-turn proof** (`packages/core/src/a2a/span_proof.ts`,
  `packages/brain/src/chat/owner_turns.ts`): Core checks that words came
  from the owner's current turn before acting on them.
- **Core-held confirm card** (`packages/core/src/talk/owner_send.ts`
  `confirmCard`): an approval workflow task holding the exact action.

**Every new card type is Core-minted.** Today Brain can both create and
approve part 1's message card: `owner_talk_send` is missing from
`CORE_MINTED_PAYLOAD_TYPES` (`server/routes/workflow.ts:1567-1604`), so the
create route (`:494`) and Brain's decision guard (`:249-255`) let a `brain`
caller through. This round adds `owner_talk_send` and every new card type
(`owner_forget`, `owner_standing_reply`, `owner_spend_allowance`) to that
set, so Brain can neither create nor decide them. `owner_forget` and
`owner_spend_allowance` are also presence-gated
(`PRESENCE_GATED_PAYLOAD_TYPES`): only an owner device present at the time
can approve them.

**Guard modes live in Core.** The new reply guards (§3, §6.2) start in
`report` mode (they log what they would change) and move to `enforce` once
both scenario suites show no wrong changes. The mode is a Core setting read
by Brain (`GET /v1/settings/guard-modes`), not an environment variable, so
the phone and the server behave the same.

**The owner's time zone.** No owner time zone exists today: the time block
and the remember runtime use the host's zone
(`reasoning/ask_handler.ts:256-258`, `composition/remember_runtime.ts:131-135`),
which on a server is often UTC. Core gains an `owner_timezone` setting. The
phone writes it at boot from the device; the web app writes it on owner
sign-in; the host zone is the fallback. Every date this design shows or
reasons about (§8.4, §10, §15) uses it.

## 1. Map from finding to fix

| Finding (REAL_LIFE_SCENARIOS_2) | Stories | Fix |
|---|---|---|
| 1 Empty replies | R1, S6 | §2 |
| 2 Claims an action it did not take | W5 | §3, §4 |
| 3 No way to forget | Y3 | §4 |
| 4 "I'm here" at 3am | O8 | §6 |
| 5 Medical and legal facts stated as fact | P1, P9, R5 | §6 |
| 6 Agent's work question skips the work vault | W4 | §7 |
| 7 A changed fact stored beside the old one | Y2 | §8 |
| 8 Stored facts missed; dates misjudged | O1, Q2, Q4, Q5, R3 | §9, §10 |
| 9 No gift ideas when the network is empty | S5 | §11 |
| 10 No export | Z6 | §5 |
| 11 Introductions; raw JSON in a service reply | V8 | §12 |
| 12 Reminder lines with no dates after /remember | W4, Y3 | §8.4 |
| 13 Standing replies; spending limits (gaps) | W6, X9 | §14, §15 |

§13 is the build order; §16 the tests that close each finding.

## 2. Never an empty reply (finding 1)

### 2.1 Root cause

All four empty turns had the same shape (brain.log, R1 turns 3–4, S6
three times): the model's last response was a `draft_quote_request` tool
call with no text.

- `draft_quote_request` is a **terminal** tool
  (`packages/brain/src/reasoning/quote_request_tool.ts:110`). When a
  terminal tool succeeds, the loop ends the turn with whatever text came
  with the call: `answer = resp.content` (`agentic_loop.ts:600-603`), which
  is `''` when the model sent only the call. The tool's own description
  asks the model to "say in one line that the draft is ready", which the
  terminal rule makes impossible.
- `translateLoopResult` (`composition/ask_coordinator.ts:649-657`) has an
  empty-text fallback for `invoke_plugin` only.
- The fast path (`coordinator_ask_handler.ts:437-440`) posts the card with
  empty content and returns `response: ''`. The deferred path
  (`:297, :353-358`) overwrites the "Working on it" placeholder with the
  empty text, blanking the one bubble the owner had.
- The orchestrator (`chat/orchestrator.ts:322-334`) reads an empty
  `response` as "the handler posted its own message" and adds nothing.

The same gap exists for the other terminal tools, `query_service`
(`service_tools.ts:560`) and `coordinate_group` (`group_tools.ts:109`).

Two secondary faults showed in the same turns:

- **Wrong tool.** In R1 the model picked `draft_quote_request` for "Mum
  can't manage stairs" and "put the plan together", carrying over an
  earlier offer. In S6, "Ask ChairMaker for a quote…" names a contact, but
  the quote tool searches suppliers and sends nothing to ChairMaker.
- **Batched calls cut off.** A terminal tool batched after `remember`
  ended the turn before any planning answer.

### 2.2 Design

1. **Every terminal tool owns its acknowledgement.** `AgentTool` gains an
   optional `ownerNote(result): string` for terminal tools. It returns a
   plain sentence built from the tool's own result, never from model text:
   - quote draft: "I've drafted a request for quotes for {items}. Open the
     card to choose suppliers and send it; nothing has been sent yet."
   - group plan: "I've started the plan with {n} people; their answers
     will appear on the card."
   - service query: "I've asked {provider}; the answer will appear on the
     card."
   - plugin call: the note `invoke_plugin` already returns (today read by
     `extractPluginInvocationNote`, `ask_coordinator.ts:789`).
   `ownerNote` is required for a tool registered with `terminal: true`; the
   four terminal tools today are `draft_quote_request`, `query_service`,
   `coordinate_group` and `invoke_plugin`. Registration fails without it.
2. **The loop uses it.** In `agentic_loop.ts`, when a terminal tool
   succeeds and `resp.content.trim()` is empty, the answer is the tool's
   `ownerNote(result)`. When the model did write text, its text is kept.
3. **One last guard for every path.** `translateLoopResult` (both the
   fast and deferred paths go through it) never returns empty text when
   the turn carries no card: with no model text and no tool note it returns
   "I couldn't put a reply together for that. Could you say it another
   way?". In the deferred path's plain-answer branch
   (`coordinator_ask_handler.ts:350-362`) the placeholder is never patched
   to `''`. Where a service, missing-capability or failure card is the
   turn's one artifact, the placeholder is still cleared on purpose
   (`:322-324, 343-345, 386-388`): the card is the reply. For the
   orchestrator's "settled" check, a card message counts as content.
4. **Tool choice.**
   - The quote tool's description says it searches suppliers on the Dina
     network; when the owner names a contact ("ask ChairMaker for a
     quote"), use `send_message` instead (the message waits for the
     owner's confirm, as part 1 §7 built).
   - Terminal tools are skipped, with a log line, when the same model
     response also carries non-terminal calls: the non-terminal calls run;
     each skipped terminal call gets a tool result ("not run: call it on
     its own after the others"), so every call in the transcript has its
     result, as providers require; the model then gets one more iteration.
     A terminal tool still ends the turn when it is the response's only
     call.

### 2.3 Hosts

All in Brain (`packages/brain`); both hosts run the same loop.

## 3. Say only what was done (finding 2)

### 3.1 Root cause

W5: "Archive my work stuff, but keep what I need for references." The
model called `remember` on the instruction itself ("Saved to Work"), then
wrote a "Keep / Archive" plan in the past tense. No archive tool exists,
and nothing checks that what a reply says was done matches what the
turn's tools did.

- The owner-chat registry (`composition/agentic_ask.ts:425-635`) has no
  delete, archive or forget tool.
- `VAULT_CONTEXT` (`llm/prompts.ts:432-489`) has no rule about requests
  Dina cannot carry out.
- `scanResponse` (`guardian/guard_scan.ts:507-537`) takes tool **names**
  only, and the production call (`ask_coordinator.ts:559, 567-577`) passes
  only the question and keeps only `anti_her` findings. Nothing sees tool
  results or acts on other findings.

### 3.2 Design

1. **Prompt rule** (in `VAULT_CONTEXT`): "Only say you did something when
   a tool reported it done. If you cannot do what was asked, say so and
   say what you can do instead. When a tool says a card is waiting, say it
   is waiting."
2. **`remember` description:** instructions addressed to Dina ("archive…",
   "delete…", "tell…") are requests, not facts to save.
3. **Receipts.** Every action tool returns a receipt in its result:
   `{op_id, action, status, targets[], object}`: `op_id` is the operation's
   own id (task, item or reminder id); `object` is what was acted on (the
   message text for `send_message`, the stored item's summary for
   `remember`, the reminder title for `schedule_reminder`). Statuses:
   `send_message` `sent` or `confirm_pending`; `remember` `stored` or
   `duplicate`; `forget` `confirm_pending`; `schedule_reminder`
   `scheduled`. The loop collects them in the result (`toolLog` already
   carries outcomes, `agentic_loop.ts:231`). Receipts from the last 10
   turns are kept on the thread in Core chat storage. They hold names and
   message text, so they are content: forget scrubs them (§4.4).
4. **Action-claim check** (Brain, deterministic, new module
   `guardian/action_claims.ts`), run on the delivered answer in
   `guardCompletedResult` for both the fast and deferred paths and on
   resume:
   - It looks only at first-person present-perfect claims about an
     action on an object: "I've / I have {verb} {object}" and "Done: …",
     with verbs from a fixed table (sent, messaged, deleted, forgotten,
     archived, cancelled, booked, ordered, paid, transferred, scheduled,
     set a reminder, saved, stored, shared, exported). Phrases where the
     verb is about the reply itself are not claims ("I've ordered the list
     by date", "I've removed the duplicates from this list": the object is
     the answer's own content). Quoted and drafted text ("the draft says
     'I've paid'") is skipped.
   - **A claim is never judged by its wording; it is rewritten from the
     receipt.** Matching words against a receipt cannot tell "renew" from
     "cancel" when the rest is the same. So a claim sentence is replaced,
     in every case, by a line built from the receipt itself:
     - a backed send: `Sent to {recipient}: "{exact text}"`; a draft
       waiting: `Waiting for your OK: a message to {recipient}: "{exact
       text}"`;
     - a save: `Saved to {persona}: "{summary}"`; a reminder: `Reminder
       set: {title}, {date and time}`; a forget: `Waiting for your OK on
       the card: forget {what the card covers}`.
     The owner reads what actually happened, in Core's words, whatever the
     model wrote.
   - **Which receipt backs it.** A claim backs onto a receipt with the
     same action and, where the claim names a target, the same target. A
     receipt from this turn backs any claim. An earlier turn's receipt
     backs only a claim that refers back to it ("already", "earlier",
     "before", "yesterday", "last time"), whatever the tense: "I've
     already sent it to Priya" and "I sent it earlier" both back onto last
     turn's send, and are rewritten as `Already sent to Priya earlier:
     "{exact text}"`. A claim with no backing receipt is replaced by "I
     haven't done that."
   - "Ordered", "paid" and "transferred" are never backed (Cart Handover:
     Dina has no such tool).
   - An unbacked claim sentence is replaced by "I haven't done that." The
     rest of the reply, including true statements about what did happen,
     is kept.
   - It starts in `report` mode (§0). This guards an honest model's slip;
     a compromised Brain can skip it (§0 rule 3).
5. **Archive** is not a separate state. "Archive X" is served by the
   forget flow (§4) with a keep list: the card lists what will be deleted
   and what is kept. A future archive state (hidden from recall, kept for
   export) is out of scope.

## 4. Forgetting (finding 3, and the archive half of finding 2)

### 4.1 Root cause

- There is no owner path from chat to delete anything. Brain cannot
  delete vault items, correctly: `DELETE /v1/vault/item/:id` is owner-only
  (`server/routes/vault.ts:262-279`), and Brain's origin is denied
  (`vault/origin_capability.ts:50-55`).
- Deletion itself does not forget. `deleteItem` (`vault/crud.ts:691`) is a
  soft delete (`repository.ts:285-297`, `deleted=1`):
  - the row keeps its encrypted text and embedding;
  - the in-RAM vector index keeps the vector (`removeFromIndex`,
    `embedding/persona_index.ts:86`, has no callers);
  - `vault_item_subjects` links stay;
  - person excerpts keep the text (`people.clearExcerptsForItem`,
    `people/repository.ts:688`, has no callers);
  - reminders made from the item stay (`reminders` `source_item_id`);
  - a topic's `sampleItemId` can still point at it.
- Copies live elsewhere too: owner chat messages (Core chat storage,
  re-sent to the model each turn through `buildTurnHistory`), Brain's
  in-memory thread copies, staging rows not yet stored
  (`staging/repository.ts:93-110`), memory topics named after the person,
  and workflow events that copy a card's payload
  (`workflow/service.ts:671`).
- People can be tombstoned (`rejectPerson`, `people/repository.ts:449`),
  but no route exposes it.

### 4.2 The request

One request shape, `ForgetRequest`, exactly one of:

- `{person: string}`: a person by name or surface;
- `{persona: string, keep_item_ids?: string[]}`: a whole persona's items,
  except those kept (the archive case);
- `{item_ids: string[]}`: items Brain picked (for "forget that note about
  the jacket"). The card marks these "chosen by Dina" so the owner checks
  them.

For a `persona` or `item_ids` request there is no person whose name marks
the copies, so chat messages are not searched; the card says so ("what
you said about it in conversation stays; ask me to forget a person to
remove that too"). Staging copies are always found through the item link
(below).

Core resolves `person` and `persona` from its own data; it never trusts
model text for which items those cover. Brain sends the request with an
owner turn proof (new `SpanProofKind 'forget'`). Core checks the proven
turn contains a forget instruction: one of forget, delete, erase, remove,
archive, "get rid of", within the proven span. The card is raised in every
case; the instruction check stops an agent or a contact's text from
starting one.

### 4.3 The plan

`planForget(request)` (Core, `packages/core/src/forget/plan.ts`) builds a
frozen list:

- **Person:** resolved like part 1's `resolveContactRef`; ambiguous → the
  plan lists the candidates and cannot be approved.
- **Items:** linked through `vault_item_subjects`, plus items whose text
  contains a confirmed surface of the person as a **whole word**
  (FTS5 exact phrase, never the prefix form of §9.2, so "Anna" never
  plans "Annabel"); for a persona request, every item in it minus the
  kept ids. Open personas only.
- **Reminders:** those whose `source_item_id` is in the plan, and those
  whose text contains a surface as a whole word.
- **Chat messages:** owner-thread messages containing a surface as a whole
  word (counted on the card; the Talk thread with a contact is listed
  separately and removed only if ticked).
- **Staging rows:** every row linked to a planned item (stored rows keep
  the classified copy, `staging/service.ts:674-712`), and, for a person
  request, rows not yet stored that mention a surface as a whole word.
- **Topics** named after the person, and topics whose sample is in the
  plan.
- **Contact:** listed, removed only if ticked.

The card shows counts per kind and short labels. It also says what
forgetting cannot reach: closed personas ("Health was closed and not
searched: unlock it and ask again to include it"), backups made earlier,
and messages already sent to other people.

### 4.4 Execution: a durable job

On owner approval (presence-gated, §0), Core writes a `forget_jobs` row
(identity.sqlite: `id, plan_json (ids only), step, done_steps_json,
created_at, finished_at`) and runs the steps in order. Each step is
idempotent and is recorded in `done_steps_json` when it finishes:

1. items: text fields (body, summary, `content_l0/l1`, tags, metadata),
   embedding and `contact_did` cleared, `deleted=1`; the FTS row follows
   through the update trigger (`schemas.ts:3945-3957`); the row id stays
   as a tombstone. An item already tombstoned is still cleared and its
   dependants still processed. The persona file runs with
   `PRAGMA secure_delete=ON` for this step and a WAL checkpoint after it.
2. vectors: `removeFromIndex`.
3. subject links deleted; `clearExcerptsForItem`.
4. reminders deleted.
5. chat messages, staging rows (stored and not yet stored, and Core's
   cached copies of them) and thread receipts naming a surface deleted;
   for every kind of request, receipts whose `op_id` is a planned item,
   reminder or task are deleted too.
6. person tombstoned (`rejectPerson`), its surfaces removed; topics
   dropped or re-sampled; the contact if ticked.
7. readable exports (§5) not yet fetched are cancelled.
8. the card's payload and its workflow events are scrubbed to counts.
9. `forget_epoch` (a Core counter) is raised; Brain reads it before each
   turn and reloads its thread copies when it changed.
10. one audit entry: counts and ids, no text.

Every database the job deletes from (each persona file and
identity.sqlite) runs with `PRAGMA secure_delete=ON` for the job and gets
a WAL checkpoint after it.

**A persona that closes.** Planned items may sit in a sensitive or locked
persona that closes before approval or is closed at boot. The job never
waits on it: it finishes every step for open personas, records the
closed persona's ids as pending (`pending_persona` in the job row), and
reports "Forgotten, except {n} items in Health, which is closed: they will
be forgotten when you next unlock it." On the next unlock Core finishes
those ids **inside the unlock sequence**: after the key opens the file,
before the persona is marked open and before its vector index is loaded.
If that step fails, the persona stays closed and the owner is told why;
it never opens with forgotten items in it. The owner is then told the
forgetting is done. A job's
final state is always `done` or `waiting_on_unlock`, both reported.

A job interrupted by a crash or restart resumes at boot (both hosts run
Core's boot sequence) from its first unfinished step. The owner is told it
is done only when every step has finished; the reply until then is "I'm
forgetting it now."

### 4.5 Brain tool

`forget` (owner chat only, never registered for agent asks) takes a
`ForgetRequest`, calls `POST /v1/forget/propose` with the turn proof, and
returns `confirm_pending` with the card's summary. The reply says a card
is waiting and what it covers.

### 4.6 Hosts

Core logic is shared. On the phone the card appears in Approvals; on the
server, in the web app's approvals. Both run the job in Core.

## 5. "Everything you know about me" (finding 10)

### 5.1 Root cause

The only export is the encrypted `.dina` backup (`export/archive.ts:554`):
a restore format, reachable from the phone's Admin screen, not from chat,
and not readable by the owner. `/v1/export` is admin-only
(`auth/authz.ts:452`). The prompt tells the model to skip locked personas
silently (`prompts.ts:470`), which makes an honest "everything" answer
impossible.

### 5.2 Design

1. **Core `buildReadableExport()`**: a JSON document with
   - a manifest: persona name, tier, included or not, and why not
     ("closed: unlock to include");
   - per included persona: items (summary, body, type, created);
   - people (names, relationships, surfaces), contacts, reminders, memory
     topics, preferences.
   Default and standard personas are included. Sensitive and locked
   personas are included when the owner has them open (a locked persona
   is open only after its passphrase); closed ones are listed with how to
   include them ("unlock Finance and ask again"). Secrets follow the
   archive's existing denylist.
2. **Two routes.**
   - `POST /v1/owner-export/prepare` (Brain may call it): builds the
     document and keeps it **in memory only**, under a random id, for 15
     minutes; returns the manifest and the id. Possessing the id gives no
     access.
   - `GET /v1/owner-export/:id` (owner caller only: `callerType ===
     'owner'` with the owner capability, as `makeOwnerGuard` checks; a
     Brain request, including phone Brain's in-process call, is refused):
     returns the document once, then drops it.
3. **Brain tool `export_my_data`** (owner chat only) calls `prepare` and
   posts an export card (`lifecycle.kind: 'export'`). The reply names what
   is in it and what is not ("Health and Finance are closed and not
   included").
4. **Phone:** the card's button fetches the document through the owner
   path and opens the share sheet; the temporary file is deleted when the
   sheet closes. **Server web app:** the card downloads it.
5. Prompt line 470 changes: skip closed personas quietly in ordinary
   answers, but when the owner asks what Dina holds, name them.

## 6. Staying human, and no verdicts about the owner (findings 4 and 5)

### 6.1 Anti-Her (finding 4)

**Root cause.** The O8 reply named Mum and offered a draft, then ended
"if it's just the quiet you need: I'm here. Talk to me about Leela".
Four layers missed it:

- the emotion gate `EMOTION_CUES` (`guardian/anti_her_classify.ts:192`)
  has no cue for tiredness, sleeplessness or "someone to talk to", so the
  classifier never ran and no people instruction was added
  (`ask_coordinator.ts:383-391`);
- the classifier prompt (`llm/prompts.ts:339`) reserves
  `companionship_seeking` for "explicitly treats the AI as a relationship";
- the prompt rule (`prompts.ts:474`) forbids offering Dina as the "main"
  support, which the model read as allowing a fallback offer;
- the output lists (`guardian/anti_her.ts:47-80`) catch "I'm here to
  listen" and "I'm always here" but not "I'm here." or "talk to me".

**Design.**

1. **Cues decide only whether to ask the classifier.** `EMOTION_CUES`
   gains: tired, exhausted, drained, can't/won't sleep, awake all night,
   need someone/somebody, someone to talk to, keep me company, stay with
   me. A cue never sets a category by itself.
2. **One user-side pattern sets `isolation` directly**, anchored so the
   clause ends after "talk to" or "listen": "I (just) need
   someone/somebody/anyone to talk to / to listen" followed by the end of
   the clause. "I need someone to talk to the landlord" does not match.
3. The classifier prompt lists "I just need someone to talk to" and "keep
   me company" as `companionship_seeking`.
4. The prompt rule becomes: "never offer yourself as company, a listener
   or someone to talk to, not even as a fallback."
5. **Output check, on a positive verdict only.** When the turn's
   classifier verdict is one of `HUMAN_CONNECTION_KINDS` or `venting`
   (not merely a cue match), Dina's own sentences are checked for an
   offer of herself as company: a sentence that is only "I'm (right)
   here (with/for you)", or "talk to me (about …/whenever/anytime)",
   "keep you company", "I'll stay/be (up) with you". A sentence that
   explains how something works ("when you talk to me, …") is not an
   offer. A hit is removed and the people line the guard already builds
   (`peoplePointerLine`) is added if absent.

### 6.2 No verdicts about the owner from model knowledge (finding 5)

**Root cause.** No rule covers health, legal or money advice. The
`general_knowledge` source means "facts the model itself knows"
(`prompts.ts:440, 449`); the "don't fill the gap from your own knowledge"
rule covers products only (`:472`); the guard's fabrication check
excludes medical values and amounts (`prompts.ts:228+`). So P1's "normal
range, no longer pre-diabetic", P9's schedule and R5's "21 days … 1,519
SDR" came from model knowledge with nothing to stop them.

**Design.**

1. **Prompt rule** (`VAULT_CONTEXT`, and the `general_knowledge` legend):
   "On health, legal and money questions about the user: report what
   their records say (values, dates, the direction and size of a change,
   what a named doctor or document said). Do not turn it into a verdict
   about them: no diagnosis or category, no clinical thresholds, doses or
   schedules, no legal deadlines, limits or entitlements stated as what
   applies to them. Say who decides (their doctor, named from their
   contacts or notes when present; the airline's conditions; their policy
   wording) and offer to draft the question. You may say a general rule
   exists and where to check it, without stating its figures as fact."
2. **Guard category `regulated_sentences`** in the guard prompt, with the
   allowed cases spelled out (stored facts, trends, arithmetic on stored
   numbers, a named source's own words, pointing to someone).
3. **Deterministic backstop** (Brain, `guardian/regulated.ts`), on turns
   whose question or evidence touches health, legal or money terms (a
   fixed word list; personas are not hard-coded). **Evidence** is the
   user's turns, the tool results, the pre-flight retrieval block
   (`ask_coordinator.ts:431-454`) and the time block. Dina's own earlier
   replies are never evidence, for either test, so an earlier mistake
   cannot back a later one. Two separate tests:
   - **Verdict words about the user** (normal range, pre-diabetic,
     diabetic, entitled to, eligible for, liable, due for a {vaccine or
     test}, compensation of): a sentence with one is never judged by
     whether its words appear somewhere, since that cannot tell whose
     result it is or whether it was negated ("Dr Rao: your mother is
     diabetic; you are not"). Instead:
     - when exactly one evidence item contains the verdict word, the
       sentence is replaced by that item's own words, quoted and
       attributed: `Your notes say: "{item text}"`;
     - otherwise the sentence is removed.
     This handles "you are no longer pre-diabetic" (no number), "your 5.9
     is in the normal range" (the number is stored, the verdict is not)
     and a verdict borrowed from someone else's result.
   - **Unsupported figures** (a threshold, dose, period or amount) in a
     sentence with a regulated term: flagged when the figure is not in the
     evidence and not computable from it (sum, difference, date gap
     against the time block's today). "Overdue by 5 days" from a stored
     promise date and today is computable and passes.
   A flagged sentence is removed and one line added: "For what this means
   for you, ask {who decides}." Counts are logged.
4. Starts in `report` mode (§0).

## 7. Agents and work-type vaults (finding 6)

### 7.1 Root cause

The code does not match the documented tiers. `README.md:519`,
`ARCHITECTURE.md:124` and `CLAUDE.md` say a **standard** persona (`/work`)
needs a session grant for agents; `docs/AGENT_CONTROL_PLANE.md:216` lists
the free access as a known gap and sets the target: owner-chosen context
grants at pairing, with existing installs moved through explicit,
audited baseline grants. But `agentCanAccess`
(`packages/core/src/vault/lifecycle.ts:63-66`) returns true for default
**and** standard, and `requireAgentPersonaAccess`
(`agent/access.ts:198-211`) and Brain's mirror (`persona_guard.ts:303`)
follow it. So W4 could never raise a work card.

The vault was also never searched. The agent's ToC is one merged top-20
across personas (`agentic_ask.ts:780`), "Orion" did not make the cut, and a
famous public name pushed the classifier to `general_knowledge`, whose
rule is "answer directly without tools" (`prompts.ts:449`).

### 7.2 Design (the control-plane target)

1. **Tier rule.** `agentCanAccess(tier, hasGrant)` = `tier === 'default'
   || hasGrant`.
2. **Callers.** The predicate is used by `requireAgentPersonaAccess` (agent
   asks, agent vault reads, intent context) and by the connected-Brain
   facades (`packages/core/src/agent/connected_brain_facades.ts:271-292`). Both follow the
   new rule. The owner, Brain as a service caller, and in-process owner
   calls never reach it and are unaffected.
3. **A standing grant kind.** Today a grant needs a numeric expiry and an
   exact `session_id` match (`agent/grant_repository.ts:20, 179-189`, and
   the in-memory twin at `:297-305`). A schema migration adds
   `grant_kind` (`'session'`, the default and every existing row, or
   `'standing'`) and `granted_tier`. A standing grant has `expires_at`
   NULL (no expiry) and `session_id` NULL, and matches any session of
   that agent; `approval_task_id` is `baseline_migration:<id>` or
   `pairing:<id>`. Both repositories implement the same rule: a session
   grant matches as today; a standing grant matches on agent, persona and
   mode alone. Expiry sweeps skip standing grants. Existing rows keep
   their meaning exactly.
4. **Grants are bound to the tier they were given at.** Every grant
   records `granted_tier`. A grant counts only while the persona's tier
   is no more protected than `granted_tier`, checked at match time in
   Core. Core has no way to change a persona's tier today
   (`setPersonaTierInMemory`, `persona/service.ts:304`, is Brain's
   unpersisted mirror and must not be used for this); the real path is
   deleting a persona and creating one with the same name at another
   tier. So `deletePersona` (`persona/service.ts:131`, through its
   `onPersonaDeleted` listener) revokes every grant on that persona, with
   an audit entry, and the match-time tier check covers any tier change
   added later.
5. **Existing pairings keep working.** A one-time migration writes a
   standing grant (mode `read`, `granted_tier 'standard'`) for each
   standard persona to each active agent and connected-Brain pairing that
   exists at upgrade. Each grant is audited and listed on the Agents
   screen, where the owner can revoke it. No pairing loses access
   silently.
6. **New pairings.** The pairing ceremony shows the standard personas
   with none ticked; ticked ones become durable grants. An agent that
   later asks for an unticked standard persona gets the usual approval
   card (session scope offered first). A background task with no owner
   present waits on that card like any other.
7. **The agent's classifier sees gated personas.** For an agent ask, the
   ToC lists each persona the agent may not read as `{name, description,
   gated: true}` with no topics (`server/routes/memory.ts:196-204` returns
   nothing for them today).
8. **Vault before general knowledge, for agents.** In an agent ask, the
   vault fan-out runs before any `general_knowledge` answer. If the
   classifier names a gated persona, the ask raises the access request at
   once (the existing `agentPersonaAccessRequest`).
9. **ToC per persona.** The ToC returns the top 8 topics per persona,
   merged after, so a busy persona cannot crowd out another.

## 8. Remembering: changed facts and reminder dates (findings 7 and 12)

### 8.1 Root cause: changed facts

Duplicate detection is exact text only (`vault/crud.ts:204-221`, a hash
of normalised text). Nothing detects that a new fact changes an old one.
The vault has a `contradicts` column (`crud.ts:301`,
`schemas.ts:3899`), but nothing sets it. The remember runtime
(`composition/remember_runtime.ts:154-222`) has `vault_search` but its
prompt (`prompts.ts:631-645`) uses it only to enrich reminders, and the
model's closing text is dropped (`staging/drain.ts:514`).

### 8.2 Design: changed facts

1. **Remember tool `note_change`** in the remember runtime:
   `{prior_item_id, relation: 'supersedes' | 'conflicts'}`. The prompt:
   "Before routing, search for an earlier memory about the same subject
   and attribute. If it states a different value, call `note_change`:
   `supersedes` when the new message says it changed or corrects it, or
   when it is plainly newer ('moved', 'now', 'new'); `conflicts` when you
   cannot tell."
2. **Core** checks `prior_item_id` exists in an open persona and records
   the link on the new item (`contradicts` = prior id, plus
   `metadata.relation`). A prior id Brain cannot read is refused.
3. **The drain** returns `changes[]` (prior summary, relation) in
   `RememberDrainResult`.
4. **The reply** says it: "Stored in General. Earlier you told me Diya's
   class teacher is Ms Rao; I'll treat Mr Iyer as current." For
   `conflicts`: "…Which is right?" (the next turn's answer is remembered
   as normal).
5. **Ask time.** `vault_search` marks an item another item supersedes
   (`superseded_by`), and the prompt says to treat it as past.

### 8.3 Root cause: reminder lines

After `/remember`, each reminder becomes a chat card whose content is the
raw reminder message, written relative to when it fires ("… is tomorrow",
"… is today", `schedule_reminder_tool.ts:316-318`); the date lives only in
metadata (`chat/reminder_card.ts:26-37`). The phone's card shows the date
from metadata; any text-only reader shows "is tomorrow" for a December
date.

### 8.4 Design: reminder lines

1. The `/remember` reply line names the reminders with dates in the
   owner's time zone: "Stored in Work. Reminders set for 3 Dec, 10:00 and
   4 Dec, 09:00."
2. A reminder card's content is "{date, time} · {message}"; the message
   itself stays relative, because it is shown when it fires.

## 9. Recall: finding what is stored (finding 8, part 1)

### 9.1 Root cause

- **Keyword only.** `executeToolSearch` always sends `mode: 'fts5'`
  (`vault_context/assembly.ts:304, 324`), although the prompt tells the
  model search is semantic too (`prompts.ts:454`).
- **No word forms.** The FTS tokenizer has no stemming
  (`schemas.ts:3938`), and `sanitizeFTSMatch` (`crud.ts:437-445`)
  OR-joins exact tokens, so "receipt" misses "receipts" and "Wednesday"
  misses "Wednesdays".
- **Details hidden behind summaries.** Of the up to 10 items a search
  returns, only rank 0 carries `body` and ranks 0–4 `content_l1`
  (`assembly.ts:314-331`); the rest are a 100-character headline. R3's
  "10:30" lived in the body.
- **Flat scores.** Scores are `1 - index*0.05` per persona, so the fan-out
  merge interleaves personas by position (`vault_tool.ts:421-422`). The
  existing hybrid mode (`crud.ts:498-591`) is no better across personas:
  its keyword half matches raw substrings, and both halves are divided by
  that persona's own maximum (`:570-571`).
- **Small lists.** The retrieval planner fetches 5 items per query and
  renders 5 per persona, 240 characters each
  (`ask_retrieval_planner.ts:579-582`; `brain-server/src/boot.ts:508-520`).
- **No inventory pass.** "What does Kavi's week look like?" needs
  everything recent, not a keyword match; the pickup fact (O1) shares no
  word with the question.

### 9.2 Design

1. **Word forms, for recall only.** A new `recallFTSMatch` (beside the
   unchanged `sanitizeFTSMatch`, which forget and exact lookups keep
   using) drops a trailing possessive ("Kavi's" → `Kavi`), strips one
   common ending (-s, -es, -ed, -ing) from terms of 5+ letters, and adds a
   prefix star: "receipts" → `receipt*`, "booking" → `book*`. Both
   directions then match. Fragments under 3 letters are dropped. No index
   rebuild.
2. **Hybrid when an embedder exists.** When Brain has an embedding
   provider, the query vector is made through `embedMaybeSensitive`
   (`embedding/safe_embed.ts`, the PII-safe path), and the search runs
   both halves: FTS5 with `recallFTSMatch`, and vector. Hybrid's keyword
   half becomes that FTS5 query (not the substring match).
3. **Merging by rank, not score.** Results from each persona and each
   half are merged by reciprocal rank fusion (score = Σ 1/(60 + rank)),
   which needs no comparable raw scores. The prompt at `prompts.ts:454`
   states the mode actually used.
4. **Bodies for short items.** Every returned item carries its body up to
   600 characters; longer bodies keep `content_l1` and the
   `get_full_content` path.
5. **Inventory questions.** The intent classifier gains a flag
   `inventory: true` for questions about everything in a scope ("my
   week", "what do I have", "what am I missing", "what did I promise").
   When set, the planner adds a browse of the relevant personas' 40 newest
   items to the keyword results and raises its per-persona render cap from
   5 to 20.

## 10. Recall: dates (finding 8, part 2)

### 10.1 Root cause

`formatCurrentTimeBlock` (`reasoning/ask_handler.ts:254-271`) gives
`now_iso` in UTC, the host time zone and the weekday, but no local date,
no week boundaries and no rule for deadlines. The model treated a refund 5
days late as "wait a couple of days". The planner's `today` is the UTC
date (`ask_retrieval_planner.ts:305-308`).

### 10.2 Design

1. The time block uses the owner's time zone (§0) and adds: local date and
   time; this week (Monday to Sunday, the dates); next week; and the next
   7 days as a date range. The planner uses the same local date.
2. Prompt rules:
   - "Compare stored dates and deadlines with today. Call a promised date
     that has passed overdue, and say by how many days."
   - "'This week', 'next week', 'the next 7 days' and 'before the weekend'
     mean what they say, using the dates above. When something falls due
     just after the period asked about, you may add it, labelled with its
     day."

Q2's own judge expected bills due next Monday and Wednesday to count as
"this week"; with these rules they are reported as early next week. The
scenario's criterion is corrected to match (§16).

## 11. Ideas without vendor claims (finding 9)

### 11.1 Root cause

`prompts.ts:472-473` forbid naming products, brands or vendors from the
model's knowledge, and also forbid "general suggestions, category lists"
when PeerLens is empty. S5 followed that literally: no gift ideas at all.
The classifier routes buying to PeerLens and products only
(`intent_classifier.ts:172-178`).

### 11.2 Design

The rule separates two things:

- **Kinds of thing** (a fossil-dig kit, a dinosaur book, a puzzle) are
  ideas. Dina may suggest them from general knowledge, labelled as general
  ideas, when the user is choosing what to get.
- **Specific brands, vendors, prices and ratings** stay limited to
  verified sources (PeerLens, network offers, the owner's shops), as now.

The classifier may add `general_knowledge` beside the shopping sources for
idea questions (gifts, what to bring, what to plan).

## 12. Introductions and readable service replies (finding 11)

### 12.1 Root cause

"Introduce Sancho to Albert; Sancho needs a dentist" went to the provider
path: the model called `query_service` on Albert's listing, and the reply
was raw JSON. `formatGeneric` (`service/result_formatter.ts:251-254`)
dumps JSON, breaking the file's own "never raw JSON" rule (`:228`);
`FORMATTERS` cover only `eta_query` and `appointment_status`
(`:104-107`). No tool shares a listing with a contact.

### 12.2 Design

1. **Introductions** need no new channel. The prompt says: "introduce X to
   Y" means telling X about Y; find Y's public listing
   (`search_provider_services`) or Y as a contact, then `send_message` to
   X with a short note naming Y and what Y offers. Because Dina writes the
   words, Core holds it as a confirm card (part 1 §7). Only public listing
   facts go; nothing from the vault.
2. **Readable results.** `formatGeneric` renders any result object as
   short "label: value" lines (arrays of slots as a list of times), never
   JSON. Add a formatter for `appointment_availability` ("Free tomorrow at
   16:00 and 17:30").

## 13. Build order

0. §0 shared pieces: Core-minted card types (including part 1's
   `owner_talk_send`), guard modes in Core, the owner time zone.
1. §2 empty replies (Brain).
2. §3 action claims and §6 human/advice rules (Brain prompts and guard).
3. §7 agent tiers (Core, Brain classifier, ToC).
4. §9 and §10 recall (Core FTS terms and scores; Brain assembly,
   planner, time block).
5. §8 remember changes and reminder lines (Core link, Brain runtime and
   reply).
6. §11, §12 (prompts, formatter).
7. §4 forget (Core plan, route, cascade; Brain tool).
8. §5 export (Core, Brain tool, phone and web card).
9. §14 standing replies (Core table, route, receive hook; Brain tool).
10. §15 spend allowance (Core table, validate, ledger; Brain tool).

## 14. Standing replies (gap W6)

### 14.1 Today

`coordination.request` from a contact is staged and shown to the owner;
nothing answers it automatically (`d2d/receive_pipeline.ts:801`,
`staging/drain.ts:215`). `contacts.sharing_tier` controls what data may be
shared, not what may be said.

### 14.2 Design

1. **Table** `standing_replies` (identity.sqlite): `id, reply_text,
   contact_dids (JSON list), starts_at, expires_at (required, at most 30
   days ahead), created_at, revoked_at, last_sent (JSON map contact →
   time)`.
2. **Always a card.** Brain tool `set_standing_reply {contacts, reply_text,
   until}` → Core `POST /v1/standing-replies/propose` with an owner turn
   proof (kind `standing_reply`). Core resolves each contact name to one
   contact (ambiguous → refused), requires an expiry, and raises a
   Core-minted card (`owner_standing_reply`) that shows every recipient by
   name, the exact text, the expiry, and the rule's reach: "sent in reply
   to any request from these people until {date}". Nothing is active until
   the owner approves. There is no "all contacts" option.
3. **What Core cannot judge.** A condition such as "if they ask about
   work" is not enforced: Core cannot judge a topic without a model. The
   card says the reply goes to any request from the named people, so the
   owner approves exactly what will happen.
4. **On receive.** In `receiveD2D`, after the ingress gates, for a
   `coordination.request` from a contact named in a live rule: Core sends
   `coordination.response {text: reply_text, auto: true}` through the
   normal egress gates, at most once per contact per rule per 24 hours.
   The inbound message is still staged as usual. Nothing is read from the
   vault; no model is involved.
5. **List and cancel.** `GET /v1/standing-replies` and `POST
   /v1/standing-replies/:id/revoke` (owner, or Brain from an owner turn
   whose proof carries a cancel instruction); the tool supports "cancel my
   away reply". Revocation takes effect before the next inbound message is
   handled.

## 15. Agent spend allowance (gap X9; owner decision 2026-10-09)

### 15.1 Today

`purchase`, `payment` and `transfer_money` are HIGH
(`gatekeeper/intent.ts:46-75`); HIGH always raises an approval card
(`server/routes/intent.ts:341-345`). There is no amount in an intent and no
per-agent policy beyond a profile (`agent_gating_policies`). Proposal ids
are made only on the approval path (`intent.ts:366`).

### 15.2 Design

1. **Tables** (identity.sqlite).
   - `agent_spend_allowances`: `id, agent_did, currency (ISO 4217, three
     capital letters), amount_minor, period ('week' | 'month'), timezone
     (the owner's zone when the card was approved), category (the owner's
     words), per_item_cap_minor (optional), expires_at (required, at most
     one year), created_at, revoked_at`.
   - `agent_spend_uses`: `allowance_id, agent_did, request_key (unique per
     agent), payload_digest, decision, amount_minor, merchant, period_key,
     at`.
2. **Values.** Amounts are positive safe integers in minor units; zero,
   negative, fractional, non-number or oversized values are refused with
   400 and nothing is recorded. Sums use checked integer arithmetic.
3. **Only the owner sets one.** Brain tool `set_spend_allowance {agent,
   amount, currency, period, category}` → Core propose route with an owner
   turn proof; Core always raises a Core-minted, presence-gated card
   (`owner_spend_allowance`) naming the agent, amount, period and
   category. Agents and Brain on their own cannot create, raise or approve
   one.
4. **List and revoke.** `GET /v1/spend-allowances` and `POST
   /v1/spend-allowances/:id/revoke`, plus the tool ("stop the shopping
   agent's budget"). Revocation and validation take the same lock, so a
   revoke that returns is final for every later request. Revoking an
   agent's device (`cutDeviceAccess`, `devices/registry.ts:680`) revokes
   its allowances; re-pairing does not restore them.
5. **Agents declare.** `/v1/agent/validate` accepts, for `purchase`,
   `amount {value_minor, currency}`, `merchant`, `category` and a
   `request_key` (required when an amount is given). These are the
   agent's claim; Dina cannot see the cart. Cards and the audit say "the
   agent states ₹X at M". The `dina-agent` CLI and its MCP server gain the
   same fields (`cli/src/dina_cli/main.py`, `mcp_server.py`), with
   contract tests over MsgBox. An older client sends none and gets a card,
   as today.
6. **Decision** (`evaluateSpend`, after `evaluateIntent`, only for
   `purchase` from an agent at or above the trust level that may buy at
   all), in one transaction under the allowance lock:
   - a `request_key` already seen for this agent returns the recorded
     decision when the payload digest matches, and 409 when it does not;
   - otherwise auto-approve only when a live allowance exists for this
     agent, the amount is declared in the allowance currency and under the
     per-item cap, the declared category matches the allowance category
     (case-folded word match), and this period's uses plus this amount
     stay within the allowance. The period is the calendar week or month
     in the allowance's own pinned `timezone`; a later change to the
     owner's time zone (§0) never moves an existing allowance's periods.
     To use a new zone the owner sets a new allowance.
   - Anything else is HIGH and a card, as today. `payment` and
     `transfer_money` are never covered.
   An auto-approval gets a Core-made proposal id (`spend-<random>`),
   recorded with the use row. An owner-approved card that carried an
   amount is recorded the same way, once, keyed by its proposal id.
7. **Failed purchases** stay counted: an agent's report of failure is a
   claim Dina cannot check, and crediting it back would let an agent
   refill its own budget. The owner can raise or reset the allowance.
8. **Money.** An auto-approval only answers the agent's question. The
   agent checks out with its own merchant session; Dina holds no card,
   mandate or token and sends nothing (Cart Handover). Each auto-approval
   is logged quietly, as the owner chose; "what did my agents buy?" lists
   them, and the daily briefing counts them.

## 16. Tests

Each fix's tests use inputs outside the scenario suite.

- **§0:** a `brain` caller gets 403 creating or approving
  `owner_talk_send`, `owner_forget`, `owner_standing_reply` and
  `owner_spend_allowance`; a forget or allowance card needs a present
  owner device; guard modes read from Core on both hosts; the owner time
  zone is used when the host zone differs.
- **§2:** a scripted model returns only a terminal tool call with empty
  content → the reply is the tool's note, on the fast and deferred paths;
  a terminal tool without `ownerNote` fails registration (and
  `invoke_plugin` registers); a response batching `remember` and a
  terminal tool runs `remember`, gives the terminal call a "not run"
  result and iterates; a service-card turn still clears the placeholder.
- **§3:** "I've cancelled your gym membership" with no receipt → "I
  haven't done that."; a send claim is always rewritten from its receipt,
  so "I've sent Priya a request to cancel my gym membership" after a
  message asking to renew it reads `Sent to Priya: "Please renew my gym
  membership"`; "I've already sent it" and "I sent it earlier" both back
  onto last turn's receipt, and a fresh "I've sent it" with no receipt
  this turn does not; "I've sent it to Priya" with a `sent` receipt for
  Priya stands, for Omar it is replaced; "I've drafted it" with
  `confirm_pending` stands; "I sent it earlier" backed by a recent
  thread receipt stands; "I've ordered the list by date" is not a claim;
  "I've paid" is always replaced; in a mixed turn only the false sentence
  goes; after sending message A to Priya, "I've sent Priya the
  cancellation" is replaced when A was not the cancellation; an earlier
  turn's receipt does not back a present-perfect claim.
- **§4:** plan from links and whole-word surfaces ("Anna" does not plan
  "Annabel"); closed personas listed; the instruction check refuses a
  turn with no forget verb; an approval by Brain or an absent device is
  refused; the job, killed after each step and restarted, finishes every
  step; an already-tombstoned item still has its reminders and excerpts
  removed; after the job, recall, chat history, staging, the ToC and an
  unfetched export, stored staging rows and thread receipts hold nothing
  of the person; a planned persona locked before approval and the host
  restarted ends `waiting_on_unlock`, reported, and finishes on unlock;
  a vault query issued as the persona unlocks never returns a pending
  item; a `persona` request removes the `remember` receipts of its items;
  `forget` is absent from agent asks.
- **§5:** the manifest marks a closed persona excluded; a locked-tier
  persona is excluded while closed and included after unlock; Brain (server
  HTTP and phone in-process) is refused on the fetch route; the id works
  once and expires; the document is never written to disk by Core.
- **§6.1:** new cue phrases reach the classifier; "I need someone to talk
  to the bank" stays normal; with a positive verdict, "I'm here." and
  "talk to me anytime" are removed; "when you talk to me, your words stay
  on the phone" stays; with no verdict nothing is removed.
- **§6.2:** "your 5.9 is in the normal range" (5.9 stored, verdict not)
  is removed; "you are no longer pre-diabetic" is removed; with one stored
  note "Dr Rao: HbA1c normal", "Dr Rao says yours is normal" becomes
  `Your notes say: "Dr Rao: HbA1c normal"`; with a stored "Dr Rao: your
  mother is diabetic; you are not", "Dr Rao wrote that you are diabetic"
  becomes that note's own words; "it fell from 6.4 to 5.8" stays;
  "overdue by 5 days" computed from a stored date stays; a 21-day claim
  deadline not in the evidence is removed; a verdict or a deadline Dina
  said in an earlier reply backs nothing later.
- **§7:** an agent reading a standard persona without a grant gets a card;
  with a session grant it reads; a migrated standing grant lets an
  existing pairing read in every named session, survives an expiry sweep
  and can be revoked; existing session grants keep their session
  isolation; a grant given at standard does not open a persona of the
  same name re-created as sensitive or locked, on both hosts; deleting a
  persona revokes its grants; the connected-Brain facade
  follows the same rule; the owner and Brain are unaffected; the agent ToC
  lists gated personas with no topics.
- **§8:** a superseding fact links to the prior item and the reply names
  both; a prior id in a closed persona is refused; the reminder line
  carries dates in the owner's zone.
- **§9/§10:** "receipt" finds "receipts" and "receipts" finds "receipt";
  possessives match; rank fusion orders items across personas; short
  items reach the model with their bodies; an inventory question returns
  items with no keyword overlap; the time block carries the local date
  and weeks; "this week" on a Friday does not include next Monday unless
  labelled.
- **§11/§12:** a gift question with empty commerce results returns kinds
  of thing and no brand; `formatGeneric` never returns JSON.
- **§14:** a proposal raises a card naming each recipient; a rule answers
  a named contact once per day, never another contact, a stranger, or
  after expiry or revocation; "colleagues" with no names is refused.
- **§15:** within allowance → auto; over, undeclared, wrong currency,
  wrong category, `payment` → card; zero, negative, fractional and
  oversized amounts → 400 with no row; the same `request_key` and payload
  returns the same decision without a second debit, a changed payload →
  409; two concurrent requests cannot both pass the last of the budget;
  revoke racing a validation leaves no approval after the revoke returns;
  device revocation ends the allowance; an old CLI client gets a card;
  changing the owner's time zone near a month boundary does not open a
  second period for an existing allowance.

Then the part 2 scenarios O–Z are rerun (Q2's judge criterion corrected
per §10.2), and part 1's A–N, to check nothing regressed.

## 17. Review log

**Round 1** (Claude continuity reviewer, 15 findings; Codex, 13; much
overlap). All were taken. The main changes from revision 1:

- **Cards Brain could approve** (§0): part 1's message card was not
  Core-minted; every new card type now is, and two are presence-gated.
- **Forget** (§4): one request shape; Core resolves people and personas;
  whole-word matching only; the plan reaches chat, staging, topics,
  exports and Brain's copies; a durable, resumable job; the card says
  what forgetting cannot reach.
- **Export** (§5): a Brain-callable prepare route and an owner-only fetch
  route; the document stays in memory.
- **Guards** (§3, §6): receipts with targets and recent history back
  action claims; the replacement no longer claims "nothing has changed";
  Anti-Her removal needs a positive verdict and an actual offer; the
  regulated check tests verdicts and figures separately against all the
  evidence the model saw; both start in report mode, set in Core.
- **Agents** (§7): follows the control-plane target, with audited
  baseline grants for existing pairings and the connected-Brain facades
  covered.
- **Recall and dates** (§9, §10): word forms both ways; rank fusion;
  PII-safe query vectors; the owner's time zone; "this week" keeps its
  meaning.
- **Standing replies** (§14): always a card naming each recipient; no
  "all contacts".
- **Spend allowance** (§15): value checks, idempotent requests,
  list and revoke, device revocation, CLI and MCP fields, failed
  purchases stay counted. The owner's choice of a quiet log over a notice
  per purchase stands (Claude C11 asked for a notice per purchase, as
  `docs/AP2_AGENT_PAYMENTS.md` §5.2 suggests).

**Round 2** (Claude, 4 new; Codex, 2 unresolved and 5 new). The owner's
two-round limit was reached, so these were folded in without a third
review:

- forget: a persona that closes ends the job `waiting_on_unlock` (told,
  finished on unlock); stored staging rows and thread receipts are
  scrubbed; secure delete covers every database touched; what a persona
  or item request cannot reach is said on the card (Claude N1, N4; Codex
  X2);
- receipts carry the operation id and object, and a new claim needs this
  turn's receipt that fits it (Codex X10);
- a locked-tier persona is exported once the owner unlocks it (Codex X14);
- a verdict attributed to a source needs one evidence item naming both,
  and Dina's own earlier replies are not evidence (Codex X15);
- a `standing` grant kind with its schema and matching rules; every grant
  is bound to the tier it was given at (Claude N2; Codex X16, X17);
- the connected-Brain facade path corrected (Claude N3);
- each allowance pins its time zone (Codex X18).

**Round 3** (Claude, 3 new; Codex, 2 unresolved and 1 new), folded in:

- a closed persona's pending forget runs inside the unlock sequence,
  before the persona opens and its index loads (Claude R1);
- grants are revoked when a persona is deleted; tier binding is checked
  at match time; Brain's in-memory tier mirror is not used (Claude R2);
- receipts of planned items are scrubbed for every request kind (Claude
  R3);
- action claims are rewritten from the receipt instead of judged by
  wording, and a claim that refers back ("already", "earlier") backs onto
  an earlier receipt whatever its tense (Codex X10, X19);
- a regulated verdict is replaced by the stored item's own words, quoted,
  or removed; Dina's earlier replies are not evidence for either test
  (Codex X15).

## 18. Build notes (2026-10-09)

All of §13 is built, with tests, on both hosts. Where the build differs
from the design:

- **Standing grants** (§7.2): `expires_at` holds a far-future value
  (year 9999) instead of NULL, because the column is `NOT NULL` and SQLite
  cannot drop that without rebuilding the table. `grant_kind = 'standing'`
  is what makes a grant session-free and non-expiring; sweeps and lookups
  read the kind.
- **Choosing work-type vaults at pairing** (§7.2 item 6): offered on the
  phone's Agents screen when pairing a coding agent, and on
  `POST /v1/pair/initiate` (`standard_personas`).
- **Regulated sentences** (§6.2): the deterministic check is built; the
  `regulated_sentences` category in the model guard is not. That guard sees
  only the reply and the question, not the evidence, so it cannot tell a
  stored verdict from an invented one.
- **Inventory questions** (§9.2 item 5): the retrieval planner flags them
  (`inventory`), not the intent classifier, since the planner is what
  pre-fetches.
- **Hybrid search** (§9.2): the keyword half is the FTS5 query; each hit is
  scored by how many query terms it holds (equal matches stay equal, so the
  trust re-rank still orders them). Personas merge by rank,
  `1 / (60 + rank)`.
- **Receipts** (§3.2): they carry action, status, targets and the object
  text, but no operation id: the tools that produce them do not all return
  one. Forget scrubs receipts that name the person or quote a forgotten
  item's text.
- **Forgetting** (§4): the job's state lives in Core's key-value store
  rather than a new table; it resumes at boot and whenever Brain checks the
  forget counter before a turn. A contact, and the message thread with
  them, are kept and the card says so; there is no tick to include them.
- **Standing replies and spend allowances** (§14, §15) also keep their
  state in Core's key-value store; a single lock orders every spend check,
  record and revocation. An allowance names the agent by its paired device
  name, and ends after 90 days when no end date is given.
- **Guard modes** (§0): `GET/PUT /v1/settings/guard-modes`, both starting
  in `report`. There is no settings screen yet.

- **An agent's question searches the vault first** (§7.2): Brain makes
  the first searches itself before the model's first turn: one across what
  the agent may read, then one naming each vault the intent classifier
  picked (a vault the agent may not read raises the owner's card). When the
  open search finds nothing, its result names the vaults not searched.

- **Running out of steps** (added after the scenario runs): when an ask
  spends its step budget, the loop makes one last call with no tools.
  The model answers from what the tools returned, says what it could not
  find, and may ask one question. This replaces "Try a simpler query". A
  turn that showed a missing capability keeps its own notice.
- **Asking back** (added after the scenario runs): the ask prompt tells
  Dina that a note which may belong to what was asked, but does not say
  so, is raised as one short question, never dropped silently or assumed.
  The Anti-Her closer pattern `let me know if …` now matches only the
  empty closers ("if you need anything", "if there's anything", "if you
  have any questions"), so a specific offer survives.

- **Safety checks on replies** (2026-10-10, owner decision): the model
  guard (`GUARD_SCAN`) had failed open on every server reply: a reasoning
  model spent its 1,024-token budget thinking and returned nothing, and
  nothing logged it. Now:
  - the router asks for low thinking on lightweight tasks with no tools
    (`reasoning: 'low'` → `reasoning_effort`, 'none' on OpenRouter);
  - a fixed-choice call, `LLMRouter.decide`, sends typed yes/no questions
    with a PII-scrubbed state to a decision backend, after the same consent
    gate as chat; it answers null on a local model, so the question stays
    on the node;
  - Jev (`typesafe/jev-1.13`, OpenRouter `/api/alpha/decisions`, with
    `zdr: true` and `data_collection: 'deny'`) is that backend when the
    owner's model is on OpenRouter (`DINA_DECISIONS=model` turns it off on
    a server). The guard asks one question per sentence per check and keeps
    the old prompt as its fallback;
  - Settings shows who checks replies, and a disabled "On this phone —
    coming soon" button for an on-device model (Laya, later).
  The four Anti-Her "listening" regexes added for O8 were taken out:
  growing phrase lists is not the fix.

Four bugs found while building:

- **The server's pre-fetch could not list a vault**: `GET /v1/vault/list`
  had no authz entry, so Core refused Brain with 403. On a server, an
  inventory question never read the newest items, and `browse_vault`
  failed. The route already ran the agent gate and recorded releases;
  Brain and devices may now call it, as for a single item.

- **The server never had a working-memory ToC**: server Core filled the
  per-persona topic stores but never created the memory service, so
  `GET /v1/memory/toc` answered 503 and Brain's intent classifier saw an
  empty ToC on every server ask, owner and agent alike. The phone was not
  affected. Server boot now creates the service.

- **Approved message cards never completed** (part 1, §7): approving an
  owner-message card sent the message, then called `complete` from
  `queued`, which the workflow refuses, so the route answered an error
  after the message had gone. Fixed by `settleApprovedCard` (claim, then
  complete), used by every card Core acts on itself.
- **Reminder dates went stale on a long-running node**: the remember
  runtime computed "today" once at boot. It now reads the date, and the
  owner's time zone, on every run.

### Code review, round 1 (2026-10-13)

A Claude reviewer and Codex reviewed the uncommitted build: 18 findings
after merging, all fixed, each with a test.

- Server owner surface: the export fetch, the settings, and listing or
  revoking standing replies and budgets were missing, so the web app's
  owner calls could not reach them on a server.
- Forget: a finished, declined or expired job keeps counts only; the person
  is erased (surfaces and identity links deleted, the row blanked), not
  only marked rejected; topics drawn from forgotten items go for every kind
  of request; waiting cards that the approved one covers are closed and cut
  to counts; one lock per job; a host missing a needed method leaves the
  job unfinished instead of reporting it done; a card approved just before
  a crash runs at the next resume.
- Export: a forget during preparation (a cancel generation) means the
  document is rebuilt, never stored with forgotten data.
- Standing replies: every change runs under one lock, so two arrivals send
  once and a send never undoes a revoke.
- Budgets: one record per agent and request key covers a review and its
  approval, so a retried purchase reuses its card and counts once; only a
  signed agent caller spends its own budget; amounts use the currency's own
  decimals (Core's `money_display` table; the CLI mirrors it); the list
  route and the tool show each purchase this period; approval waits for the
  count, and boot settles approvals a crash cut short (purchases, budgets,
  standing replies). The daily briefing does not yet count purchases.
- Grants: the tier check runs before a grant is chosen, so an old standing
  grant never hides a fresh approval at a higher tier.
- Brain: a wrap-up passes every reply guard; calls a batch did not run get
  a result before the wrap-up request.
- Scenario Z6 now checks a real export (card, one owner fetch, the stored
  fact present, closed vaults absent, a second fetch refused).

### Live testing on the local Dinas (2026-10-13)

Four Home Node Lite nodes from this checkout (`dina-nodes/`, ports
85xx/86xx), OpenRouter with Jev on, one real `dina-agent` paired over the
cloud relay. Passed: remember and recall, birthday reminders with dates on
the cards, Finance routing without a prompt, a message to Sancho delivered
into his chat, forget (card lists what goes; approving one card closes the
overlapping one and cuts both to counts; nothing about the person remains),
the export (card, one owner fetch, a second refused), an automatic reply
delivered into Albert's chat, and a spending budget (within: approved with
no card; a retry counts once; over it or another category: a card; an
approved card counts once; after the owner stops it, a card again). Jev
answered every reply check.

Found and fixed while testing:
- The approvals inbox showed every card Core mints for the owner (send,
  forget, automatic reply, budget) as "Unnamed service" with no text; it
  now shows the question and Core's description, headed "Your request".
- Forgetting a person left the forget conversation itself (the request
  and Dina's card reply) in the chat; messages naming the person written
  after the plan now go too.
- "Let my agent shopper spend…" was refused: Core required the device name
  to contain the whole phrase. Filler words ("my", "the", "agent") are now
  ignored, and an ambiguous name is still refused. The budget tool's list
  also returns the paired agents' names, so Dina can check one.

