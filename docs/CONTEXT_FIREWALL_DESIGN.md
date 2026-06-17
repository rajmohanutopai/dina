# Context Firewall Design

**Status:** Design / plan only. No runtime code in this pass.
**Date:** 2026-06-17
**Scope:** Mobile Dina, Brain, Core workflow, PeerLens/AppView review search,
Dina Services, paired local agents, D2D talk/service calls, and approval UX.

## 0. Problem statement

Dina's product value depends on context enrichment:

- reminders use vault context to schedule and phrase the right nudge;
- AppView review search uses preferences and history to retrieve better matches;
- service discovery uses location, budget, language, and known providers;
- agent tasks need enough context to complete useful work;
- final chat responses must explain why a result fits the user.

The security problem is not that Dina reads context. The problem is when locally
read context is copied into an outbound request to an external system before the
user approved that egress.

The concrete failure mode observed:

1. The user asked Dina to delegate a task.
2. Task mode instructed Brain to resolve vault references first.
3. Brain read a locked/sensitive health fact as the owner.
4. Brain placed that fact in `task_description`.
5. The paired external agent received the sensitive fact before its own
   `dina ask --session ...` call could hit the approval gate.

The approval gate worked on the back door, but the front door leaked context in
the task framing. `scrubPII()` is not sufficient because "bad back pain" is not
structured PII; it is semantic health data.

## 1. Design goal

Keep context enrichment. Add a hard boundary before context leaves Dina.

> Dina may use private context locally to plan, filter, rank, and explain.
> Dina may not send private context outward unless policy allows it or the user
> approves it.

This document proposes a Context Firewall: a typed, provenance-aware egress layer
between private reasoning and every external call.

## 1.1 Design refinements / non-negotiables

The firewall must be an enforced runtime boundary, not a prompt convention.

1. **Typed egress APIs, not best-effort prompt discipline.** External calls should
   be possible only through APIs that require an `EgressDecision`. A tool should not
   be able to call AppView, a service provider, D2D talk, or agent delegation with
   arbitrary free text that bypasses the compiler.
2. **Structured facts before free text.** Vault/search/preference tools should
   return typed `ContextFact` values whenever possible. LLM prose can summarize
   those facts for the owner, but egress decisions operate on structured facts.
3. **Approvals bind to exact payloads.** If the user approves sharing context, the
   approval should bind to the recipient, purpose, scope, and a hash of the exact
   outbound payload. Before send, code verifies the payload still matches.
4. **Discovery and execution are different gates.** Directory/AppView discovery gets
   coarse intent. Provider execution receives required fields only after capability
   policy and egress approval pass.
5. **Agents use a data-request protocol.** A delegated agent receives the objective
   and a scoped session. If it needs user data, it asks Dina through that session.
   Brain does not prefill vault facts into the task prompt.
6. **External handoff is visible.** Even when the user typed the topic themselves,
   the UI should make agent/service handoff clear: "this agent/provider will see
   the task; sensitive details require separate approval."

## 2. Non-goals

- Do not weaken reminders, local Ask, local ranking, or local service selection.
- Do not make all external calls require approval. That would make Dina unusable.
- Do not rely on prompt instructions alone for security.
- Do not try to solve semantic privacy with regex-only PII scrubbing.
- Do not make AppView, service providers, or agents responsible for protecting
  facts they should never have received.

## 3. Core model

Every fact used by Brain should carry provenance and sensitivity.

