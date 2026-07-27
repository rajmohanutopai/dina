# Connected-Agent Gating and Reasoning

## Technical Architecture Specification, v0.1

**Status:** Implemented v1 substrate through Phase 4, plus the internal-Brain
Phase 5 adapter. Local-model and direct-provider adapters remain deferred.
**Date:** 2026-07-25
**Scope:** Coding-agent safety profiles and use of a connected Claude Code,
Codex, or compatible agent as Dina's reasoning layer
**Related documents:** `docs/DINA_PLUGIN_DEVELOPER_SURFACE.md`,
`docs/AGENT_CONTROL_PLANE.md`, `docs/PLUGIN_ARCHITECTURE.md`,
`docs/mobile/DINA_WORKFLOW_CONTROL_PLANE.md`

## 1. Executive decision

Dina will support three owner-selectable safety profiles for interactive
agents:

1. **Network Protection:** trust the owner-operated host for ordinary local
   work. Dina enforces non-owner requests, Dina-owned authority, and immutable
   kernel protections.
2. **Sensitive Boundaries:** allow ordinary local work without Dina prompts.
   Dina intervenes at sensitive data and external-effect boundaries.
3. **Full Supervision:** classify and enforce every supported tool call. This
   is mandatory for unattended, service-facing, delegated, or otherwise
   non-owner work.

These are policy profiles, not three implementations. All three use one
Core-owned gate. A caller cannot choose or lower its own profile.

Dina will also allow an already-running Claude Code, Codex, or compatible
agent to provide Brain reasoning. This avoids requiring a second paid AI
provider for work performed in that foreground agent session. Core remains
Dina: it owns identity, keys, encrypted data, grants, approvals, durable work,
Services, PeerLens writes, and audit. The connected agent proposes reasoning
results; Core authorizes, validates, and commits them.

An interactive subscription session is not an always-on server. Background
requests therefore use durable reasoning jobs. A connected host can claim
those jobs while it is active, but unattended processing requires an
explicitly configured always-on or local backend. If no eligible backend is
available, the job remains pending. Dina never silently borrows, scrapes, or
reuses a host's login credentials.

## 2. Product model in plain English

The user can choose how much Dina supervises Claude or Codex:

- In **Network Protection**, Claude handles normal coding with its own
  permissions. Dina steps in when another person, service, or agent is asking
  Claude to act through the user's Dina.
- In **Sensitive Boundaries**, Dina also steps in before protected information
  leaves, credentials or identity are used, or an important external action is
  taken.
- In **Full Supervision**, every tool call passes through Dina's policy
  decision, even when the owner is directly driving the session.

Separately, Claude can do the thinking that Dina's internal Brain would
otherwise do. Claude may interpret a question, organize a memory, or draft a
service answer. It does not receive Dina's keys and it cannot approve its own
request. Core supplies only authorized context and accepts only a
schema-valid result.

## 3. Goals

### 3.1 Gating goals

1. Avoid duplicating mature host safety prompts for ordinary owner-directed
   coding unless the owner explicitly asks for full supervision.
2. Preserve strict Dina enforcement when authority crosses people, agents,
   services, or trust domains.
3. Preserve hard protection for Dina's identity, keys, policy, grants, and
   encrypted stores in every mode.
4. Make the active profile understandable and reversible.
5. Avoid surveillance-style logs of ordinary owner activity in the lighter
   modes.
6. Ensure a compromised agent cannot claim it is owner-directed or select a
   weaker profile.
7. Keep one policy implementation across mobile, Home Node Lite, Claude Code,
   Codex, and future adapters.

### 3.2 Connected-Brain goals

1. Let a foreground agent use its current model to reason over
   Dina-authorized context without requiring another model API key.
2. Keep Core as the authority boundary even when the reasoning model changes.
3. Support Claude Code, Codex, OpenClaw, Hermes, Pi, and corporate agents
   through one backend contract.
4. Preserve the existing internal Brain as an optional always-on backend.
5. Support local models and direct provider APIs without changing Core
   semantics.
6. Queue reasoning work safely when no backend is available.
7. Prevent duplicate execution, stale completion, context over-disclosure,
   and backend substitution.
8. Keep mobile and Home Node implementations behaviorally identical by
   placing contracts and policy in shared packages.

## 4. Non-goals

1. Dina does not replace Claude Code's or Codex's sandbox.
2. Dina does not promise to detect prompt injection hidden in a web page,
   source file, tool result, or document during an owner-directed session.
3. Dina does not turn a consumer subscription credential into a general API.
4. Dina does not run Claude Code recursively in the background using cached
   host credentials.
5. Dina does not move root identity, vault, PDS, or recovery keys into the
   connected agent process.
6. Dina does not let a reasoning result directly perform an external effect.
7. Dina does not create separate policy implementations for each agent
   framework.
8. Dina does not require the internal Brain when the connected agent can
   complete the requested reasoning.

## 5. Architectural laws

The following rules are normative.

### LAW-1: Reasoning is not authority

A model may recommend an action or produce structured output. Only Core may:

- read or project protected vault data;
- evaluate grants;
- create approval requests;
- mint or consume permits;
- sign as the owner or a service;
- write to a PDS;
- send a D2D response;
- commit durable state;
- classify a caller's authenticated origin.

### LAW-2: The caller cannot choose its safety profile

The profile is stored against a Core-authenticated agent binding and selected
by the owner. A request body, prompt, MCP argument, environment variable, or
host hook cannot lower it.

The existing `mode: enforce | classify_only` value is an internal enforcement
mechanism. It must not be reused as the user-facing three-profile setting.

### LAW-3: Non-owner work has a mandatory floor

Any request that is not proven to be a direct owner-operated interaction uses
Full Supervision, regardless of the agent's preferred owner profile.

Unknown or missing provenance is non-owner provenance.

### LAW-4: Hard protections apply in every profile

The following cannot be disabled:

- protected key, recovery, vault database, and policy-path protection;
- authenticated identity binding;
- session and lease validation;
- grant and approval enforcement;
- payload-bound, single-use permits;
- no owner-DID impersonation;
- no direct Brain or PDS credential exposure;
- no non-owner downgrade;
- no completion after loss of claim authority;
- no unvalidated external response or PDS write.

### LAW-5: Host protection and Dina protection compose by intersection

An action runs only when both the host and Dina allow it where each applies.
Dina cannot override a host denial. A host approval cannot override a Dina
denial or missing Dina grant.

### LAW-6: Context is granted per purpose

A connected model receives a bounded projection for one task or session
purpose. It does not receive a mount, database handle, decryption key, or
general vault credential.

### LAW-7: Every completion is a proposal until Core commits it

Reasoning output is schema-validated, claim-fenced, policy-checked, and
committed by Core. A model saying "done" is not evidence that an effect
occurred.

### LAW-8: No hidden credential reuse

Dina may use a host model while that host is already executing the current
turn. It must not copy host tokens, read host credential stores, or assume a
consumer subscription is licensed for unattended embedding.

## 6. Trust boundaries and principals

```text
                         OWNER AUTHORITY DOMAIN

  Phone approval UI             Home Node Lite / Mobile Core
  -----------------             -----------------------------
  owner decisions       --->    identity, keys, vaults
                                grants, policies, permits
                                workflow + reasoning jobs
                                Services, D2D, PeerLens
                                           |
                                           | bounded context /
                                           | structured proposal
                                           v
                           Connected Claude/Codex/agent
                           ----------------------------
                           untrusted reasoner
                           paired did:key
                           no owner keys
                           no direct durable authority
                                           |
                                           | native tool request
                                           v
                           Host sandbox and permission UI
```

