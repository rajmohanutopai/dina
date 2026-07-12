# Dina Agent Authority and Control Plane

**Status:** Target architecture, reviewed against the shipping TypeScript stack and the external ecosystem as of 2026-07-12.

**Audience:** Dina maintainers, agent-framework integrators, security reviewers, enterprise architects, and contributors building mobile, Home Node, adapters, services, or plugins.

**Normative language:** `MUST`, `MUST NOT`, `SHOULD`, and `MAY` have their RFC 2119 meanings. A statement labeled **Current** describes shipping code. A statement labeled **Target** describes the architecture this document selects. A statement labeled **Deferred** is intentionally outside the first implementation.

---

## 1. Executive decision

Dina is not primarily another general-purpose personal assistant and it is not another generic agent runtime-security toolkit.

**Dina is the user-owned authority, private-context, and network control plane for agents.**

Any agent framework can connect to Dina. The agent can bring an existing identity or ask Dina to create one. Dina can operate as the complete standalone control plane, or compose with Microsoft Agent Governance Toolkit (AGT), an enterprise identity provider, an existing policy engine, an A2A implementation, MCP servers, or another control plane.

The product promise is:

> Bring any agent and any verifiable identity. Dina controls what the agent may know, what it may do, whose authority it is using, and how it may interact with people, services, and other agents.

This promise is capability-scoped. Dina controls a context disclosure, tool call, model request, or external effect only when that path is connected at the declared assurance level. A skill/MCP-only agent remains voluntarily gated; the product MUST NOT imply control over unmediated credentials, shell commands, network calls, or model clients.

The mobile application is the first Dina client and the owner's authority console. It is not the whole platform. It gives the owner a concrete place to hold keys, manage private context, inspect agents, issue grants, approve sensitive actions, publish services, and participate in the Dina network.

### 1.1 The selected strategic boundary

Microsoft AGT directly overlaps with generic policy evaluation, framework interception, agent identity, execution isolation, MCP security, compliance, audit, and reliability. Dina MUST integrate with AGT rather than rebuilding all of those facilities as its product identity.

Dina remains differentiated by the stateful whole that a stateless policy kernel or enterprise security toolkit does not naturally own:

- encrypted owner-controlled context;
- durable grants issued by the owner;
- phone-mediated human authority;
- personal and relationship identities;
- context minimization and purpose-bound disclosure;
- owner-private activity history;
- Dina-to-Dina relationships;
- public, unlisted, and contact-scoped services;
- PeerLens reviews and reputation;
- a usable consumer application that proves the system end to end.

### 1.2 Standalone and composed operation are equally first-class

Dina MUST support three deployment profiles:

1. **Dina standalone:** Dina supplies identity, policy, grants, approvals, workflows, context, audit, communication, and optional credential enforcement.
2. **Dina plus AGT or another control plane:** the external system supplies selected machine-governance components; Dina supplies selected owner-authority components.
3. **Selective composition:** each capability has an explicit provider and exactly one execution owner. For example, AGT evaluates corporate policy, Dina obtains owner approval, an enterprise OAuth broker holds credentials, and Dina records the private owner receipt.

No corporate agent is required to use AGT. No AGT-governed agent is required to adopt a Dina identity.

---

## 2. Why this architecture exists

### 2.1 Personal AI becomes a client, not the entire category

Memory, reminders, personal recommendations, and conversational assistance remain valuable, but major platform vendors can distribute those features through operating systems and existing assistant products. Dina should not depend on winning a broad assistant-distribution contest.

Those personal features still have architectural value. They create useful private context and prove that the authority plane works. The relationship is:

```text
Personal interactions
        -> build private context
        -> agents request minimal context through Dina
        -> Dina gates sensitive actions
        -> services and D2D connect other people and agents
        -> PeerLens adds accountable reputation
```

The personal application therefore remains essential as the owner's client and the first reference implementation.

### 2.2 Governance is not one thing

The ecosystem uses the word "governance" for several different responsibilities:

| Responsibility                | Example                            | Correct Dina posture                                      |
| ----------------------------- | ---------------------------------- | --------------------------------------------------------- |
| Deterministic policy decision | AGT ACS, OPA, Cedar                | Provider interface; reuse when present                    |
| Framework interception        | AGT adapters, framework middleware | Reuse adapters; do not duplicate policy in adapters       |
| Workload identity             | OIDC, SPIFFE, DID, mTLS            | Federate and bind to a Dina principal                     |
| Agent-to-tool protocol        | MCP                                | Govern or proxy; do not replace the wire protocol         |
| Agent-to-agent protocol       | A2A                                | Gateway and mapping; do not replace the external standard |
| Human authority               | Phone approval, durable consent    | Dina-owned differentiator                                 |
| Private context               | Encrypted vaults and personas      | Dina-owned differentiator                                 |
| Relationship authority        | Contact-scoped grants              | Dina-owned differentiator                                 |
| Public capability network     | Dina Services                      | Dina-owned network layer                                  |
| Reputation                    | PeerLens                           | Dina-owned trust evidence layer                           |

This document prevents these responsibilities from collapsing into one unsafe abstraction.

### 2.3 Existing Dina is not a clean slate

The shipping stack already has important control-plane primitives:

- authenticated DID-to-caller binding;
- paired `agent` and `plugin` caller types;
- restricted route authorization;
- session-scoped `agent_persona_grants`;
- explicit `service_grants` checked against the transport-authenticated DID;
- durable `workflow_tasks` and `workflow_events`;
- claim IDs, attempts, leases, idempotency keys, and `outcome_unknown`;
- mobile approval cards and approval reconciliation;
- delegated runners over MsgBox;
- service query and response workflows;
- D2D identity binding and signed envelopes;
- plugin manifests, pinned execution authority, and adapter conformance work;
- a Python `dina-agent` CLI with ask, remember, validate, scrub, sessions, and runners.

The target architecture promotes these seams into a coherent public contract. It does not discard them merely to obtain cleaner terminology.

---

## 3. Goals and non-goals

### 3.1 Goals

The architecture MUST make the following possible:

1. An existing OpenClaw, Pi, Hermes, LangGraph, OpenAI Agents SDK, corporate, or custom agent connects without changing its reasoning model.
2. An agent with an existing verifiable identity keeps that identity.
3. An agent without an identity receives a Dina-native identity through a simple pairing ceremony.
4. Dina works without Microsoft AGT or any other external control plane.
5. AGT-governed agents can use only Dina context, only Dina approvals, only Dina network facilities, or any selected combination.
6. Policy and approval results compose deterministically and fail closed.
7. Every effect has one execution owner so composition cannot send two emails, place two bookings, or apply two retries.
8. Sensitive context is disclosed minimally, with provenance and purpose binding, rather than exposing a vault mount.
9. A user can see and revoke every agent, credential binding, active grant, pending decision, and network offer.
10. The same Core contracts run on mobile and Home Node through adapters, without duplicating business rules.
11. A framework integration can be tested by a public conformance suite.
12. Existing Dina services, plugins, D2D, and PeerLens become optional facilities available to connected agents.

### 3.2 Non-goals

Dina MUST NOT attempt to:

- become a new reasoning framework;
- replace MCP as the agent-to-tool protocol;
- replace A2A as a general external agent-to-agent protocol;
- replace enterprise IAM, OIDC, SPIFFE, or Microsoft Entra;
- reimplement every AGT package;
- infer authorization from contact membership, reputation, an Agent Card, or possession of a URI;
- give an agent the user's signing key;
- mount raw persona databases into third-party agents;
- claim deterministic enforcement when the agent retains an unmediated credential or tool path;
- make Services, PeerLens, ATProto, or a Dina DID prerequisites for basic context and approval adoption;
- encode provider-specific logic in mobile or web clients.

### 3.3 Initial market boundary

The first credible market is **personal, local, and small-team agent authority**, not full enterprise fleet governance. Enterprise compatibility is an architectural requirement, but enterprise administration, procurement, compliance support, and fleet operations are later product layers.

The initial developer value must work for one user and one agent in less than five minutes.

---

## 4. Vocabulary

- **Owner:** the human whose Dina controls private context and personal authority.
- **Organization:** an optional enterprise or group authority that can impose an upper bound on actions.
- **Agent:** an external reasoning system. It may run locally, remotely, or inside an enterprise platform.
- **Agent framework:** the software hosting reasoning and tools, such as OpenClaw, Pi, Hermes, LangGraph, or a custom runtime.
- **Principal:** Dina's stable local representation of an authenticated actor.
- **Credential binding:** a verified external credential attached to a principal, such as OIDC subject, SPIFFE ID, DID key, mTLS certificate, or Dina pairing key.
- **Acting-for chain:** the explicit chain connecting an agent to the owner, organization, service, or contact whose authority it is using.
- **Grant:** a durable authorization fact issued by an authority. A grant is not the same as an approval prompt or a policy recommendation.
- **Policy decision point (PDP):** code that evaluates facts and returns a decision. Dina policy and AGT ACS are examples.
- **Policy enforcement point (PEP):** the component physically able to prevent execution.
- **Policy information point (PIP):** a provider of verified facts used by policy, such as identity assurance, data labels, or grant state.
- **Approval provider:** the system that obtains a decision from the relevant human or organizational authority.
- **Context broker:** the Dina component that answers bounded questions over encrypted context.
- **Credential broker:** a component that holds or obtains downstream credentials without handing them to the agent.
- **Action proposal:** an agent's request to perform an effect. It is not proof that the effect happened.
- **Decision:** the composed result of hard invariants, grants, policies, and required approvals.
- **Obligation:** a condition attached to an otherwise allowed action, such as redact fields, use a specific gateway, record evidence, or require approval.
- **Execution receipt:** evidence of what the selected enforcement point attempted and observed.
- **Context receipt:** metadata describing what context categories were disclosed, under what grant and purpose, without copying sensitive values into audit logs.
- **Workflow task:** durable work that can wait, retry, be claimed, require approval, or outlive a model turn.
- **Adapter:** a thin framework or transport translation layer. An adapter contains no owner policy.
- **Plugin:** a bounded capability installed into Dina under `PLUGIN_ARCHITECTURE.md`. A plugin is not an open-ended external agent.
- **Service:** a capability one Dina publishes for other Dinas or agents to invoke.

---

## 5. Architectural invariants

These rules are mandatory in every deployment profile.

### I1. Authentication is not authorization

An identity proves who called. A grant or policy decides what the caller may do. An A2A Agent Card, AGT trust score, valid DID, corporate role, contact row, or service link never grants Dina access by itself.

### I2. Bind authority to the authenticated transport identity

Authorization MUST use the caller authenticated by the transport or cryptographic envelope. It MUST NOT trust `agent_did`, `from_did`, `owner_id`, or similar identity fields supplied only inside a request body.

### I3. Preserve agent and represented-party identities separately

Every action records the authenticated principal, requesting principal, optional agent principal, and acting-for chain separately. An agent never signs as the owner and never receives the owner's private identity key.

### I4. External authority is an upper bound, not an automatic Dina grant

An enterprise role, AGT identity, or OAuth scope MAY limit what Dina can allow. It MUST NOT automatically create permission to read Dina context or use a personal service.

### I5. Explicit grants or explicit resource policy are the authorization source of truth

Some resources are intentionally available under a baseline policy: public services may accept authenticated callers without a per-caller grant, and first-party Dina components may receive owner-local authority through a versioned resource policy. Gated authority MUST come from an explicit active grant; ungated authority MUST come from an explicit versioned resource policy. Policies may recommend, prompt, or materialize a grant through an auditable transition. Runtime ingress never infers authority from social membership, reputation, possession of a link, or an unwritten default.

**Current compatibility note:** paired agents can currently read Standard/free-tier personas without a durable `agent_persona_grants` row. **Target:** an external agent receives explicit context grants during pairing, including any Standard personas the owner chooses. "Standard opens automatically for the owner" must not mean "every paired third-party agent can read it." First-party Brain access and existing installations can be migrated through explicit baseline grants or a narrowly identified first-party resource policy.

### I6. One action has one enforcement owner

Each immutable action route selects exactly one PEP; the proposal cannot choose it. Multiple PDPs may advise the route, and multiple authority domains may require approval, but only one component executes or forwards the effect.

### I7. Deny wins; approval cannot expand a hard prohibition

If any mandatory hard invariant or authoritative policy denies, the final decision is deny. A user's approval cannot override a corporate hard deny. A corporate allow cannot override the owner's deny.

### I8. Context is queried, not mounted

Agents receive bounded answers and receipts, never raw vault keys or unrestricted database access.

### I9. Every external effect has idempotency and epistemic state

An effectful task carries an execution ID and idempotency key. If execution may have happened but cannot be proved, the state is `outcome_unknown`, not `failed` and not automatically retried.

### I10. Provider substitution cannot disable Core safety invariants

External providers may replace policy evaluation, identity verification, approval routing, audit export, or execution infrastructure. They may not bypass authenticated-caller binding, route authorization, grant checks, claim ownership, schema validation, tenant isolation, or secret boundaries.

### I11. Policy and personal data are separated

Policy telemetry contains labels, reason codes, hashes, and evidence references by default. It does not contain raw private context, complete prompts, credentials, or approval-card contents.

### I12. Revocation stops future authority, not history

Revoking a grant or agent prevents future claims and completions. It cannot undo an external action that already happened. Dina reports the truth and initiates reconciliation where possible.

### I13. Mobile and Home Node share one domain implementation

Storage, crypto, transport, notifications, and OS integration may have platform adapters. Identity, grant, policy composition, task lifecycle, schema validation, and protocol mapping remain shared Core code.

### I14. Standards are boundaries, not internal state models

A2A, MCP, AGT, OIDC, SPIFFE, DID, and Dina MsgBox are mapped at adapters. The durable internal model is not forced to copy any one external protocol's limitations.

### I15. The action registry defines action semantics

An agent may select a registered action and propose parameters. It may not define that action's risk class, parameter schema, result schema, retry policy, authority requirements, credential boundary, or enforcement route. Core resolves those facts from an immutable action-registry revision.

### I16. Every effectful facade enters the action plane

An API named `message.send`, `task.submit`, `service.invoke`, or any future convenience operation does not receive a parallel authorization path merely because it is not named `action.propose`. Before an external effect, every such facade MUST create or reference a canonical action proposal and pass through decision, approval, permit, execution, and receipt handling.

---

## 6. Trust model and authority domains

### 6.1 Actors

```text
Owner
  | controls
  v
Dina authority domain
  | binds and grants
  +------------------ Agent principal
  +------------------ Device principal
  +------------------ Contact principal
  +------------------ Plugin installation
  +------------------ Service grant

Organization authority domain (optional)
  | constrains
  v
Agent workload and corporate resources

External protocols
  A2A | MCP | AGT | OIDC | SPIFFE | DID | Dina D2D
```

### 6.2 Authority domains do not silently merge

The following are separate:

- owner authorization;
- organization authorization;
- service-provider authorization;
- contact/relationship authorization;
- plugin installation consent;
- protocol authentication;
- external resource authorization.

An action may require several domains. For example, sending a health update from a corporate agent may require:

1. the organization allows the corporate email tool;
2. the owner grants the agent access to Health for this session;
3. the owner approves disclosure to the named recipient;
4. the email gateway accepts the resource-bound credential.

All four facts are retained in the decision receipt.

Context itself also belongs to an authority domain. A personal vault, an employer knowledge base, and a provider's private service data may use the same context-broker interface, but their owners, approvers, retention rules, and export policies are distinct. The first implementation may support only owner-personal vaults; the protocol MUST carry `authority_domain_id` so enterprise support does not later require treating company data as the employee's personal property.

### 6.3 Trust boundaries

| Component                  |                    Trust level |          May hold raw vault data? |                   May execute effects? |
| -------------------------- | -----------------------------: | --------------------------------: | -------------------------------------: |
| Dina Core authority kernel |                           High | Only through persona repositories |      No, unless it is the selected PEP |
| Dina context broker        |                           High |    Yes, transiently and minimally |                                     No |
| Mobile authority console   |       High for owner decisions |    Only data required for display |                    No external effects |
| Home Node                  |   High within owner deployment |                               Yes |                 May host selected PEPs |
| AGT ACS or other PDP       | Policy-trusted, data-minimized |                     No by default |                      No; host enforces |
| Framework adapter          |                            Low |                                No |               No independent authority |
| External agent             |  Untrusted reasoning principal |             Only released context | Only through selected PEP, if enforced |
| Plugin runner              |       Untrusted code principal |             Only projected inputs |             Only declared capabilities |
| MCP server                 |              External resource |       Only tool inputs sent to it |                Yes within its resource |
| A2A peer                   |             External principal |  Only explicitly shared artifacts |                   Its own effects only |

---

## 7. Component architecture