```ts
export type ContextSource =
  | 'user_prompt_current_turn'
  | 'user_prompt_prior_turn'
  | 'vault'
  | 'preference'
  | 'contact'
  | 'reminder'
  | 'service_result'
  | 'appview_result'
  | 'derived';

export type Sensitivity =
  | 'public'
  | 'personal'
  | 'sensitive'
  | 'locked'
  | 'regulated'
  | 'credential';

export type ContextCategory =
  | 'health'
  | 'finance'
  | 'location'
  | 'contact'
  | 'identity'
  | 'schedule'
  | 'preference'
  | 'relationship'
  | 'work'
  | 'general';

export interface ContextFact {
  id: string;
  text: string;
  source: ContextSource;
  persona?: string;
  sensitivity: Sensitivity;
  category: ContextCategory;
  confidence: number;
  createdAtMs: number;
  derivedFrom?: string[];
  safeExternalHints?: Array<{
    target: EgressTarget;
    value: string;
    sensitivityAfterGeneralization: Sensitivity;
  }>;
}
```

Derived facts inherit the maximum sensitivity of their inputs. Paraphrasing does
not remove taint.

Example:

```text
Vault fact:
  "User has recurring lower-back pain."
  source=vault, persona=health, sensitivity=sensitive, category=health

Derived fact:
  "Needs lumbar support."
  source=derived, derivedFrom=[health-fact-id], sensitivity=sensitive,
  category=health
```

The derived phrase is less revealing, but it is still derived from health data.
The egress compiler may generalize it for some targets, but the raw derivation
must be known.

`safeExternalHints` are optional, pre-reviewed transformations supplied by local
tools or deterministic mappers. They are not a bypass. The compiler still checks
target policy before using them.

Example:

```json
{
  "text": "User has recurring lower-back pain.",
  "source": "vault",
  "persona": "health",
  "sensitivity": "sensitive",
  "category": "health",
  "safeExternalHints": [
    {
      "target": "appview_review_search",
      "value": "lumbar_support",
      "sensitivityAfterGeneralization": "personal"
    }
  ]
}
```

For AppView review search, `lumbar_support` may be allowed as a coarse product
attribute. For a clinic/provider/agent, the original health condition still
requires approval before being shared.

## 4. Egress targets

Different destinations get different context.

```ts
export type EgressTarget =
  | 'internal_local'
  | 'appview_review_search'
  | 'appview_service_directory'
  | 'service_provider_query'
  | 'paired_agent_task'
  | 'd2d_talk_message'
  | 'review_publish'
  | 'audit_log';
```

### 4.1 Internal local

Examples: reminders, local Ask synthesis, local reranking, local notifications.

Policy:

- Full context may be used locally.
- No approval is needed merely to reason with the owner's data.
- Sensitive output shown to the owner is allowed.
- If an internal result is later sent outward, it must pass the firewall then.

### 4.2 AppView review search

Examples: "where do I get a chair?", "is this tutorial good?", "which bakery is
better?"

Policy:

- Send subject, category, coarse preferences, and non-sensitive filters.
- Do not send raw vault facts.
- Sensitive facts can be transformed only into coarse product attributes when
  the transformation is materially less identifying.
- Rerank AppView results locally using private facts.

Allowed:

```json
{
  "query": "ergonomic office chair",
  "filters": {
    "features": ["lumbar_support"],
    "budgetBand": "mid",
    "durability": "high"
  }
}
```

Not allowed without approval:

```json
{
  "query": "office chair for Rajmohan's chronic back pain, budget $500"
}
```

### 4.3 AppView service directory

Examples: find a bus ETA service, find a clinic appointment provider, find a
bakery availability provider.

Policy:

- Send capability and coarse routing constraints.
- Do not send subject-private data to generic discovery.
- Directory search is about finding providers, not executing the full request.
- Local Dina chooses candidates using private preferences after the directory
  returns.

Allowed:

```json
{
  "capability": "appointment_availability",
  "category": "clinic",
  "locationBand": "nearby",
  "language": "en"
}
```

Not allowed without approval:

```json
{
  "capability": "appointment_availability",
  "condition": "lower-back pain since March",
  "doctorPreference": "orthopedic"
}
```

### 4.4 Specific service provider query

Examples: ask a public service for ETA, appointment slots, price, order status.

Policy:

- Send only the capability's required params.
- Capability schemas must classify each field by privacy.
- Public/personal fields may be sent if necessary.
- Sensitive/regulated fields require approval or an existing grant.
- The approval is an egress approval, not just a vault-read approval.

Example service schema metadata:

```ts
type CapabilityParamPolicy = {
  field: string;
  privacy: 'public' | 'personal' | 'sensitive' | 'regulated';
  required: boolean;
  generalizable?: boolean;
};
```

ETA query:

```json
{
  "stop": "Castro Station",
  "route": "42"
}
```

Health appointment query requiring approval:

```json
{
  "specialty": "orthopedics",
  "reason": "lower-back pain"
}
```

The approval card should say exactly what leaves:

```text
Share with provider?

Dina wants to send:
- Specialty: orthopedics
- Reason: lower-back pain

To:
Castro Clinic appointment service

For:
Find available appointment slots

Allow once / Allow for this task / Deny
```

### 4.5 Paired agent task

Examples: `dina agent-daemon --runner claude-code`, OpenClaw, Codex, Gemini,
Hermes, or a custom local agent paired to this Home Node.

Policy:

- The task description must contain the user's objective, not vault-derived
  facts.
- The workflow task must always carry a non-empty `sessionName`.
- The agent must use `dina ask --session <session>` to request user data.
- Sensitive persona reads then hit the existing approval gate.
- If Brain wants to proactively share a sensitive summary with the agent, it
  must create an egress approval before the task is claimed.

Allowed task description:

```text
Create a short document about the user's health condition. If you need user
health details, ask Dina using the provided session.
```

Not allowed:

```text
Create a short document about the user's health condition. The user has bad
back pain.
```

### 4.6 D2D talk message

Examples: sending a message to another Dina or to a contact.

Policy:

- The user-visible message body is the egress payload.
- If Dina drafts from sensitive context, the send action must show the exact
  outgoing message before sending.
- No hidden sensitive context should be sent in metadata.
- Contact names can be resolved locally; only the final recipient DID/handle and
  message body leave.

### 4.7 Review publishing

Examples: writing a review, vouch, flag, endorsement.

Policy:

- A review body is public/federated by nature.
- Dina must distinguish "write a review" from "summarize my private facts in a
  review."
- If the review draft contains sensitive vault-derived context, it must be shown
  explicitly before publishing.
- Review ranking can use private context locally without publishing that context.

## 5. Egress compiler

All external tools should call one compiler before sending data.

```ts
export interface EgressRequest {
  target: EgressTarget;
  purpose: string;
  recipient?: {
    did?: string;
    serviceUri?: string;
    displayName?: string;
  };
  facts: ContextFact[];
  requestedPayloadShape?: unknown;
}

export interface GeneralizedFact {
  text: string;
  category: ContextCategory;
  derivedFrom: string[];
  sensitivityAfterGeneralization: Sensitivity;
}

export interface EgressDecision {
  decision: 'allow' | 'allow_generalized' | 'requires_approval' | 'deny';
  payload: Record<string, unknown>;
  payloadHash: string;
  includedFactIds: string[];
  generalizedFacts: GeneralizedFact[];
  withheldFactIds: string[];
  approvalDraft?: EgressApprovalDraft;
  audit: EgressAuditSummary;
}
```

The compiler must be deterministic and testable. LLMs may suggest external query
phrases, but they do not decide what can leave.

`payloadHash` is computed over canonical JSON:

```ts
payloadHash = sha256(canonicalJson({
  target,
  recipient,
  purpose,
  payload,
}));
```

When approval is required, the approval stores this hash. The sender recomputes
the hash immediately before egress. If the payload changed, the approval is no
longer valid and a new approval is required.

### 5.1 Mandatory egress wrappers

External call sites should not accept raw prompt strings directly. They should
accept an `EgressDecision` or a narrower safe payload produced by the compiler.

Preferred shape:

```ts
async function searchReviews(decision: EgressDecision): Promise<SearchResult> {
  assertDecisionAllowed(decision, 'appview_review_search');
  return appview.search(decision.payload);
}
```

Avoid:

```ts
await appview.search(llmGeneratedQuery);
```

The rule is especially important for agent delegation. The API that creates a
claimable `free_form_task` should require either:

- a raw user objective with no `ContextFact` inputs; or
- an approved `EgressDecision` whose target is `paired_agent_task`.

There should be no code path where Brain can pass a vault-enriched paragraph
straight to `description`.

## 6. Sensitivity and transformation rules

### 6.1 Public

Can leave if useful and relevant.

Examples:

- product category: office chair;
- route number;
- public business name;
- public review subject.

### 6.2 Personal

Can leave only when necessary and expected for the task.

Examples:

- rough location;
- preferred language;
- general budget band;
- device type.

Transform before egress where possible:

```text
"I live at 123 Castro St" -> "near Castro"
"budget is exactly $487" -> "under $500" or "mid budget"
```

### 6.3 Sensitive

Cannot leave silently. Can be generalized for some targets if the result no
longer reveals the sensitive condition.

Allowed generalized form for review search:

```text
"back pain" -> "lumbar support"
```

Still approval-required for a human/service/agent recipient if phrased as a
condition:

```text
"I have lower-back pain"
```

### 6.4 Locked / regulated / credential

Never leave without explicit approval. Credentials should almost never leave at
all; use capability-specific token flows instead.

Examples:

- medical diagnosis;
- bank balance;
- insurance claim number;
- recovery phrase;
- API key;
- passphrase;
- government identifier.

## 7. Approval types

Today Dina has approval for agent persona access and actions. Context egress
needs a distinct approval type.

```ts
export interface ContextEgressApprovalPayload {
  type: 'context_egress';
  target: EgressTarget;
  recipient: {
    did?: string;
    serviceUri?: string;
    displayName?: string;
  };
  purpose: string;
  payloadHash: string;
  payloadPreview: Record<string, unknown>;
  fields: Array<{
    label: string;
    valuePreview: string;
    category: ContextCategory;
    sensitivity: Sensitivity;
    sourcePersona?: string;
  }>;
  scope: 'once' | 'task' | 'session';
  sessionName?: string;
  sourceThreadId?: string;
  sourceMessageId?: string;
}
```

The card must answer:

- who receives the data;
- what exact data leaves;
- why it is needed;
- how long the approval lasts.

The sender must verify:

```ts
assert(storedApproval.payloadHash === currentDecision.payloadHash);
assert(storedApproval.target === currentDecision.target);
assert(sameRecipient(storedApproval.recipient, currentDecision.recipient));
```

If any check fails, the previous approval is stale and cannot authorize the send.
This prevents "approve one payload, send a different payload" drift.

## 8. Local enrichment patterns

### 8.1 Review search

Flow:

```text
User asks: "Where do I get a chair?"
  -> Dina reads local health/preference/finance context.
  -> Context pack contains back pain, budget, durability preference.
  -> Egress compiler sends "ergonomic office chair", "lumbar_support",
     "mid_budget".
  -> AppView returns candidates.
  -> Dina reranks locally using the exact private facts.
  -> Dina answers with local explanation.
```

Chat response:

```text
I checked ranked reviews for ergonomic office chairs and filtered them locally
using your saved back-support and budget notes.
```

No external system receives "back pain" unless the user approves that egress.

### 8.2 Service directory

Flow:

```text
User asks: "When does the next bus reach Castro?"
  -> Dina may use location/preference locally.
  -> Directory query sends capability eta_query + public stop/route context.
  -> Directory returns providers.
  -> Dina chooses provider locally.
  -> Service query sends required ETA params.
```

No approval required if params are public.

### 8.3 Provider query with sensitive context

Flow:

```text
User asks: "Find a doctor for this back issue."
  -> Directory search can find clinics/orthopedics with coarse category.
  -> To ask a clinic for appointment availability with "back pain", Dina needs
     egress approval.
```

If denied:

```text
I can search general orthopedic availability without sharing the reason.
```

### 8.4 Paired agent task

Flow:

```text
User: /task create a document about my health condition
  -> Brain creates delegation with sessionName "task-..."
  -> Task description contains no vault facts.
  -> Agent asks Dina: "what health details should I use?"
  -> Core creates approval card.
  -> User approves or denies.
  -> If approved, agent receives only the approved answer.
```

Agent data request protocol:

```text
Agent prompt:
  TASK ID: task-...
  DINA SESSION: task-...
  OBJECTIVE: Create a short document about the user's health condition.
  INSTRUCTION: If you need user data, ask Dina using this session.

Agent request:
  dina ask "What health details may I use for this document?" --session task-...

Dina/Core:
  detects health persona read
  creates approval card
  returns pending_approval

Owner approves:
  Core grants this agent/session/persona read access or returns an approved
  scoped answer, depending implementation stage.

Agent retry:
  receives approved health summary
  completes task
```

The delegated task description itself must remain safe to show in agent logs,
runner transcripts, workflow lists, and crash reports. It is not a private data
container.

### 8.5 Internal reminder

Flow:

```text
User: remind me to stretch before long meetings
  -> Dina uses calendar/work/health context locally.
  -> Reminder is stored locally.
  -> No external egress.
```

No approval required unless the reminder is sent to another service/contact.

## 9. Scenario matrix

| Scenario | Local context allowed? | External payload | Approval? |
|---|---:|---|---:|
| Reminder from health note | Yes | None | No |
| Review search for chair using back pain | Yes | ergonomic/lumbar filters | No |
| Review search sends exact diagnosis | Yes | diagnosis text | Yes |
| Services directory for bus ETA | Yes | eta_query, stop/route | No |
| Service provider asks for bus ETA | Yes | stop/route | No |
| Clinic availability with symptom | Yes | symptom/reason | Yes |
| Paired agent writes generic haiku | No private read needed | objective only | No |
| Paired agent needs health summary | Yes locally, not in description | agent asks Dina | Yes before data |
| D2D message drafted from health vault | Yes locally | exact message body | User send confirmation |
| Review publish includes private fact | Yes locally | review body | Confirm before publish |
| AppView service profile publish | Yes for config | public listing data only | No, if user initiated |
| AppView review ranking | Yes locally | subject/coarse filters | No |

## 10. Required code changes

### 10.1 Delegation prompt changes

Change task-mode instructions from:

```text
Resolve any contact names or vault references using the read tools FIRST...
```

to:

```text
Resolve routing-only references such as contact names when needed. Do not read
or include vault facts in the delegated task description. If the agent needs
user data, it must ask Dina inside the provided session.
```

Change `delegate_to_agent` tool description from:

```text
Include any resolved contact identifiers, vault facts, or constraints...
```

to:

```text
Include the user's objective and non-sensitive routing details only. Do not
include vault-derived facts. Sensitive/user-private context must be requested by
the agent through Dina using the delegated session, or shared only after a
context-egress approval.
```

### 10.2 Delegation sessions

Every workflow task with `kind='delegation'` and `payload.type='free_form_task'`
must carry non-empty `sessionName`.

Recommended session naming:

```text
task-<taskId suffix>
```

Core should reject claimable external delegation tasks without a session. The
daemon should also fail closed if `session_name` is empty.

### 10.3 Context pack

The agentic loop should accumulate a `ContextPack` next to normal tool results:

```ts
export interface ContextPack {
  facts: ContextFact[];
  turnId: string;
  threadId?: string;
}
```

Every vault/search/preference/contact tool returns both:

- answer text for local reasoning;
- provenance facts for egress decisions.