### 6.1 Owner identity

The owner keeps the canonical `did:plc` where public publication requires it.
The connected agent does not become that DID.

### 6.2 Agent identity

Each connected agent installation authenticates with its own revocable
`did:key`. The current plugin enrollment model already provides this
separation. The agent DID identifies the caller and its policy binding; it is
not the owner's publishing identity.

### 6.3 Reasoning-backend binding

Being paired as a coding agent does not automatically authorize an agent to
act as a Brain. The owner creates a separate Core record that binds:

- the agent DID;
- allowed reasoning task kinds;
- allowed sensitivity levels;
- foreground-only or always-on availability;
- the selected safety profile;
- optional persona limits;
- expiry and revocation state.

This can reference the same `did:key` used by the coding plugin without
granting every coding installation Brain authority.

### 6.4 Internal Brain

The existing Brain process remains an untrusted reasoning tenant. It may
satisfy the same reasoning-backend contract, but it receives no additional
authority merely because it is loopback-bound.

## 7. Authenticated request origin

The current workflow `origin` values such as `d2d`, `agent`, `cli`, and
`dinamobile` describe transport channels. They are not sufficient to decide
whether work is owner-directed.

Add a separate, immutable authority-origin object:

```ts
type AuthorityOriginKind =
  | 'owner_interactive'
  | 'contact_request'
  | 'service_request'
  | 'delegated_task'
  | 'background_job'
  | 'system_maintenance'
  | 'unknown';

interface AuthorityOrigin {
  kind: AuthorityOriginKind;
  ownerDid: string;
  requesterDid?: string;
  ingress: 'mobile' | 'web' | 'cli' | 'host_hook' | 'd2d' | 'service' | 'scheduler' | 'internal';
  correlationId: string;
  authenticatedAtMs: number;
  evidenceHash: string;
}
```

### 7.1 Assignment rules

1. Core assigns origin at the authenticated ingress.
2. `requesterDid` comes from verified transport identity, never a body field.
3. The object is immutable after task creation.
4. Derived work inherits the original authority origin.
5. A delegated task remains `delegated_task` even if the owner's coding agent
   later claims it.
6. A service query remains `service_request` after routing through Brain.
7. Missing evidence resolves to `unknown`.
8. Only an authenticated, owner-operated host session may receive
   `owner_interactive`.

### 7.2 Meaning of `owner_interactive`

`owner_interactive` means Core resolved the request to a live agent session
the owner configured for interactive use. It does not prove that every token
in the model's context expresses the owner's intent. Prompt injection inside
files or web content remains possible. Network Protection intentionally
delegates that problem to the host's sandbox and permission system.

Current desktop hosts also do not give Core cryptographic proof that a human
is physically present for each turn. Core may assign `owner_interactive` only
to an agent binding the owner explicitly enabled for foreground use, through
the installed host adapter. This is a configured trust decision, not
per-prompt human-presence attestation. A compromised foreground agent can
therefore misuse that trust outside a Core-originated task. Users who do not
accept that residual risk should select Full Supervision.

### 7.3 Origin propagation into host tool calls

When a connected host claims non-owner work, Core binds the claim to a
task-scoped authority context. Every tool call in that execution must resolve
to the same context server-side.

For v1:

- one host session may have at most one active non-owner authority context;
- a principal with any active non-owner authority context is treated as
  non-owner across all of its sessions, preventing a second-session escape;
- the context is attached by Core to the DID-bound session, not supplied as a
  trusted client field;
- all tool calls in that context use Full Supervision;
- ending or losing the reasoning claim clears the context;
- the session must not process unrelated owner work until the context ends.

Later adapters may create child sessions per task for concurrency. They must
preserve the same server-side binding.

The gate hook and MCP tools must resolve to the same canonical Core session.
At `SessionStart`, the adapter resolves `(agentDid, hostSessionId)` to one
`coreSessionId`. Gate calls may continue to carry the host session ID for
lookup, while MCP calls carry the resolved Core session ID. Core verifies that
both map to the same live record. An independently created CLI session cannot
claim connected-Brain work for a host and cannot carry its authority context.

For crash safety, Core persists the task's context ticket before reserving the
session authority origin. The ticket is the durable backlink used by boot
reconciliation, cancellation, lease reclaim, expiry, completion, and failure
to release that exact reservation. Revoking a connected agent ends every live
session for that principal, revokes every outstanding ticket, clears runtime
presence, and disables every reasoning-backend binding for the principal. The
owner revoke operation remains retryable against the persisted post-revoke
policy version when the binding CAS committed but a later cascade step reported
incomplete.

## 8. The three gating profiles

```ts
type GatingProfile = 'network_protection' | 'sensitive_boundaries' | 'full_supervision';
```

### 8.1 Profile 1: Network Protection

**User promise:** "Let my agent handle my normal work. Protect my Dina and
anything another person or agent asks it to do."

For direct owner-interactive work:

- ordinary host tools are left to the host's sandbox and permissions;
- Dina does not create ordinary action classifications;
- Dina does not log ordinary tool calls;
- Dina performs only the immutable kernel precheck;
- Dina MCP calls still pass through their own Core authorization;
- protected Dina paths and credentials remain blocked.

For contact, service, delegation, background, or unknown work:

- Full Supervision is mandatory;
- grants and requester identity are evaluated;
- risky actions use the normal approval path;
- the request cannot inherit owner-interactive trust merely because the same
  Claude session executes it.

**Honest limitation:** this mode does not protect against a malicious
instruction hidden inside owner-opened content if the resulting action stays
outside Dina-owned authority and the host itself allows it.

### 8.2 Profile 2: Sensitive Boundaries

**User promise:** "Do not interrupt normal work. Step in when private data,
identity, permissions, or an external effect is involved."

For direct owner-interactive work, Core transiently inspects the raw tool call
only enough to identify a boundary. It does not retain ordinary arguments or
emit ordinary audit records.

Boundary classes are:

1. **Protected context:** reading a sensitive or locked vault, retrieving
   secrets, or exporting a Dina context projection.
2. **External disclosure:** sending, uploading, publishing, messaging, or
   posting user content.
3. **External effect:** purchase, booking, deletion outside the workspace,
   account mutation, deployment, or irreversible remote action.
4. **Identity use:** PDS signing, owner DID use, relationship grant, vouch, or
   public review publication.
5. **Authority mutation:** changing permissions, gate settings, grants,
   policies, credentials, or pairing state.
6. **Delegation:** handing work or data to another agent or service.
7. **System-sensitive mutation:** changing authentication, startup services,
   device security, or protected configuration.

Normal code reads, edits, builds, and tests remain host-managed unless they
touch a hard-protected path.

For non-owner work, Full Supervision remains mandatory.

Initial boundary examples:

| Tool/action                                                               | Sensitive Boundaries result           |
| ------------------------------------------------------------------------- | ------------------------------------- |
| Read or edit normal files inside the active workspace                     | host-managed                          |
| Build, lint, test, or inspect local source                                | host-managed                          |
| Read a Dina key, vault database, recovery file, or gate policy            | hard deny                             |
| `git commit` in the local repository                                      | host-managed                          |
| `git push`, create a pull request, publish a package, or deploy           | gate external disclosure/effect       |
| Web search with a generic public query                                    | host-managed                          |
| Send user content, identifiers, or vault-derived context to a remote host | gate external disclosure              |
| Delete build output                                                       | host-managed when confidently bounded |
| Destructive or broad local deletion                                       | gate destructive effect               |
| Install software or alter startup, auth, permissions, or system config    | gate system-sensitive mutation        |
| Send email/message, book, purchase, publish, or change a remote account   | gate external effect                  |
| Read public service/review data                                           | dedicated Core route policy           |
| Publish a service/review or send D2D                                      | dedicated Core authority gate         |

These mappings are floors. A host may impose stricter controls. Tool
annotations are useful classification input but are not trusted as the sole
authority because a third-party tool can mislabel itself.

### 8.3 Profile 3: Full Supervision

**User promise:** "Have Dina evaluate every supported tool call and enforce my
policy throughout the session."

- every host tool call reaches the Core gate;
- every MCP action reaches its dedicated Core policy;
- safe calls may still run without a prompt;
- moderate and high-risk calls follow host or phone approval policy;
- blocked actions are denied;
- decision metadata is auditable; repetitive SAFE/allow decisions may be
  sampled per agent, action, and tool while every call is still evaluated;
- raw tool arguments are not retained by default.

Full Supervision means complete policy coverage, not continuous
interruption. Existing grants and safe classifications should keep the common
path quiet.

### 8.4 Effective-profile resolution

```ts
const PROFILE_RANK: Record<GatingProfile, number> = {
  network_protection: 1,
  sensitive_boundaries: 2,
  full_supervision: 3,
};

function effectiveProfile(
  configured: GatingProfile,
  origin: AuthorityOrigin,
  sessionElevation?: GatingProfile,
): GatingProfile {
  const originFloor: GatingProfile =
    origin.kind === 'owner_interactive' ? 'network_protection' : 'full_supervision';

  return strictest(configured, originFloor, sessionElevation);
}
```

Before this function runs, the immutable kernel precheck always runs.
`strictest` chooses the highest-ranked profile. A session or task may raise
protection temporarily; no session field may lower the stored profile or
origin floor.

### 8.5 Recommended defaults

| Agent use                                           | Default              | Can owner lower it?             |
| --------------------------------------------------- | -------------------- | ------------------------------- |
| Foreground Claude Code or Codex controlled by owner | Network Protection   | No lower profile exists         |
| Foreground agent with extra protection requested    | Sensitive Boundaries | Yes, back to Network Protection |
| Security-sensitive owner workflow                   | Full Supervision     | Yes after the workflow ends     |
| Background or scheduled agent                       | Full Supervision     | No                              |
| Public or approved-only service execution           | Full Supervision     | No                              |
| Contact or D2D request                              | Full Supervision     | No                              |
| Delegated task                                      | Full Supervision     | No                              |
| Unknown provenance                                  | Full Supervision     | No                              |

Existing installations should remain on their present full-enforcement
behavior until the owner explicitly chooses a lighter profile. New
foreground coding-agent installations may recommend Network Protection with
the limitation stated plainly.

## 9. Gate processing pipeline

```text
signed host request
  -> authenticate agent DID
  -> resolve/renew Core session
  -> resolve server-owned authority origin
  -> resolve owner-configured profile
  -> apply non-owner floor
  -> immutable kernel precheck
  -> profile-specific boundary/classification step
  -> grants and policy
  -> host approval or phone approval when required
  -> payload-bound single-use permit
  -> tool execution
  -> minimal audit according to profile
```

### 9.1 Kernel precheck

The kernel precheck is intentionally smaller than the current general action
classifier. It detects:

- Dina vault/key/recovery/policy paths;
- direct access to credential stores owned by Dina;
- attempts to alter the gate or its enrollment;
- malformed or unauthenticated session state;
- an active non-owner claim that is being presented as owner work;
- permit replay or payload mismatch.

It returns only `allow_kernel` or `deny_kernel`; it does not label ordinary
coding actions.

### 9.2 Sensitive-boundary classifier

This classifier is deterministic and conservative. It should use:

- tool identity and declared MCP annotations;
- canonicalized paths;
- destination host and operation;
- action verbs plus structured fields;
- Core-owned action metadata;
- declared effect and idempotency information.

It must not use an LLM to authorize an action. Unknown tools that may cross a
boundary escalate rather than silently pass.

### 9.3 Full classifier

The existing `classifyToolCall` and action-floor machinery are the starting
point. Framework adapters normalize native calls into the canonical gate
shape. Classification stays Core-owned.

### 9.4 Server-owned profile resolution

The current `/v1/agent/gate` body accepts `mode`. During implementation:

1. keep accepting it temporarily for wire compatibility;
2. ignore it as authority;
3. resolve the actual profile from the authenticated agent DID and session;
4. make `enforce | classify_only` an internal adapter/conformance property;
5. reject any attempt to request a weaker result than the server policy;
6. remove the public field after all adapters move to the new protocol.

### 9.5 Mode changes

Only an owner-authorized route may change a profile. A change:

- is bound to an exact agent DID;
- increments a policy version;
- ends or re-evaluates active sessions;
- invalidates outstanding automatic permits;
- is recorded in owner-private audit;
- cannot weaken an active non-owner authority context.

## 10. Gating persistence

Recommended Core-owned record:

```ts
interface AgentGatingPolicy {
  agentDid: string;
  profile: GatingProfile;
  policyVersion: number;
  selectedByOwnerDid: string;
  selectedAtMs: number;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
}
```

This record belongs in Core's encrypted identity/configuration store, not in
the agent's config file. Before the public schema freezes, the current
greenfield schema may be edited in place.

### 10.1 Audit levels

| Event                           | Network Protection                | Sensitive Boundaries | Full Supervision  |
| ------------------------------- | --------------------------------- | -------------------- | ----------------- |
| Session start/end               | yes                               | yes                  | yes               |
| Profile change                  | yes                               | yes                  | yes               |
| Hard-kernel denial              | yes                               | yes                  | yes               |
| Ordinary local tool call        | no                                | no                   | decision metadata |
| Sensitive boundary              | when denied or approval is needed | decision metadata    | decision metadata |
| Dina vault/grant/service action | policy receipt                    | policy receipt       | policy receipt    |
| Non-owner request               | full receipt                      | full receipt         | full receipt      |

Audit records contain action class, principal, origin, decision, policy
version, timestamps, and hashes. Raw prompts, file contents, vault values,
tool outputs, and secrets are excluded by default.

## 11. Connected-agent Brain model

### 11.1 What "Claude becomes the Brain" means

It means Claude supplies reasoning for a bounded operation. It does not mean:

- Claude owns Dina's identity;
- Claude becomes the Home Node;
- Claude reads vault databases directly;
- Claude signs public records;
- Claude approves itself;
- Claude runs continuously after its session ends.

The actual composition is:

```text
Connected agent = reasoning
Core            = identity + authority + durable state + effects
Mobile/web      = user interaction + owner approval
```

### 11.2 Backend types