```text
                         OWNER
                           |
                 Mobile / Web authority UI
                           |
                           v
+----------------------------------------------------------------+
|                     DINA AUTHORITY CORE                         |
|                                                                |
| Principal registry    Grant kernel       Approval coordinator  |
| Context broker        Decision composer  Workflow service      |
| Receipt service       Protocol mapper    Revocation service    |
|                                                                |
| Hard invariants: auth binding, tenant boundary, grants, leases, |
| schema validation, secret isolation, single execution owner     |
+-------------+--------------------+-----------------------------+
              |                    |
      Provider interfaces          | Network facilities
              |                    |
   +----------+----------+         +-> Dina D2D / MsgBox
   |          |          |         +-> Services / AppView
   v          v          v         +-> PeerLens
 Policy    Identity   Enforcement   +-> Plugins
 Dina      Dina DID   Dina gateway
 AGT ACS   OIDC       AGT host
 OPA       SPIFFE     Enterprise PEP
 Cedar     mTLS       MCP proxy
 Corp PDP  Entra      Custom PEP
              ^
              |
       Framework adapters
 OpenClaw | Pi | Hermes | LangGraph | custom | A2A | MCP
```

### 7.1 Core versus providers

Core owns state and invariants. Providers supply replaceable mechanisms.

Core MUST own:

- principal IDs and credential bindings;
- acting-for chains;
- owner grants and revocation;
- task state and claim ownership;
- decision composition;
- approval correlation;
- context disclosure and receipts;
- execution-owner selection;
- durable owner-private history;
- service and relationship authority.

Providers MAY supply:

- credential verification;
- policy evaluation;
- classification annotations;
- human approval delivery;
- corporate approval delivery;
- action execution;
- credential brokering;
- audit export;
- A2A/MCP/framework translation.

### 7.2 Mandatory baseline and optional providers

Dina standalone ships baseline providers so the system is complete without AGT:

```text
DinaIdentityVerifier
DinaPolicyProvider
DinaPhoneApprovalProvider
DinaWorkflowExecutor
DinaPrivateAuditSink
DinaMsgBoxTransport
```

An AGT deployment can replace or augment selected entries:

```text
AgtPolicyProvider
AgtFrameworkInterceptionProvider
AgtAuditExportSink
AgtExecutionRuntimeProvider
DinaPhoneApprovalProvider
DinaContextProvider
DinaRelationshipGrantProvider
```

Provider choice is explicit configuration, versioned, auditable, and included in decision receipts.

Changing a load-bearing provider, policy version, credential broker, action route, or enforcement provider invalidates unexecuted decisions evaluated against the old configuration. Core either re-evaluates them or expires them; it never silently carries approval across a changed authority boundary.

---

## 8. Integration assurance levels

The UI and SDK MUST describe what Dina can actually enforce.

### 8.1 Level O: observed

The agent reports actions or results to Dina after they occur. Dina provides visibility but cannot prevent the action.

### 8.2 Level G: voluntarily gated

The agent calls Dina before acting, such as `dina validate`. Dina can return pending, deny, or approve, but the agent still possesses a direct execution path.

This is useful cooperation, not deterministic enforcement.

### 8.3 Level I: intercepted

A framework adapter or AGT host intercepts every action in a declared mediated surface before execution. The **adapter path** may be Level I while an undeclared tool, separate process, ambient credential, or direct network path remains an escape path. If such an escape path can perform the same capability, the capability-wide assurance is not Level I; report the intercepted path and the uncovered path separately.

### 8.4 Level E: credential-enforced

The agent does not possess the downstream credential or network path. A Dina, AGT, enterprise, or other selected PEP obtains the decision and executes. Denied actions are structurally unavailable through that credential.

### 8.5 Level S: sandbox-enforced

The agent also runs in an execution sandbox that restricts process, filesystem, network, and tool access. AGT runtime rings or an enterprise sandbox may supply this level.

### 8.6 Assurance is per capability

An agent may be Level E for email, Level I for MCP tools, and Level G for local shell commands. Never label the entire agent "safe" based on its strongest integration.

The level is accompanied by explicit dimensions rather than used as a one-letter substitute for evidence:

```ts
interface EffectiveCapabilityAssurance {
  capabilityId: string;
  level: 'O' | 'G' | 'I' | 'E' | 'S';
  blockingCoverage: 'verified' | 'partial' | 'unknown';
  finalPayloadBinding: 'verified' | 'unverified' | 'not_applicable';
  credentialIsolation: 'verified' | 'agent_retains_path' | 'unknown';
  modelEgressCoverage: 'verified' | 'partial' | 'none' | 'unknown';
  escapePaths: string[];
  evidenceRefs: string[];
  computedAt: number;
  validUntil: number;
}
```

Core computes this record. A route is enabled only when its required dimensions and minimum level are satisfied.

---

## 9. Provider contract and composition

### 9.1 Provider categories

```ts
interface IdentityVerifier {
  verify(evidence: CredentialEvidence): Promise<VerifiedCredential>;
}

interface PolicyProvider {
  evaluate(snapshot: PolicySnapshot): Promise<PolicyVerdict>;
}

interface ApprovalProvider {
  request(request: ApprovalRequest): Promise<ApprovalHandle>;
  status(handle: ApprovalHandle): Promise<ApprovalDecision>;
}

interface EnforcementProvider {
  execute(request: AuthorizedExecution): Promise<ExecutionReceipt>;
  reconcile?(executionId: string): Promise<ReconciliationResult>;
}

interface AuditSink {
  append(record: RedactedDecisionRecord): Promise<void>;
}

interface ProtocolAdapter<TExternal, TInternal> {
  inbound(value: TExternal, auth: VerifiedTransport): Promise<TInternal>;
  outbound(value: TInternal, target: ExternalTarget): Promise<TExternal>;
}
```

These interfaces are conceptual until frozen in `@dina/protocol`. Implementations MUST use typed discriminated unions and schema validation, not unchecked `unknown` objects.

### 9.2 Policy verdict

A verdict is not only allow or deny:

```ts
type PolicyDecision = 'allow' | 'deny' | 'require_approval';

interface PolicyVerdict {
  providerId: string;
  providerVersion: string;
  policyVersion: string;
  decision: PolicyDecision;
  reasonCodes: string[];
  constraints: GrantConstraints;
  obligations: PolicyObligation[];
  evidenceRefs: string[];
}
```

Warnings are telemetry, not authority. A transform is an obligation attached to an allow or approval-required decision, not a fourth ambiguous authorization result.

### 9.3 Deterministic composition

For all mandatory providers:

1. If any hard invariant fails, deny.
2. If any authoritative provider denies, deny.
3. Intersect all constraints. An empty intersection denies.
4. Union compatible obligations.
5. If transformations conflict or ordering is ambiguous, deny.
6. If any authority domain requires approval, create one decision object with multiple approval requirements rather than duplicate actions.
7. Execute only after every required authority has approved and every grant plus its complete ancestry is still active.

```text
AGT allow + Dina allow                  -> allow
AGT allow + Dina owner approval         -> pending approval
AGT deny  + Dina owner approval         -> deny
AGT approval + Dina allow               -> pending approval
Corporate allow + expired Dina grant    -> deny
```

### 9.4 Transformation order

Target order:

```text
normalize input
  -> remove fields forbidden by source policy
  -> apply minimum-disclosure projection
  -> scrub/tokenize external egress
  -> validate transformed schema
  -> present the exact transformed payload for approval
  -> execute that exact approved payload
```

The payload hash shown at approval MUST match the payload hash executed. Any post-approval mutation requires a new decision unless the mutation was an explicitly approved deterministic transform.

### 9.5 Single execution owner

Every action registry entry declares:

```ts
interface ActionRoute {
  routeId: string;
  actionId: string;
  actionVersion: string;
  routeRevision: string;
  enforcementProviderId: string;
  credentialBrokerId?: string;
  policyProviderIds: string[];
  additionalAuthorityDomains: string[];
  minimumAssuranceLevel: 'O' | 'G' | 'I' | 'E' | 'S';
}
```

Core rejects configurations with zero or multiple enforcement providers for an effectful action.

The immutable action definition supplies base authority requirements. A deployment route may add organization/provider authority domains through `additionalAuthorityDomains`; it cannot remove or replace the action's base requirements. The decision composer uses the union and records its source revisions.

`minimumAssuranceLevel` is a requirement, not an operator assertion about achieved safety. Core computes the effective assurance from the current adapter version, signed manifest, conformance evidence, framework compatibility, credential placement, deployment topology, health state, fail-closed configuration, and known escape paths. If the computed level is below the route minimum, the route is unavailable; configuration cannot promote it.

---

## 10. Identity federation

### 10.1 Stable internal principal

Dina needs a stable local principal independent of credential rotation:

```ts
interface Principal {
  principalId: string;
  tenantId: string;
  principalKind: 'agent' | 'device' | 'service' | 'plugin' | 'human';
  displayName: string;
  framework?: string;
  ownerPrincipalId?: string;
  organizationPrincipalId?: string;
  status: 'active' | 'suspended' | 'revoked';
  createdAt: number;
}

interface CredentialBinding {
  bindingId: string;
  principalId: string;
  issuer: string;
  subject: string;
  credentialType: 'dina_did' | 'did' | 'oidc' | 'spiffe' | 'mtls' | 'a2a' | 'api_key';
  assuranceLevel: 'legacy' | 'transport' | 'proof_of_possession' | 'federated' | 'hardware';
  keyThumbprint?: string;
  audience?: string;
  expiresAt?: number;
  revokedAt?: number;
}
```

Authorization keys on `principalId`; authentication resolves a current binding to that principal.

### 10.2 Supported identity choices

1. **Dina-native:** an Ed25519 key created during pairing, represented as a DID where appropriate.
2. **Existing DID:** prove control using a nonce challenge and current DID document/key resolution.
3. **OIDC/Entra:** validate issuer, signature, audience, subject, time bounds, and relevant confirmation binding.
4. **SPIFFE/mTLS:** validate the workload certificate and trust domain; bind the SPIFFE ID to the principal.
5. **A2A credential:** authenticate using the scheme declared by the Agent Card. The card is discovery metadata; the transport credential is the authentication evidence.
6. **API key:** legacy, low-assurance compatibility only; restricted scopes and rotation required.

### 10.3 Bring-your-own-identity flow

```text
1. Adapter reports supported identity evidence.
2. Dina chooses a verifier from policy, never from an untrusted body field alone.
3. Verifier proves issuer, audience, freshness, and proof of possession where available.
4. Owner or organization confirms the binding.
5. Core creates or attaches a CredentialBinding to one Principal.
6. Existing grants remain attached to the principal through credential rotation.
```

Bindings are never merged because names match. Linking two credentials requires proof of possession or an authorized administrator plus an owner-visible event.

### 10.4 Acting-for chain

Every request context includes a verified chain:

```ts
interface ActorContext {
  authenticatedPrincipalId: string;
  requestingPrincipalId: string;
  agentPrincipalId?: string;
  actingForPrincipalId: string;
  organizationPrincipalId?: string;
  delegationChainId?: string;
  delegationChainHash: string;
  delegationGrantIds: string[];
  sessionId?: string;
  taskId?: string;
}
```

`requestingPrincipalId` is the logical principal requesting the operation: an agent, device, service, plugin, or human. `agentPrincipalId` is present only when an agent reasoning system participates. A gateway may be `authenticatedPrincipalId` while the delegated agent is `requestingPrincipalId` and `agentPrincipalId`.

`delegationGrantIds` is the ordered list of authority hops from the transport-authenticated principal through the requesting principal to `actingForPrincipalId`. `delegationChainId`, when present, resolves to an immutable durable chain carrying the same ordered hops; `delegationChainHash` pins that resolution into tasks and decisions. A direct owner action has an empty list and the canonical empty-chain hash. It is not represented using a synthetic grant.

Every hop binds issuer principal, issuer authority domain, subject principal, audience, resource/scope hash, time bounds, and parent. Core verifies the complete chain, same-tenant ancestry, attenuation, revocation, expiry, and bounded depth. The transport-authenticated principal MUST equal the expected caller or a specifically authorized gateway principal. A gateway forwarding an agent must provide a verifiable delegation chain; an unsigned `X-Agent-DID` style assertion is not sufficient for the final public contract.

### 10.5 Identity does not imply reputation

Identity assurance answers "is this the same actor?" PeerLens and AGT trust evidence answer different questions about behavior. Neither automatically grants access.

---

## 11. Grant kernel

### 11.1 Unified grant envelope, typed resource bodies

The architecture SHOULD converge persona grants, service grants, agent delegations, and future tool grants on one common envelope while preserving typed resource-specific constraints.

Do not replace typed tables with one unvalidated JSON authorization table.

```ts
interface AuthorityGrant<TResource, TConstraints> {
  grantId: string;
  tenantId: string;
  issuerPrincipalId: string;
  issuerAuthorityDomainId: string;
  subjectPrincipalId: string;
  resourceType: string;
  resource: TResource;
  actions: string[];
  constraints: TConstraints;
  purpose: string;
  sessionId?: string;
  taskId?: string;
  approvalTaskId?: string;
  issuanceDecisionId?: string;
  parentGrantId?: string;
  issuedAt: number;
  notBefore?: number;
  expiresAt: number;
  revokedAt?: number;
}
```

Each `resourceType` has a closed schema and evaluator:

```text
persona_access
service_invocation
tool_action
network_recipient
plugin_capability
delegation
context_query
```

### 11.2 Grant constraints

V1 constraints SHOULD support:

- read/write/action modes;
- session or task binding;
- maximum count;
- time window;
- recipient allowlist;
- resource instance allowlist;
- parameter bounds such as maximum amount;
- disclosure labels;
- purpose;
- required PEP;
- no-forward/no-store flags.

Predicate languages can be added later through typed providers. Core constraints remain understandable and renderable on approval cards.

`no-forward` and `no-store` are only as strong as the integration level. They are enforceable when a sandbox, proxy, or credential boundary controls egress and storage. With a voluntary agent integration they are contractual obligations and MUST be labeled as such rather than presented as structural guarantees.

### 11.3 Grant derivation and attenuation

A delegated grant MUST be no broader than its parent:

```text
child.actions subset of parent.actions
child.resources subset of parent.resources
child.constraints at least as restrictive
child.expires_at <= parent.expires_at
child.recipient subset of parent.recipient
```

Core validates attenuation; the agent cannot self-declare it.

Derivation also obeys these invariants:

1. the parent and child belong to the same tenant;
2. the issuer of a child is authorized by the parent to delegate;
3. parent links are acyclic and delegation depth is bounded;
4. every ancestor remains active, unexpired, and unrevoked at use time;
5. revoking or expiring an ancestor immediately disables all descendants, even if descendant rows remain historically present;
6. an implementation may cascade a cached inactive state, but authorization MUST still be correct if that cache is stale or absent.

### 11.4 Grant lifecycle

```text
proposed -> approved -> active -> expired/revoked
```

Approval and grant are separate objects:

- approval records a human decision;
- grant is the durable authorization result;
- execution decision checks that the grant and every ancestor are still active;
- revocation never rewrites historical receipts.

### 11.5 Existing grants

**Current:** `agent_persona_grants` and `service_grants` already implement strong specialized semantics. They remain authoritative until a unified repository has parity tests and an atomic migration.

**Target:** expose both through a common `GrantService` interface first. Physical table convergence is optional and must not precede semantic convergence.

For external agents, pairing creates explicit initial context grants for the personas/actions shown on the consent screen. A later request outside that set creates a new approval and grant. This replaces implicit free-tier readability without requiring a prompt for every query.

---

## 12. Context plane

### 12.1 Context request

Agents ask a bounded question, not "give me the Health vault."

```ts
interface ContextQueryRequest {
  clientRequestId?: string;
  authorityDomainId: string;
  requestedPurpose: string;
  query: string;
  requestedPersonas?: string[];
  requestedLabels?: string[];
  maxFacts: number;
  requestedRecipientHints: string[];
  requestedToolHints: string[];
  requestedRetention: 'none' | 'task' | 'session';
}

interface ContextRequest extends ContextQueryRequest {
  requestId: string;
  actor: ActorContext;
}

interface AuthorizedContextUse {
  authorityDomainId: string;
  authorizedPurpose: string;
  verifiedSink?: ResourceRef;
  authorizedRecipientPrincipalIds: string[];
  authorizedToolActionIds: string[];
  enforceableRetention: 'none' | 'task' | 'session' | 'obligation_only';
  sourceGrantIds: string[];
  assuranceLevel: 'O' | 'G' | 'I' | 'E' | 'S';
}
```

`ContextQueryRequest` is the untrusted northbound input. Core allocates `requestId` and resolves `actor` from authenticated transport evidence; a body-supplied actor or internal request ID is rejected. The `requested*` fields are untrusted intent supplied by the agent. They may narrow a request but cannot widen authority and MUST NOT be treated as evidence that a purpose, recipient, tool, or retention promise is true. Core derives `AuthorizedContextUse` from the authenticated actor, task and delegation chain, active grants, canonical action route, selected sink/PEP, and current policy. When the future sink is not yet verified, Core either returns a projection safe for any remaining permitted sink or defers disclosure until the sink is bound.

### 12.2 Context response

