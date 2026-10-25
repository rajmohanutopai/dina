# Dina and OpenAI dots: can they work together?

**Status:** FEASIBILITY CHECK, 2026-10-20. Built since (uncommitted, branch
`research/openai-dots`): the tender-draft lane and status read (§6.4 items
1–3; `packages/core/src/commerce/tender_drafts.ts`, migration v82), the
`/owner` open form with its presence gate (item 4), and the `dot` MCP profile
with `dina_tender_draft` / `dina_tender_status` (§4.4). Then the bridge
(§4.1–§4.2; `cli/src/dina_cli/dot_bridge.py`, `dina dot-bridge serve`): the
`dot` profile over Streamable HTTP, and its own OAuth server whose consent step
is a `dina1:` setup code from the app, so each ChatGPT link pairs its own
agent key (revocable in Settings → Agents). Its container
(`cli/Dockerfile.dot-bridge`) runs as an optional service in the shared infra
(`DOT_BRIDGE_HOST` in `deploy/managed/infra`), on its own network behind the
shared Caddy (§4.3); not yet built or deployed. Not built: the plugin listing.
The bridge serves people who run their own Dina; the default path, a Dina we
create at sign-up, is designed in `docs/HOSTED_DINA.md`, whose demo cut is
built (its §12). Each
status poll renews the session lease (§4.5); a dot that stops polling for 15
minutes loses its session. Facts about dots come
from public write-ups of the 29 September 2026 launch; OpenAI's own page
refused automated reads, so re-check the details there before building. Points
marked *(unverified)* rest on a single write-up or on inference.

## 1. What dots are

A dot is an always-on agent inside ChatGPT (GPT-6 Astra). Each one has its own
cloud computer and browser and keeps working on a goal after the user leaves.

- **Reaching apps:** through ChatGPT plugins, the same ones ChatGPT and Codex
  use (Gmail, Drive, GitHub; "4,000+ apps"). A plugin can hold an MCP server
  and skills, with optional UI; the MCP server is reached over public HTTPS
  (Streamable HTTP or SSE) with OAuth. Permissions can be set per action, such
  as read mail but not send it. Whether a dot loads a plugin's skills is
  *(unverified)*.
- **Hooks:** one write-up says dots support only admin-managed remote MCP
  hooks; command, prompt and agent hooks don't run *(unverified)*.
- **Talking to it:** ChatGPT, Slack, Teams and voice. Texting is in narrow beta.
- **Rules:** four levels per kind of action: act, act if pre-approved, ask the
  user first, hand off. Password changes and money transfers always go to the
  user; purchases need approval. An Auto-review step checks some actions (such
  as sending mail) and the user can't turn it off.
- **No API.** OpenAI has announced no way for outside software to start or
  steer a dot. Dots can start Codex tasks; nothing documented goes the other way.
- **Who gets it:** ChatGPT Pro and Business Premium; Enterprise in beta. Pro
  excludes the EEA, Switzerland and the UK. No data residency or zero data
  retention during the beta. What a dot learns stays after you disconnect an app.

## 2. Verdict

| Direction | Possible? | How |
|---|---|---|
| A dot uses Dina (memory, trust, approvals, services, negotiation) | **Yes**, with work | Dina ships as a ChatGPT plugin: a remote MCP server |
| Dina hands work to a dot | **No**, not today | No dot API. Slack messages to the dot would work but are fragile and unsupported |
| Dina stops a dot's other actions | **No** | A dot's Gmail or shopping plugins act on their own; Dina sees only what the dot chooses to send it |

So the shape that works: **Dina is a plugin the dot calls.** The dot can ask
Dina what the user knows and prefers, check PeerLens, find services, and draft
a negotiation for the owner to open. Anything that commits the owner (an award, a send, a risky
action) stays a decision the owner makes on an owner surface.

## 3. What fits well

- **Most tools already exist.** `dina mcp-server` (`cli/src/dina_cli/mcp_server.py`)
  exposes about 40 tools: `dina_ask`, `dina_remember`, `dina_validate` /
  `dina_validate_status`, `dina_peerlens`, `dina_find_service` /
  `dina_invoke_service`, `dina_reminders`, `dina_talk`, and more. A dot needs a
  narrower set (§4.4).
- **Dina's slow paths suit a slow agent.** Ask, validate and tender work are
  async (start, then poll). A dot runs for hours, so it can wait, provided the
  session survives the wait (§4.5).
- **A user can tell the dot to check with Dina** before risky steps. This is an
  instruction the model may or may not follow, so it is advice, never
  enforcement (§5).