```ts
type ReasoningBackendKind = 'connected_host' | 'internal_brain' | 'local_model' | 'remote_provider';

interface ReasoningBackendBinding {
  backendId: string;
  kind: ReasoningBackendKind;
  principalDid: string;
  allowedTaskKinds: ReasoningTaskKind[];
  maxSensitivity: 'public' | 'personal' | 'sensitive';
  availability: 'foreground' | 'always_on';
  modelClass?: string;
  policyVersion: number;
  enabled: boolean;
  createdAtMs: number;
  expiresAtMs: number | null;
}
```

`connected_host` is foreground by default. Marking one `always_on` requires a
supported programmatic host contract and explicit credentials configured by
the owner or organization. A cached interactive login is not sufficient.

### 11.3 Reasoning task kinds

Start with a bounded set:

```ts
type ReasoningTaskKind =
  | 'answer.compose'
  | 'memory.structure'
  | 'intent.route'
  | 'service.respond'
  | 'review.summarize'
  | 'reminder.extract';
```

Task kinds describe reasoning, not effects. For example,
`service.respond` may produce a proposed appointment response, but it cannot
book an appointment directly. A requested effect becomes a separate
Core-owned workflow task with its own policy and approval.

## 12. Two connected-host lanes

### 12.1 Lane A: foreground inline reasoning

The owner is already talking to Claude or Codex. The model calls Dina MCP
tools to request authorized evidence or propose a structured update.

There are two submodes:

1. **Context-assisted host answer:** the host requests context and answers
   directly. This is useful, but Core does not see the final prose. Product
   copy must call it an agent answer using Dina context, not a Core-managed
   Dina result.
2. **Connected-Brain answer:** the host starts an inline reasoning job, receives
   its authorized context, and submits the result through Core before showing
   it. Core then validates evidence, applies output policy, rehydrates allowed
   tokens, records provenance, and returns the final result. This is the
   normative path for claiming that Claude or Codex is Dina's Brain.

Examples:

- "What chair should I buy?" The host requests a context packet, queries
  Ranked Reviews or Services as authorized, and composes the answer in the
  current turn.
- "Remember that I have back pain." The host proposes structured memory;
  Core validates the target persona and commits it.
- "Publish my salon service." The host drafts configuration; Core validates
  and routes publication through the normal gate.

No second model invocation is needed in either submode because the current
agent is already reasoning.

### 12.2 Lane B: Core-originated or background reasoning

A mobile Ask, inbound service request, reminder extraction, or D2D request may
arrive when no host turn is active. Core creates durable reasoning work.

An MCP server cannot force an idle model to start a turn. Therefore:

- the plugin may show a pending-work count at session start;
- a user may run a skill such as `/dina-work`;
- an active host may claim and complete jobs;
- a supported host automation may poll only under an explicit always-on
  contract;
- otherwise an internal, local, or remote always-on backend may claim;
- with no eligible backend, work remains pending and the requester receives a
  truthful pending/unavailable state.

This limitation must be present in product copy. "Use Claude as Dina's Brain"
means "during an active model turn, or when the user explicitly starts Dina
work" unless the user separately configures an always-on backend. Merely
leaving the host application open does not create a worker.

## 13. Reasoning broker

Core owns one `ReasoningBroker`. Backends are adapters behind it.

```ts
interface ReasoningBroker {
  submit(input: CreateReasoningJobInput): Promise<ReasoningSubmission>;
  status(jobId: string, requester: Principal): Promise<ReasoningStatus>;
  cancel(jobId: string, requester: Principal): Promise<boolean>;
  claim(input: ClaimReasoningJobInput): Promise<ReasoningClaim | null>;
  heartbeat(input: HeartbeatReasoningJobInput): Promise<boolean>;
  complete(input: CompleteReasoningJobInput): Promise<ReasoningCompletion>;
  fail(input: FailReasoningJobInput): Promise<ReasoningFailure>;
}
```

### 13.1 Reuse of workflow infrastructure

Reuse the existing workflow state machine, claim lease, claim ID fencing,
attempt budget, idempotency, cancellation, and expiry implementation. Add
`reasoning` as a typed task kind with a sealed reasoning envelope.

Do not expose reasoning jobs through the generic runner claim path.

Required separation:

- a dedicated reasoning claim route;
- a `reasoning_backend` authorization check;
- task-kind and backend-binding filters in the repository query;
- no unfiltered runner may claim reasoning work;
- no reasoning backend may claim delegation, plugin, or service-effect work;
- no reasoning completion may directly trigger an effect without the normal
  Core bridge.

This reuses durable machinery without conflating authority.

### 13.2 Reasoning envelope

```ts
interface ReasoningTaskEnvelopeV1 {
  version: 1;
  taskId: string;
  taskKind: ReasoningTaskKind;
  ownerDid: string;
  authorityOrigin: AuthorityOrigin;
  authorityPolicyRef: {
    kind: 'service';
    serviceRkey: string;
    targeted: boolean;
    capability: string;
    requesterDid: string;
    grantId: string | null;
  } | null;
  backendBindingId: string | null;
  requestSchemaId: string;
  resultSchemaId: string;
  policySnapshotHash: string;
  inputProjectionId: string;
  inputProjectionHash: string;
  contextProjectionId: string | null;
  contextProjectionHash: string | null;
  sensitivity: 'public' | 'personal' | 'sensitive';
  evidencePolicy: 'none' | 'optional' | 'required';
  allowedEvidenceIdsHash: string | null;
  requestFingerprint: string;
  purpose: string;
  executionId: string;
  idempotencyKey: string;
  createdAtMs: number;
  deadlineAtMs: number;
  maxAttempts: number;
}
```

The durable workflow payload contains references and hashes, not raw sensitive
context. Context is stored in an encrypted Core-owned projection store with a
short retention period. A context ticket is minted only when a backend wins a
claim; it binds the exact task, claim, backend principal, backend policy
version, session, and projection references without becoming part of the
durable task envelope.

`authorityPolicyRef` is Core-only mutable-authority metadata. For service
reasoning it identifies the exact listing, capability, requester, targeting
mode, and grant used at submission. Core revalidates that reference at claim,
completion, and commit recovery, so disabling a listing or revoking a grant
while the model runs prevents the result from being sent.

`backendBindingId` is non-null when the owner or routing policy targets one
exact backend. When it is null, the broker may select only from the
policy-approved backend set. The first claim atomically pins the selected
binding for that attempt. A permitted fallback after lease loss receives a
new claim and a new context ticket; the old backend cannot complete it.

### 13.3 Claim

A successful claim returns:

```ts
interface ReasoningClaim {
  taskId: string;
  claimId: string;
  contextTicketId: string;
  leaseExpiresAtMs: number;
  taskKind: ReasoningTaskKind;
  purpose: string;
  authorityOrigin: AuthorityOrigin;
  input: unknown;
  context: ModelContextProjection | null;
  allowedEvidenceIds: string[];
  resultSchema: JsonSchema;
  resultSchemaId: string;
  executionId: string;
  contextProjectionHash: string | null;
  policySnapshotHash: string;
}
```

Core verifies:

- caller signature and live session;
- active reasoning-backend binding;
- task-kind permission;
- sensitivity ceiling;
- exact backend selection;
- no competing live claim;
- deadline and attempt budget;
- owner approval or grant for the context projection.

### 13.4 Completion

Completion requires:

- `taskId`;
- `claimId`;
- `executionId`;
- schema-valid structured output;
- the expected context projection hash;
- optional evidence/source identifiers;
- no caller-supplied authority fields.