```ts
interface ContextResponse {
  facts: Array<{
    disclosureRef: string;
    value: unknown;
    persona: string;
    labels: string[];
    provenance: {
      kind: 'owner_memory' | 'organization_context' | 'service_result' | 'network_evidence';
      authorityDomainId: string;
    };
    observedAt?: number;
  }>;
  receipt: ContextReceipt;
}

interface ContextReceipt {
  receiptId: string;
  requestId: string;
  tenantId: string;
  requestingPrincipalId: string;
  agentPrincipalId?: string;
  actingForPrincipalId: string;
  authorityDomainId: string;
  delegationChainHash: string;
  authorizedUseHash: string;
  authorizedPurpose: string;
  verifiedSinkRef?: string;
  authorizedRecipientPrincipalIds: string[];
  authorizedToolActionIds: string[];
  effectiveAssuranceRef: string;
  grantRefs: Array<{ grantId: string; grantVersionOrHash: string }>;
  disclosedPersonas: string[];
  disclosedLabels: string[];
  disclosureCount: number;
  saltedDisclosureEnvelopeHash: string;
  createdAt: number;
  expiresAt: number;
}
```

`disclosureRef` is an opaque, disclosure-scoped reference. It MUST NOT expose an internal vault row ID or remain correlatable across unrelated sessions unless a separate grant explicitly permits durable fact identity. Detailed source provenance is retained in the encrypted owner-private receipt and disclosed to the agent only when required and authorized.

The receipt stores hashes, labels, personas, grant IDs, authorized purpose, verified recipient/tool restrictions, assurance, and timestamps. It MUST NOT duplicate plaintext sensitive facts into a general audit table.

### 12.3 Context decision sequence

```text
authenticate agent
  -> resolve principal and acting-for chain
  -> verify session/task grant
  -> classify requested personas and labels
  -> obtain missing owner approval
  -> query only permitted repositories
  -> minimize and label result
  -> apply egress restrictions
  -> return facts plus receipt
```

### 12.4 Context enrichment

Context enrichment is a Dina differentiator and MUST remain available to every lane:

- normal ask;
- Reviews search;
- Services query;
- agent task;
- plugin tool;
- A2A delegation;
- contact service.

Each lane declares a different egress target and therefore may receive a different projection of the same underlying context.

### 12.5 Information-flow labels

Dina SHOULD expose labels to AGT ACS or another policy provider without exposing values:

```json
{
  "source_labels": ["persona:health", "sensitivity:high"],
  "sink": "tool:send_email",
  "recipient_class": "external",
  "purpose": "health_update"
}
```

The provider may deny or require redaction. Dina remains responsible for applying the approved projection to actual vault data.

---

## 13. Action and enforcement plane

### 13.1 Action lifecycle

```text
Observe -> Plan -> Propose -> Decide -> Approve -> Execute -> Verify -> Record
```

The model may propose. It does not declare itself authorized.

### 13.2 Action proposal

```ts
interface ActionProposalRequest {
  idempotencyKey: string;
  actionId: string;
  actionVersion: string;
  target: ResourceRef;
  parameters: unknown;
  sourceContextReceiptIds: string[];
  requestedDeadline?: number;
}

interface ActionProposal {
  proposalId: string;
  executionId: string;
  idempotencyRecordId: string;
  actor: ActorContext;
  actionId: string;
  actionVersion: string;
  actionRegistryRevision: string;
  target: ResourceRef;
  parameters: unknown;
  targetHash: string;
  parameterHash: string;
  sourceContextReceiptIds: string[];
  requestedAt: number;
  expiresAt: number;
}
```

`ActionProposalRequest` is the untrusted northbound input. The transport supplies authenticated evidence outside the body. Core resolves `ActorContext`, allocates `proposalId` and `executionId`, reserves idempotency, validates and canonicalizes the target/parameters, and creates the durable `ActionProposal`. Caller-provided IDs or actor fields are ignored or rejected; they never select another principal, execution, or existing decision.

The caller does not supply action semantics. Core resolves an immutable registry entry:

```ts
interface ActionDefinition {
  actionId: string;
  actionVersion: string;
  registryRevision: string;
  actionClass: 'read' | 'quote' | 'booking' | 'write' | 'payment' | 'agentic';
  targetSchema: unknown;
  parameterSchema: unknown;
  resultSchema: unknown;
  baseRequiredAuthorityDomains: string[];
  retryPolicy: 'read_only' | 'provider_idempotent' | 'no_automatic_retry';
  safetyFloor: 'allowed' | 'approval_required' | 'prohibited';
  routeId: string;
}
```

Core rejects an unknown action/version before policy evaluation, validates the target and parameters against the registry entry, and pins the registry revision into the proposal snapshot. Framework metadata such as `sensitive=true`, a caller-supplied action class, or an expected schema may be classification evidence only; it never overrides the registry.

### 13.3 Decision snapshot

The final decision binds:

- proposal hash;
- transformed parameter hash;
- authenticated/requesting principals, optional agent principal, and acting-for chain;
- active grant IDs and versions;
- policy provider IDs and policy versions;
- approval requirement IDs;
- selected PEP;
- selected credential broker;
- schema snapshot;
- expiry and nonce.

Changing any load-bearing field invalidates the decision.

### 13.4 Interception decisions and single-use execution permits

Approval can sit for minutes while grants, policy, identity, or configuration changes. An approval is therefore not an executable bearer capability.

There are two different artifacts and they MUST NOT be conflated:

- An **interception decision token** authorizes a Level I framework path to release one exact normalized tool call. It proves that Dina evaluated the call; it does not prove that an external effect occurred exactly once.
- An **execution permit** authorizes the selected Level E/S credential-owning PEP to perform one exact external effect. Only this artifact carries the atomic claim-and-consume semantics below.

Immediately before a credential-enforced effect, Core MUST atomically:

1. re-authenticate or verify the active caller binding;
2. re-check tenant and acting-for chain;
3. re-check grant activity and constraints;
4. re-evaluate changed mandatory policy or configuration;
5. verify that every required approval covers the current payload hash;
6. reserve the execution ID against the selected PEP;
7. mint a short-lived, single-use execution permit bound to the PEP, proposal hash, payload hash, and deadline.

The credential-owning PEP atomically claims that permit before the external effect and consumes it exactly once. A remote PEP returns a signed or mutually authenticated completion bound to the permit and current claim. If the PEP claims the permit and disappears before a provable terminal result, Dina cannot infer that the effect did not happen; it applies the same `outcome_unknown` and reconciliation rules as a claimed workflow task. This closes the revocation and bait-and-switch race without creating an unsafe retry path.

For Level I, the framework's final tool executor MUST validate the interception token against the final tool name and canonical arguments immediately before entering the executor. A wrapper that owns `next()`/the executor is the reference implementation. If Dina runs only as one callback among later or parallel callbacks, and the framework cannot prove that no post-Dina mutation occurs, the adapter may still block covered calls but MUST report payload-binding as unverified and cannot claim the exact-payload property. Consuming an execution permit inside a pre-tool callback and then returning `allow` is forbidden because permit consumption would not be atomic with the effect.

### 13.5 Credential boundary

Level E enforcement requires the agent not to possess the downstream credential. The broker MAY:

- perform OAuth token exchange;
- hold a resource-specific refresh token;
- mint a short-lived internal capability token;
- call the external API itself;
- delegate to an enterprise PEP.

Tokens MUST be audience/resource bound. Dina MUST NOT pass a token issued to Dina through to an unrelated downstream server.

### 13.6 Verification and outcome truth

The PEP returns one of:

```text
not_started
executed_and_verified
executed_unverified
not_executed
outcome_unknown
```

A timeout after network submission is not automatically `not_executed`. Retrying an effect requires provider idempotency evidence or explicit reconciliation.

---

## 14. Approval plane

### 14.1 Approval requirements

An action may require:

- owner approval;
- organization approval;
- service-provider approval;
- second-person/quorum approval;
- no approval because a valid constrained grant already covers it.

These are separate requirements inside one decision object.

```ts
interface ApprovalRequirement {
  requirementId: string;
  decisionId: string;
  authorityDomainId: string;
  approverPrincipalIds?: string[];
  quorum: number;
  providerId: string;
  canonicalPayloadHash: string;
  viewProjectionId: string;
  viewProjectionHash: string;
  allowedDecisionKinds: Array<'approved_once' | 'approved_with_grant' | 'modified' | 'denied'>;
  expiresAt: number;
}

interface ApprovalViewProjection {
  projectionId: string;
  authorityDomainId: string;
  canonicalPayloadHash: string;
  disclosedFields: string[];
  redactedPayload: unknown;
  projectionHash: string;
}
```

Every requirement binds the same canonical action payload but may expose a different minimum-disclosure projection. An organizational approver does not automatically receive the owner's personal context, and an owner does not automatically receive organization-confidential fields. The approval provider signs or mutually authenticates the requirement ID, canonical payload hash, projection hash, decision, approver identity, and time. A projection authorizes a decision about the canonical action; it is not permission to disclose hidden fields to that approver. Projections are encrypted for their authority audience, expire with the requirement, and are never copied wholesale into notifications, general audit, or provider telemetry.

### 14.2 One card, exact payload

The owner card MUST show, subject to the owner's authorized projection:

- which principal and, when applicable, which agent is asking;
- on whose behalf;
- action and target;
- exact post-transform parameters the owner is authorized to see, with any fields governed exclusively by another authority explicitly identified as withheld;
- context categories used;
- intended recipients;
- whether the action is observed, gated, intercepted, or credential-enforced;
- one-time, session, standing, or deny options where valid;
- expiry;
- consequences and uncertainty.

### 14.3 Approval result

```ts
type ApprovalDecision =
  | { kind: 'approved_once'; payloadHash: string }
  | { kind: 'approved_with_grant'; grantId: string; payloadHash: string }
  | { kind: 'modified'; replacementProposalId: string }
  | { kind: 'denied'; reasonCode?: string }
  | { kind: 'expired' };
```

Modification creates a new proposal; it does not mutate a signed approval in place.

`approved_with_grant` is committed atomically with grant creation or records a retry-safe issuance intent keyed by requirement ID. It MUST NOT return a grant ID before the durable grant exists, and replaying the same approval decision MUST NOT mint a second grant.

On resume from a delayed approval, Core performs the execution-permit checks in section 13.4. An old approval may satisfy the human-decision requirement only if its exact payload and authority scope are unchanged; it cannot suppress re-evaluation of revocation, expiry, route changes, or new hard policy.

### 14.4 Approval provider selection

Dina's mobile approval provider is the default owner authority. An enterprise may use another provider for organizational approval. Exactly one provider owns each authority requirement, and each requirement has a stable ID so retries cannot create duplicate prompts. Provider selection also fixes the approver audience and view projection; changing either invalidates a pending requirement and creates a new one.

### 14.5 Offline behavior

If approval is required and no provider is reachable, the action remains pending or expires. It never auto-approves. Existing active grants may permit offline execution only within their explicit constraints.

---

## 15. Workflow plane

### 15.1 Existing task model is the foundation

The current `WorkflowTask` state machine already supports durable service queries, approvals, delegations, timers, watches, claims, retries, cancellation, and `outcome_unknown`. The target architecture generalizes its envelopes; it does not replace the repository with framework-specific state.

### 15.2 Required task authority snapshot

Every external-agent task MUST pin at enqueue:

- tenant ID;
- authenticated and requesting principals, plus agent principal when applicable;
- acting-for chain ID and immutable hash;
- requested runner or protocol route;
- grant IDs and relevant hashes;
- policy/config revision;
- action ID/version, registry revision, and schema snapshot;
- execution ID and idempotency key;
- action class;
- action-route revision, PEP ID, and credential-broker ID;
- deadline;
- retry/idempotency declaration.

Claim-time checks compare the pinned snapshot with current revocation and configuration state.

### 15.3 Claim security

1. The transport-authenticated principal must be eligible for the lane.
2. Claim creates a unique `claim_id` and lease.
3. Heartbeat, progress, completion, and failure bind to task plus claim ID.
4. A stale claimant cannot complete after lease reassignment.
5. Revocation prevents new claims and rejects stale completions.
6. Late results are recorded as late evidence, not applied silently.

### 15.4 Retry policy

Read-only, proven-idempotent work may retry within a bounded budget. Effectful work defaults to no automatic redispatch after a claim unless the provider contract explicitly supports idempotency and the same idempotency key reaches the real external system.

### 15.5 Cancellation

Cancellation stops future claims and asks an active PEP to cancel. It does not claim to undo an effect already performed. The user-visible state distinguishes:

- cancelled before execution;
- cancellation requested;
- cancelled by provider;
- external outcome unknown.

---

## 16. AGT composition

### 16.1 Correct boundary

AGT ACS is a stateless deterministic PDP. An AGT host or framework adapter is the PEP that intercepts lifecycle points and enforces ACS verdicts. Dina can participate in four ways:

1. **Dina as AGT approval backend:** AGT `escalate` creates or resolves a Dina approval workflow.
2. **Dina as policy information provider:** Dina supplies labels, active-grant facts, identity assurance, and relationship class, not raw vault values.
3. **AGT as Dina policy provider:** Dina invokes ACS during decision composition.
4. **Dina as private receipt and context provider:** Dina links AGT evidence to owner-private context and approval records.

### 16.2 AGT must remain optional

`AgtPolicyProvider` is a provider implementation. Core types MUST NOT import AGT SDK types. The bridge translates AGT snapshots and verdicts at one package boundary.

### 16.3 Suggested AGT integration package

```text
@dina/agt-bridge or dina-agt
  - DinaApprovalBackend
  - DinaPolicyInformationProvider
  - AgtPolicyProvider
  - DinaPrivateAuditSink
  - decision_id correlation helpers
```

### 16.4 AGT trust scores

AGT behavioral trust MAY be policy evidence. It MUST NOT replace owner grants, contact-service grants, or relationship settings. A machine-generated score is not a socially meaningful statement of personal closeness.

### 16.5 AGT audit

AGT receives redacted governance evidence. Dina stores encrypted owner-visible details. Both records share `decision_id`, `execution_id`, principal ID, and policy hashes. Raw context does not cross into general AGT telemetry.

### 16.6 Safety floors remain Dina-owned

Using AGT does not automatically make every AGT-supported action a Dina-supported action. Dina may impose non-configurable product safety floors, such as prohibiting direct payment movement in a release even when an external policy returns allow. Action classes are vocabulary, not evidence that the product currently permits every class.

### 16.7 AGT package-by-package relationship

| AGT facility                           | Dina relationship                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Agent Control Specification / Agent OS | Optional `PolicyProvider`; Dina retains hard invariants and state                                                                   |
| Framework adapters                     | Preferred interception layer where supported; bridge to Dina providers                                                              |
| Agent Mesh identity                    | Accepted credential/trust evidence; bind to Dina principal rather than minting a second mandatory identity                          |
| IATP / AgentMesh wire                  | Optional protocol adapter for AGT deployments; A2A remains the general external interoperability target and Dina D2D remains native |
| Agent Runtime / Hypervisor             | Optional sandbox and enforcement provider                                                                                           |
| Agent SRE                              | Optional provider health, circuit breaker, and reliability evidence source                                                          |
| Agent Compliance                       | Optional redacted audit/compliance sink                                                                                             |
| MCP Security Gateway                   | Optional MCP inspection provider before Dina decision/execution                                                                     |
| Agent Marketplace                      | Software supply-chain evidence for plugins; does not replace Dina Services or PeerLens                                              |

This mapping lets an AGT user adopt Dina without running duplicate kernels, identity ceremonies, meshes, or dashboards unless they deliberately want Dina's native equivalent.

---

## 17. MCP composition

### 17.1 MCP is a tool protocol

Dina can act as:

- an MCP client consuming external tools;
- an MCP server exposing Dina context and authority operations;
- a policy proxy in front of an MCP server;
- a credential broker for a protected MCP resource.

### 17.2 MCP server exposed by Dina

The public MCP surface SHOULD be narrow:

```text
dina.session.start/end
dina.context.query
dina.action.propose/status
dina.task.submit/status
dina.message.send
```

`dina.validate` remains a convenience surface, but the typed `action.propose` contract is the architectural primitive.

### 17.3 MCP security

- The MCP transport authenticates the principal.
- OAuth tokens are audience/resource bound.
- Token passthrough is forbidden.
- Tool descriptions and outputs are untrusted content.
- Sensitive arguments are transformed before approval and execution.
- A tool result passes schema and sanitization before entering context.
- AGT's MCP gateway MAY supply poisoning/drift checks.

### 17.4 Enforcement honesty

Calling a Dina MCP validation tool voluntarily is Level G. Running every downstream MCP call through a Dina/AGT proxy is Level I or E depending on credential ownership.

---

## 18. A2A composition

### 18.1 A2A is the external interoperability boundary

A2A provides discovery, messages, tasks, artifacts, streaming, cancellation, and declared security schemes. Dina SHOULD expose an A2A gateway instead of requiring external agents to understand Dina D2D.

