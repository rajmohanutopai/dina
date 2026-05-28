# Dina Scenarios & Flows

A plain-English walkthrough of every Dina feature you can drive from
the mobile app, with flows. Every scenario in this doc was verified
live on the iOS simulator with `idb` and (for agent flows) a real
paired `dina-agent` CLI talking through MsgBox.

This complements:
- **`dina_details.md`** — the source spec (what each feature *is*)
- **`docs/MANUAL_RELEASE_TEST_RESULTS.md`** — the latest run log

This doc is the *how it actually works* part — for the eyes of
someone who wants to understand the behavior without reading the code.

---

## Table of Contents

1. [The Mental Model](#the-mental-model)
2. [The Session Model (for agent flows)](#the-session-model-for-agent-flows)
3. [Feature 1 — Remember](#feature-1--remember)
4. [Feature 2 — Ask](#feature-2--ask)
5. [Feature 3 — Reminders (auto-created)](#feature-3--reminders-auto-created)
6. [Feature 4 — Agent Safety (Vault Read Gate + Intent Gate)](#feature-4--agent-safety-vault-read-gate--intent-gate)
7. [Feature 5 — Talk (Dina-to-Dina, D2D)](#feature-5--talk-dina-to-dina-d2d)
8. [Feature 6 — PeerLens](#feature-6--peerlens)
9. [Feature 7 — Services (Bus Driver)](#feature-7--services-bus-driver)
10. [The Code Map](#the-code-map)

---

## The Mental Model

Two actors, two paths into your Dina:

```
   ┌───────────────────┐                      ┌──────────────────────┐
   │      YOU          │                      │   AGENT              │
   │  (in the app)     │                      │   (OpenClaw / Hermes │
   └─────────┬─────────┘                      │    / your own bot)   │
             │                                └──────────┬───────────┘
             │                                           │
             │                                           ▼
             │                                ┌──────────────────────┐
             │                                │   dina-agent CLI     │
             │                                │   (the interface —   │
             │                                │    signs requests    │
             │                                │    with Ed25519)     │
             │                                └──────────┬───────────┘
             │                                           │
             │                                           ▼
             │                                ┌──────────────────────┐
             │                                │       MsgBox         │
             │                                │  (cloud relay)       │
             │                                └──────────┬───────────┘
             │                                           │
             ▼                                           ▼
   ┌────────────────────────────────────────────────────────────────┐
   │                       Your Dina (mobile)                        │
   │                                                                 │
   │   ┌────────────────────────────────────────────────────────┐   │
   │   │  persona_guard.ts                                       │   │
   │   │  - You? short-circuit (return null). All vaults open.   │   │
   │   │  - Agent? check tier, session grant.                    │   │
   │   └────────────────────────────────────────────────────────┘   │
   │                                                                 │
   │   Vaults (per persona, SQLCipher):                              │
   │     /general, /work, /health (locked), /finance (locked), …    │
   │   Workflow tasks (approvals + agent jobs)                       │
   │   Reminders (scheduled cards)                                   │
   │   Approval cards (chat + tab + badge)                           │
   └────────────────────────────────────────────────────────────────┘
```

**The rule:** When YOU use the app, everything's open. When an AGENT
acts on your behalf, sensitive stuff gates on your tap.

> **What `dina-agent` is — and isn't.** `dina-agent` is the **CLI
> interface** that agents (OpenClaw, Hermes, your own bot) use to
> talk to Dina. It's not the agent. It's a Python tool that signs
> requests with Ed25519, routes them through MsgBox to your Home
> Node, polls for approval results, and surfaces the answers back to
> the calling agent. The agent itself — the thing with the reasoning
> loop — lives one layer above. When this doc says "the agent calls
> `dina ask`", it means "OpenClaw (or whoever) shells out to
> dina-agent which makes the call."

---

## The Session Model (for agent flows)

Agent commands always run inside a named Dina session:

```bash
$ dina session start --name "morning-mail"
Session: sess-abc123 (morning-mail) active

$ dina ask --session sess-abc123 "what's my blood pressure"
$ dina validate --session sess-abc123 send_large "Email to 12 customers"
```

- Every `ask` and `validate` requires `--session <id>`.
- A new `dina session start` mints a **new** session id.
- Approval grants are keyed on `(agent_did, session_id, action_or_vault)`.
  Approvals from old sessions don't carry forward.

This is what "Approve for this session" means on the approval card —
the specific Dina session **you** explicitly created.

---

## Feature 1 — Remember

**One-liner:** Tell Dina to remember something, it stores it in the
right vault. If the topic is sensitive (Health, Finance), Dina
auto-routes to the locked vault — no approval is needed because you
yourself asked from the app (you're the trusted owner).

### Where things go (the routing)

Dina runs a classifier on what you typed and picks the persona:

| What you typed | Classified persona | Vault |
|---|---|---|
| "My daughter's name is Emma" | general | open `/general` |
| "Emma loves dinosaurs" | general | open `/general` |
| "Acme Inc is my employer" | work | open `/work` (or `/general` if you don't have `/work`) |
| "My bank account is in Barclay's, ends 0102" | finance | locked `/finance` |
| "My HbA1c is 9%, very high" | health | locked `/health` |

The persona list is **user-configurable** — `general/work/health/finance`
are just defaults. If you've added `/journal` or removed `/work`, the
classifier sees your current list at runtime.

### Scenario 1.1 — Remember casual fact

**Setup:** Default personas configured.
**Trigger:** You tap Remember, type `My daughter's name is Emma`, send.

```
You ──tap Remember──▶ Type "My daughter's name is Emma" ──▶ Send
                                                              │
                                                              ▼
                                                    Brain classifier:
                                                    domain = 'general'
                                                              │
                                                              ▼
                                                    Open vault /general
                                                    INSERT vault_item
                                                              │
                                                              ▼
                                                    Reply: "Stored in
                                                    General vault."
```

**What you see:** Dina bubble — "Stored in General vault." Done.

### Scenario 1.2 — Remember a fact that goes into a LOCKED vault (no approval)

**Setup:** `/health` configured as locked.
**Trigger:** You type `My HbA1c is 9%, very high`.

```
You ──tap Remember──▶ "My HbA1c is 9%" ──▶ Send
                                              │
                                              ▼
                                    Brain classifier:
                                    domain = 'health'
                                              │
                                              ▼
                                    persona_guard.ts:
                                    requester == owner DID
                                    SHORTCUT: return null
                                              │
                                              ▼
                                    Locked vault /health
                                    INSERT vault_item
                                              │
                                              ▼
                                    Reply: "Stored in Health vault."
```

**What you see:** Dina bubble — "Stored in Health vault." No approval
card, no badge. The vault is locked but you yourself are storing the
fact from inside the app, so the gate doesn't fire.

### Scenario 1.3 — Mid-conversation auto-remember

**Setup:** You're chatting (using `Ask`, not `Remember`).
**Trigger:** You say something that sounds like a durable preference
mid-chat — e.g. "I really love cold brew coffee."

Dina notices and decides this is worth remembering. It adds it to the
vault on its own and tells you. No need to explicitly use `/remember`.

This is "Dina can add to memory, even if it is a normal convo and
something feels like it should be remembered" from §3.1 of
`dina_details.md`.

---

## Feature 2 — Ask

**One-liner:** Normal chat with Dina. Queries vault, performs
multi-vault synthesis when needed, answers in plain prose. No
approval prompts — you're the owner asking from the safe space.

### What makes ask different from a stupid search

Ask is allowed to walk **multiple vaults at once** and combine what
it finds. The classic example: "What should I get Emma for her
birthday?"

- `/general` has "Emma loves dinosaurs"
- `/finance` has "Budget for gifts: $50/month"
- `/work` has "Emma's birthday: Nov 7"

A naïve keyword search ("Emma's birthday gift") would miss the budget.
Ask runs a structured retrieval planner that asks the LLM: "Given the
user's query and the available personas, which vaults should I read,
with what queries?" Then it fans out, reads the relevant vaults in
parallel, and synthesizes the answer.

### Scenario 2.1 — Simple ask, one vault

**Trigger:** You tap Ask, type `What does Emma like`.

```
You ──tap Ask──▶ "What does Emma like" ──▶ Send
                                            │
                                            ▼
                                  Brain retrieval planner:
                                  - personas: general
                                  - fts5 query: "Emma like"
                                            │
                                            ▼
                                  /general FTS5 returns
                                  "Emma loves dinosaurs"
                                            │
                                            ▼
                                  LLM synthesizes:
                                  "Emma loves dinosaurs"
```

**What you see:** Dina bubble — "Emma loves dinosaurs."

### Scenario 2.2 — Cross-vault synthesis

**Trigger:** "Where do I work and what's my latest blood pressure?"

```
You ──tap Ask──▶ "Where do I work and what's my latest BP" ──▶ Send
                                                                  │
                                                                  ▼
                                                        Retrieval planner:
                                                        - personas: [work, health]
                                                        - work query: "employer"
                                                        - health query: "blood pressure"
                                                                  │
                                                                  ▼
                                                        persona_guard:
                                                        owner asking → all open
                                                                  │
                                              ┌───────────────────┴───────────────────┐
                                              ▼                                       ▼
                                    /work FTS5:                              /health FTS5:
                                    "Acme Inc"                               "BP 138/88"
                                              │                                       │
                                              └───────────────┬───────────────────────┘
                                                              ▼
                                                  LLM synthesizes:
                                                  "You work at **Acme Inc**.
                                                  Your latest BP is **138/88**."
```

**What you see:** A single Dina bubble with both facts. The `**` are
markdown-bold (rendered with proper heavier font weight in the chat).

### Scenario 2.3 — Owner asks for locked-vault data (no approval)

**Trigger:** You tap Ask, type `What's my HbA1c`.

`/health` is locked. **But you're asking.**

```
persona_guard.ts:
  requester DID == owner DID? YES
  → SHORTCUT: return null
  → no gate, no approval card
       │
       ▼
  /health vault opened, read,
  answer returned directly.
```

**What you see:** "Your HbA1c was last recorded at 9%, which is high."
No approval card. No badge. The gate is for AGENTS, not for you.

---

## Feature 3 — Reminders (auto-created)

**One-liner:** When you remember a fact that has a date or implies
future relevance, Dina creates reminder cards on its own. The cards
are enriched with vault context — Dina pulls related facts to make
the reminder useful.

### Scenario 3.1 — Birthday auto-reminder with context

**Setup:** `/general` has:
- "Emma loves dinosaurs"
- "Emma is my daughter"

**Trigger:** You type `Emma's birthday is on Nov 7th`.

```
You ──Remember──▶ "Emma's birthday is Nov 7th" ──▶ Send
                                                      │
                                                      ▼
                                            Store in /general
                                                      │
                                                      ▼
                                            Reminder planner runs:
                                            - Detected date: Nov 7
                                            - Subject: "Emma" (related to user)
                                            - Vault scan: "Emma loves dinosaurs"
                                                      │
                                                      ▼
                                            Create TWO reminder cards:
                                            1. Nov 6, 10:00 AM
                                               "Emma's birthday tomorrow —
                                                you may want to buy a
                                                dinosaur-themed gift."
                                            2. Nov 7, 09:00 AM
                                               "It's Emma's birthday today,
                                                you may wish to contact her."
```

**What you see:**
- Dina bubble: "Stored in General vault."
- Dina bubble (immediately after): "Reminders set:" followed by two
  reminder cards with the dates and the context-aware text.

### The Reminder Trinity

The reminder planner balances three things:
1. **Date detection** — when is the event?
2. **Lead time** — how far in advance should I remind you? (Birthdays:
   1 day before. Subscriptions: 7 days before renewal. Etc.)
3. **Context enrichment** — what else from your vault makes this
   reminder more useful?

It's an LLM, not a rule engine. Tell it about Emma's interests once
and the reminder will weave it in naturally. There are no hand-coded
"if X do Y" rules — heavy reasoning models infer lead times and
context from your data.

---

## Feature 4 — Agent Safety (Vault Read Gate + Intent Gate)

This is the biggest section because it's where Dina earns its
"sovereign personal AI" badge. Two gates fire when an agent acts on
your behalf:

| Gate | What it protects | Triggered by |
|------|------------------|--------------|
| **Vault Read Gate** | Reading a locked vault | Agent's `dina ask` needs locked-vault data |
| **Intent Gate** | Doing a risky action | Agent calls `dina validate` |

Both use the same approval card UI and the same session model.

### The Three Buttons on Every Approval Card

```
┌──────────────────────────────────────────────────┐
│  🔐 AGENT VAULT READ                              │
│  An agent wants to access /health.                │
│  did:key:z6MkkWssTCrpm7tzo6Qt…                   │
│                                                   │
│  [   Deny   ] [ Approve Once ] [   Approve   ]   │
└──────────────────────────────────────────────────┘
```

- **Deny** — blocks this request. Agent gets back `denied`.
- **Approve Once** — grants this single request. Next call needs fresh approval.
- **Approve** — grants for the current `(agent, session, vault/action)` tuple.
  Subsequent matching calls pass through silently.

### The Risk Decision Table (used by `dina validate`)

| Risk | Behavior | Actions |
|------|----------|---------|
| **SAFE** | Silent auto-pass | `search`, `list`, `query`, `remember`, `store`, `send_small`, `delete_small` |
| **MODERATE** | Approval once per `(agent, session, action)` | `send_large`, `delete_large`, `modify_settings` |
| **HIGH** | Approval **every single time** (no session shortcut) | `purchase`, `payment`, `transfer_money`, `bulk_operation` |
| **BLOCKED** | Always denied | `credential_export`, `key_access`, `read_vault` |

Plus the **brain-denied** list — actions no agent can ever submit. The
user does these themselves via the app UI: `did_sign`, `did_rotate`,
`vault_backup`, `persona_unlock`, `seed_export`, `vault_raw_read`,
`vault_raw_write`, `vault_export`.

### Scenario 4.1 — Agent reads a locked vault (Vault Read Gate)

**Setup:** `/health` configured as locked.
**Trigger:** Agent runs `dina ask --session sess-abc "what's my blood pressure"`.

```
Agent ───POST /v1/ask (X-Session: sess-abc)──▶ Your Dina (mobile)
                                                       │
                                                       ▼
                                              Brain plans retrieval
                                              for /health (locked)
                                                       │
                                                       ▼
                                              persona_guard.ts:
                                              requester ≠ owner
                                              persona.tier = "locked"
                                              session grant? NO
                                                       │
                                                       ▼
                                              Create workflow_task
                                              kind: 'approval'
                                              payload.type:
                                              'vault_read_request'
                                                       │
                       ┌───────────────────────────────┴──────────────────────┐
                       ▼                                                      ▼
              Card pops on phone:                                  CLI returns 202:
              - Chat thread (inline)                               { status: 'in_flight',
              - Approvals tab                                        request_id: 'abc' }
              - Notifications tab badge: 1                          CLI begins polling
                                                                   ask-status
                       │
                       ▼
              You tap one button:
              Deny / Approve Once / Approve
                       │
              ┌────────┴────────┐
              ▼                 ▼
            Deny             Approve(*)
              │                 │
              ▼                 ▼
         Cancel task       Queue task → answer the ask
              │                 │
              ▼                 ▼
         CLI poll sees:    CLI poll sees:
         { reason:         { status: 'complete',
           'denied' }        answer: '...' }
```

**After Deny:**
- Card flips to italic "Denied."
- Badges clear (both tabs)
- CLI exits with `Request failed: {reason: denied}`

**After Approve (session):**
- Card flips to italic "Approved for this session."
- Badges clear
- Agent gets the answer
- **Next** `dina ask --session sess-abc` for `/health` passes silently

### Scenario 4.2 — Cross-vault isolation

**Setup:** You already tapped "Approve (Session)" for `/health` in `sess-abc`.
**Trigger:** Same agent, same session, asks about `/finance`.

```
persona_guard.ts checks:
  - persona.tier == 'locked'?  YES
  - session grant for (agent, sess-abc, /finance)?  NO
       ↑
       Earlier grant was for (..., /health) — different vault
       │
       ▼
  Create NEW approval card for /finance
```

**Why:** Each vault is an independent grant. Approving health doesn't
unlock finance.

### Scenario 4.3 — Session isolation

**Setup:** Earlier in `sess-abc`, you Approve(Session)-d the `/health` read.
**Trigger:** Agent starts a new session, asks again.

```
$ dina session start --name "afternoon"
# → sess-xyz789

$ dina ask --session sess-xyz789 "what's my blood pressure"
```

```
persona_guard.ts checks:
  - session grant for (agent, sess-xyz789, /health)?  NO
       ↑
       Earlier grant was for sess-abc — different session
       │
       ▼
  Create NEW approval card
```

**Why:** New sessions are clean slates. You explicitly opened a new
scope; old grants don't follow you in.

### Scenario 4.4 — Three surfaces, all in sync

**Where the card shows up:**
1. **Chat thread** (inline card with three buttons)
2. **Approvals tab** (same card, same three buttons)
3. **Notifications tab badge** (red `1` until resolved)

The sync contract:
- Approve via Approvals tab → chat card auto-flips to "Approved."
  within ~5s without a tap (the card polls).
- Deny anywhere → other surfaces flip silently.
- Once resolved, badges clear on both tabs.
- Cross-tap (approve on tab, then tap card too): silent reconcile, no
  error popup.

### Scenario 4.5 — `dina validate` for a MODERATE action

**Setup:** Agent wants to send a bulk email. `send_large` is MODERATE.
**Trigger:**
```bash
dina validate --session sess-abc send_large "Email to 12 customers" \
  --context '{"to":"sales@co.com","subject":"Q4 Wrap"}'
```

```
Agent ──POST /v1/agent/validate──▶ Your Dina
   {                                       │
     type: 'agent_intent',                  ▼
     action: 'send_large',          evaluateIntent('send_large')
     session: 'sess-abc',                    │
     ...                                     ▼
   }                                  riskLevel: MODERATE
                                              │
                                  Session grant for
                                  (agent, sess-abc, 'send_large')?
                                              │
                              ┌───────────────┴───────────────┐
                              ▼                               ▼
                            YES                              NO
                              │                               │
                              ▼                               ▼
                  200 { action: 'auto_approve',     Create workflow_task
                       reason: 'Session approval     payload.type:
                       active' }                     'intent_validation'
                              │                             │
                       Agent proceeds                       ▼
                                                  Card pops on phone
                                                  Agent gets 200:
                                                  { action: 'flag_for_review',
                                                    proposal_id: 'prop-xxx' }
                                                            │
                                                            ▼
                                                  Agent polls
                                                  /v1/intent/prop-xxx/status
```

After approval: `status: 'approved'` → agent proceeds.
After deny: agent exits with `reason: denied`.

### Scenario 4.6 — `dina validate` for a HIGH action

**Trigger:**
```bash
dina validate --session sess-abc transfer_money "Move $500 to savings"
```

**HIGH is special: no session shortcut.** Every `transfer_money` call
pops a card, even if you already approved the previous one for the
same session. This is the README's "Cart Handover" principle — Dina
advises but never touches money silently.

### Scenario 4.7 — `dina validate` for SAFE / BLOCKED actions

```
SAFE action (e.g. 'search'):
  → 200 { action: 'auto_approve' }
  → No card, no badge, you never see it.

BLOCKED action (e.g. 'credential_export'):
  → 200 { action: 'deny' }
  → No card — user never gets the option to approve. Policy says no.
```

### Scenario 4.8 — Approval times out

If you don't tap anything within the TTL (default ~30 min):

```
workflow_task.expires_at < now
  → background sweep marks task 'expired'
  → Chat card poll sees 'missing' → flips "Denied"
  → CLI poll sees { status: 'expired' } → exits timeout-style
  → Badges clear
```

---

## Feature 5 — Talk (Dina-to-Dina, D2D)

**One-liner:** Your Dina can send a message to another person's Dina
over an Ed25519-encrypted channel through MsgBox. Neither side needs
a public IP. The receiving Dina enriches the message with vault
context — so "Alonso is coming tomorrow morning" becomes
"Alonso is coming tomorrow morning — keep cold brew handy."

### The Plumbing: D2D Envelopes

D2D = "Dina-to-Dina." Every D2D message is:

1. **Sealed** with `crypto_box_seal` (NaCl) using the recipient's
   public encryption key — only the recipient's Dina can open it.
2. **Signed** with the sender's Ed25519 key — recipient verifies it's
   really from you.
3. **Relayed** through MsgBox over WebSocket. MsgBox sees only the
   encrypted blob + the destination DID; never the plaintext.

```
Sender ──seal(plaintext, recipient_pub)──▶ sealed_blob
       ──sign(sealed_blob, sender_priv)──▶ envelope { sealed_blob, sig }
                                                │
                                                ▼
                                        POST to MsgBox
                                        with X-Recipient: did:plc:xyz
                                                │
                                                ▼
                                        MsgBox buffers + relays
                                        (cannot read content)
                                                │
                                                ▼
                                  Recipient's Dina pulls envelope,
                                  verifies signature, opens with priv key
                                                │
                                                ▼
                                          Plaintext message
```

The signing key is the same one that signs `dina-agent` requests —
it's the Home Node's Ed25519 keypair derived from the master seed.

### The Three Trust Stores (the safety part)

This is where it gets interesting. Your Dina has three separate
identity stores that all participate in deciding whether to let a
D2D message in:

| Store | What it tracks | Used for |
|---|---|---|
| **D2D trust gate** (`knownContacts`) | DIDs you've explicitly added | Personal messages — stranger DIDs get quarantined |
| **Contact directory** (`add-contact.tsx`) | Display name + trust score | UI rendering (who is this DID, what do I show?) |
| **People graph** (`PeopleRepository`) | Confirmed person bound to a DID | Resolving "Alonso" in a query to a specific DID |

For Talk to work between you and Sancho:
- **You** must have Sancho's DID in your `knownContacts`
- **Sancho** must have your DID in *his* `knownContacts`

If either side is missing, the message gets quarantined and the user
sees a "Stranger trying to contact you — accept?" prompt. (For
Services / bus driver, there's a separate "leave-a-note" mechanism
— covered in Feature 7.)

### Scenario 5.1 — Alonso tells Sancho he's coming over

**Setup:**
- Alonso has Sancho in his contacts.
- Sancho has Alonso in his contacts.
- Sancho's `/general` vault has "Alonso loves cold brew coffee."

**Trigger:** Alonso opens chat, taps a Sancho-direct entry (or types
`@sancho`), sends `Coming tomorrow morning.`

```
Alonso's Dina ──seal+sign envelope──▶ MsgBox ──relay──▶ Sancho's Dina
                                                              │
                                                              ▼
                                                    receive_pipeline.ts:
                                                    - Verify sig
                                                    - Decrypt sealed_blob
                                                    - Check knownContacts:
                                                      Alonso's DID present? YES
                                                              │
                                                              ▼
                                                    Stage message in
                                                    inbox-then-thread pipeline
                                                              │
                                                              ▼
                                                    Brain enrichment step:
                                                    - Resolve "Alonso" → DID
                                                    - Detect time signal
                                                      ("tomorrow morning")
                                                    - Scan Sancho's vault
                                                      for Alonso preferences
                                                              │
                                                              ▼
                                                    Found:
                                                    "Alonso loves cold brew"
                                                              │
                                                              ▼
                                                    Render chat bubble:
                                                    "📨 From Alonso:
                                                     'Coming tomorrow morning.'
                                                     💡 He loves cold brew —
                                                     keep one handy."
                                                              │
                                                              ▼
                                                    Reminder planner:
                                                    Create reminder for
                                                    tomorrow ~08:00:
                                                    "Alonso is coming this
                                                     morning. Cold brew."
```

**What Sancho sees:**
- A new chat bubble showing the message from Alonso.
- A nudge / enrichment line: "He loves cold brew — keep one handy."
- A scheduled reminder card for tomorrow morning.

All of this without Sancho having to ask Dina anything. Just by
receiving a message, his Dina pulled relevant context out of his own
vault and surfaced it.

### Scenario 5.2 — Stranger tries to message you

**Setup:** Some random DID has your DID, sends you a D2D message.

```
Random's Dina ──seal+sign──▶ MsgBox ──relay──▶ Your Dina
                                                    │
                                                    ▼
                                          receive_pipeline.ts:
                                          - Verify sig: OK
                                          - Decrypt: OK
                                          - knownContacts: DID NOT present
                                                    │
                                                    ▼
                                          Quarantine in d2d_inbox
                                          with state = 'staged_stranger'
                                                    │
                                                    ▼
                                          Approval card on your phone:
                                          "🔐 Unknown sender wants to
                                           message you. did:plc:abc...
                                           [Block] [Add to contacts +
                                           Show message]"
```

**Your options:**
- **Block** → reject; subsequent messages from that DID auto-quarantine.
- **Add to contacts + Show message** → adds DID to `knownContacts`,
  releases the staged message into your thread.

You never see the message content until you decide. Strangers can't
spam your chat surface.

### Scenario 5.3 — Message enrichment with multiple vaults

If Alonso says something that touches multiple of Sancho's vaults, the
enrichment walks all of them. Example:

```
Alonso: "Bringing the new puppy over Sunday afternoon."

Sancho's Dina pulls:
- /general:  "Alonso has a goldendoodle named Biscuit"
- /general:  "Sancho's son Tomas is allergic to dog dander"
- /work:     "Sancho has a 2pm Sunday call"

Resulting nudge:
"Alonso is bringing Biscuit (goldendoodle) Sunday afternoon.
 Heads up — Tomas's dog allergy. You also have a 2pm work call;
 want me to suggest a later time?"
```

This is the same retrieval-and-synthesize loop as `Ask`, applied to
**incoming messages** instead of explicit queries.

### Why Talk Is Different From Texting

| Texting | Dina Talk |
|---|---|
| You send words. | You send words; recipient's Dina adds context. |
| If recipient forgets you love cold brew, too bad. | Recipient's Dina remembers and reminds them. |
| Spam = always possible. | Strangers gated; quarantined until you choose. |
| Sender controls everything. | Receiver's vault + LLM shape the experience. |

---

## Feature 6 — PeerLens

**One-liner:** Dina's reviews network. Every Dina contributes signed
reviews of products, videos, services. When you ask about something,
your Dina ranks results by trust — not by ad spend.

PeerLens is an **AppView** (think: search engine for signed reviews)
running on `appview.dinakernel.com` (or `test-appview.dinakernel.com`
for testing). Your Dina queries it; it weighs reviewers by transaction
history, peer attestations, time-decay, and trust ring.

### Scenario 6.1 — Find a trustworthy product review

**Trigger:** You tap PeerLens, search `ergonomic chair`.

```
You ──tap PeerLens──▶ Search "ergonomic chair" ──▶ Send
                                                      │
                                                      ▼
                                            POST /xrpc/com.dina.peerlens.search
                                            to test-appview.dinakernel.com
                                                      │
                                                      ▼
                                            AppView scorer ranks reviews:
                                            - reviewer DID trust score
                                            - peer attestations
                                            - transaction history
                                            - time-decay (recent > old)
                                            - "Dead Internet" filter:
                                              drops AI-generated /
                                              promotional patterns
                                                      │
                                                      ▼
                                            Top-N reviews returned
                                                      │
                                                      ▼
                                            Your Dina shows ranked list
                                            with reviewer's name,
                                            short summary, deep link
                                            to the product page.
```

**What you see:** A list of reviews, ordered by trust. Tapping a
review opens the original (deep-link credit — creators get traffic).
No ads, no SEO-spam, no AI-generated noise (filtered).

### Scenario 6.2 — Write your own review

You can also publish reviews into the network. The review is signed
by your DID; other people's Dinas trust it proportional to your
standing in their trust graph.

```
You ──tap "Write Review"──▶ Type review ──▶ Sign + Publish
                                                  │
                                                  ▼
                                    Review record signed with
                                    your Ed25519 key, pushed to
                                    your PDS at
                                    test-pds.dinakernel.com
                                                  │
                                                  ▼
                                    Jetstream firehose propagates
                                    to all AppView ingesters
                                                  │
                                                  ▼
                                    Other Dinas can see it,
                                    weighted by their trust in you.
```

### What Makes This Different

- **Sign-then-trust.** Every review is signed by a DID. The AppView
  doesn't censor — it ranks.
- **Time-decay.** A glowing review from 5 years ago counts less than
  a thoughtful "still good after 6 months" from last week.
- **Cart Handover.** If a review leads to a purchase, Dina hands you
  off to the merchant — Dina itself never touches money.
- **Deep Link Default.** Dina credits sources by linking to the
  original, not by reskinning them.

---

## Feature 7 — Services (Bus Driver)

**One-liner:** The cleverest feature in Dina. Combines AppView
(directory lookup), [D2D](#feature-5--talk-dina-to-dina-d2d) (private
encrypted query between two Dinas), and `dina-agent` (the daemon on
the provider side that claims work) into one flow: your Dina finds a
service provider in a directory, sends them a private query, gets
back a real answer.

The canonical demo: "When does bus 42 reach Castro?"

> **What's new on top of Talk.** Talk requires both sides to have
> each other in contacts. Services lets you query a **stranger** —
> but only for what they've publicly advertised, and only with the
> "leave a note" mechanism below.

### The Full Flow

```
You ──tap Ask──▶ "When does bus 42 reach Castro" ──▶ Send
                                                          │
                                                          ▼
                                                Your Dina checks vault:
                                                "I don't know this"
                                                          │
                                                          ▼
                                                POST to test-appview:
                                                "Who can answer eta_query
                                                 for stop 'Castro'?"
                                                          │
                                                          ▼
                                                AppView directory lookup:
                                                bus42-agent registered as
                                                service answering eta_query
                                                for route 42 / Castro stop
                                                          │
                                                          ▼
                                                Your Dina ranks candidates,
                                                picks bus42-agent
                                                          │
                                                          ▼
                                                D2D service.query sent
                                                via MsgBox to bus42-agent's
                                                Home Node
                                                          │
                                                          ▼
                                                bus42-agent's Home Node:
                                                "I advertised eta_query.
                                                 Policy: auto-accept from
                                                 strangers for advertised
                                                 services."
                                                          │
                                                          ▼
                                                Creates workflow_task
                                                with kind=service_query
                                                          │
                                                          ▼
                                                bus42-agent's paired
                                                dina-agent daemon polls
                                                /v1/workflow/tasks/claim
                                                          │
                                                          ▼
                                                Claims task, runs
                                                stub_eta_runner.py:
                                                  eta = random.randint(2,14)
                                                  reverse-geocode stop
                                                  → real GPS coords
                                                          │
                                                          ▼
                                                service.response D2D back
                                                via MsgBox:
                                                  eta_minutes: 13
                                                  stop_name: "Jane Warner Plaza"
                                                          │
                                                          ▼
                                                Your Dina renders ETA card:
                                                "Route 42 · 13 min to
                                                 Jane Warner Plaza"
                                                 [Open in Maps]
                                                 via Demo ETA Provider ·
                                                 did:plc:6zyy3b...
```

### The Trust Gate (how strangers can talk safely)

Per Feature 5, D2D requires both sides to have each other in
`knownContacts` — otherwise messages get quarantined. But bus42-agent
is a stranger to you, and vice versa. Two mechanisms make Services
work without permanently opening either side's door:

**On YOUR side — "leave a note":**

```
When YOUR Dina SENDS the service.query, it leaves a note:
  "I'm expecting ONE reply from bus42-agent's DID,
   about request_id=abc, within 60 seconds."

When bus42-agent's REPLY arrives, your Dina checks:
  - From bus42-agent's DID?     YES
  - For request_id=abc?         YES
  - Within 60s?                 YES
  → Let it in. Tear up the note.

A personal message from bus42-agent NEXT day:
  "Hey, want to be friends?"
  → QUARANTINED. No matching note. Stranger.
```

**On THEIR side — "advertised service" policy:**

```
- bus42-agent published eta_query in test-appview's directory.
- Policy: auto-accept eta_query D2D from ANY DID for that capability.
- A personal message ("be my contact") from a stranger?
  → QUARANTINED. Personal messages still gate on contacts.
```

So the door opens once for a known answer, closes immediately. Both
sides keep their guard up for everything else.

### The Real Path (no shortcuts)

This entire flow was verified live:
- Discovery via `test-appview.dinakernel.com`
- D2D over `test-mailbox.dinakernel.com` (real MsgBox)
- Provider Dina is a separate lite Core process on `:18298`
- bus42-agent daemon polls via the actual dina-agent claim loop
- ETA from `bus42-agent/stub_eta_runner.py` (the only stand-in — it
  replaces a real transit-API integration)

The Demo ETA Provider DID and `via Demo ETA Provider · did:plc:6zyy3b…`
line in the ETA card is what proves the answer came from the
provider Dina via real D2D — not from a local mock.

### What You Can Build On Top

This pattern generalizes:
- Doctor's office advertises `appointment_query` → ask your Dina
  "next available with Dr. Rao?" and it routes through the doctor's
  Dina to the doctor's office's dina-agent.
- Restaurant advertises `reservation_query` → ask "table for 2 at 7
  tonight?" and Dina queries the restaurant's Dina.
- Local handyman advertises `availability_query` → same pattern.

Every interaction is signed, end-to-end. No ads. No middlemen.

---

## The Code Map

| Concern | File |
|---|---|
| Remember classifier | `packages/brain/src/composition/persona_classifier.ts` |
| Ask retrieval planner | `packages/brain/src/composition/ask_retrieval_planner.ts` |
| Cross-vault synthesis | `packages/brain/src/reasoning/vault_tool.ts` |
| Reminder planner | `packages/brain/src/pipeline/reminder_planner.ts` |
| Owner-aware vault gate | `packages/brain/src/composition/persona_guard.ts` |
| Risk classification table | `packages/core/src/gatekeeper/intent.ts` |
| Validate route + session grants | `packages/core/src/server/routes/intent.ts` |
| Workflow task state machine | `packages/core/src/workflow/repository.ts` |
| Chat-bubble approval card | `apps/mobile/src/components/InlineVaultReadApprovalCard.tsx` |
| Inbox bridge | `packages/brain/src/notifications/bridges.ts` |
| Approvals tab | `apps/mobile/app/approvals.tsx` |
| PeerLens AppView client | `apps/mobile/src/peerlens/appview_runtime.ts` |
| PeerLens scorer | `appview/src/scorer/` |
| Services directory lookup | `apps/mobile/src/services/` |
| D2D send/receive pipeline | `packages/core/src/d2d/` |
| bus42-agent demo runner | `bus42-agent/stub_eta_runner.py` |

---

## Summary: When Does Anything Pop?

| Who's asking | What | What happens |
|---|---|---|
| You (in app) | `/remember <anything>` | Stored in classified vault. Open or locked, no approval — you're the owner. |
| You (in app) | `/ask <anything>` | Walks all relevant vaults (incl. locked). No approval. |
| Date-bearing remember | Auto-reminders | Cards appear immediately, enriched with vault context. |
| Mid-conversation observation | Auto-remember | Dina decides + tells you what it stored. |
| Agent via msgbox | `ask` open vault | Free. No card. |
| Agent via msgbox | `ask` locked vault, no grant | Vault Read card pops. |
| Agent via msgbox | `ask` locked vault, matching grant | Free. No card. |
| Agent via msgbox | `validate` SAFE action | Free. No card. |
| Agent via msgbox | `validate` MODERATE, no grant | Intent card pops. |
| Agent via msgbox | `validate` MODERATE, matching grant | Free. No card. |
| Agent via msgbox | `validate` HIGH | Intent card pops. **Every time.** |
| Agent via msgbox | `validate` BLOCKED | Hard deny. No card. |
| Agent via msgbox | brain-denied action | 400 error before evaluation. |
| You searching | PeerLens query | AppView call, ranked results. No approval. |
| You asking unknown fact | Service discovery | Service.query via D2D. No approval. |

---

*Last verified live: 2026-05-28. Test pairing: dina-agent v0.15.0 via
`wss://test-mailbox.dinakernel.com/ws`, paired with Home Node
`did:plc:aiidvbzbdvbglt5ywducnryi`.*