- **The TLS front end and container pattern of the A2A gateway**
  (`apps/home-node-lite/a2a-gateway`) can be copied. The gateway itself can't
  host the bridge: it listens on loopback, forwards only to Core's fixed A2A
  and UCP ingress routes under its own service key, and holds no agent key
  (its README, lines 18–27 and 75–83; `authz.ts` gateway rows).

## 4. General plugin work

1. **Remote MCP transport.** Today the MCP server runs over stdio only
   (`mcp_server.py:1038`), started on the user's own machine. ChatGPT needs a
   public HTTPS endpoint.
2. **Linking.** Dina has no inbound OAuth. Two principals exist that a bridge
   could use:
   - a paired device with `role='agent'` and its own Ed25519 key, revocable
     from Settings → Agents, gated by persona tiers;
   - an A2A Lane 2 client (`a2a:<client_id>`, owner-minted bearer stored as a
     hash, 90-day expiry, scoped grants; its review cards already reach the
     phone; `A2A_GATEWAY_ARCHITECTURE.md` §5.1).

   Either way, ChatGPT's OAuth consent must wrap an owner approval on an owner
   surface, and the OAuth token OpenAI holds becomes the working credential
   (§5).
3. **Where the bridge runs.**
   - *Home-server users:* on their own server, as a **new, isolated public
     process**: its own container and OS user, only its own key, no Core
     secret mounts, no access to Brain's listener. The A2A gateway's README
     forbids exposing a same-user native install; the same rule applies here.
   - *Phone-only users (most users):* the phone sits behind NAT, so a hosted
     bridge run by Dina would reach it through MsgBox. That bridge would hold
     every linked user's agent key and would see every reply in plain text,
     since it must hand replies to OpenAI. That is a central point of trust
     the Four Laws (Absolute Loyalty) argue against. Also, iOS suspends the app,
     so the phone Home Node is often unreachable while a dot keeps working.
     **Both are open blockers** for phone-only users.
4. **A dot tool profile.** An explicit allowlist. Leave out the reasoning and
   runner tools (`dina_reasoning_*`, `dina_task_*`, `dina-work` jobs carry vault
   context to OpenAI), and `dina_scrub` / `dina_rehydrate` (the dot's text is
   already at OpenAI; rehydrate would return raw PII to it). Neither existing
   profile fits (`mcp_server.py:976-1002`): `connected` (the one in
   `.mcp.json`) keeps the reasoning tools, and `coding` drops them but keeps
   `dina_scrub`, `dina_rehydrate` and `dina_ask`. So a new profile is needed.
5. **Sessions.** Core sessions hold a 15-minute lease renewed only by calls
   (`packages/core/src/session/registry.ts:41`); a lapsed session fails with
   `invalid_session` and its grants go with it. Unnamed starts all share the
   name `mcp-session` (`mcp_server.py:70-74`). Codex ends sessions through a
   `SessionEnd` hook, which dots won't run. The bridge needs one unique session
   per dot task, renewal while the dot waits on an approval, clean-up when the
   task ends or is cancelled, and recovery after a lapse. (Most tools take a
   `session`; `dina_status`, `dina_scrub`, `dina_rehydrate` and the
   `dina_task_*` tools don't.)
6. **Approvals on a server node.** On `home-node-lite` the phone mirror
   (`apps/home-node-lite/core-server/src/approval/phone_approval_sync.ts:510-653`)
   carries coding-gate, A2A, UCP and agent-facade cards only. The cards a dot
   would raise through `dina_validate` (`intent_validation`) and commerce cards
   (`commerce_staff_escalation`, tender cards) are decided on Core's `/owner`
   console (NEGOTIATION_PLAN §4.7). Approving on the phone means new mirroring.
7. **Listing.** Start as a private plugin (developer mode or workspace); the
   public directory needs OpenAI review.

## 5. Risks and decisions for the owner

- **Data leaves the Home Node.** Whatever Dina returns to a dot goes to OpenAI and
  stays in the dot's memory, even after unlinking. Default: health and finance
  closed to the dot; default-tier personas are free to agents and standard-tier
  ones open with a session grant, so the dot profile should not include
  `dina_ask` at all for the commerce demo.
- **Supplier prices and the owner's limits.** The ranking, story and held-quote
  reads return each bakery's quoted prices and the bargaining history (totals,
  revisions, counters, lines); the ranking also returns the café's
  `target_total` and `budget_ceiling` (`commerce.ts:7529-7540`);
  `GET /v1/commerce/buyer/quotes` lists every held quote on the node, not one
  tender's. Sending these to OpenAI breaks the promise to suppliers that their
  price reaches one buyer and never a platform (TRADE_FIRST_STRATEGY §3, §3.5)
  and the rule that the owner's limits are entered on an owner-present form no
  model reads (COMMITMENT_KERNEL §7). Releasing the full signed quotes would be
  worse still: a signed quote is provable (§3.5). So the dot's read shows
  ranks and bakery names only. Showing it prices is out of scope: the café
  owner's consent alone can't change a promise made to the bakeries.