### 18.2 Mapping

| A2A concept                | Dina concept                                                |
| -------------------------- | ----------------------------------------------------------- |
| Agent Card                 | Discovery projection of selected agent/service capabilities |
| Agent Card security scheme | Supported external authentication method                    |
| Authenticated client       | Credential binding resolved to Principal                    |
| Message                    | Workflow input or D2D message after policy                  |
| Task                       | WorkflowTask                                                |
| contextId                  | Correlation/session context, not automatically a grant      |
| task id                    | External ID mapped to internal task ID                      |
| Artifact                   | Schema-validated task result or service result              |
| input-required             | Dina awaiting additional non-sensitive input                |
| auth-required              | External authorization flow, distinct from owner approval   |
| cancellation               | Cancellation request with honest external-effect semantics  |

### 18.3 Agent Card is not authority

An Agent Card can be signed and can advertise capabilities. Dina still authenticates the live caller and checks grants. Discovery metadata never grants vault, tool, or service access.

### 18.4 A2A extension discipline

Dina-specific metadata MAY use a versioned A2A extension for receipt IDs, grant selectors, or assurance labels. Core semantics MUST remain usable without the extension, and private Dina concepts must not be leaked through public cards.

---

## 19. Agentic Resource Discovery composition

### 19.1 ARD is discovery, not execution or authority

Google's Agentic Resource Discovery (ARD) specification defines domain-hosted catalogs and federated registries for finding agents, MCP servers, A2A agents, OpenAPI tools, and nested catalogs. After discovery it hands the client to the resource's native protocol.

Dina SHOULD support ARD as an additional discovery source. It MUST NOT treat an ARD catalog, registry ranking, domain name, or trust manifest as an invocation grant.

### 19.2 Dina publishing through ARD

A Dina owner or organization MAY publish an ARD catalog projection containing only capabilities intentionally exposed for web discovery:

- public Dina services;
- public A2A endpoints;
- public MCP servers;
- public developer plugins where the plugin architecture permits it.

Unlisted, known-only, contact, private plugin, persona, and owner-local capabilities MUST NOT appear in the public projection.

### 19.3 Dina consuming ARD

```text
ARD search or direct catalog fetch
  -> verify publisher/domain/trust metadata
  -> resolve native endpoint and protocol
  -> create a local candidate, not a grant
  -> apply Dina/enterprise selection policy
  -> authenticate using the native protocol
  -> request or verify required authority
  -> invoke through the selected PEP
```

PeerLens evidence and owner preferences may rank candidates after discovery. They do not replace endpoint authentication or authorization.

### 19.4 Relationship to AppView

AppView remains Dina's protocol-aware index for Dina records, service taxonomy, and PeerLens. ARD can broaden discovery across the web. Dina SHOULD ingest or query ARD through an adapter rather than forcing AppView's internal schema to become a complete ARD registry.

## 20. Dina D2D, Services, PeerLens, and plugins

### 20.1 D2D remains the native personal network

Dina D2D carries signed, owner-oriented communication over MsgBox and supports Dina-specific relationship semantics. It remains the preferred Dina-to-Dina path. A2A is the broad external compatibility path. A gateway maps when appropriate; neither protocol is declared universally superior.

### 20.2 Services

Connected agents may:

- discover public services;
- invoke an unlisted service by reference;
- invoke known-only services only with an explicit grant;
- publish capabilities through their owner's Dina;
- act as Tier 2 or Tier 3 service runners;
- use Dina Tier 1 providers without running external code.

Service discoverability and invocation authority remain separate axes.

### 20.3 Contact services

Relationship defaults may decide whether to materialize or prompt for a service grant. Ingress authorization checks only the explicit grant and authenticated caller. Requester-visible failure collapse and owner-private decision logging remain product invariants.

### 20.4 PeerLens

PeerLens evidence may inform routing and risk UI, but it never overrides grants. Reputation attaches to stable publisher, service, plugin, or principal identities with version/runtime evidence where available.

### 20.5 Plugins are not agents

The plugin architecture remains a bounded installed-capability subsystem:

- interpreted plugins are data executed by a trusted interpreter;
- runner plugins are paired out-of-process code with install-scoped identity;
- plugins have manifest-pinned schemas, scope, configuration, and lanes;
- open-ended reasoning systems pair as agents instead.

The control plane supplies common identity, grants, workflows, decisions, receipts, and enforcement to both without merging their contracts.

---

## 21. Public Dina control-plane API

### 21.1 API principles

- One semantic contract across local HTTP, MsgBox RPC, MCP, and future SDK bindings.
- Transport-specific authentication stays outside request bodies.
- Every mutating call accepts an idempotency key.
- Async decisions return handles rather than holding a request open indefinitely.
- Version negotiation is explicit.
- Errors use stable machine codes plus safe human messages.

#### 21.1.1 Idempotency contract

Every mutating operation applies the same durable rule:

1. Core namespaces the caller's key by tenant, authenticated principal, semantic operation, and action/resource identity.
2. The first accepted request stores the key, canonical pre-transform request hash, canonical post-transform hash when applicable, logical object/result reference, state, and retention deadline in one transaction with object creation.
3. Repeating the same key with the same canonical request returns the original logical result or current status; it does not repeat creation or execution.
4. Repeating the same key with a different canonical request returns `idempotency_conflict` without changing the original operation.
5. The record survives restart and is retained beyond the longest execution, provider idempotency, callback, and reconciliation window for that operation.
6. Effectful providers receive the same execution-level idempotency key where their contract supports it. An internal deduplication record alone is not evidence that the external provider deduplicates.
7. If the real provider lacks idempotency, automatic redispatch after a claim defaults to off and ambiguous completion becomes `outcome_unknown`.

### 21.2 Minimum northbound surface

```text
identity.capabilities
identity.bind
identity.rotate
identity.revoke

session.start
session.end
session.status

context.query
context.status

action.catalog
action.propose
action.status
action.cancel

task.submit
task.claim
task.heartbeat
task.progress
task.complete
task.fail
task.cancel

message.send
message.status

grant.list
grant.revoke

receipt.get
health.get
```

Agents MUST NOT receive generic grant-creation authority. Grant creation is an owner/admin/provider operation exposed through a separate privileged surface.

`message.send`, effectful `task.submit`, service invocation, plugin action, and similar methods are typed facades, not alternative execution routes. Each resolves an immutable action definition and creates or references an `ActionProposal` before any external effect. A facade MAY complete locally without an action proposal only when the canonical action registry classifies the operation as a non-effectful local state transition and its repository route independently authorizes the caller.

### 21.3 Error taxonomy

At minimum:

```text
unauthenticated
identity_unbound
identity_suspended
tenant_mismatch
grant_missing
grant_expired
grant_revoked
approval_required
approval_pending
approval_denied
approval_expired
policy_denied
constraint_violation
schema_violation
claim_conflict
stale_claim
idempotency_conflict
provider_unavailable
credential_unavailable
execution_timeout
outcome_unknown
protocol_version_unsupported
```

Requester-facing relationship failures may intentionally collapse several internal codes. Internal owner and audit surfaces retain the true code.

### 21.4 Privilege surfaces

The semantic API is divided into caller-specific surfaces. Sharing a method name does not imply sharing route authority.

| Surface                  | Permitted callers                                | Examples                                                                                       |
| ------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Pairing bootstrap        | Unpaired principal proving a fresh challenge     | initiate/complete pairing only                                                                 |
| Agent                    | Bound active agent principal                     | session, bounded context query, action proposal/status, task submit/status, message send       |
| Runner                   | Bound agent/plugin principal on an assigned lane | claim, heartbeat, progress, complete, fail                                                     |
| Owner device             | Authenticated owner-controlled device            | approve/deny, list/revoke grants, inspect receipts, manage agents                              |
| Authority administration | Owner or authorized organization administrator   | bind/rotate identities, configure providers, issue standing grants, define action routes       |
| Internal service         | Narrow service principal                         | repository-specific internal operations, never implicit full access merely because it is local |

The final route matrix MUST be generated or type-checked from one source. A new principal kind or device role defaults to no routes; it never falls through to a wider `device` or `service` role.

---

## 22. Durable data model

### 22.1 Recommended entities

```text
principals
credential_bindings
delegation_chains
delegation_chain_hops
authority_grants
typed grant extension tables or validated typed payloads
action_definitions and immutable registry revisions
action_routes and immutable route revisions
action_proposals
action_decisions
approval_requirements
approval_decisions
approval_view_projections
approval_resume_tokens
interception_decision_tokens and consumption state
execution_permits and claim/consumption state
idempotency_records
workflow_tasks
workflow_events
context_receipts
framework_run_bindings
hosted_runtime_events and deduplication keys
execution_receipts
execution_reconciliation_attempts
adapter_manifests and signatures
adapter_conformance_results and digests
provider_configurations
provider_health
private_decision_log
```

These are semantic entities, not necessarily one table each. However, action/route revisions, delegation hops, idempotency state, approval resume state, permit consumption, framework bindings, hosted-event deduplication, and reconciliation attempts are load-bearing durable state. They MUST be committed transactionally at their lifecycle boundaries and cannot be reconstructed only from logs after a crash.

### 22.2 Tenant boundary

Every enterprise-capable row carries `tenant_id`. Every repository operation is tenant-scoped by construction. A tenant-less lookup by public ID is forbidden outside a migration or single-owner adapter that injects the one local tenant.

### 22.3 Secret placement

- Owner root secrets and vault DEKs remain in Dina's existing key hierarchy.
- Agent private keys remain with the agent or Dina secure storage if Dina-generated.
- External refresh tokens live in a credential broker, not workflow payloads.
- Workflow payloads contain selectors and encrypted references, not reusable credentials.
- Provider configuration is encrypted and versioned.
- Approval view projections and hosted resume tokens are encrypted for their intended authority/runtime audience and deleted under explicit retention rules.
- Logs never contain private keys, bearer tokens, raw approval payloads, or raw vault values by default.

### 22.4 Export and restore

Identity bindings, active grants, in-flight authority, and credential references require explicit restore policy. Restoring authority to another device can be unsafe.

Default posture:

- export public identities and non-secret configuration;
- export encrypted owner data;
- do not silently reactivate agent sessions or active grants;
- require re-verification of external credentials;
- mark in-flight external effects `outcome_unknown` unless reconciled;
- preserve historical receipts in encrypted form.

---

## 23. Deployment models

### 23.1 Mobile in-process

Mobile hosts Core, encrypted storage, Brain, approval UI, and optional local PEPs. Framework agents connect over MsgBox or a paired local channel. Platform adapters provide SQLite, crypto, keychain, notifications, and networking.

### 23.2 Home Node Lite split process

Core owns authority and durable state. Brain owns reasoning. Web and mobile are clients. External runners claim tasks through Core. No Brain route may bypass Core grants merely because it runs locally.

### 23.3 Local sidecar

A Dina sidecar runs beside an agent framework:

```text
Agent process -> localhost/Unix socket -> Dina sidecar -> Home Node/mobile
```

The sidecar holds the paired agent credential, performs protocol translation, and optionally hosts AGT. It does not hold owner root secrets.

### 23.4 Enterprise service

An organization may host identity verification, AGT, PEPs, and audit export centrally while each user retains a Dina authority domain. Policy composition treats enterprise restrictions as an upper bound and personal grants as required authority for personal data.

### 23.5 Vendor-hosted agent

Each customer installation receives a distinct principal or credential binding. A vendor-wide identity may authenticate the vendor, but customer authority is install- and tenant-scoped. One compromised tenant binding must not authorize another tenant.

---

## 24. Onboarding and developer experience

### 24.1 Five-minute standalone flow

```text
1. Install adapter or dina-agent.
2. Dina discovers the framework.
3. User scans or pastes one setup code.
4. Dina creates an identity or verifies the existing one.
5. User sees requested capabilities in plain language.
6. A diagnostic context query and approval-gated action run.
7. Integration level is displayed honestly.
```

### 24.2 Existing identity flow

The UI asks:

```text
Use this agent's existing verified identity
or
Create a Dina identity for this agent
```

It does not ask normal users to choose DID methods, OIDC claims, or certificate formats.

### 24.3 AGT flow

```text
1. Detect AGT or install the Dina AGT bridge.
2. Reuse AGT's framework interception.
3. Configure Dina as approval and/or context provider.
4. Bind the AGT identity to a Dina principal.
5. Run conformance diagnostics.
6. Display which capabilities AGT and Dina each enforce.
```

### 24.4 Capability selection

```text
Add Dina to this agent

[x] Private context
[x] Phone approvals
[x] Session grants
[ ] Runtime policy evaluation       Provided by AGT
[ ] Execution sandbox               Provided by AGT
[x] Dina services and messaging
[x] Owner-private activity history
```

### 24.5 Framework adapters

First-party adapters SHOULD be thin:

- OpenClaw hook/runner;
- Pi extension;
- Hermes runner;
- AGT provider bridge;
- generic Python SDK;
- generic TypeScript SDK;
- A2A gateway;
- MCP server/proxy.

Adapters translate lifecycle events and transport. They do not implement vault, grant, approval, or service policy.

### 24.6 Market reality: there is no single corporate agent framework

The architecture MUST NOT assume that corporate agents are generally built with Claude Code, the Claude Agent SDK, or any other single SDK. Production agents currently fall into several materially different classes:

1. **Framework-owned loops:** Claude Agent SDK, OpenAI Agents SDK, LangChain/LangGraph, Microsoft Agent Framework, Google ADK, PydanticAI, CrewAI, and LlamaIndex.
2. **Hosted agent runtimes:** Claude Managed Agents and vendor-hosted agent products where the application receives events but does not own the process.
3. **Self-hosted end-user agents:** OpenClaw, Pi, and Hermes.
4. **Protocol-only agents:** remote A2A agents or clients using MCP tools.
5. **Custom loops:** a company directly calls a model API and implements its own tool dispatcher.
6. **Headless coding agents:** `claude -p`, `codex exec`, `gemini -p`, or another CLI invoked as a subprocess.

A model client is not automatically an agent framework. A company calling the Anthropic Messages API or OpenAI Responses API directly still owns its loop and needs Dina's generic tool-dispatch wrapper. Conversely, a Claude Agent SDK application has native blocking hooks that Dina should use instead of treating it as a generic subprocess.

The product promise is therefore:

> Keep the reasoning loop you already use. Attach Dina at the strongest lifecycle or credential boundary that loop exposes.

### 24.7 Two contracts that MUST remain separate

Dina needs two different extension contracts:

| Contract                | Purpose                                                                              | Existing analogue                  | Security meaning                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------- |
| `AgentRunner`           | Execute one durable delegated task and return/reconcile its outcome                  | `cli/src/dina_cli/agent_runner.py` | Execution transport only; it does not prove that the agent's own tools are governed |
| `AgentFrameworkAdapter` | Bind a framework run to a Dina principal/session and intercept lifecycle/tool events | New                                | Can provide Level I interception when coverage is complete                          |

An integration MAY implement both. OpenClaw, for example, can remain a detached task runner while also installing an in-process Dina policy plugin. Those are independent capabilities and MUST be reported independently.

Do not expand `AgentRunner` into a policy engine. It has the wrong lifecycle and would couple durable task execution to every framework's local hook semantics.

### 24.8 Integration profiles

Every integration declares one or more profiles. Product UI and conformance results are derived from these profiles, not from the framework's brand.

| Profile                    | What Dina does                                                                   | Typical assurance ceiling                                        |
| -------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `context_client`           | Calls Dina ask/remember/scrub APIs or MCP tools                                  | G                                                                |
| `task_runner`              | Claims and executes Dina workflow tasks                                          | G unless combined with another profile                           |
| `tool_interceptor`         | Blocks, rewrites, defers, and observes framework tool calls before execution     | I                                                                |
| `model_egress_interceptor` | Inspects and minimizes the complete model request before it leaves the runtime   | I for covered model calls                                        |
| `model_gateway`            | Owns the model-provider credential and forwards only approved/minimized requests | E for model egress                                               |
| `credential_gateway`       | Owns the real external credential and executes only with a Dina permit           | E                                                                |
| `sandbox_controller`       | Runs the agent inside a policy-controlled process/container boundary             | S                                                                |
| `hosted_event_bridge`      | Maps hosted-runtime tool/approval events to Dina and resumes the hosted run      | I for covered hosted tools                                       |
| `agt_bridge`               | Reuses AGT framework interception and composes Dina as provider                  | AGT adapter's demonstrated level                                 |
| `a2a_gateway`              | Maps remote A2A tasks to Dina workflows                                          | No internal-tool claim; authority is per exposed task capability |
| `mcp_server`               | Exposes Dina functions as model-callable tools                                   | G by itself                                                      |
| `mcp_proxy`                | Brokers selected MCP servers/credentials through Dina                            | E for proxied effects                                            |

Installing the Dina skill, `AGENTS.md`, or MCP server is useful cooperative integration. It is not `tool_interceptor` and MUST NOT be marketed as deterministic agent control.