### 10.4 Egress compiler adapters

Add adapters for:

- PeerLens/AppView review search;
- AppView service capability search;
- D2D service query;
- paired agent task creation;
- D2D talk send;
- review publish.

Each adapter must call `compileForEgress()` before a network send or workflow
task create.

### 10.5 Audit trail

Every egress decision should append a compact audit event:

```json
{
  "event": "context_egress_decision",
  "target": "appview_review_search",
  "decision": "allow_generalized",
  "included": ["topic:office_chair"],
  "generalized": ["health:lumbar_support"],
  "withheld": ["health:back_pain"],
  "approvalTaskId": null
}
```

Audit must not store raw sensitive values unless the event itself is inside the
same encrypted local store and not exported.

## 11. UX rules

### 11.1 Normal successful answer

Do not expose protocol mechanics by default.

Good:

```text
I checked ranked reviews for ergonomic office chairs and filtered them locally
using your saved back-support and budget notes.
```

Avoid:

```text
I sent your health context to PeerLens.
```

### 11.2 Withheld context

If Dina withholds context but can still proceed:

```text
I searched without sharing your private health note. I used it only to rank the
results locally.
```

### 11.3 Approval needed

If external quality materially improves only by sharing:

```text
I can ask the clinic with the reason for the visit, but that would share a
health detail. Approve sharing it?
```

### 11.4 Denied approval

```text
I will keep that private. I can continue with a general search.
```

## 12. Test plan

This feature needs tests at five levels: pure policy, tool integration, workflow,
mobile UI, and end-to-end.

### 12.1 Pure unit tests: egress compiler

File target:

```text
packages/brain/__tests__/context/egress_policy.test.ts
```

Tests:

1. `allows_public_facts_to_appview_review_search`
   - Input: product category public.
   - Expect: `allow`.

2. `generalizes_health_fact_for_review_search`
   - Input: health fact "back pain".
   - Target: `appview_review_search`.
   - Expect: payload contains `lumbar_support`, not `back pain`.

3. `withholds_raw_sensitive_fact_from_appview`
   - Input: "chronic back pain since March".
   - Expect: raw phrase absent from payload and audit.

4. `requires_approval_for_sensitive_service_provider_param`
   - Target: `service_provider_query`.
   - Schema field `reason` marked sensitive.
   - Expect: `requires_approval`.

5. `denies_credentials_for_all_external_targets`
   - Input: API key/recovery phrase.
   - Expect: `deny`.

6. `derived_fact_inherits_sensitivity`
   - Input derived "needs lumbar support" from health fact.
   - Expect: derived fact sensitivity remains sensitive.

7. `current_turn_sensitive_text_is_not_automatically_free`
   - User typed "I have back pain".
   - External target is provider/agent.
   - Expect: still goes through target policy; may generalize for AppView, but
     raw sharing to provider requires egress approval unless the user's command
     explicitly says to tell that provider.

8. `explicit_share_instruction_allows_once`
   - User says "tell the clinic I have lower-back pain".
   - Expect: compiler creates approval draft or marks explicit-current-turn
     egress as allowed only for that recipient and purpose, depending product
     decision.

9. `payload_hash_changes_when_payload_changes`
   - Same recipient/purpose, different outbound value.
   - Expect: different `payloadHash`.

10. `approval_payload_hash_binds_recipient_and_purpose`
   - Same payload, different provider or purpose.
   - Expect: different hash / previous approval invalid.

### 12.2 Delegation tests

File target:

```text
packages/brain/__tests__/reasoning/delegate_agent_tool_context_firewall.test.ts
```

Tests:

1. `delegation_description_rejects_vault_derived_health_fact`
   - Simulate tool call with a tainted health fact.
   - Expect: createWorkflowTask description does not contain it.

2. `delegation_description_allows_user_objective`
   - User asks "create a document about my health condition".
   - Expect: objective remains, but no health vault details are included.