- **Prompt injection.** A dot reads the web and mail. Text it reads can steer it
  to call Dina tools and carry the answers out through its own Gmail or
  browser, a step Dina can't see. Dina's own defence is Tier 1 only today.
  Mitigation: the narrow profile (§4.4), no vault reads in the demo, and
  nothing in a dot reply the owner would mind leaking.
- **The OAuth token.** It becomes the real credential on a public endpoint.
  Needed: short lifetime, refresh tied to the paired device, revocation from
  Settings → Agents that kills the token, and per-token rate limits.
- **Dina can advise the dot but can't stop it.** The demo must not claim Dina
  governs a dot. Only steps that pass through Dina's own routes are enforced,
  and those keep the owner's decisions with the owner.
- **It reverses a recorded decision.** MCP agents were deprecated in favour of
  the `dina-agent` CLI. A remote MCP door just for ChatGPT plugins is a narrow
  exception, and the owner should make that call.
- **Overlap with the dot's own safety.** Dots already gate money and run
  Auto-review. Dina adds what OpenAI can't: the user's private memory, trust from
  their own circle, and owner decisions on a device the owner holds.
- **Reach.** Pro and Business Premium only, not in the EEA or UK, still in beta.

## 6. The bakery negotiation demo through a dot

### 6.1 Relation to the Codex plugin

Same plugin **format**; a separate dot variant of the package. The Codex plugin
(`cli/codex-plugin/plugins/dina`, v0.3.2) starts its MCP server locally
(`./bin/dina-cli mcp-server --profile connected`), installs a Home Node through
its setup skills and `bin/` scripts, and gates local Codex tool calls through
the trusted `PreToolUse` hook (`bin/dina-gate`; hosted tools such as web search
and paths that skip hooks stay outside it). None of that works for a dot. The `audit`
skill runs `bin/dina-cli`, `status` checks Codex hooks, `dina-work` makes the
host a reasoning backend, and `dina` assumes the Codex gate. So the dot variant
carries only an adapted `dina` skill (if dots load skills), the dot tool
profile (§4.4) and the new negotiation tools.

### 6.2 How negotiation works in Core today

- **Opening a tender** (`POST /v1/commerce/trade/tender`, owner-only, no
  presence check) needs each bakery's `supplier_did` and `service_rkey`, the
  lines and a delivery projection (`commerce.ts:7365-7380`). The only form that
  opens one with a target and ceiling is the phone's `app/ask-quotes.tsx`; the
  `/owner` console views, awards and sends, but can't open a tender.
- **Counters run in Core.** Core's loop counters for the buyer only when the
  tender opens with a `negotiation` policy (`target_total`, `budget_ceiling`)
  (`commerce.ts:7448-7477`). A counter by hand (`POST /v1/commerce/trade/counter`)
  is owner-only; a clerk can't counter (NEGOTIATION_PLAN §4.7).
- **Award needs a person present**, the owner included
  (`commerce.ts:7591-7595`), but only where presence can be proved: on a
  convenience-mode server with no wrapped seed there is no verifier and the
  check is skipped (`commerce.ts:628`, `owner_presence.ts:156-168`). It holds an order and returns its `approval_id`;
  **`POST /v1/commerce/orders/submit`** sends it (`commerce.ts:1300`).
- **Two limits.** `budget_ceiling` is a hard tender limit: offers above it are
  never awardable. A clerk's grant cap is separate: above it the award goes to
  the owner's card.