### 24.9 Canonical framework adapter contract

The direct adapter contract is deliberately smaller than a framework SDK. It translates only lifecycle facts and blocking decisions.

```ts
type IntegrationProfile =
  | 'context_client'
  | 'task_runner'
  | 'tool_interceptor'
  | 'model_egress_interceptor'
  | 'model_gateway'
  | 'credential_gateway'
  | 'sandbox_controller'
  | 'hosted_event_bridge'
  | 'agt_bridge'
  | 'a2a_gateway'
  | 'mcp_server'
  | 'mcp_proxy';

type FrameworkEventKind =
  | 'run.started'
  | 'input.received'
  | 'model.before'
  | 'model.after'
  | 'tool.before'
  | 'tool.after'
  | 'tool.failed'
  | 'handoff.before'
  | 'handoff.after'
  | 'run.suspended'
  | 'run.resumed'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled';

interface FrameworkRunBinding {
  bindingId: string;
  tenantId: string;
  requestingPrincipalId: string;
  agentPrincipalId: string;
  actingForPrincipalId: string;
  dinaSessionId: string;
  frameworkId: string;
  frameworkVersion: string;
  nativeRunId: string;
  nativeSessionId?: string;
  workflowTaskId?: string;
  authorityDomainIds: string[];
  startedAt: number;
}

interface FrameworkToolCall {
  eventId: string;
  bindingId: string;
  nativeToolCallId: string;
  toolName: string;
  toolKind?: string;
  arguments: unknown;
  argumentSchemaHash?: string;
  requestedAt: number;
  provenance: {
    framework: string;
    agentName?: string;
    subagentId?: string;
    source: 'model' | 'workflow' | 'user' | 'framework';
  };
}

interface FrameworkModelRequest {
  eventId: string;
  bindingId: string;
  nativeRequestId?: string;
  provider: string;
  model: string;
  messages: unknown;
  tools?: unknown;
  attachments?: unknown;
  requestedAt: number;
}

type FrameworkModelDecision =
  | { kind: 'allow'; request: FrameworkModelRequest; receiptId: string }
  | { kind: 'deny'; reasonCode: string; receiptId: string };

type FrameworkToolDecision =
  | { kind: 'allow'; interceptionToken: string; payloadHash: string; arguments: unknown }
  | { kind: 'deny'; decisionReceiptId: string; reasonCode: string }
  | { kind: 'defer'; approvalId: string; resumeToken: string; expiresAt: number };

interface AgentFrameworkAdapter {
  readonly manifest: FrameworkAdapterManifest;
  bindRun(input: BindRunInput): Promise<FrameworkRunBinding>;
  beforeModel?(request: FrameworkModelRequest): Promise<FrameworkModelDecision>;
  beforeTool?(call: FrameworkToolCall): Promise<FrameworkToolDecision>;
  afterTool?(input: FrameworkToolResult): Promise<void>;
  onLifecycle?(event: FrameworkLifecycleEvent): Promise<void>;
  resume?(resumeToken: string, resolution: ApprovalResolution): Promise<void>;
  cancel?(bindingId: string): Promise<CancelResult>;
  health(): Promise<FrameworkAdapterHealth>;
}
```

The adapter does not evaluate personal policy, query vault repositories, mint grants, render approval cards, or execute external effects. `beforeTool` submits a canonical proposal to Core and translates the resulting decision into the framework's native allow/deny/defer mechanism.

The interface is capability-shaped: methods are optional at the TypeScript boundary, while each declared profile imposes mandatory method and conformance requirements. `tool_interceptor` requires `beforeTool` and final-executor evidence; `model_egress_interceptor` requires `beforeModel`; lifecycle-dependent profiles require the relevant `onLifecycle` events. Startup rejects a manifest whose declared profile is not implemented. A `context_client`, `task_runner`, `mcp_server`, or `a2a_gateway` is not forced to pretend it intercepts framework tools.

`interceptionToken` is an opaque, short-lived Level I decision token bound to the framework binding, native tool-call ID, tool identity, canonical payload hash, adapter/framework versions, and expiry. It is not a Level E execution permit. A final executor wrapper MUST validate and consume it immediately before entering the native executor and MUST verify that the final arguments still produce `payloadHash`. A pre-tool callback that cannot own the final executor may return the exact approved arguments and block denied calls, but it cannot consume a Level E permit or claim atomic/exact-payload execution without framework-specific proof that no later mutation is possible. If the framework cannot durably defer and resume the same tool-call ID, a pending approval is translated to a temporary denial; the user may retry after approval. The adapter MUST NOT invent an in-memory resume flow and call it durable.

`bindRun` authenticates with an install/workload credential. Core resolves `requestingPrincipalId`, `agentPrincipalId`, `actingForPrincipalId`, tenant, and authority domains from verified bindings and delegation; the adapter never copies these values from a model message, framework agent name, task body, or session metadata. Likewise, `resume` accepts only a resolution retrieved from Dina's authenticated approval service, not a boolean supplied by the agent.

`beforeModel` is separate from `beforeTool`. Dina always minimizes context it discloses through `ContextBroker`, but an agent may also obtain sensitive data from files, another tool, or its own memory. Full model-egress assurance requires interception of the complete serialized model request or a Dina/enterprise model gateway that owns the provider credential. Prompt instructions to call `dina scrub` remain Level G.

### 24.10 Adapter manifest and coverage declaration

Each adapter ships a machine-readable manifest:

```ts
interface FrameworkAdapterManifest {
  manifestSchemaVersion: string;
  adapterId: string;
  adapterVersion: string;
  buildDigest: string;
  signerKeyId: string;
  signature: string;
  frameworks: Array<{
    id: string;
    versionRange: string;
    executionModes: Array<'local' | 'hosted' | 'cli' | 'embedded'>;
  }>;
  profiles: IntegrationProfile[];
  blockingEvents: FrameworkEventKind[];
  observationalEvents: FrameworkEventKind[];
  toolCoverage: {
    builtIn: 'all' | 'allowlist' | 'none' | 'unknown';
    custom: 'all' | 'allowlist' | 'none' | 'unknown';
    mcp: 'all' | 'allowlist' | 'none' | 'unknown';
    subagents: 'inherited' | 'separate_binding' | 'uncovered' | 'unknown';
  };
  modelCoverage: {
    completeRequest: boolean;
    attachments: boolean;
    retries: boolean;
    subagents: 'inherited' | 'separate_binding' | 'uncovered' | 'unknown';
  };
  supports: {
    argumentRewrite: boolean;
    asynchronousApproval: boolean;
    durableResume: boolean;
    cancellation: boolean;
    structuredResult: boolean;
    outcomeReconciliation: boolean;
  };
  knownEscapeHatches: string[];
}
```

Rules:

1. A callback that fires after a tool starts is observational, even if named "started."
2. A hook timeout that defaults to continue lowers assurance unless the host is configured fail closed.
3. Coverage means all tools in the declared set, including dynamically loaded tools and subagents.
4. An adapter cannot claim Level I if the agent retains direct credentials or an unmediated shell/network path for the same effect.
5. Framework and adapter versions are pinned in the receipt because hook semantics change over time.
6. Unknown coverage is displayed as unknown, never inferred as safe.
7. Tool interception does not imply model-egress interception; report them separately.
8. The manifest is a signed compatibility claim, not proof of coverage. Core derives effective assurance from a matching, unexpired conformance result plus runtime topology and health evidence.
9. `knownEscapeHatches` is useful disclosure but cannot raise assurance. Conformance and deployment probes may discover additional escape paths and always lower the computed level when they conflict with the manifest.
10. A framework or adapter upgrade invalidates prior conformance evidence unless its declared compatibility policy and test digest explicitly cover the new version.

### 24.11 Adapter composition and non-duplication

There are two supported integration paths:

```text
Direct path
framework native hook -> thin Dina adapter -> Dina action/context APIs

AGT path
framework native hook -> existing AGT adapter -> AGT policy/interception
                                      |-> Dina provider bridge
```

When AGT already owns a framework's interception, Dina MUST NOT install a second blocking interceptor for the same tool. Dina registers as an AGT policy/context/approval provider and consumes the single AGT interception result. This preserves invariant I6.

Dina's direct adapter contract is not a competing generic policy framework. It exists for:

- installations that do not use AGT;
- Dina-specific context and phone-approval translation;
- frameworks AGT does not yet support;
- owner-controlled deployments where a smaller dependency is desired.

The direct contract SHOULD align names and conformance vectors with AGT's public Framework Adapter Contract where practical, but Core MUST NOT import AGT types. The AGT contract includes a common tool-call interceptor and native adapters for multiple frameworks; duplicating those adapter implementations would create needless maintenance and inconsistent enforcement.

### 24.12 Reference integration: Claude Agent SDK

Claude Code SDK has been renamed Claude Agent SDK. A Claude Agent SDK application is not the same integration as running the `claude` CLI in print mode.

Native seam:

- `PreToolUse` can allow, deny, ask, defer, and rewrite tool input;
- `PostToolUse` and `PostToolUseFailure` provide result/error evidence;
- `UserPromptSubmit`, subagent, stop, and session hooks provide lifecycle context;
- SDK MCP servers expose Dina context functions without a separate process.

Direct implementation:

```text
ClaudeAgentOptions.hooks.PreToolUse
  -> normalize tool name/input/subagent/run
  -> Dina beforeTool
  -> allow: permissionDecision=allow + updatedInput
  -> deny: permissionDecision=deny
  -> pending: permissionDecision=defer, persist resume token
```

Requirements:

1. Register a catch-all `PreToolUse` matcher, not only a hand-maintained list.
2. Match MCP tools as `mcp__<server>__<action>` and preserve their actual server identity.
3. Bind subagents either to the parent's attenuated authority or to a new child binding; do not silently inherit full authority.
4. Use structured output for delegated task results; do not parse the final prose summary.
5. Do not enable broad `Bash` permissions merely so the agent can invoke Dina. Prefer in-process SDK/MCP tools.
6. Treat matching hooks as independent and potentially parallel. If another hook can produce a conflicting `updatedInput`, deny the call or lower payload-binding assurance; never assume hook completion order.
7. A callback-only installation may prove blocking coverage, but exact-payload interception requires a framework guarantee or final executor wrapper that validates the Dina interception token after all input transformation.

Assurance: Level I for SDK-mediated tools only after conformance proves blocking and final-payload coverage for the declared hook composition. If the callback can block but cannot prove the final payload after parallel hooks, report interception with unverified payload binding rather than full Level I exact-payload assurance. Level E applies only to effects whose credentials are held behind Dina. A shell with ambient credentials remains an escape path.

The documented Claude Agent SDK hook set does not expose a complete pre-provider model payload hook equivalent to Pi's `before_provider_request`. `UserPromptSubmit` can add/sanitize user input, and Dina can minimize context it supplies, but the adapter MUST report full model-egress interception as unavailable unless traffic is routed through a model gateway.

### 24.13 Claude Managed Agents

Hosted agents require a different adapter. The application receives custom tool-use events and decides whether/how to provide results, while built-in and MCP tools are governed by hosted permission policy.

The Dina hosted bridge MUST:

1. map the hosted session and tool-use ID to a durable `FrameworkRunBinding`;
2. submit custom tool calls to Dina before returning a result;
3. convert pending Dina approval into a suspended hosted session or unresolved tool event;
4. persist the vendor resume/session token before acknowledging suspension;
5. configure sensitive built-in/MCP tools as always-ask or deny where the hosted platform permits;
6. declare any built-in tool that cannot be intercepted as uncovered;
7. make callback/webhook delivery idempotent.

Do not reuse the local SDK hook adapter for this path. Local callbacks and hosted event delivery have different availability, resume, and trust boundaries.

### 24.14 Reference integration: OpenAI Agents SDK

Use three native surfaces together:

- tool input guardrails or a function-tool wrapper for blocking before execution;
- `needs_approval` and run interruption/resume for human approval;
- `RunHooks`/`AgentHooks` for lifecycle and audit correlation.

`on_tool_start` alone is not a sufficient PEP unless the SDK contract guarantees it can prevent the wrapped call. The Dina adapter SHOULD wrap every local function tool and every locally executed MCP tool, then use lifecycle hooks only for evidence.

Input/output guardrails do not necessarily expose every complete serialized model request in a multi-turn run. Use a wrapped model client or model gateway for model-egress enforcement; do not infer it from tool guardrails.

Hosted MCP is a separate route: if the model provider invokes the remote MCP server directly, a local Python hook cannot intercept it. In that mode Dina must be the OAuth-protected MCP proxy/credential holder, or the capability remains outside Dina's enforcement claim.

Assurance: Level I for wrapped tools; Level E for Dina-proxied credentials; Level G for an unproxied remote MCP server that merely exposes Dina validation as another optional tool.

### 24.15 Reference integration: LangChain and LangGraph

For LangChain `create_agent`, use middleware `wrap_tool_call`, which may choose not to call the underlying handler. Use before/after agent/model hooks for context and evidence. For owner approval, map Dina pending state to LangGraph's durable interrupt/resume mechanism and require a persistent checkpointer.

`before_model` may implement model-egress minimization when it sees the complete request used by the configured model adapter. Conformance must include retries, attachments, subgraphs, and model clients invoked directly outside the agent middleware.

For a custom `StateGraph`, there is no guarantee that every effect passes through `create_agent` middleware. The integrator MUST wrap the actual `ToolNode` or every effectful node. Graph compilation alone is not proof of coverage.

The adapter MUST preserve:

- graph thread/checkpoint ID;
- tool-call ID;
- node and subgraph provenance;
- resume token;
- the exact arguments before and after approved transformation.

Assurance: Level I only for graphs whose effectful nodes pass conformance coverage. Otherwise report mixed G/I per capability.

### 24.16 Microsoft Agent Framework

Microsoft Agent Framework exposes agent-run, function-call, and chat-client middleware. Function-call middleware is the direct PEP seam; agent-run middleware binds lifecycle and identity.

Preferred order:

1. If AGT is installed, use its Microsoft Agent Framework adapter and attach Dina through the AGT bridge.
2. Otherwise install a thin Dina function-call middleware that delegates to the canonical `beforeTool` contract.

Never run AGT middleware and Dina middleware as independent approval owners. One middleware owns blocking; the other is a provider behind that owner.

### 24.17 Google Agent Development Kit

Google ADK exposes agent, model, and tool callbacks across its supported languages. Its `before_tool_callback` can skip the real tool and return a replacement result, so it is a valid blocking seam. It becomes the declared Level I PEP only after conformance proves callback composition cannot later override the denial or mutate the approved payload. ADK Plugins apply callbacks globally and are the preferred installation surface over editing every agent definition.

The Dina ADK plugin SHOULD implement:

- `before_agent` for run binding;
- `before_tool` for proposal/deny/defer;
- `after_tool` and `on_tool_error` for evidence;
- ADK session state only as a cache of opaque Dina IDs, never as the grant source of truth.

Where ADK's `before_model_callback` can inspect/replace the complete LLM request, the same plugin MAY implement `model_egress_interceptor`; this is a separate coverage claim from `before_tool_callback`.

Because plugin callbacks run before tool-level callbacks, composition order must be tested. A later callback must not turn a Dina denial into execution.

### 24.18 PydanticAI

PydanticAI provides two strong seams:

- subclass `WrapperToolset` and override `call_tool()` to mediate every wrapped toolset call;
- use deferred tools and `ApprovalRequired`/`DeferredToolRequests` for durable human approval.

The Dina integration SHOULD be a wrapper toolset plus a deferred-tool handler. `ApprovalRequiredToolset` can cover MCP toolsets, but the adapter still needs Dina-specific payload binding and receipt IDs.

The wrapper MUST cover dynamically prepared toolsets and must not trust tool metadata such as `sensitive=true` as authorization. Metadata is a policy input only.

### 24.19 CrewAI and LlamaIndex

CrewAI event listeners and LlamaIndex observability callbacks are useful evidence surfaces, but an event named `ToolUsageStartedEvent` or function-call callback is not automatically a blocking PEP.

Preferred integration:

1. use AGT's existing adapter where supported;
2. otherwise wrap the actual CrewAI `BaseTool` execution or LlamaIndex function tool/worker call;
3. use events/callbacks for run correlation and receipts only;
4. fail conformance if a tool registered after adapter installation bypasses the wrapper.

CrewAI task guardrails validate task output and do not substitute for pre-effect authorization. LlamaIndex output validation likewise cannot undo an external action already performed.

Direct first-party adapters for these frameworks are lower priority than the AGT bridge unless real adopter demand demonstrates a missing capability.

#### 24.19.1 Other enterprise frameworks