The terminal transition compares the current `claimId`. A stale worker cannot
complete work reclaimed by a newer worker.

When evidence is required, Core verifies that every cited identifier belongs
to the task's allowed evidence set and that the minimum task-specific evidence
rule is satisfied. Calling a review search that returned no attestations does
not satisfy a review-evidence requirement.

## 14. Context broker and model egress

### 14.1 Core-owned context projection

The connected agent never performs vault search by opening storage. Core:

1. authorizes the requested personas and sources;
2. performs bounded retrieval;
3. applies sensitivity policy;
4. minimizes fields;
5. scrubs PII when required;
6. creates a task-bound projection;
7. records only projection identifiers and hashes in audit.

```ts
interface ModelContextProjection {
  projectionId: string;
  purpose: string;
  items: Array<{
    sourceId: string;
    sourceType: 'memory' | 'review' | 'service' | 'relationship' | 'reminder';
    text: string;
    confidence?: number;
    occurredAtMs?: number;
  }>;
  scrubbed: boolean;
  sensitivity: 'public' | 'personal' | 'sensitive';
  expiresAtMs: number;
}
```

### 14.2 PII handling

For cloud-connected hosts:

- sensitive originals stay in Core;
- tokenized text is returned where useful;
- rehydration mappings remain local and short-lived;
- a result shown through Dina is rehydrated after validation;
- a result shown directly in Claude/Codex uses the existing explicit
  `dina_rehydrate` flow where needed.

The owner may create an explicit context grant that allows unsanitized data
for a defined purpose and duration. This is never inferred from selecting a
lighter coding gate.

### 14.3 Context tickets

A context ticket is:

- bound to task, backend, owner, purpose, and policy version;
- single-purpose and short-lived;
- unusable after cancellation, lease loss, or session end;
- non-transferable to another backend;
- retained only as an encrypted record until the task retention window ends.

## 15. Functional flows

### 15.1 Ask from Claude or Codex

```text
Owner asks host
  -> host begins an inline answer.compose job
  -> Core validates session, persona access, and evidence policy
  -> Core returns bounded model projection + allowed evidence IDs
  -> host composes answer in current turn
  -> host submits structured result to Core
  -> Core validates, scans, rehydrates, and records provenance
  -> host displays the Core-returned final answer
```

This is the full connected-Brain, no-extra-provider flow. A shorter
context-assisted path may omit the begin/complete cycle, but it has the weaker
semantics described in section 12.1.

### 15.2 Ask from Dina mobile using a connected host

```text
Owner asks in mobile
  -> Core creates answer.compose job
  -> connected host is active and eligible
  -> host claims job
  -> Core returns bounded context + output schema
  -> host submits answer proposal
  -> Core validates, scans, rehydrates, and commits
  -> mobile displays result
```

If the host is not active, Core may route to another explicitly configured
backend or keep the request pending.

### 15.3 Remember

```text
Owner text
  -> memory.structure reasoning
  -> proposal: persona, subject, fact, reminder candidates
  -> Core validates target persona and caller authority
  -> sensitive target may require approval
  -> Core commits through the existing staging/memory path
```

The model cannot choose an unauthorized persona or bypass the staging rules.

### 15.4 Inbound service query

```text
signed service query
  -> Core authenticates requester
  -> Core resolves listing, capability, grant, schema, and origin
  -> Core creates service.respond reasoning job
  -> eligible backend claims under Full Supervision
  -> Core projects only capability-authorized context
  -> backend returns schema-valid response proposal
  -> Core Response Bridge validates against pinned schema
  -> Core signs and sends response
```

If the response requests an external effect, Core creates a separate
effectful workflow task. The reasoning completion itself cannot perform it.

### 15.5 Reviews and Services enrichment

A connected Brain may:

- infer search intent;
- rank authorized candidates;
- summarize signed evidence;
- combine local preferences with public review results;
- explain why a service or review fits.

It may not:

- fabricate a review source;
- turn an empty review search into evidence-backed advice;
- publish a review or service directly;
- use vault context in a remote query without an applicable grant.

### 15.6 Reminder extraction

The backend proposes reminder candidates. Core validates the timestamp,
persona, source memory, and deduplication key before creating a reminder.

## 16. Backend selection and fallback

Backend selection is Core-owned and policy-driven.

```ts
interface ReasoningRoutingPolicy {
  preferredOrder: ReasoningBackendKind[];
  allowedByTask: Partial<Record<ReasoningTaskKind, ReasoningBackendKind[]>>;
  allowRemoteForSensitive: boolean;
  queueWhenUnavailable: boolean;
  maxQueueMsByPriority: Record<'user_blocking' | 'normal' | 'background', number>;
}
```

### 16.1 Recommended order

For a request already occurring in a connected foreground host:

1. current connected host;
2. explicitly selected local model;
3. explicitly selected internal/remote always-on backend;
4. pending/error.

For mobile, service, D2D, or background work:

1. an eligible active connected host only if it has registered for such work;
2. local always-on backend;
3. configured internal/remote always-on backend;
4. pending/error.

### 16.2 No silent privacy downgrade

Core must not move a sensitive task from local/connected processing to a
remote provider unless the routing policy permits that exact sensitivity and
task kind. Backend fallback is an authority decision because it changes who
receives context.

### 16.3 Exactly one winning result

Jobs use one live claim. Speculative multi-backend execution is off by default
because it multiplies context disclosure and cost. If later enabled, it needs
an explicit fan-out policy, separate context tickets, and a Core-owned
selection phase.

## 17. Host integration

### 17.1 Claude Code

Use:

- MCP tools for Dina operations and reasoning claim/complete;
- `SessionStart` to establish/renew the Core session and surface only a
  pending-work count;
- `PreToolUse` for the selected gating profile;
- `SessionEnd` to end the Core session and revoke session grants;
- a `/dina-work` skill to claim Core-originated reasoning jobs.

The adapter must not assume that an idle Claude session polls MCP. Programmatic
or unattended Claude execution is a separate deployment mode and must use an
officially supported authentication contract.

The plugin-owned `/dina:setup` flow is the explicit owner-consent surface for a
new local installation. It enrolls a separate coding-scoped `did:key` and may
create that exact identity's first `connected_host` binding. The setup helper
uses the local owner capability internally but never prints or persists it.
Repair is idempotent: a matching live binding is reused, while a revoked,
modified, expired, or competing owner-selected binding is preserved rather
than revived or replaced. Claude Code still applies its native Bash permission
boundary before running the setup command.

### 17.2 Codex

Use:

- the Dina MCP server for bounded tools;
- `AGENTS.md`/skill instructions for the interactive Brain protocol;
- lifecycle hooks for session and tool gating where the installed Codex
  surface supports them;
- a Dina work skill for explicit pending-job processing.

The plugin-owned `$dina-setup` skill uses the same bootstrap executable and
shared `dina agent-host setup` engine as Claude Code. It installs a managed CLI
when necessary, installs or repairs the native Home Node, enrolls a separate
coding-scoped `did:key`, and may create that exact identity's first
`connected_host` binding. It never replaces an owner-selected competitor or
revives a revoked binding. The user must separately inspect and trust the
plugin hook under `/hooks`; setup cannot grant trust to its own enforcement
code.

Codex can be used interactively with subscription authentication. Unattended
use must rely on a documented automation credential or API configuration, not
on Dina reading Codex's credential store.

### 17.3 Other frameworks