3. `delegation_task_has_session_name`
   - Execute `delegate_to_agent`.
   - Expect: `sessionName` non-empty.

4. `delegation_payload_visible_to_agent_has_no_sensitive_fact`
   - Scan top-level description and payload description.
   - Expect: no raw sensitive value.

5. `pii_entities_is_not_used_as_semantic_privacy_escape`
   - Semantic health fact must not be stored in `_pii_entities` as if it were
     safe to rehydrate.

6. `task_mode_prompt_forbids_vault_fact_prefill`
   - Assert `wrapAsTaskPrompt` no longer says to resolve vault references first.

7. `delegation_api_requires_raw_objective_or_approved_egress_decision`
   - Attempt to pass arbitrary enriched text from a context pack directly.
   - Expect: compile/type/runtime rejection.

### 12.3 Core workflow tests

File targets:

```text
packages/core/__tests__/workflow/delegation_session.test.ts
packages/core/__tests__/agent/access_context_egress.test.ts
```

Tests:

1. `external_delegation_without_session_rejected`
   - Create/claim free-form delegation with no session.
   - Expect: 400 at create or fail-closed at claim.

2. `agent_persona_access_approval_payload_has_no_vault_content`
   - Existing invariant, extend to semantic health content.

3. `context_egress_approval_grants_only_matching_recipient_purpose`
   - Approve sharing health reason to clinic A.
   - Attempt sharing same fact to agent B.
   - Expect: requires new approval.

4. `context_egress_approval_scope_once_consumed`
   - Allow once.
   - First send succeeds.
   - Second send requires approval.

5. `context_egress_approval_scope_task_reuses_within_same_session`
   - Same task/session can reuse approved fact.
   - Different session cannot.

6. `approved_payload_must_match_hash_before_send`
   - Approve one context payload.
   - Mutate payload before send.
   - Expect: send refused and new approval required.

### 12.4 AppView review search tests

File target:

```text
packages/brain/__tests__/reasoning/peerlens_context_firewall.test.ts
```

Tests:

1. `chair_query_uses_lumbar_filter_not_back_pain_text`
   - Seed health context.
   - Mock AppView client.
   - Assert outbound query contains `lumbar_support`, not `back pain`.

2. `finance_budget_generalized_to_band`
   - Exact budget `$487`.
   - Assert outbound filter is `under_500` or `mid_budget`, not exact amount
     unless policy explicitly allows exact.

3. `local_reranker_receives_private_context`
   - AppView receives coarse query.
   - Reranker still uses private facts locally.

4. `answer_explains_local_filter_without_claiming_external_share`
   - Final response may say "filtered locally using your notes".
   - Must not say "shared your health note".

### 12.5 Services tests

File targets:

```text
packages/brain/__tests__/reasoning/service_tools_context_firewall.test.ts
packages/brain/__tests__/service/capability_privacy_policy.test.ts
```

Tests:

1. `public_eta_query_sends_public_params_without_approval`
   - stop/route only.
   - Expect: no approval.

2. `clinic_reason_requires_context_egress_approval`
   - field `reason` sensitive.
   - Expect: approval task before service.query.

3. `services_directory_search_never_sends_subject_private_data`
   - generic search for provider.
   - Expect: no symptom/account/private record leaves.

4. `denied_context_egress_falls_back_to_general_query`
   - Deny health sharing.
   - Expect: general appointment search possible.

5. `approved_context_egress_payload_exactly_matches_card`
   - What the card previews equals what service receives.

6. `service_call_wrapper_rejects_missing_egress_decision`
   - Direct provider call without compiler output.
   - Expect: rejected by API/type guard.

### 12.6 Mobile UI tests

File targets:

```text
apps/mobile/__tests__/approvals/context_egress_card.test.tsx
apps/mobile/__tests__/chat/context_firewall_copy.test.tsx
```

Tests:

1. `renders_context_egress_card_with_recipient_fields_purpose`
   - Shows recipient, exact fields, reason, Allow once/task/Deny.

2. `does_not_render_vault_content_in_normal_task_card`
   - Delegated task card shows objective only.

3. `foreground_sync_loads_missed_context_approvals`
   - Simulate missed MsgBox push.
   - On foreground, pending approval appears.

4. `denied_card_posts_private_fallback_message`
   - After Deny, chat says Dina continued without sharing private detail.

### 12.7 Agent daemon / CLI tests

File targets:

```text
cli/tests/test_agent_daemon_context_firewall.py
cli/tests/test_headless_runner_context_firewall.py
```

Tests:

1. `daemon_fails_closed_on_missing_session`
   - Claimed task has no `session_name`.
   - Expect: task_fail, no runner execution.

2. `headless_prompt_contains_session_and_no_prefilled_sensitive_context`
   - Build prompt.
   - Expect: objective only; no vault fact.

3. `agent_receives_pending_approval_when_requesting_health`
   - Mock `dina ask`.
   - Expect: `pending_approval` handling message.

4. `agent_does_not_continue_after_pending_approval`
   - Runner transcript should not complete with fabricated health content.

5. `agent_prompt_handoff_preview_contains_topic_not_vault_fact`
   - User typed a health-topic task.
   - Prompt may contain the user objective.
   - Prompt must not contain vault-retrieved details.

### 12.8 End-to-end tests

Targets:

```text
apps/mobile/maestro/context_firewall_task_health.yaml
apps/mobile/maestro/context_firewall_review_search.yaml
apps/mobile/maestro/context_firewall_service_provider.yaml
```

Scenarios:

1. Health document task:
   - Store health fact.
   - Ask `/task create a document about my health condition`.
   - Agent task prompt/transcript must not contain health fact before approval.
   - Approval card appears when agent asks Dina.
   - Deny means no health summary sent.
   - Approve means agent receives approved summary and completes.

2. Chair review search:
   - Store health and finance facts.
   - Ask chair query.
   - Capture AppView request.
   - Assert coarse filters only.
   - Final answer references local ranking.

3. Clinic service query:
   - Ask for clinic appointment because of back pain.
   - Directory search happens without symptom.
   - Provider query asks approval before symptom egress.
   - Deny uses generic query.
   - Approve sends exact previewed value.

4. Relay reconnect:
   - Force MsgBox stale/disconnected during approval creation.
   - Foreground/reconnect mobile.
   - Approval card appears from durable workflow polling.

## 13. Release gates

Do not call this complete until all of these pass:

1. No external delegation task can be created without `sessionName`.
2. No task prompt contains vault-derived sensitive facts pre-approval.
3. AppView review search requests contain only safe/generalized context.
4. Service provider requests enforce param-level privacy policy.
5. Context-egress approval cards show exact recipient, fields, purpose, and scope.
6. Missed approval pushes are recovered on mobile foreground.
7. Audit logs record egress decisions without leaking raw sensitive values.
8. Regression tests include the original "back pain in task description" case.

## 14. Implementation order

1. Patch task-mode and `delegate_to_agent` prompt text to stop prefilled vault
   facts.
2. Add non-empty session creation to mobile/Brain delegation workflow tasks.
3. Add daemon fail-closed check for missing `session_name`.
4. Add first regression tests for "health fact not in task description".
5. Introduce minimal `ContextFact` and `compileForEgress()` for AppView review
   search and delegation.
6. Add service capability param privacy metadata enforcement.
7. Add context-egress approval task type and mobile approval card.
8. Extend to D2D talk and review publish.
9. Add foreground polling for missed approvals.
10. Expand E2E coverage.

## 15. Product principle

The product promise should be:

> Dina knows your context. Other systems do not, unless you choose to share it.

This preserves the main advantage of Dina while making the trust boundary real.