- **Semantic Kernel:** use its function-invocation filter, which can stop execution by not calling `next`. Prefer AGT's adapter when AGT is present. Filters do not run when applications bypass `Kernel`, so direct chat/model clients are an explicit escape path.
- **AutoGen:** mediate the actual `ToolAgent`, Workbench, or `BaseTool` execution path. Message handlers and team events provide orchestration evidence but are not substitutes for tool authorization. Prefer AGT's maintained adapter where compatible.
- **AWS Strands Agents:** install a plugin/hook provider using `BeforeToolCallEvent`, which can cancel, replace, or rewrite a tool before execution. Also cover direct programmatic tool calls and dynamically loaded tools; lifecycle callbacks alone are insufficient.
- **smolagents:** wrap `Tool.forward`/tool execution or use AGT. A `CodeAgent` can generate Python code with authority beyond registered tools, so tool interception alone cannot claim complete coverage unless code execution is sandboxed and credentials are removed.

These frameworks belong in the compatibility matrix, but they do not justify four more independent policy implementations. The canonical contract plus AGT reuse is the scaling mechanism.

### 24.20 OpenClaw, Pi, and Hermes

These are important integration targets, but their current Dina runners are not equivalent.

#### OpenClaw

OpenClaw now exposes typed plugin hooks, including `before_tool_call` with block, parameter rewrite, and approval semantics. The target Dina integration is an in-process OpenClaw plugin using that hook. The existing HTTP-hook `OpenClawRunner` remains only the detached task-execution profile.

The plugin MUST set fail-closed timeout behavior for sensitive tools. OpenClaw documents that timed-out hook promises may continue running and some outbound hooks continue after timeout; those semantics must be captured in the adapter manifest and tested per hook.

#### Pi

Pi extensions expose a blocking `tool_call` event, mutable arguments, result modification, session lifecycle, and project trust. A Dina Pi extension can therefore provide Level I for Pi-mediated tools. It MUST also intercept Pi's direct user-bash path if that path can exercise the same protected effects, and it must account for parallel sibling tool preflight.

Pi's `before_provider_request` can replace the serialized provider payload and is the strongest direct model-egress reference integration. Coverage still excludes provider calls made by extensions outside Pi's registered provider path.

Pi extensions run with full host permissions. The extension is part of the trusted computing base, not a sandbox.

#### Hermes

Hermes supports MCP and plugins, and its tool-search bridge preserves the underlying tool name for pre-tool hooks, guardrails, approvals, and post-tool hooks. This makes a native Hermes plugin/tool guard the target path. Gateway event hooks are explicitly non-blocking and must remain observational.

The current Dina `HermesRunner` creates an `AIAgent` and injects Dina MCP configuration. That is a `task_runner + context_client` integration at Level G. It should not be described as Hermes runtime governance until a blocking native tool hook is wired and conformance-tested.

### 24.21 Generic custom loops

Most bespoke corporate agents have one function that dispatches a model-selected tool. Dina should make the secure path smaller than an unsafe direct call:

```python
result = await dina_tools.execute(
    agent=principal,
    session=session,
    name=tool_call.name,
    arguments=tool_call.arguments,
    executor=registered_tools[tool_call.name],
)
```

The SDK wrapper performs proposal, approval suspension, argument transformation, permit validation, execution, receipt capture, and result sanitization. The application registers tools once. It must not call `dina.validate()` and then separately call the tool, because that recreates the payload-binding race.

The generic SDK also provides `wrap_model_client()` for applications that want model-egress minimization. It is independent of `wrap_tools()` because some deployments intentionally use only one of those controls.

Equivalent TypeScript and Python packages MUST share protocol types and conformance vectors. They may have idiomatic APIs, but no language-specific policy logic.

### 24.22 Headless CLIs and skills

The existing `claude -p`, `codex exec`, `gemini -p`, and OpenClaw CLI runners are useful for delegated execution with almost no setup. They remain Level G because the prompt and installed skill tell the child to call Dina voluntarily.

Rules:

1. Call these integrations "task runners," not SDK adapters.
2. Never infer safety from a successful final summary.
3. Do not parse prose for structured service results.
4. Prefer the framework's native structured result mode where available.
5. A timeout while an effect may have occurred becomes `outcome_unknown`, not an ordinary failure.
6. Process termination is not proof that a remote effect was cancelled.

Claude Code's permission system can reduce local tool scope, but `--allowedTools Bash(dina:*)` only ensures access to Dina commands. It does not force every other effect through Dina and therefore does not raise the integration above Level G.

### 24.23 Framework support matrix and shipping order

| Framework/runtime             | Recommended first path                  | Native blocking seam                            | Initial ceiling        | Ship priority |
| ----------------------------- | --------------------------------------- | ----------------------------------------------- | ---------------------- | ------------- |
| Custom Python/TypeScript loop | Dina execution wrapper                  | Application tool dispatcher                     | I/E                    | P0            |
| Claude Agent SDK              | Direct Dina hooks                       | `PreToolUse` + defer/resume                     | I/E                    | P0            |
| AGT-supported frameworks      | AGT bridge                              | AGT native adapter                              | Adapter-dependent      | P0            |
| OpenAI Agents SDK             | Direct tool wrapper/guardrail           | Tool guardrails + approvals                     | I/E                    | P1            |
| LangChain/LangGraph           | Direct middleware                       | `wrap_tool_call` + interrupts                   | I                      | P1            |
| OpenClaw                      | Native Dina plugin plus existing runner | `before_tool_call`                              | I/E                    | P1            |
| Pi                            | Native Dina extension                   | blocking `tool_call`                            | I                      | P1            |
| Microsoft Agent Framework     | AGT bridge, direct fallback             | function-call middleware                        | I/E                    | P1            |
| Semantic Kernel               | AGT bridge, direct filter fallback      | function-invocation filter                      | I/E                    | P2            |
| AutoGen                       | AGT bridge/tool executor wrapper        | `ToolAgent`/Workbench execution                 | I                      | P2            |
| AWS Strands Agents            | direct plugin or AGT when available     | `BeforeToolCallEvent`                           | I                      | P2            |
| Claude Managed Agents         | Hosted event bridge                     | custom tool event + permission policy           | capability-dependent   | P2            |
| Google ADK                    | Plugin callbacks                        | `before_tool_callback`                          | I                      | P2            |
| PydanticAI                    | wrapper toolset                         | `WrapperToolset.call_tool` + deferred approvals | I                      | P2            |
| Hermes                        | native plugin; retain runner            | native pre-tool guard; MCP for context          | I target, G current    | P2            |
| CrewAI                        | AGT bridge                              | AGT/tool wrapper                                | adapter-dependent      | P3            |
| LlamaIndex                    | AGT bridge/tool wrapper                 | actual function tool/worker wrapper             | adapter-dependent      | P3            |
| smolagents                    | AGT/tool wrapper plus code sandbox      | tool wrapper; sandbox for `CodeAgent`           | I for tools, S target  | P3            |
| Generic MCP client            | Dina MCP server/proxy                   | no client-loop guarantee                        | G or E for proxy       | Always        |
| Remote A2A agent              | A2A gateway                             | workflow ingress/egress                         | per exposed capability | P2            |

P0 does not mean implementing ten adapters. It means proving the canonical contract with:

1. one generic SDK wrapper;
2. one rich native hook integration (Claude Agent SDK);
3. one reuse path (AGT bridge);
4. one existing end-user agent upgraded from runner-only to native interception later (OpenClaw).

### 24.24 Identity binding inside framework integrations

Framework-native IDs such as a Claude session ID, LangGraph thread ID, OpenClaw session key, Pi session file, CrewAI task ID, or ADK invocation ID are correlation identifiers. They are not authenticated Dina principals.

The smooth identity flow is:

```text
adapter starts
  -> discover existing enterprise/workload identity
  -> otherwise load the install's Dina key from OS keystore
  -> otherwise show one Dina pairing code
  -> prove possession to Dina
  -> bind credential to stable Principal
  -> create a framework run binding for each run/session
```

Supported choices:

- corporate service: OIDC workload identity, mTLS/SPIFFE, cloud service account, or a corporate gateway delegation;
- locally installed agent: install-scoped Dina key generated during pairing;
- agent with an existing DID/key: proof-of-possession binding without changing its identity;
- hosted runtime: verified vendor token plus tenant/install subject; the vendor-wide identity alone is insufficient;
- remote A2A agent: authenticated A2A transport identity mapped to a Dina principal.

The adapter stores only opaque principal/binding/session IDs in framework state. It never writes the Dina root secret, vault key, or owner credential into framework memory. Reinstallation, credential rotation, and identity unlinking preserve audit history but revoke future bindings.

### 24.25 Packaging and five-minute integration recipes

Recommended packages:

```text
@dina/agent-control              generic TypeScript wrapper and protocol types
dina-agent-control               generic Python wrapper and protocol types
@dina/adapter-claude-agent-sdk   Claude Agent SDK hooks
dina-adapter-openai-agents       OpenAI Agents SDK wrapper/guardrails
dina-adapter-langchain           LangChain middleware/LangGraph helpers
@dina/openclaw-plugin            OpenClaw typed plugin
@dina/pi-extension               Pi extension
dina-adapter-google-adk          Google ADK plugin
dina-agt-bridge                  AGT provider bridge
```

The packages contain translation only. Shared schemas are generated from `packages/protocol`; policy remains in Core.

Generic Python:

```python
from dina_agent_control import DinaControlPlane

dina = await DinaControlPlane.pair_or_load()
safe_tools = dina.wrap_tools(tools, principal=workload_identity)
agent = MyAgent(tools=safe_tools)
```

Claude Agent SDK:

```python
from dina_adapter_claude import dina_options

options = await dina_options(existing_options, principal=workload_identity)
async with ClaudeSDKClient(options=options) as client:
    await client.query(prompt)
```

LangChain:

```python
agent = create_agent(
    model=model,
    tools=tools,
    middleware=[DinaMiddleware(principal=workload_identity)],
    checkpointer=durable_checkpointer,
)
```

AGT composition:

```python
agt = existing_agt_runtime(...)
agt.register_provider(DinaProvider(pair_or_load=True))
```

These examples are target ergonomics, not permission shortcuts. Pairing still shows exact requested capabilities and creates explicit grants. A package MUST fail startup if it was configured to enforce a capability but cannot install its required native hook.

### 24.26 Framework onboarding diagnostics

After installation Dina runs a non-destructive diagnostic:

1. bind a fresh test principal/session;
2. execute an allowed read-only synthetic tool;
3. attempt a denied synthetic tool and prove its body did not run;
4. request an approval, suspend, approve on phone, and resume the same call ID;
5. load a dynamically registered tool and verify interception;
6. spawn a subagent where supported and verify attenuation;
7. simulate adapter timeout and verify fail-closed behavior;
8. emit a canary secret in tool arguments and verify that operational audit does not contain it;
9. if model-egress coverage is claimed, send canaries through retries, attachments, and a subagent and verify interception/minimization;
10. report direct credentials and uncovered tool/model paths;
11. store the framework/adapter version and conformance digest.

The UI then reports concrete coverage:

```text
Claude Agent SDK integration
Tool interception: all registered SDK tools
Subagents: inherited with attenuation
Phone approval resume: verified
Model egress: Dina-supplied context only; full payload not intercepted
Direct shell credentials: not verified
Overall: Intercepted for SDK tools; not credential-enforced
```

---

## 25. Failure and availability semantics

### 25.1 Fail-closed matrix

| Failure                                        | Read-only local action                              | Sensitive context                                              | External effect                                                                    |
| ---------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Policy provider unavailable                    | Baseline policy may decide if configured            | Deny unless another authoritative provider has complete policy | Deny before execution                                                              |
| Approval provider unavailable                  | Continue if no approval required                    | Deny/pending without active grant                              | Pending or expire                                                                  |
| Audit sink unavailable                         | Private durable outbox; do not leak data            | Same                                                           | Policy decides whether audit is mandatory; default fail closed for regulated route |
| Context broker unavailable                     | No context                                          | Fail request                                                   | Action may proceed only if decision does not depend on missing context             |
| Required framework hook absent or incompatible | Continue only outside the declared governed surface | Do not disclose protected context through that route           | Deny startup or disable the protected tool; never silently downgrade               |
| Framework hook times out                       | Follow declared adapter policy                      | Fail closed                                                    | Fail closed before the native call                                                 |
| Hosted event delivery lost                     | Recover from vendor session state                   | Do not redisclose without a valid binding                      | Keep suspended/unknown; reconcile by native tool-call ID                           |
| Required model-egress hook/gateway unavailable | Local-only reasoning may continue if configured     | Do not send protected payload                                  | Deny the model request; never bypass to a direct provider credential               |
| PEP unavailable                                | N/A                                                 | N/A                                                            | Queue only if safe and not expired                                                 |
| Network ambiguous after send                   | N/A                                                 | N/A                                                            | `outcome_unknown`, reconcile                                                       |

### 25.2 Provider health cannot silently change authority

Fallback from AGT to Dina policy is permitted only if the route explicitly declares the baseline policy semantically complete for that action. Otherwise provider failure denies. A lower-assurance fallback is never automatic.

### 25.3 Clock and expiry

Expiry checks use a trusted local clock with bounded skew handling for remote credentials. A grant expired locally is not revived because a remote caller reports a different time.

### 25.4 Duplicate delivery

All transport adapters assume at-least-once delivery. Internal creation is deduplicated by idempotency key; completion is guarded by claim ID and task state; external effects rely on the real provider's idempotency key where supported.

---

## 26. Privacy, audit, and receipts

### 26.1 Two audit audiences

1. **Owner-private history:** encrypted detail sufficient for the owner to understand what happened.
2. **Operational/compliance evidence:** redacted, low-cardinality facts suitable for AGT, OpenTelemetry, or enterprise export.

They share identifiers, not necessarily content.

### 26.2 Decision receipt

```ts
interface DecisionReceipt {
  decisionId: string;
  proposalId: string;
  proposalHash: string;
  executionId: string;
  idempotencyKeyRef: string;
  tenantId: string;
  requestingPrincipalId: string;
  agentPrincipalId?: string;
  actingForPrincipalId: string;
  organizationPrincipalId?: string;
  authorityDomainIds: string[];
  delegationChainId?: string;
  delegationChainHash: string;
  actionId: string;
  actionVersion: string;
  actionRegistryRevision: string;
  decision: 'allow' | 'deny' | 'pending';
  reasonCodes: string[];
  grantRefs: Array<{ grantId: string; grantVersionOrHash: string }>;
  policyRefs: Array<{ providerId: string; providerVersion: string; policyVersion: string }>;
  approvalRefs: Array<{
    requirementId: string;
    authorityDomainId: string;
    canonicalPayloadHash: string;
    viewProjectionHash: string;
  }>;
  parameterHash: string;
  schemaSnapshotHash: string;
  contextReceiptIds: string[];
  actionRouteId: string;
  actionRouteRevision: string;
  enforcementProviderId: string;
  credentialBrokerId?: string;
  frameworkEvidence?: {
    bindingId: string;
    frameworkId: string;
    frameworkVersion: string;
    adapterId: string;
    adapterVersion: string;
    conformanceDigest: string;
  };
  nonce: string;
  createdAt: number;
  expiresAt: number;
}
```

The receipt may reference encrypted durable snapshots rather than embedding their full content, but every reference is immutable, hash-bound, retained for the receipt lifetime, and resolvable by the authorized audit audience. A mutable lookup such as "current route for this action" is not evidence of the route used for an earlier decision. Interception tokens, execution permits, and execution receipts are created later and reference `decisionId`; the immutable decision receipt is never backfilled with later lifecycle state.

### 26.3 Data minimization

- Hashes are not a substitute for protecting low-entropy sensitive values.
- Context receipts avoid hashes of raw values where dictionary attacks are plausible; hash a salted canonical disclosure envelope or use opaque receipt IDs.
- Audit descriptions are structured and capped.
- External sinks receive allowlisted fields only.
- Approval screenshots and notification previews avoid unnecessary private details.

### 26.4 Owner-visible truth

The owner sees true internal outcomes, including auto-declines, policy failures, and uncertainty. Requesters may receive collapsed failures where relationship privacy requires it.

---

## 27. Threat model

### 27.1 Agent lies about identity

**Attack:** body claims a more privileged DID or acting-for owner.

**Control:** transport authentication, credential binding, gateway delegation proof, and body/transport identity checks.

### 27.2 Agent bypasses voluntary validation

**Attack:** agent ignores `dina validate` and calls a tool directly.

**Control:** display Level G honestly; move sensitive credentials behind an intercepted or credential-enforced PEP.

### 27.3 Confused deputy

**Attack:** authenticated gateway submits another principal's identity or a service URI redirects authority.

**Control:** explicit acting-for delegation, audience/resource binding, authenticated caller checks, and immutable target snapshots.

### 27.4 Grant replay or widening

**Attack:** use a grant in another session, task, persona, tenant, recipient, or action.

**Control:** typed resource binding, session/task constraints, expiry, tenant scoping, attenuation checks, and active-grant lookup.

### 27.5 Approval bait-and-switch

**Attack:** display safe parameters, then execute modified parameters.

**Control:** approval and execution bind the same canonical payload hash and transform chain.

### 27.6 Duplicate external effect

**Attack/failure:** lease recovery or dual PEPs send twice.