Framework adapters normalize into:

- signed session lifecycle;
- canonical gate request;
- context request;
- reasoning claim/heartbeat/complete/fail;
- effect proposal;
- decision receipt.

OpenClaw, Hermes, Pi, and corporate agents should not receive custom Core
policy. They receive adapters to this contract.

## 18. MCP surface

Keep the current `coding` profile. Add a separate capability-controlled Brain
surface:

| Tool                       | Purpose                                                   | Authority                                |
| -------------------------- | --------------------------------------------------------- | ---------------------------------------- |
| `dina_reasoning_backends`  | discover this exact caller's active backend IDs           | signed coding-agent DID only             |
| `dina_reasoning_status`    | pending counts and backend status                         | bound backend only                       |
| `dina_reasoning_begin`     | begin and claim an inline job for the current host turn   | coding session + enabled backend binding |
| `dina_reasoning_claim`     | claim one eligible queued reasoning job                   | `reasoning_backend` binding              |
| `dina_reasoning_heartbeat` | renew exact claim lease                                   | claim holder only                        |
| `dina_reasoning_complete`  | submit schema-valid proposal                              | claim holder + claim ID                  |
| `dina_reasoning_fail`      | report retryable/permanent failure                        | claim holder + claim ID                  |
| `dina_context_prepare`     | bounded context for a context-assisted owner conversation | coding session + persona policy          |
| `dina_memory_propose`      | submit structured memory proposal                         | coding session                           |

The `coding` profile should not expose claim tools merely because the tool
binary contains them. Tool registration and Core authorization both enforce
the distinction.

For a host enabled as both coding agent and Brain, the owner-authorized backend
binding makes the additional tools visible or usable.

## 19. Core API

Proposed narrow routes:

```text
POST /v1/reasoning/backends/register       owner only
POST /v1/reasoning/backends/:id/revoke     owner only
GET  /v1/reasoning/backends                owner/admin
GET  /v1/reasoning/backends/self           exact signed coding agent

GET  /v1/reasoning/status                  bound backend
POST /v1/reasoning/begin                   coding session + bound backend
POST /v1/reasoning/claim                   bound backend
POST /v1/reasoning/:id/heartbeat           exact claim holder
POST /v1/reasoning/:id/complete            exact claim holder
POST /v1/reasoning/:id/fail                exact claim holder

POST /v1/agent/context/prepare              coding agent, session-bound
POST /v1/agent/memory/propose               coding agent, session-bound

GET  /v1/owner/agent-policies               owner/admin
PUT  /v1/owner/agent-policies/:agentDid     owner only
```

Every backend route authenticates the signed caller DID. Body-supplied DIDs,
origins, profiles, owner identities, and policy versions are treated as data
to compare, never authority.

## 20. Result validation and commit bridges

Each reasoning task kind has:

- a versioned input schema;
- a versioned result schema;
- size and depth limits;
- allowed source types;
- a Core commit bridge;
- deterministic failure semantics.

Example:

```ts
interface MemoryStructureResultV1 {
  persona: string;
  subject: {
    kind: string;
    label: string;
  };
  facts: Array<{
    text: string;
    confidence: number;
  }>;
  reminderCandidates: Array<{
    text: string;
    dueAtMs: number;
  }>;
}
```

Core still checks:

- whether the persona exists and is writable;
- whether it is open or requires approval;
- whether the result exceeds memory limits;
- whether a reminder date is valid;
- whether the write duplicates an existing item;
- whether the policy snapshot is still current.

### 20.1 Shared pre- and post-processing

Changing the model backend must not silently remove Dina behavior that is not
model-specific. The broker and commit bridge preserve, as applicable:

- input safety and companionship-policy pre-screening;
- persona and context-grant checks;
- PII scrubbing and controlled rehydration;
- evidence-presence and evidence-membership checks;
- result schema and size limits;
- output guard scanning and prohibited-field removal;
- trust-density disclosure;
- source/provenance receipts;
- task-specific commit validation.

For a context-assisted host answer that bypasses completion, Core cannot apply
these final-output controls. That is why it has a weaker product claim.

## 21. State machine and failure semantics

Reasoning jobs use:

```text
created -> queued -> claimed -> running -> completed
                         |          |
                         |          +-> failed
                         +-> queued after safe lease reclaim

created/queued/claimed/running -> cancelled
created/queued/claimed/running -> failed(reason = expired | attempts_exhausted)
```

This deliberately uses the existing workflow terminal states. It does not add
a second `expired` state solely for reasoning jobs. Reasoning execution is
at-least-once after lease failure; commit is single-winner through claim
fencing and `executionId` idempotency.

### 21.1 Retry

Reasoning itself is side-effect-free, so retry after lease loss is normally
safe. Commit bridges must be idempotent on `executionId`.

If a backend used an external tool despite the reasoning-only contract, that
effect is not accepted as a Dina completion. It must be reconciled separately.

### 21.2 Backend disappears

- heartbeat expires;
- stale claim is fenced out;
- projection ticket is revoked;
- job requeues within attempt/deadline limits;
- another eligible backend may claim only if routing policy permits;
- otherwise the job remains pending or fails truthfully.

### 21.3 Policy changes while running

Completion compares `policySnapshotHash`. If authority or context policy
changed:

- no commit occurs;
- the result is retained only as a redacted late report if audit requires it;
- the job re-evaluates or terminates as `stale_authority`.

### 21.4 Malformed or unsafe output

Schema-invalid output is rejected without partial commit. Repeated invalid
output consumes the attempt budget and produces a user-visible failure.

### 21.5 Core unavailable

An installed enforcing hook fails closed when Core is unavailable in every
profile. Core owns profile resolution, origin, kernel protection, and active
task context; the adapter cannot safely reconstruct those facts.

If an owner wants to continue with host-only protection during a prolonged
Core outage, that is an explicit owner action to disable or remove the Dina
hook. It is never an automatic fallback. No cached permit authorizes a
different payload.

## 22. Security analysis

### 22.1 Profile downgrade

**Threat:** agent submits `network_protection` or `classify_only`.
**Control:** Core resolves profile from authenticated binding; client value is
ignored or rejected.

### 22.2 Origin laundering

**Threat:** a service task is executed in the owner's Claude session and
inherits owner trust.
**Control:** immutable task origin plus server-bound active authority context;
non-owner floor remains Full Supervision.

### 22.3 Prompt injection in Network Protection

**Threat:** hostile file instructs Claude to perform a local action.
**Control:** host sandbox/permissions and kernel protection only. This is a
documented accepted risk of the lighter mode, not something Dina falsely
claims to solve.

### 22.3.1 False owner presence

**Threat:** a compromised foreground agent opens or reuses a host session and
presents its own work as owner-interactive.
**Control:** only owner-enabled foreground bindings may create such sessions;
Core-originated work remains pinned to its non-owner origin; sessions are
leased and revocable. Residual risk remains because current desktop hosts do
not attest per-turn human presence. Full Supervision is the correct profile
when the owner does not trust the host with this distinction.

### 22.4 Context exfiltration

**Threat:** backend asks for more vault data than the task needs.
**Control:** Core-owned retrieval, purpose-bound tickets, sensitivity ceiling,
scrubbing, size limits, no raw database access.

### 22.5 Backend impersonation

**Threat:** one paired agent claims another backend's work.
**Control:** signed caller DID, backend binding, task-kind filter, exact
backend assignment, claim ID.