- **Buyer approval within a spending limit, with no person present, is
  deferred** (NEGOTIATION_PLAN item 10: "It bypasses owner presence and needs
  its own design").

### 6.3 Recommended demo shape

> **Superseded for hosted Dinas (2026-10-25).** The owner's ChatGPT dot now
> opens, reads the quotes and awards too (`docs/HOSTED_DINA.md` §6.3): few
> people will install Dina, so the plugin has to do everything. The shape
> below still holds for any other agent.

This keeps every owner decision with the owner and needs no new spending power
for the dot.

1. The Main Street Café owner messages their dot in Slack: "get 200 croissants
   for Friday from our usual bakeries, best price."
2. The dot calls Dina to **draft** a tender with what it needs: the lines, the
   date, the delivery. The dot names no suppliers. Core fills them from the
   café's existing trade counterparties, so a bakery named in text the dot
   read (or was fed) never reaches the card. The draft holds no target and no
   ceiling.
3. Core turns the draft into an owner card. The owner checks the bakeries, adds
   the target and the ceiling on a Core form that needs the owner present, and
   opens the tender.
4. Each bakery's Dina answers within its own floors (the plan's example: list
   240, auto floor 220, owner-only floor 210). Core's loop counters within the
   café's policy.
5. The dot polls a per-tender status (rounds done, bakeries ranked, no prices
   or limits) and tells the owner in Slack when it is ready.
6. The owner awards and sends on the owner surface (Core's `/owner` console on
   a server node; the phone's tender screen on a phone node). Dina never
   touches money.
7. The dot reports the held order's state (held, sent, lapsed; the ranking's
   `held_order`) and the bakery's answer to the order (accepted, rejected or
   countered), which the new status read must carry (§6.4).

### 6.4 What it needs, beyond §4

1. A **tender-draft lane** for the dot: an agent route that takes lines, date
   and delivery, fills the suppliers (with their commerce `service_rkey`) from
   the café's trade counterparties, stores the draft and raises an owner card.
   No agent route opens, counters, awards or sends.
2. A **per-tender status read** for the dot, scoped to one tender: rounds,
   ranks and bakery names, the held order's state and the bakery's answer to
   the order. No prices, no quotes, no `target_total` or `budget_ceiling` (§5).
3. **Tools** in the dot profile: draft a tender, read its status.
4. **An owner form on the `/owner` console** that opens a drafted tender with
   target and ceiling, gated on owner presence and refusing when presence
   can't be proved. This is new: the console can't open tenders, and the
   tender route has no presence check today. Phone mirroring of tender cards
   on a server node is extra work (§4.6).
5. **A security-mode server** for the demo (wrapped seed, so a presence
   verifier exists); otherwise award and the new form don't check presence.
6. **Demo preconditions on the bakery side:** each bakery's supplier pack at
   1.1.0 or later (1.0.0 declines counters), `SupplierSettings.negotiation`
   set with floors, a published listing, and an existing relationship with
   the café. A stranger buyer gets 5 price questions an hour, which runs out
   during rounds (NEGOTIATION_PLAN §9), and phase-1 tendering is limited to
   existing or invited relationships (TRADE_FIRST_STRATEGY §3.5).

### 6.5 Later option, not for the demo

A dot that awards within a cap with no person present reopens NEGOTIATION_PLAN
item 10. It needs its own design and the owner's sign-off, including how a dot
proves anything a staff PIN proves (a dot is not a person, and the PIN must not
go to OpenAI).

## 7. Suggested next steps

1. **Negotiation spike** (tests the demo): on a security-mode home server, with
   the bridge isolated (§4.3), build the tender-draft lane, the status read and
   the owner's open form on `/owner` (§6.4), link them
   to ChatGPT as a private plugin, and run §6.3 end to end with two test
   bakeries the café already knows, the owner deciding on `/owner`.
2. **General plugin spike** (tests only the general path): check whether a dot
   calls `dina_validate` before sending mail when told to. Several runs, since
   one run proves nothing about a model's habits; whatever the result, this
   stays advice (§5).

Build the hosted bridge only after both, and only once its blockers (§4.3) have
answers.

## Sources

- [OpenAI: Introducing dots](https://openai.com/index/introducing-dots/)
- [TechCrunch: OpenAI launches Dots](https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/)
- [VentureBeat: Dots and ChatGPT Space](https://venturebeat.com/technology/openai-launches-dots-always-on-ai-agent-coworkers-and-chatgpt-space-where-they-can-collaborate-with-human-teams)
- [Flavio Copes: A deep dive into OpenAI dots](https://flaviocopes.com/openai-dots/)
- [Emergent: What dots can't do yet](https://emergent.sh/learn/openai-dots)
- [OpenAI: Apps in ChatGPT and the Apps SDK](https://openai.com/index/introducing-apps-in-chatgpt/)
- [OpenAI Help: Developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta)
- [Pinggy: Build a ChatGPT plugin with MCP](https://pinggy.io/blog/build_and_publish_chatgpt_plugin_mcp/)