**Control:** single enforcement owner, execution ID, provider idempotency key, claim token CAS, no unsafe auto-retry.

### 27.7 Data exfiltration through policy or telemetry

**Attack:** raw context enters AGT annotations, logs, traces, or framework callbacks.

**Control:** label-only PIP by default, allowlisted telemetry schema, local minimization, and conformance tests with canary secrets.

### 27.8 Malicious tool result or prompt injection

**Attack:** MCP/A2A/plugin output manipulates the reasoning loop.

**Control:** schema validation, provenance labels, mandatory sanitization, policy intervention after tool result, and no automatic authority from text.

### 27.9 Compromised adapter

**Attack:** framework adapter fabricates decisions or suppresses denials.

**Control:** adapters cannot mint grants; signed/verified interception tokens and execution permits; the final executor or credential PEP validates the relevant artifact directly; conformance tests; minimal adapter privileges.

### 27.10 Compromised policy provider

**Attack:** provider returns allow for everything or leaks snapshots.

**Control:** Core hard invariants, minimum policy floor, provider isolation, data minimization, provider version receipts, and owner-visible configuration.

### 27.11 Identity rotation takeover

**Attack:** attacker links a new credential to an existing principal.

**Control:** proof of possession, owner/admin authorization, old-binding notification, recovery delay for high-authority principals, and revocation history.

### 27.12 Cross-tenant access

**Attack:** public task/grant ID is used in another tenant.

**Control:** tenant-scoped repositories and authorization before object existence is disclosed.

### 27.13 Framework drift or bypass

**Attack/failure:** a framework upgrade changes hook semantics, a dynamically registered tool bypasses the adapter, a subagent uses a separate executor, or application code invokes a tool outside the governed runtime.

**Control:** pinned support ranges, startup compatibility checks, dynamic-tool and subagent probes, fail-closed installation for protected tools, periodic conformance digest, and capability-wide assurance that includes known escape paths.

### 27.14 Hosted event replay, loss, or reordering

**Attack/failure:** a hosted runtime retries a custom tool event, delivers approval completion twice, loses a suspension event, or resumes an older tool call after the owner approved a newer payload.

**Control:** tenant/run/tool-call idempotency key, canonical parameter hash, durable resume token, expiry, claim/decision CAS, and reconciliation against the hosted runtime before terminal state.

### 27.15 Model-egress bypass

**Attack/failure:** an adapter intercepts tools but the agent sends vault-derived, file-derived, or tool-derived sensitive content directly to an external model through an uncovered model client.

**Control:** minimize every Dina context response, report model-egress separately from tool assurance, intercept the complete model request where supported, remove direct provider credentials for Level E, and use a model gateway when the framework cannot expose the full payload.

### 27.16 Caller-defined action semantics

**Attack:** an agent labels a payment as a read, supplies a permissive result schema, or chooses a weaker route/PEP.

**Control:** Core resolves class, target/parameter/result schemas, retry policy, authority domains, safety floor, and route only from a pinned immutable action-registry revision. Caller metadata can narrow a request or provide classification evidence but cannot define authority.

### 27.17 False context-use declaration

**Attack:** an agent claims a benign purpose, recipient, retention period, or destination tool to obtain context and then forwards it elsewhere.

**Control:** requested intent remains untrusted; Core derives authorized purpose and verified sink from grants, task/action route, and selected PEP. No-forward/no-store are labeled obligations at cooperative assurance levels and enforced only where the runtime or credential boundary can structurally control them.

### 27.18 Descendant grant survives ancestor revocation

**Attack/failure:** a delegated child grant remains apparently active after its parent or another ancestor expires or is revoked.

**Control:** every use validates the complete bounded, acyclic ancestry; an inactive ancestor disables all descendants regardless of cached child state.

---

## 28. Conformance and testing

### 28.1 Control-plane conformance kit

The existing adapter-conformance pattern SHOULD expand into a zero-policy, framework-neutral control-plane suite.

Mandatory cases:

1. transport identity cannot be overridden by body identity;
2. external identity binding requires proof;
3. expired/revoked grants deny;
4. grants do not cross session, task, persona, service, recipient, or tenant;
5. external allow cannot override Dina deny;
6. owner approval cannot override corporate hard deny;
7. approval payload hash equals execution payload hash;
8. only one PEP executes;
9. duplicate task delivery creates one logical task;
10. stale claim cannot complete;
11. claimed effectful timeout becomes `outcome_unknown` when appropriate;
12. context response is minimized and receipt-linked;
13. policy/audit telemetry contains no canary secret;
14. MCP tokens are audience/resource bound and not passed through;
15. A2A Agent Card does not authorize invocation;
16. AGT unavailable follows configured fail-closed behavior;
17. identity rotation preserves principal but invalidates revoked binding;
18. mobile and Home Node produce identical domain decisions;
19. relationship refusal remains requester-indistinguishable;
20. plugin caller never inherits device or agent routes;
21. a denied synthetic framework tool proves its executor body was never entered;
22. dynamically registered tools are intercepted or explicitly reported uncovered;
23. subagent authority is attenuated or separately bound, never silently widened;
24. adapter timeout follows declared fail-closed semantics;
25. approval resumes the same native tool-call ID and canonical parameter hash;
26. direct shell/network/credential escape paths lower the reported assurance level;
27. observational events are never accepted as proof of interception;
28. installing both AGT and Dina does not create two PEPs for one effect;
29. hosted-runtime event replay produces one logical proposal and one result;
30. runner timeout after possible external execution becomes `outcome_unknown`;
31. tool interception is not reported as model-egress interception;
32. complete model payload tests cover retries, attachments, and subagents where claimed;
33. a direct model-client escape path lowers model-egress assurance;
34. revoking or expiring any ancestor immediately disables every descendant grant;
35. cyclic, cross-tenant, over-depth, or non-attenuated delegation chains are rejected;
36. caller-supplied action class, schema, route, and assurance metadata cannot alter the canonical registry decision;
37. `message.send`, effectful `task.submit`, service invocation, and plugin actions cannot bypass the action lifecycle;
38. the same idempotency key plus the same canonical request returns one logical result, while the same key plus a different request returns `idempotency_conflict`;
39. a later or parallel hook cannot mutate the payload after Dina's approved payload hash; if the framework cannot prove this, effective assurance is lowered;
40. consuming an interception token without entering the executor does not claim that an external effect occurred, and a Level E permit is never consumed in a pre-tool callback;
41. multiple approval authorities receive only their authorized projections while every decision remains bound to the same canonical payload hash;
42. hosted approval suspension, process restart, duplicate callback, and resume preserve one native tool-call ID and one logical execution;
43. manifest claims cannot raise assurance above current conformance, topology, credential-placement, health, and escape-path evidence;
44. agent-supplied purpose, recipient, tool, and retention hints do not become trusted context-use facts;
45. context disclosure references cannot be correlated across unrelated sessions without an explicit grant;
46. caller-supplied actor, proposal, execution, request, decision, task, or receipt IDs cannot select or overwrite Core-owned objects.

### 28.2 Provider certification

Report assurance by capability:

```text
Dina-compatible
Identity: proof-of-possession
Policy: deterministic
Interception: complete for declared tools
Final payload binding: verified for wrapped tools
Credential enforcement: email only
Model egress: partial; direct client uncovered
Context minimization: passed
Approval binding: passed
Evidence valid until: 2026-08-01
```

Avoid one misleading global "certified safe" badge.

### 28.3 Differential tests

Run identical policy snapshots through Dina baseline and AGT-backed providers where semantic parity is claimed. Differences must be reviewed, not automatically normalized.

### 28.4 Fault injection

Test crashes at every seam:

- before and after approval persistence;
- before and after grant creation;
- after external send but before receipt;
- before claim CAS;
- during lease expiry;
- during provider switch;
- while mobile locks;
- while tenant identity rotates;
- while AGT or audit is unavailable;
- after an interception token is issued but before the final executor begins;
- after a Level E permit is claimed but before the provider accepts the request;
- after hosted approval state and resume token are persisted but before acknowledgement;
- after idempotency reservation but before logical object creation commits;
- during parent-grant revocation while a descendant decision is pending.

---

## 29. Relationship to existing Dina documents

### 29.1 This document is the umbrella

This document owns cross-system identity, authority, provider composition, enforcement levels, standards interoperability, and product boundary.

### 29.2 `DINA_AGENT_KERNEL.md`

Retains ownership of a single reasoning turn, provider-specific message handling, tool-loop integrity, budgets, cancellation, and mandatory result sanitization.

It MUST consume control-plane decisions; it must not invent grants or execute high-impact actions outside the action lifecycle.

### 29.3 `DINA_WORKFLOW_CONTROL_PLANE.md`

Retains detailed durable workflow patterns. Its "not implemented" status and old source references are stale relative to the TypeScript `workflow_tasks` implementation and SHOULD be updated.

This document supersedes it only for provider composition, actor identity, grant snapshots, PEP selection, and protocol mappings.

### 29.4 `DINA_DELEGATION_CONTRACT.md`

Its security goals remain useful, but a bespoke universal external wire contract should not compete with A2A. The contract SHOULD become:

- the native MsgBox runner protocol for Dina-specific paired runners; and/or
- an internal canonical envelope mapped to A2A externally.

It SHOULD NOT be marketed as the universal agent interoperability protocol.

### 29.5 `PLUGIN_ARCHITECTURE.md`

Remains authoritative for plugin identity, releases, install consent, interpreted runtime, runner lanes, plugin scope hashes, and plugin threat model. Plugins consume this control plane but remain distinct from agents.

### 29.6 Contact services and service grants

`CONTACT_SERVICES_ARCHITECTURE.md` and the current service-grant repository remain authoritative for relationship service behavior. Their explicit-grant and asymmetric-visibility invariants are adopted here.

---

## 30. Current implementation gap and build-versus-reuse assessment

### 30.1 Keep and promote

| Current capability                                                       | Assessment                                                 | Target action                                                                                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `workflow_tasks`, events, claims, leases, idempotency, `outcome_unknown` | Strong foundation                                          | Keep; add actor, decision, PEP, and authority snapshots                                                    |
| Transport-authenticated DID binding                                      | Correct invariant                                          | Keep; generalize DID lookup into credential bindings                                                       |
| `agent_persona_grants`                                                   | Correct explicit session/persona authority for gated tiers | Keep semantics; expose through common GrantService and extend pairing grants to selected Standard personas |
| `service_grants`                                                         | Correct selector plus authenticated-caller authorization   | Keep semantics; expose through common GrantService                                                         |
| Contact grant policy                                                     | Correct policy-versus-authorization separation             | Keep; preserve requester failure collapse                                                                  |
| Persona vault encryption and repositories                                | Core differentiator                                        | Keep; put ContextBroker in front of agent access                                                           |
| Service schemas and Response Bridge validation                           | Correct frozen-contract boundary                           | Keep and reuse for external agents                                                                         |
| Plugin task envelope, claim token, retry, and pinned scope work          | Strong bounded-execution model                             | Keep separate from agents; reuse common receipts and providers                                             |
| Mobile approval UI and workflow approval tasks                           | Correct product surface                                    | Consolidate on durable approval objects and payload binding                                                |
| MsgBox paired runner path                                                | Useful native transport                                    | Keep as native sidecar/runner binding; add standards gateways                                              |
| CLI sessions, ask, remember, scrub, validate                             | Valuable compatibility surface                             | Keep; map onto new typed contracts                                                                         |

### 30.2 Rewrite or generalize

| Current limitation                                                             | Why it matters                                                                                                                         | Required change                                                                                                                              |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Caller identity is mostly a DID plus caller type                               | Cannot represent OIDC, SPIFFE, multiple credentials, owner/org chain, or rotation cleanly                                              | Introduce principal registry and credential bindings                                                                                         |
| Legacy forwarded `X-Agent-DID` can represent an agent through a service        | A header assertion is not a complete public delegation proof                                                                           | Require verifiable gateway delegation in the target contract                                                                                 |
| Two caller-type unions and route mapping can drift                             | A new role may inherit a wider route surface                                                                                           | Centralize role/caller/route policy and retain denial tests                                                                                  |
| Persona grant `scope` is informational and persona-wide per session            | Correct for current UX, too broad for some corporate/context uses                                                                      | Preserve current mode; add optional task/query/recipient constrained grant types                                                             |
| Paired agents can read Standard personas without a durable grant               | Pairing becomes over-broad when arbitrary corporate/framework agents connect                                                           | Materialize owner-selected initial context grants at pairing; reserve baseline policy for explicit first-party principals                    |
| `dina validate` is voluntary                                                   | Cannot honestly promise deterministic enforcement                                                                                      | Add action routes, PEP selection, and execution permits                                                                                      |
| Approval and execution are not universally bound to one canonical payload hash | Creates bait-and-switch and stale-approval risk                                                                                        | Add proposal/decision/permit receipts and revalidation                                                                                       |
| Approval state exists in more than one abstraction                             | Risks UI/lifecycle disagreement                                                                                                        | Make durable workflow approval the authoritative object; adapt convenience managers                                                          |
| No provider composition registry                                               | AGT or corporate systems require invasive branching                                                                                    | Add provider interfaces and deterministic composer                                                                                           |
| No tenant/authority-domain dimension across all control-plane objects          | Blocks safe enterprise and mixed personal/corporate use                                                                                | Add tenant and authority-domain scoping before enterprise exposure                                                                           |
| Delegation contract is bespoke and marked not implemented as written           | Risks competing with A2A and drifting from shipping runners                                                                            | Keep native runner envelope; use A2A externally                                                                                              |
| Framework safety instructions live partly in skills/prompts                    | Cooperative agents can bypass them                                                                                                     | Preserve instructions for UX; move guarantees to PEP/credential boundary                                                                     |
| Audit records are not one linked receipt graph                                 | Hard to correlate policy, approval, context, and external result                                                                       | Add shared decision/execution/context receipt IDs                                                                                            |
| `AgentRunner` exposes only running/completed/failed text results               | Cannot represent `outcome_unknown`, structured artifacts, claim-bound completion, or partial cancellation                              | Version the runner result envelope; add structured result, execution receipt, reconciliation state, and epistemic outcome                    |
| Python agent claim/heartbeat/complete/fail calls omit `claim_id`               | Core requires claim-token CAS for plugins but permits legacy agents without it; a stale agent lease can still submit a terminal result | Carry the minted claim ID through daemon, MCP, callback, heartbeat, reconciliation, complete, and fail; require it for all claimed executors |
| Service execution asks an LLM to call one MCP tool and copy JSON "verbatim"    | Prompt compliance is not a reliable typed transport; summaries or extra prose break schema validation                                  | Bind the tool in the task envelope and collect its structured result outside model prose                                                     |
| `OpenClawRunner` submits by hook and has no cancellation                       | A local failed/cancelled state can disagree with an external effect                                                                    | Keep as detached runner; use claim-bound callback/reconciliation and preserve `outcome_unknown`                                              |
| OpenClaw callback and reconciliation are runner-specific authority seams       | Parallel completion paths can drift from workflow claim authorization                                                                  | Authenticate completion as the paired agent and require active task/claim/execution binding                                                  |
| `HermesRunner` injects only Dina MCP configuration                             | Gives Hermes cooperative Dina tools but does not intercept its built-in tools                                                          | Retain as Level G runner; add a separate native Hermes framework plugin for interception                                                     |
| `HermesRunner` temporarily mutates process-global `HERMES_CONFIG`              | Future concurrent tasks can cross-contaminate configuration                                                                            | Pass per-agent configuration through a library API or isolate each Hermes run in its own process                                             |
| Headless runners rely on prompt instructions and final stdout                  | Child may bypass validation; timeout/final text cannot prove effect outcome                                                            | Report Level G; use native SDK adapters for enforcement and typed task results                                                               |
| Framework adapter conformance does not exist                                   | Brand-level compatibility can hide uncovered dynamic tools, subagents, or shell paths                                                  | Add framework adapter manifests, escape-path probes, and per-capability assurance reports                                                    |

### 30.3 Reuse externally

| Need                                                             | Preferred reuse                                 |
| ---------------------------------------------------------------- | ----------------------------------------------- |
| Generic deterministic policy, Rego/Cedar, lifecycle intervention | AGT ACS where selected; Dina baseline otherwise |
| Existing framework interception                                  | AGT adapters when a framework is supported      |
| Execution sandbox, kill switch, agent SRE                        | AGT or enterprise runtime provider              |
| MCP poisoning/drift analysis                                     | AGT MCP gateway or another dedicated provider   |
| General external agent protocol                                  | A2A                                             |
| Web-wide capability discovery                                    | ARD                                             |
| Workload identity                                                | OIDC/Entra, SPIFFE/mTLS, DID, or Dina pairing   |

### 30.4 Do not rewrite merely for conceptual purity

The following rewrites are rejected unless implementation evidence proves a concrete safety or operability benefit:

- replacing specialized grant tables with one generic JSON table;
- replacing the workflow repository with A2A task storage;
- replacing Dina D2D with A2A internally;
- putting AGT types into Core domain entities;
- moving policy into mobile/web clients;
- merging agents and plugins;
- replacing all current DID identities before credential binding exists;
- rewriting mobile and Home Node separately.