### 22.6 Stale completion

**Threat:** first worker completes after lease reclaim.
**Control:** terminal CAS on exact claim ID and current state.

### 22.7 Duplicate model execution

**Threat:** two foreground sessions claim the same job.
**Control:** atomic claim and one live claim per job.

### 22.8 Model result as authority

**Threat:** output includes `"approved": true` or owner DID.
**Control:** output schemas contain no authority fields; Core ignores any
unknown fields and obtains authority only from durable records.

### 22.9 Host credential theft

**Threat:** Dina reads Claude/Codex auth to run later.
**Control:** prohibited by architecture; only the active model turn or
explicit official automation credentials may be used.

### 22.10 Audit leakage

**Threat:** raw context or tool input appears in diagnostics.
**Control:** hashed references, bounded reason codes, encrypted owner-private
detail where necessary, canary tests.

### 22.11 Cross-backend fallback

**Threat:** local sensitive job silently moves to remote API.
**Control:** routing policy includes sensitivity and backend kind; mismatch
fails closed.

### 22.12 Connected host performs direct effects

**Threat:** reasoning job uses Bash/browser tools to send or mutate outside
Core.
**Control:** active non-owner authority context forces Full Supervision;
reasoning contract accepts proposals only; external effects require separate
Core workflow and permits.

### 22.13 Hook bypass and incomplete host coverage

**Threat:** a malicious or incompatible host skips the hook, adds an uncovered
tool path, or executes an effect outside the adapter.
**Control:** conformance tests enumerate covered native and MCP tools; Dina
credentials and protected data remain outside the host; Services and
Core-owned effects still require Core authority. The residual is explicit:
host-hook enforcement governs calls the host actually exposes to the hook. It
is not an operating-system security boundary and cannot make a malicious host
process trustworthy.

## 23. User experience

### 23.1 Pairing

After agent enrollment:

```text
How should Dina protect this agent?

Network Protection
Best for an agent you use directly.
Dina protects your identity, private data, and requests from other people
or agents. Normal local work uses the agent's own permissions.

Sensitive Boundaries
Dina also checks before private data leaves or important external actions
are taken.

Full Supervision
Dina evaluates every supported tool call. Required for background and
service-facing agents.
```

The recommended option for foreground coding is Network Protection. Full
Supervision is preselected for background/service use and cannot be lowered.

### 23.2 Brain enablement

Separate choice:

```text
Use this agent as Dina's Brain while it is open?

It can organize memories and answer using context Dina explicitly shares.
It never receives your identity keys or direct vault access.
```

Options:

- Use while open
- Do not use for Dina reasoning
- Configure always-on AI separately

### 23.3 Status

Show:

- connected agent name and DID suffix;
- gating profile;
- current origin: Owner session or Protected non-owner task;
- host coverage level and last conformance result;
- Brain availability: Active, Foreground only, Offline, or Always-on;
- pending reasoning job count;
- last policy decision;
- revoke button.

### 23.4 Approval copy

Approval cards state:

- who initiated the request;
- which agent is reasoning;
- what data or effect is requested;
- whether approval is once, session, or standing;
- where data will go;
- what happens after approval.

They do not expose relationship tiers or hidden policy reasons to a remote
requester.

## 24. Current implementation mapping

### 24.1 Already present

- separate coding-agent `did:key` enrollment;
- durable DID-bound agent sessions;
- session-end grant revocation;
- catch-all Claude/Codex gate hooks;
- deterministic tool classification;
- payload-bound permits and durable phone approvals;
- agent-safe MCP facades;
- Core/Brain process separation;
- injectable Brain reasoning function;
- Core-to-Brain Ask bridge;
- durable workflow claim/heartbeat/complete/fail;
- claim ID lease fencing and idempotency;
- mobile approval surface;
- Services, D2D, PeerLens, reminders, and vault policy primitives.

### 24.2 Implemented three-profile control

The shared Core implementation now includes:

1. durable `AgentGatingPolicy` storage with optimistic concurrency;
2. Core-assigned `AuthorityOrigin` records;
3. server-side effective-profile resolution and the mandatory non-owner floor;
4. immutable kernel protection and Sensitive Boundaries classification;
5. profile-aware, metadata-only audit behavior;
6. exact `(agentDid, hostSessionId)` Core session resolution;
7. principal-wide non-owner elevation across alternate sessions;
8. policy-change invalidation and principal-wide revocation;
9. mobile and Home Node owner controls; and
10. shared route, classifier, repository, and conformance tests.

### 24.3 Implemented reasoning plane

The shared Core implementation now includes:

1. durable reasoning-backend bindings and runtime presence;
2. typed, hash-bound reasoning envelopes and schema contracts;
3. dedicated submit, claim, heartbeat, complete, fail, cancel, and owner
   projection routes;
4. encrypted input/context projections and single-use context tickets;
5. connected-host MCP tools plus the `/dina-work` Claude/Codex skill;
6. exact claim/session/backend fencing and commit recovery;
7. Core-owned context projection with PII scrubbing and evidence membership;
8. output guards, post-guard schema validation, and idempotent commit bridges;
9. mobile chat lifecycle rows and Home Node owner-console projections;
10. instruction-backed service reasoning with listing/grant revalidation;
11. an in-process mobile internal Brain and a signed split-process Home Node
    internal Brain using the same worker contract; and
12. boot/foreground recovery, lease/expiry cleanup, and principal-wide
    revocation.

Still deferred: local-model adapters, direct-provider always-on adapters,
automatic subscription-host polling, and broader reasoning task support in
the internal Brain. These are integrations over the same authority contract,
not missing policy implementations.

## 25. Migration from the current system

### 25.1 Gating

Current coding hooks always send `mode="enforce"`. Preserve this as
Full Supervision for existing agents.

Migration steps:

1. introduce server-side profiles while continuing to accept the old wire;
2. create Full Supervision records for existing coding DIDs;
3. ship owner UI explaining lighter profiles;
4. update adapters to omit the mode;
5. enforce non-owner origin binding;
6. remove client authority over gate mode.

### 25.2 Brain

The existing HTTP Brain becomes one backend adapter:

```text
current makeHttpAskHandler
  -> internal_brain backend
  -> ReasoningBroker
```

Do not delete Brain first. Add the broker, prove connected-host equivalence for
specific task kinds, then route by policy.

### 25.3 `dina-agent`

The existing runner remains relevant:

- it executes durable delegated and service tasks;
- it can host an always-on model adapter;
- it is still the right path for OpenClaw or a custom daemon;
- it does not become obsolete when Claude provides foreground reasoning.

The coding plugin and `dina-agent` are complementary:

- coding plugin: interactive reasoning and owner workflow;
- runner: unattended execution and durable task processing.

## 26. Delivery plan

### Phase 0: freeze the contracts

- accept this document;
- add protocol types and schemas;
- add decision tables and conformance fixtures;
- make no UX claim that Claude is always-on.

### Phase 1: three gating profiles

- server-owned policy storage;
- origin resolution;
- kernel precheck;
- Sensitive Boundaries detector;
- non-owner floor;
- owner settings UI;
- profile-aware audit.

Exit criterion: an agent cannot downgrade itself, and the same tool call
produces the expected decision under all profile/origin combinations.

### Phase 2: foreground Claude/Codex Brain

