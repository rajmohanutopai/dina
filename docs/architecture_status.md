# Architecture Phase Status

Date: 2026-03-15
Canonical architecture document: `ARCHITECTURE.md`

This file is a simplified review sheet for the architecture.
It is based on the architecture document itself and on the strongest reading of Dina's product thesis.

`Phase 2+` here intentionally folds together the longer-horizon material that the architecture currently labels as `Phase 3`, `Future Protocol`, or `Deferred`.

---

## Core Reading

- **Phase 1** should stand on its own as a sovereign private core with a working Trust Network, multi-persona security, and active data ingestion.
- **Phase 2** should deepen density, recovery, verification, and routing.
- **Phase 2+** should expand Dina into a mature trust and open-economy layer.

The cleanest version of Dina remains:

- Home Node private core: Go core + Python brain + encrypted multi-persona SQLite vaults
- External work: delegated to agents via MCP
- Public trust layer in v1: Trust Network via PDS/AppView
- Active ingestion: customer data is classified and fed into persona vaults
- Optional profiles: local LLM, recovery, future economy

---

## Phase 1

Phase 1 should be the smallest version of Dina that already feels complete and valuable without requiring large network effects. It should still ship with a working Trust Network and AppView, multi-persona security, active human-connection enforcement, and initial customer-data hydration into persona vaults.

| Area | Expected In Phase 1 | Why It Matters |
|---|---|---|
| **Core product shape** | Dina is already useful as a private Home Node core with multi-persona memory, identity, nudges, safety, delegation, trust, and approval-gated action handoff | This is the strongest cold-start story |
| **Core architecture** | `dina-core` + `dina-brain` + encrypted SQLite vault are the center of gravity | This is the simple architecture the document should keep defending |
| **Identity and auth** | Home Node holds root identity; paired devices use Ed25519; browser admin uses session cookie → `dina-admin` → Ed25519 → core | These are foundational and must remain canonical |
| **Vault model** | Multi-persona vaults are part of the Phase 1 security model, not a later add-on | Persona separation is central to Dina's security story |
| **Persona safety** | Gatekeeper, persona boundaries, PII scrubbing, and action gating already matter from day one | Dina's security story is part of the product, not a future add-on |
| **Initial data hydration** | Customer data is pulled in, classified, and written into the correct persona vaults from the start | Dina is only real once the vaults are populated with actual life context |
| **External agents** | MCP delegation to OpenClaw or similar agents is the default work pattern | Dina is the orchestrator, not the worker |
| **Quiet-first intelligence** | Silence protocol, whispers, harm-based interruption, and human-connection enforcement are first-class | Dina should not behave like an attention product or a synthetic companion |
| **Cross-cutting invariants** | Loyalty, human connection, and pull economy are active architectural constraints, not future aspirations | These are what make Dina more than a secure assistant |
| **Dina-to-Dina messaging** | Secure direct sharing and messaging already exist as part of the core shape | Private coordination should not depend on the public trust stack |
| **Action layer** | Draft-don't-send, approval gates, and cart handover are present; autonomous money movement is out of scope | Dina helps act, but does not take over |
| **Trust Network** | Ships in v1 via PDS/AppView and should already work, but Phase 1 value must not depend on the trust graph being large | Trust is part of the release, but not the only source of value |
| **Inference profile** | Cloud-first is acceptable; local inference stays optional | Inference choice is a deployment profile, not the thesis |
| **Deployment** | One Home Node, one compose stack, minimal moving parts | The default system should stay boring and understandable |

### Phase 1 Should Not Require

| Not Required In Phase 1 | Reason |
|---|---|
| Large trust-network scale | Core value must stand even when trust data is sparse |
| Shamir recovery | Important next step, but not part of the minimum viable shape |
| Local LLM by default | Optional profile, not a baseline requirement |
| Full settlement and commerce protocols | Intent economy can exist before the full market/settlement layer exists |
| Estate execution | Important, but not part of the initial product center |
| Advanced network topology | Noise, mesh, and similar work should not lead the architecture narrative |

---

## Phase 2

Phase 2 should make Dina denser, more resilient, and more powerful without changing the basic shape of the system.

| Area | Expected In Phase 2 | Why It Matters |
|---|---|---|
| **Vault and personas** | Persona policy, unlock behavior, and cross-persona handling become more refined and configurable | The security model gets deeper without changing the core idea |
| **Trust-aware recommendations** | Trust AppView data becomes materially more useful as graph density grows, instead of merely being present | The public layer starts adding more value without becoming the center |
| **Bot routing** | Dina can discover, compare, and route to more trusted specialist bots | Loyalty becomes operational, not just conceptual |
| **Recovery** | Shamir social recovery becomes the right next-step default beyond paper mnemonic | This improves survivability without changing sovereignty |
| **Inference profiles** | Local and hybrid inference profiles become stronger and more practical | Privacy-sensitive use gets a better default |
| **Human connection enforcement** | Anti-companionship and relational-redirection behavior becomes broader, more systematic, and more explainable | Human-connection invariants become easier to see and audit |
| **Ingestion model** | More sources and richer sync behavior can expand around the same core/brain split | Capabilities grow without moving connector logic into core |
| **Verification** | Better provenance, attribution, and recommendation explainability show up more explicitly in ranking flows | Loyalty and pull economy need visible system behavior |

---

## Phase 2+

Phase 2+ is the expansion frontier: the place where Dina becomes a mature trust and open-economy layer without abandoning the private-core model.

| Area | Expected In Phase 2+ | Why It Matters |
|---|---|---|
| **Open trust ecosystem** | Multi-AppView verification, stronger public trust infrastructure, and broader ecosystem participation | Trust becomes durable shared infrastructure |
| **Open economy flows** | Dina-to-Dina commerce, deeper handoff, and richer verified transaction flows become possible | This is where the economic layer matures beyond the already-present intent economy |
| **Settlement and market protocols** | Richer payment, negotiation, and settlement flows become practical | This is the later economic layer, not the initial intent layer |
| **Estate and continuity** | Digital estate execution and continuity workflows become viable | Sovereign systems need a long-term continuity story |
| **Advanced network model** | Noise sessions, richer topology, and stronger peer verification can arrive | Useful, but not part of the simple Phase 1 center |
| **Advanced verification** | Anchoring, deeper provenance checks, and stronger public evidence systems become worthwhile | High-value trust systems need stronger verification at scale |
| **Richer device ecosystem** | More capable mobile, voice, and edge-device behaviors can expand around the same kernel | Device breadth should follow architectural maturity, not lead it |

---

## Document Discipline

| Rule | Why It Matters |
|---|---|
| Keep Phase 1 centered on the private core | That is the simplest and strongest version of Dina |
| Treat the Trust Network as part of the v1 release, but not the only source of Phase 1 value | This preserves the cold-start story without understating your intended release scope |
| Treat multi-persona as Phase 1 security, not a future organizational feature | This keeps the document aligned with the real protection model |
| Make initial data ingestion explicit | Dina is empty until real customer context flows into the persona vaults |
| Keep identity and auth canonical in one place | These are foundational and should never drift |
| Keep the cross-cutting invariants early and visible | They carry the README's distinctiveness into architecture |
| Keep long-horizon material documented but mentally downstream | This keeps the architecture readable without losing ambition |

---

## One-Line Summary

| Phase | Summary |
|---|---|
| **Phase 1** | Private core, trust network, multi-persona security, and active ingestion |
| **Phase 2** | Density, recovery, and richer routing/verification |
| **Phase 2+** | Open trust and open-economy expansion |