### 30.5 Required rewrite order

The safe dependency order is:

```text
golden current-behavior vectors
  -> principal/credential abstraction
  -> provider interfaces using current implementations
  -> immutable action registry and route revisions
  -> typed proposal/decision/approval/idempotency receipts
  -> interception tokens and credential-PEP execution permits
  -> adapter and standards bridges
  -> optional storage convergence
```

Doing storage convergence or external protocol work before the authority kernel would create new wire surfaces around an unstable authorization model.

### 30.6 Current implementation anchors

These are the principal shipping or in-progress seams against which migration parity should be tested:

| Concern                         | Current source                                                         |
| ------------------------------- | ---------------------------------------------------------------------- |
| Agent persona gate              | `packages/core/src/agent/access.ts`                                    |
| Durable persona grants          | `packages/core/src/agent/grant_repository.ts`                          |
| Caller resolution               | `packages/core/src/auth/caller_type.ts`                                |
| Route authorization             | `packages/core/src/auth/authz.ts`                                      |
| Request authentication          | `packages/core/src/auth/middleware.ts`                                 |
| Envelope/body identity binding  | `packages/core/src/rpc/identity_binding.ts`                            |
| Pairing proof                   | `apps/home-node-lite/core-server/src/auth/pairing_identity_binding.ts` |
| Device and role registry        | `packages/core/src/devices/registry.ts`                                |
| Workflow model                  | `packages/core/src/workflow/domain.ts`                                 |
| Workflow persistence and claims | `packages/core/src/workflow/repository.ts`                             |
| Plugin authority envelope       | `packages/core/src/workflow/plugin_envelope.ts`                        |
| Service grants                  | `packages/core/src/service/service_grant_repository.ts`                |
| Contact grant policy            | `packages/core/src/service/contact_grant_policy.ts`                    |
| Agent CLI and sidecar behavior  | `cli/src/dina_cli/`                                                    |
| Shared protocol types           | `packages/protocol/src/`                                               |
| Cross-platform storage contract | `packages/adapter-conformance/`                                        |

Framework integration anchors:

| Concern                                  | Current source                                                | Architectural classification                                        |
| ---------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- |
| Runner protocol and prompt envelope      | `cli/src/dina_cli/agent_runner.py`                            | `task_runner`, not framework governance                             |
| Runner selection                         | `cli/src/dina_cli/runner_registry.py`                         | Execution registry only                                             |
| Durable task claim/run/reconcile loop    | `cli/src/dina_cli/agent_daemon.py`                            | Workflow execution bridge                                           |
| OpenClaw HTTP hook runner                | `cli/src/dina_cli/openclaw_runner.py`                         | Detached `task_runner`; current Level G for the agent's other tools |
| Hermes library runner                    | `cli/src/dina_cli/hermes_runner.py`                           | Inline `task_runner + context_client`; current Level G              |
| Claude/Codex/Gemini/OpenClaw CLI runners | `cli/src/dina_cli/headless_cli_runner.py`                     | Cooperative headless `task_runner`; current Level G                 |
| Dina MCP tools                           | `cli/src/dina_cli/mcp_server.py`                              | `context_client` surface; voluntary unless used behind a PEP        |
| Installed skill/AGENTS instructions      | `cli/src/dina_cli/skill.py`, `cli/src/dina_cli/skill_assets/` | Cooperative guidance only                                           |

### 30.7 Current implementation verdict

The existing code proves that Dina can pair agents, create scoped sessions, gate context, delegate durable tasks, and receive results. It does **not** yet prove the universal control-plane claim because the dominant integrations are cooperative runners:

- a child agent is instructed to call `dina validate`;
- a Hermes agent is given Dina MCP tools;
- OpenClaw receives a detached task through a hook;
- the daemon infers completion from MCP task state or runner output.

These are valuable compatibility paths and should remain. The architectural next step is not to replace them, but to add an independent `AgentFrameworkAdapter` layer and upgrade one integration at a time from G to I/E.

No current runner name should be used as evidence of enforcement. The admin UI should display both dimensions, for example:

```text
Runtime: OpenClaw
Task execution: connected
Tool interception: not installed
Credential enforcement: none
Context grants: active for this session
```

Uncommitted plugin P0 work is relevant evidence but must not be treated as a stable public contract until committed, reviewed, and covered by migration/conformance vectors.

## 31. Migration from current code

### Phase 0: Freeze boundaries before rewriting

1. Add this document to the architecture suite.
2. Mark existing documents with ownership and supersession notes.
3. Inventory every current agent-facing route and its authenticated principal source.
4. Define golden vectors for current persona grants, service grants, workflow claims, and plugin claims.
5. Inventory every effectful facade and prove which current path actually executes the effect.
6. Define the initial canonical action catalog and versioning rules before freezing proposal schemas.
7. Do not change persistence until parity tests exist.

### Phase 1: Principal and provider kernel

1. Add `Principal`, `CredentialBinding`, ordered delegation chains, and `ActorContext` to shared protocol/Core.
2. Adapt current paired DIDs into principal bindings without changing behavior.
3. Add provider registries for identity, policy, approval, enforcement, and audit.
4. Implement baseline Dina providers using current code.

### Phase 2: Typed action and receipt contract

1. Implement the immutable action registry so callers cannot define class, schemas, route, retry, or safety semantics.
2. Add explicit versioned `ActionRoute` with a minimum assurance requirement and computed effective assurance.
3. Replace free-form validation as the architectural core with typed `ActionProposal`.
4. Bind approval requirements and viewer-specific projections to one canonical transformed payload hash.
5. Add durable idempotency, decision, context, interception-token, execution-permit, and execution-receipt state.
6. Preserve CLI compatibility by mapping `dina validate` to `action.propose`.
7. Route every effectful convenience API through the action lifecycle.
8. Add one credential-enforced action as the reference implementation.

### Phase 3: Grant service convergence

1. Put current persona and service grant repositories behind `GrantService`.
2. Add typed delegation/tool/context grants.
3. Implement attenuation, cycle/depth checks, complete ancestry validation, and common revocation.
4. Consider physical table convergence only after semantic parity and migration tests.

### Phase 4: Generic SDK, sidecar, and adapter kernel

1. Publish TypeScript and Python SDKs for the northbound API.
2. Implement one safe `execute(tool, arguments, executor)` wrapper so custom loops cannot separate validation from execution.
3. Make the sidecar use current pairing and MsgBox transport.
4. Define `AgentFrameworkAdapter`, lifecycle envelopes, manifests, and shared conformance vectors.
5. Preserve `AgentRunner` as a separate task-execution protocol.
6. Version runner results to include structured artifacts, `outcome_unknown`, execution receipts, and cancellation/reconciliation facts.
7. Require claim-token CAS for paired agents as well as plugins and propagate the token through every runner lifecycle path.
8. Remove LLM prose as the structured result transport for service-query tasks.
9. Persist framework run bindings, hosted resume tokens/events, adapter evidence, and reconciliation state before claiming durable resume.
10. Keep Level I interception tokens separate from Level E execution permits in SDK and wire types.

### Phase 5: Reference framework integrations

1. Implement Claude Agent SDK `PreToolUse`/defer/resume as a direct reference adapter, but claim exact-payload Level I only if final-executor or hook-composition conformance passes.
2. Implement an OpenClaw typed plugin hook while retaining the existing HTTP-hook runner.
3. Implement the Pi extension after the same conformance vectors pass.
4. Keep Hermes MCP/library execution at Level G until a blocking native plugin is implemented.
5. Add framework onboarding diagnostics and publish per-capability assurance.
6. Prove dynamic-tool and subagent coverage before claiming Level I.

### Phase 6: AGT bridge

1. Implement Dina approval backend for AGT escalation.
2. Implement label-only policy information provider.
3. Implement AGT as a Dina policy provider.
4. Link redacted AGT evidence to encrypted Dina receipts.
5. Differential-test Dina and AGT composition.
6. Reuse AGT framework adapters rather than installing duplicate Dina interceptors.

### Phase 7: MCP enforcement

1. Expose the narrow Dina MCP server.
2. Add MCP proxy/credential broker for selected tools.
3. Enforce token audience and resource binding.
4. Integrate optional AGT MCP security analysis.

### Phase 8: A2A gateway

1. Publish selected capabilities through an Agent Card.
2. Map A2A tasks and artifacts to workflow tasks.
3. Support streaming/status/cancellation without weakening internal claims.
4. Add optional Dina receipt extension.

### Phase 9: Enterprise federation

1. OIDC/Entra verifier.
2. SPIFFE/mTLS verifier.
3. Tenant-scoped repositories and admin authority.
4. Corporate policy upper bounds and dual approvals.
5. Redacted audit export and deployment guidance.

### Phase 10: Network integration

1. Allow connected agents to consume Services safely.
2. Allow agents to back Tier 2/Tier 3 provider capabilities.
3. Attach PeerLens evidence to stable principals and releases.
4. Bridge suitable A2A agents into Dina service discovery without treating discovery as authority.

---

## 32. Product surface and positioning

### 32.1 Developer positioning

> Add Dina to any agent to get private user context, durable consent, phone approvals, relationship-aware delegation, and access to an open service network.

### 32.2 Consumer positioning

The consumer does not need to understand "control plane."

> Your AI. Your authority. Your network.

The application explains concrete outcomes:

- connect an agent;
- choose what it can know;
- approve sensitive actions;
- see what happened;
- let it work with people and services you trust.

### 32.3 Enterprise positioning

> Keep your existing identity, agent framework, and governance system. Add owner-controlled context and approvals where human authority is required.

### 32.4 Adoption rule

Dina must provide immediate value without Services, PeerLens, D2D contacts, or another Dina user. Network facilities are the expansion path, not the activation prerequisite.

### 32.5 How Dina can become a default

"Default" cannot come from owning another proprietary protocol. It requires:

1. **Lowest-friction owner authority:** pairing, first context query, and first phone approval in less than five minutes.
2. **No identity tax:** existing identities work; Dina identity is the easy fallback.
3. **No framework tax:** AGT adapters, thin first-party adapters, MCP, and A2A avoid framework rewrites.
4. **Standalone value:** Dina remains useful with one owner and one agent.
5. **Composable adoption:** a company can add only context or approvals without replacing its governance stack.
6. **Honest assurance:** developers can see exactly which actions are observed, gated, intercepted, or credential-enforced.
7. **Open contracts and conformance:** external implementations can prove compatibility without trusting Dina marketing.
8. **Network upside:** once connected, the same agent can reach user-published services, relationships, and PeerLens evidence.
9. **Local-first deployment:** developers and privacy-sensitive users can run the authority domain without handing personal context to a central SaaS.
10. **A clear wedge:** "your existing agent, safely connected to your context and phone" precedes the broader platform claim.

The architecture supports universal compatibility. Product messaging should claim universal control only after multiple independent frameworks and identity systems pass conformance in real deployments.

---

## 33. Architecture decisions

The following decisions are selected, not open:

1. AGT is optional and supported through providers.
2. Dina standalone remains complete.
3. External identities are bound, not replaced.
4. Agent identity and acting-for identity stay separate.
5. Explicit grants remain authorization facts.
6. One effect has one PEP.
7. Deny and constraint intersection are deterministic.
8. Context is queried, minimized, labeled, and receipt-bound.
9. A2A is the general external agent protocol; Dina D2D remains native.
10. MCP is the tool protocol; Dina may proxy or broker it.
11. Plugins remain bounded capabilities, not agents.
12. Mobile is the first client and owner authority console.
13. Existing workflow tasks remain the durable lifecycle foundation.
14. Assurance is reported per capability.
15. Core security invariants cannot be replaced by providers.
16. Task runners and framework governance adapters are separate contracts.
17. AGT and Dina never install independent blocking owners for the same effect.
18. Action semantics come from an immutable registry, never from caller metadata.
19. Every effectful facade enters the same action lifecycle.
20. Level I interception tokens and Level E execution permits are different artifacts.
21. Grant ancestry remains valid at use time; ancestor revocation disables descendants.
22. Approval authorities may see different projections bound to one canonical payload.
23. Effective assurance is computed from evidence and topology, not asserted by configuration or a manifest.

## 34. Open decisions requiring implementation evidence

1. Exact canonical serialization and signing format for decision receipts.
2. Whether unified grants use one envelope table plus extension tables or repository-level unification only.
3. The first credential-enforced external action.
4. The local sidecar transport: Unix socket, loopback HTTP, or both.
5. Exact AGT approval-backend API and version-support policy.
6. Which A2A binding ships first: HTTP+JSON, JSON-RPC, or both.
7. Tenant and principal recovery ceremony for enterprise deployments.
8. Retention periods for owner-private receipts and redacted compliance evidence.
9. Hardware-backed agent-key support by platform.
10. How corporate administration interacts with a user's sovereign authority without claiming access to personal vault plaintext.
11. Initial support-version windows and deprecation policy for each framework adapter.
12. Whether framework adapters ship in the main repository, separate packages, or a versioned adapter monorepo.
13. Canonical serialization and signature format for interception tokens and execution permits.
14. Maximum delegation depth and ancestry-cache strategy.
15. Conformance-result validity windows and evidence revocation policy.
16. Per-operation idempotency retention periods and external-provider key mappings.

No open decision changes the selected component boundaries or invariants.

---

## 35. External references

- [Microsoft Agent Governance Toolkit announcement](https://opensource.microsoft.com/blog/2026/04/02/introducing-the-agent-governance-toolkit-open-source-runtime-security-for-ai-agents/)
- [Microsoft Agent Governance Toolkit repository](https://github.com/microsoft/agent-governance-toolkit)
- [AGT Agent Control Specification](https://github.com/microsoft/agent-governance-toolkit/blob/main/policy-engine/README.md)
- [AGT Framework Adapter Contract](https://github.com/microsoft/agent-governance-toolkit/blob/main/docs/specs/FRAMEWORK-ADAPTER-CONTRACT-1.0.md)
- [Claude Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- [Claude Managed Agents permission policies](https://platform.claude.com/docs/en/managed-agents/permission-policies)
- [OpenAI Agents SDK guardrails](https://openai.github.io/openai-agents-python/guardrails/)
- [OpenAI Agents SDK human-in-the-loop approvals](https://openai.github.io/openai-agents-python/human_in_the_loop/)
- [LangChain custom middleware](https://docs.langchain.com/oss/python/langchain/middleware/custom)
- [LangChain human-in-the-loop middleware](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)
- [Microsoft Agent Framework middleware](https://learn.microsoft.com/en-us/agent-framework/agents/middleware/)
- [Semantic Kernel function-invocation filters](https://learn.microsoft.com/en-us/semantic-kernel/concepts/enterprise-readiness/filters)
- [AutoGen ToolAgent](https://microsoft.github.io/autogen/stable/reference/python/autogen_core.tool_agent.html)
- [AWS Strands Agents hooks](https://strandsagents.com/docs/user-guide/concepts/agents/hooks/)
- [Hugging Face smolagents agents](https://huggingface.co/docs/smolagents/reference/agents)
- [Google ADK callback types](https://adk.dev/callbacks/types-of-callbacks/)
- [Google ADK plugins](https://adk.dev/plugins/)
- [PydanticAI toolsets and `WrapperToolset`](https://pydantic.dev/docs/ai/tools-toolsets/toolsets/)
- [PydanticAI deferred tools and approvals](https://pydantic.dev/docs/ai/tools-toolsets/deferred-tools/)
- [CrewAI event listeners](https://docs.crewai.com/en/concepts/event-listener)
- [LlamaIndex observability callbacks](https://developers.llamaindex.ai/python/framework/module_guides/observability/callbacks/)
- [OpenClaw typed plugin hooks](https://docs.openclaw.ai/plugins/hooks)
- [Pi extension lifecycle and tool interception](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md)
- [Hermes Agent plugin development](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins)
- [Hermes Agent tool search and hook preservation](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-search)
- [A2A protocol specification](https://a2a-protocol.org/latest/specification/)
- [Google Agentic Resource Discovery announcement and specification links](https://developers.googleblog.com/announcing-the-agentic-resource-discovery-specification/)
- [Model Context Protocol authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [SPIFFE overview](https://spiffe.io/docs/latest/spiffe-about/overview/)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)

---

**Document version:** 1.2-draft

**Last reviewed:** 2026-07-12

**Review basis:** current Dina TypeScript architecture and Python runner/MCP implementation; current uncommitted plugin P0 work; official framework contracts for Claude Agent SDK and Managed Agents, OpenAI Agents SDK, LangChain/LangGraph, Microsoft Agent Framework, Semantic Kernel, AutoGen, AWS Strands Agents, Google ADK, PydanticAI, CrewAI, LlamaIndex, smolagents, OpenClaw, Pi, and Hermes; Microsoft AGT public-preview architecture and specifications; A2A v1.0; MCP authorization; OIDC; and SPIFFE.