- inline reasoning begin/complete path;
- context-assisted preparation tool;
- memory proposal tool;
- Ask/review/service search composition guidance;
- backend binding;
- no additional API key;
- evidence validation and provenance receipt;
- shared output post-processing.

Exit criterion: from an active Claude/Codex session, the user can Ask,
Remember, search Reviews, and search Services using Dina-authorized context
without invoking the internal LLM. A connected-Brain answer returns through
Core before display; a direct context-assisted host answer is labeled with
its weaker semantics.

### Phase 3: durable reasoning jobs

- `reasoning` workflow kind;
- dedicated claim routes;
- context tickets;
- `/dina-work`;
- mobile pending/result UX;
- schema commit bridges.

Exit criterion: a mobile Ask queues while Claude is closed, completes when the
user processes Dina work in Claude, and cannot be completed by another
backend or stale claim.

### Phase 4: service and D2D reasoning

- inbound service response jobs;
- non-owner authority context;
- response-schema bridge;
- truthful offline/pending behavior;
- requester privacy and collapsed failures.

Exit criterion: an authorized remote Dina can request a service; the connected
host reasons under Full Supervision; Core alone signs and sends the response.

### Phase 5: always-on options

- internal Brain adapter;
- local model adapter;
- provider API adapter;
- documented automation-credential adapters where supported;
- explicit fallback and cost policy.

Exit criterion: the user can choose foreground-only, local always-on, or
provider-backed always-on operation without changing service semantics.

## 27. Test plan

### 27.1 Gating matrix

For every profile, test:

- owner-interactive safe file read;
- owner-interactive code edit;
- owner-interactive network send;
- owner-interactive protected-path read;
- service-origin safe read;
- service-origin external effect;
- delegated task;
- unknown origin;
- Core unavailable;
- expired session;
- caller-supplied downgrade;
- profile change during approval;
- permit replay with changed payload.

Required assertions:

- non-owner outcomes are identical across configured profiles;
- protected paths deny in all profiles;
- Network Protection emits no ordinary-action audit;
- Sensitive Boundaries emits no ordinary-action audit;
- Full Supervision emits decision metadata; repetitive SAFE/allow decisions
  may be sampled while policy evaluation remains per-call;
- raw tool input is absent from operational logs.

### 27.2 Reasoning broker

Test:

- atomic claim;
- claim-kind authorization;
- backend binding;
- heartbeat;
- lease reclaim;
- stale completion rejection;
- cancellation;
- expiry;
- attempt exhaustion;
- policy-snapshot mismatch;
- malformed result;
- oversized result;
- idempotent commit;
- projection expiry;
- projection/backend mismatch;
- fallback sensitivity mismatch;
- no backend available;
- Core restart;
- host session end.

### 27.3 End-to-end scenarios

1. Claude foreground Ask with no second provider configured.
2. Claude foreground Remember into a Standard vault.
3. Locked Health context requests phone approval.
4. Mobile Ask queues and is completed through `/dina-work`.
5. Service query runs under Full Supervision despite agent profile being
   Network Protection.
6. Service response with invalid schema is not sent.
7. Agent attempts to publish a review without Core commit and fails.
8. Revoking Brain binding prevents the next claim.
9. Local backend fallback works only when explicitly allowed.
10. No host credential file is opened by installer or runtime.

### 27.4 Cross-platform conformance

Run the same shared fixtures against:

- mobile in-process Core;
- Home Node Lite Core;
- Claude Code adapter;
- Codex adapter;
- `dina-agent` runner;
- internal Brain adapter;
- local model adapter when shipped.

Platform code may implement transport and secure storage. It must not
reimplement profile resolution, authority origin, task schemas, or commit
rules.

## 28. Acceptance criteria

The architecture is ready to call implemented only when:

1. A client cannot lower its own gating profile.
2. All non-owner requests use Full Supervision.
3. Network Protection does not classify or log ordinary owner work.
4. Sensitive Boundaries remains quiet for ordinary code work.
5. Hard kernel protections pass in all profiles.
6. A connected host can provide foreground reasoning without a second model
   key.
7. No product copy implies foreground subscription access is always-on.
8. Core owns every context projection and external commit.
9. A stale or wrong backend cannot complete a reasoning job.
10. Sensitive context cannot silently fall back to a remote backend.
11. Services and D2D retain authenticated requester origin through reasoning.
12. The connected agent never receives owner, vault, recovery, or PDS private
    keys.
13. Mobile and Home Node pass one conformance suite.
14. Operational logs contain no raw sensitive context or credentials.
15. Revocation takes effect for new claims and outstanding context tickets.

## 29. Open decisions

These decisions can be deferred without changing the architecture:

1. Whether new foreground installs default directly to Network Protection or
   show a one-time required choice.
2. The exact Sensitive Boundaries action table.
3. Whether a connected host may claim mobile jobs automatically when the host
   supports a documented background-agent feature.
4. Whether reasoning jobs share `workflow_tasks` physically or use a separate
   table backed by the same lease library. The normative requirement is one
   lifecycle implementation and separate authorization surfaces.
5. Default projection retention for personal and sensitive context.
6. Whether model responses shown directly in the host receive a Core-issued
   provenance receipt by default.
7. Which local model runtime ships first.

## 30. Explicit decisions

The following are not open:

1. Core remains the authority and durable-state owner.
2. Connected models are untrusted reasoners.
3. Non-owner gating is mandatory.
4. Unknown provenance is non-owner provenance.
5. The safety profile is server-owned.
6. Lighter gating never exposes Dina's protected paths or keys.
7. Interactive host access is not presented as always-on access.
8. No host credential scraping or undocumented subscription automation.
9. Reasoning completion is proposal-only.
10. External effects stay in Core-owned workflows.
11. Context is purpose-bound and minimized.
12. Mobile and Home Node share the same contracts and policy code.

## 31. Implementation references

Current repository seams:

- `apps/home-node-lite/core-server/src/gate/gate_decision.ts`
- `apps/home-node-lite/core-server/src/gate/coding_gate_impl.ts`
- `packages/core/src/server/routes/coding_gate.ts`
- `packages/core/src/session/registry.ts`
- `packages/core/src/workflow/domain.ts`
- `packages/core/src/workflow/repository.ts`
- `packages/core/src/workflow/local_delegation_runner.ts`
- `packages/core/src/server/routes/ask.ts`
- `apps/home-node-lite/core-server/src/agent/http_ask_handler.ts`
- `packages/brain/src/pipeline/chat_reasoning.ts`
- `cli/src/dina_cli/mcp_server.py`
- `cli/src/dina_cli/main.py`

Host facts that must be revalidated when adapters ship:

- Claude Code hooks:
  `https://code.claude.com/docs/en/hooks`
- Claude Code MCP:
  `https://code.claude.com/docs/en/mcp`
- Claude Code CLI/programmatic mode:
  `https://docs.anthropic.com/en/docs/claude-code/cli-usage`
- Codex hooks:
  `https://learn.chatgpt.com/docs/hooks`
- Codex MCP:
  `https://learn.chatgpt.com/docs/extend/mcp`
- Codex authentication:
  `https://learn.chatgpt.com/docs/auth`

## 32. One-line summary

**Dina lets the owner choose how closely to supervise their foreground agent,
but never relaxes non-owner authority; the same agent may supply Dina's
reasoning while Core keeps the keys, context grants, approvals, durable state,
and final effects.**
