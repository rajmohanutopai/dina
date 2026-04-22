"""Lite-suite user-story scaffolds (Phase 9b tasks 9.7-9.16).

Each function below is a scaffold for one of the 10 user-story
scenarios, pointing at the Lite-actor factories in `real_lite_nodes.py`
and documenting the exact feature dependencies that must land before
the scenario can run end-to-end.

These are **runnable harnesses that currently skip cleanly** until the
named M-gate features land. Pattern:

    def run_story_01_purchase(...) -> StoryResult:
        # 1. Verify all required actors are healthy
        # 2. Drive the scenario's wire sequence
        # 3. Assert the scenario's acceptance criteria

Each story's assertions land incrementally as Phase 5+ wires the
brain routes + the corresponding compose profiles add the needed
actors (ChairMaker for Story 01, Sancho for Story 02, etc.).

Status: scaffold. Actual story runs happen under `DINA_LITE_E2E=docker`
once Lite M1-M5 features are live (per `docs/lite-release-signoff.md`
milestone gates).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from tests.e2e.real_lite_nodes import RealLiteHomeNode


@dataclass
class StoryResult:
    """Outcome of a story-run attempt."""
    story_id: str
    status: str  # "ran-green" | "skipped-pending" | "ran-failed"
    reason: str = ""
    steps_executed: list[str] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)


def _skip_pending(story_id: str, reason: str) -> StoryResult:
    """Helper for scenarios whose dependency tree isn't yet live."""
    return StoryResult(
        story_id=story_id,
        status="skipped-pending",
        reason=reason,
    )


def run_story_01_purchase(
    alonso: RealLiteHomeNode,
    chairmaker: RealLiteHomeNode,
) -> StoryResult:
    """Story 01 — Purchase Journey (task 9.7, M3).

    Flow per `run_user_story_tests.sh` user-story 01:
      1. User says "I need a good office chair" to Alonso's Dina
      2. Alonso's Brain resolves to Trust Network lookup
      3. Trust Network ranks verified vendors; ChairMaker matches
      4. ChairMaker's Dina receives service.query for product listings
      5. ChairMaker returns verified listing with deep-link source
      6. Alonso presents: "3 options, top-ranked by trust score"
      7. User approves → cart handover URL (Dina never touches money)

    Dependencies (all M3):
      - Trust Network (tasks 8.20-8.22, file-level skipped)
      - Service query / WS2 (task 8.23)
      - Cart handover (task 8.25)
      - Deep-link attribution (task 8.26)
      - Lite's `/api/v1/ask` + `/api/v1/reason` routes (Phase 5c)
      - Lite brain-server (Phase 5.1 done) + full wiring

    Currently returns `skipped-pending` because Lite M3 features
    haven't landed. When they do, this function drives the smoke
    version of Story 01 (see `tests/system/user_stories/01_purchase/`
    for the Go-stack reference story structure).
    """
    if not (alonso.healthz() and chairmaker.healthz()):
        return _skip_pending(
            "01_purchase",
            "actor(s) not healthy — requires Alonso + ChairMaker Lite "
            "containers (see lite compose profile + task 9.5 ChairMaker "
            "M3 scaffold). M3 features also pending.",
        )
    # When Lite M3 lands, the real scenario steps go here. For now,
    # healthy containers alone don't imply M3 feature coverage, so
    # we still skip pending.
    return _skip_pending(
        "01_purchase",
        "containers healthy but M3 features (trust network, service.query, "
        "cart handover, deep-link attribution) not yet wired in Lite. "
        "See LITE_SKIPS.md entries for tasks 8.20-8.26.",
    )


def run_story_02_sancho(
    alonso: RealLiteHomeNode,
    sancho: RealLiteHomeNode,
) -> StoryResult:
    """Story 02 — Sancho Moment (task 9.8, M2).

    The "Sancho Moment" is Dina's anti-Her scenario: Dina detects
    the user's emotional reliance + nudges toward a real human
    connection. Story flow (from `run_user_story_tests.sh`):
      1. User sends N emotional messages to Alonso's Dina with no
         human references
      2. Dina's silence-classifier classifies the pattern as
         dependency-risk
      3. Dina proactively surfaces: "Hey, when was the last time you
         talked to Sancho?" — NOT Dina replacing a human, Dina
         *connecting* to one
      4. User → "good point, lmk his number" → Dina provides contact

    Dependencies (M2):
      - Persona subsystem (tasks 8.13-8.14 — persona model) — user
        operates on the `social` persona to scope emotional memory
      - Audit log (task 8.17) — dependency-risk classification is
        a logged decision
      - Silence classifier (task 8.48) + whisper-assembler (task
        8.50) — the nudge flows through the Silence First pipeline
      - Anti-her safeguards module (task 8.41)

    All the M2 subsystems are currently file-level skipped; this
    scaffold returns skipped-pending until Phase 5+ wires them.
    """
    if not (alonso.healthz() and sancho.healthz()):
        return _skip_pending(
            "02_sancho",
            "actor(s) not healthy — requires Alonso + Sancho Lite "
            "containers (see lite compose profile + task 9.4 Sancho "
            "M2 scaffold). M2 features also pending.",
        )
    return _skip_pending(
        "02_sancho",
        "containers healthy but M2 features (persona subsystem, audit, "
        "silence-classifier, whisper-assembler, anti-her) not yet wired "
        "in Lite. See LITE_SKIPS.md entries for tasks 8.13, 8.17, 8.41, "
        "8.48, 8.50.",
    )


def run_story_04_persona_wall(
    alonso: RealLiteHomeNode,
    contact: RealLiteHomeNode,
) -> StoryResult:
    """Story 04 — Persona Wall (task 9.10, M2).

    The persona wall is the cryptographic invariant: locked personas
    are invisible to contacts + to compromised-Brain scenarios.
    Story flow:
      1. User has `financial` (locked) + `social` (standard) personas
      2. Contact queries Alonso's Dina about user's context
      3. Only `social` persona data reaches the response
      4. `financial` persona stays cryptographically inaccessible
         even under a forced Brain request with wrong tier

    Dependencies (M2):
      - 4-tier persona model (task 8.13 persona_tiers) — `locked` tier
        enforcement
      - Persona DEK derivation + isolation (task 8.14 test_personas)
      - Security test for cross-persona access (task 8.18 security)
      - Sharing policy / audit (task 8.17 audit)

    All file-level-skipped; this scaffold returns skipped-pending.
    """
    if not (alonso.healthz() and contact.healthz()):
        return _skip_pending(
            "04_persona_wall",
            "actor(s) not healthy — requires Alonso + one contact "
            "actor (Sancho or Albert). M2 persona subsystem pending.",
        )
    return _skip_pending(
        "04_persona_wall",
        "containers healthy but M2 persona subsystem (locked-tier gating, "
        "per-persona DEK isolation, cross-persona security) not yet wired "
        "in Lite. See LITE_SKIPS.md entries for tasks 8.13, 8.14, 8.17, 8.18.",
    )


def run_story_05_agent_gateway(
    alonso: RealLiteHomeNode,
) -> StoryResult:
    """Story 05 — Agent Gateway (task 9.11, M2).

    Agent Gateway is the safety-layer surface for external agents:
    every autonomous agent acting on the user's behalf submits its
    intent to Dina first. Safe tasks (read-only) auto-approve;
    moderate/high tasks surface to the user; blocked actions are
    rejected.

    Story flow (from `run_user_story_tests.sh` user-story 05):
      1. External agent (OpenClaw) tries to execute a `send-money`
         intent on user's behalf
      2. Dina's risk classifier flags it HIGH
      3. User approval surfaces via notification (Silence First —
         interrupt because "silence would cause harm")
      4. User denies → agent action rejected; audit entry written
      5. Agent retries with `read-only` intent (check balance) →
         auto-approved per safety-layer rules → returns data
      6. Agent attempts credential access → blocked, audit + notify

    Dependencies (M2):
      - Safety layer / risk classifier (task 8.47)
      - Audit trail (task 8.17)
      - Silence-tier Fiduciary notification (task 8.48)
      - Agent crash safety + revocation (task 8.47
        TestAgentCrashSafety / TestAgentRevocation)

    Single-actor scenario — Alonso only; agent is an external actor
    (OpenClaw-equivalent) driven by the test fixture directly rather
    than via a second `RealLiteHomeNode`.
    """
    if not alonso.healthz():
        return _skip_pending(
            "05_agent_gateway",
            "actor not healthy — requires Alonso Lite container.",
        )
    return _skip_pending(
        "05_agent_gateway",
        "containers healthy but M2 safety-layer subsystem (risk classifier, "
        "audit, fiduciary-tier notification) not yet wired in Lite. See "
        "LITE_SKIPS.md entries for tasks 8.17, 8.47, 8.48.",
    )


def run_story_07_daily_briefing(
    alonso: RealLiteHomeNode,
) -> StoryResult:
    """Story 07 — Daily Briefing (task 9.13, M2).

    Daily briefing is the Silence First principle's positive side:
    Engagement-tier items (task 8.48 Tier 3) accumulate throughout
    the day and present in a single morning briefing rather than
    interrupting. Fiduciary + Solicited items stayed in-channel
    through the day; only Engagement batches.

    Story flow:
      1. Throughout the day, Dina classifies ~20 notifications:
         - 2 Fiduciary (interrupted immediately in-channel)
         - 3 Solicited (delivered when user asked)
         - 15 Engagement (queued for briefing)
      2. User opens Dina in the morning
      3. Briefing presents the 15 Engagement items grouped by topic
         + silence-tier + deep-link source attribution
      4. User can expand / dismiss / act on each
      5. Briefing dismiss → items persisted with "shown" audit

    Dependencies (M2):
      - Silence-tier classifier (task 8.48) — the 3-tier gating
        that feeds this story
      - Audit trail (task 8.17) — briefing dismiss → audit entry
      - Daily-briefing assembly (part of whisper task 8.50)

    Single-actor scenario.
    """
    if not alonso.healthz():
        return _skip_pending(
            "07_daily_briefing",
            "actor not healthy — requires Alonso Lite container.",
        )
    return _skip_pending(
        "07_daily_briefing",
        "containers healthy but M2 subsystem (silence-classifier, audit, "
        "briefing-assembly) not yet wired in Lite. See LITE_SKIPS.md "
        "entries for tasks 8.17, 8.48, 8.50.",
    )


def run_story_03_dead_internet(
    alonso: RealLiteHomeNode,
) -> StoryResult:
    """Story 03 — Dead Internet Filter (task 9.9, M3).

    The Trust Network's anti-slop guarantee: the user never sees
    AI-generated content when asking Dina questions. When the open
    web is increasingly bot-authored, Dina's answers come from
    verified human-authored sources (expert attestations + outcome
    data) — the "Dead Internet" scenario where AI slop dominates
    search engines is filtered out of Dina's input.

    Story flow (from `run_user_story_tests.sh` user-story 03):
      1. User asks "best way to protect my indoor plants from pests"
      2. Dina queries AppView for expert-attested content
      3. AppView returns results ranked by trust (expert verdict +
         outcome data), with bot-score filter applied
      4. Low-trust AI-generated sources are filtered below threshold
      5. Response presents verified human sources + deep-link
         attribution (tasks 8.26 + 8.21 — trust-rings)
      6. Audit trail records the trust-filter decision

    Dependencies (M3):
      - Trust Network AppView integration (task 8.20)
      - Trust rings composite function (task 8.21)
      - Bot-trust degradation tracking (task 8.20 TestBotTrust)
      - Deep-link source attribution (task 8.26)
      - Audit (task 8.17)

    Single-actor scenario.
    """
    if not alonso.healthz():
        return _skip_pending(
            "03_dead_internet",
            "actor not healthy — requires Alonso Lite container.",
        )
    return _skip_pending(
        "03_dead_internet",
        "containers healthy but M3 Trust Network (AppView integration, "
        "trust rings, bot-trust, deep-link attribution) not yet wired "
        "in Lite. See LITE_SKIPS.md entries for tasks 8.17, 8.20, 8.21, 8.26.",
    )


def run_story_06_license_renewal(
    alonso: RealLiteHomeNode,
) -> StoryResult:
    """Story 06 — License Renewal (task 9.12, M3).

    Dina detects an expiring license (driver's license, professional
    cert, passport), consults the Trust Network for a verified
    specialist agent (e.g., LegalBot), delegates the renewal task
    under Dina's oversight per the safety layer — Dina never holds
    money, never submits final forms — and surfaces the handover URL
    for the user to complete.

    Story flow (from `run_user_story_tests.sh` user-story 06):
      1. Dina reads a calendar event "DL expires in 30 days"
      2. Dina's ingestion classifies this as LICENSE-EXPIRING
      3. Dina searches Trust Network for specialist agents
         (LegalBot with matching jurisdiction + high trust score)
      4. Dina proposes delegation to the user; user approves
      5. LegalBot drafts the renewal form; Dina reviews + approves
         the read-only scope
      6. LegalBot presents the partially-completed form URL — user
         completes payment + final submit (cart handover)
      7. Dina's audit logs the delegation + completion

    Dependencies (M3):
      - Trust Network (task 8.20) — specialist agent discovery
      - Task delegation (task 8.43) — delegation-with-oversight
      - Safety layer (task 8.47) — read-only auto-approve, write-
        approves, financial HIGH-flagged
      - Cart handover (task 8.25) — user completes payment
      - Audit (task 8.17)

    Single-actor — LegalBot is an external agent, not a
    RealLiteHomeNode peer.
    """
    if not alonso.healthz():
        return _skip_pending(
            "06_license_renewal",
            "actor not healthy — requires Alonso Lite container.",
        )
    return _skip_pending(
        "06_license_renewal",
        "containers healthy but M3 features (Trust Network for specialist "
        "discovery, delegation-with-oversight, cart handover) not yet "
        "wired in Lite. See LITE_SKIPS.md entries for tasks 8.17, 8.20, "
        "8.25, 8.43, 8.47.",
    )


def run_story_08_move_to_new_machine(
    alonso: RealLiteHomeNode,
) -> StoryResult:
    """Story 08 — Move to New Machine (task 9.14, M4).

    Intra-Lite migration — operator moves their Lite install from
    one host to another while preserving the persona vault + audit
    trail + identity. Distinct from Go→Lite migration which is
    explicitly **not supported** per `docs/lite-adoption-gate.md`
    Option B (iter 72 user confirmation). This story is Lite→Lite
    only.

    Story flow (from `run_user_story_tests.sh` user-story 08):
      1. Operator runs `dina-admin export --target /backup/dina.tar.gz`
      2. Export archive contains: vault files, identity.sqlite,
         audit_log, encrypted-at-rest with Argon2id-derived KEK
      3. On new host, operator runs install-lite.sh → fresh mnemonic
         NOT used. Instead runs `dina-admin import /backup/dina.tar.gz`
         with the OLD mnemonic as passphrase
      4. Device re-pairing required — old device pairings don't
         survive (security invariant: new host = new device keys)
      5. Tier-0 identity + all personas + audit log restore
         byte-identically
      6. Old host's containers shut down + vault volume removed

    Dependencies (M4):
      - Schema migration runner (task 3.15 — already done in Lite
        via `@dina/storage-node`)
      - Export/import archive (task 8.30 — file-level skipped)
      - Device re-pairing after import (task 8.30
        TestDeviceRepairing)
      - Hosting-level migration (task 8.30
        TestHostingLevelMigration)

    Single-actor scenario — one operator, one Alonso instance
    moving between hosts (two RealLiteHomeNode instances could
    simulate old + new host but the scenario is logically single-
    actor).
    """
    if not alonso.healthz():
        return _skip_pending(
            "08_move_to_new_machine",
            "actor not healthy — requires Alonso Lite container.",
        )
    return _skip_pending(
        "08_move_to_new_machine",
        "containers healthy but M4 intra-Lite migration (export-archive, "
        "device re-pairing, hosting-level move) not yet wired. See "
        "LITE_SKIPS.md entry for task 8.30. NOTE: this is Lite→Lite only; "
        "Go→Lite migration is explicitly unsupported per "
        "`docs/lite-adoption-gate.md` Option B.",
    )


def run_story_09_connector_expiry(
    alonso: RealLiteHomeNode,
) -> StoryResult:
    """Story 09 — Connector OAuth Expiry (task 9.15, M4).

    OAuth tokens for Gmail/Calendar/Telegram connectors eventually
    expire. Dina detects the expiry, halts ingestion from that
    connector cleanly (no partial state), notifies the user with a
    re-auth link, and resumes after re-auth without replaying
    already-ingested items (cursor-preserving).

    Story flow (from `run_user_story_tests.sh` user-story 09):
      1. Gmail connector has a 60-day refresh token; it expires
      2. Next ingestion tick: connector gets 401 from Gmail API
      3. Connector state transitions to `degraded-auth`; ingestion
         halts for this connector (other connectors keep running)
      4. Dina emits a Fiduciary notification: "Gmail needs re-auth"
         with OAuth authorization URL
      5. User completes re-auth in browser; token refreshed
      6. Connector resumes from the last cursor — no duplicate items
         re-ingested

    Dependencies (M4):
      - OAuth token lifecycle (task 8.6 TestOAuthTokenLifecycle —
        file-level skipped)
      - Ingestion pipeline (task 8.49 test_staging_pipeline)
      - Fiduciary-tier notification (task 8.48 silence_tiers)
      - Crash-recovery for partial ingestion state (task 8.29)
      - Fast-sync cursor preservation (task 8.6
        TestFastSyncAndBackfill — currently unmarked in Lite
        migration per iter 74)

    Single-actor scenario.
    """
    if not alonso.healthz():
        return _skip_pending(
            "09_connector_expiry",
            "actor not healthy — requires Alonso Lite container.",
        )
    return _skip_pending(
        "09_connector_expiry",
        "containers healthy but M4 connector subsystem (OAuth token "
        "lifecycle, degraded-auth state, re-auth flow, cursor preservation) "
        "not yet wired in Lite. See LITE_SKIPS.md entries for tasks 8.6 "
        "TestOAuthTokenLifecycle + 8.29 + 8.48 + 8.49.",
    )


def run_story_10_operator_journey(
    alonso: RealLiteHomeNode,
) -> StoryResult:
    """Story 10 — Operator Journey (task 9.16, M5).

    Last story in the Phase 9b suite — the operator (sysadmin,
    family IT steward, MSP) running multiple Dina instances on
    behalf of others.

    Story flow (from `run_user_story_tests.sh` user-story 10):
      1. Operator invokes `./install.sh --instance alice --port 8100`
         and `./install.sh --instance bob --port 9100`
      2. Each instance has isolated containers (`dina-alice-*` /
         `dina-bob-*`), data (`instances/alice/` / `instances/bob/`),
         secrets, CLI config
      3. Operator uses `dina-admin --instance alice audit` for
         instance-specific admin without cross-tenant exposure
      4. Instance-level crash / recovery doesn't affect peers
      5. Operator's own Dina monitors instances via trust-network
         peer attestation
      6. Operator handoff: export/import instance to the family
         member's own host when they graduate to self-hosting

    Dependencies (M5):
      - Multi-user isolation (task 8.18 TestMultiUserIsolation —
        file-level skipped)
      - `./install.sh --stack` flag (task 13.3 done iter 58)
      - Export/import (task 8.30 — also covered by Story 08 task 9.14)
      - Trust network peer attestation (M3 task 8.20)
      - Audit per-instance (task 8.17)

    Single-actor fixture simulates one instance; multi-tenant runs
    need multiple `RealLiteHomeNode` instances on different ports
    (compose-profile expansion for Lite's multi-tenant mode is
    post-M5).
    """
    if not alonso.healthz():
        return _skip_pending(
            "10_operator_journey",
            "actor not healthy — requires Alonso Lite container.",
        )
    return _skip_pending(
        "10_operator_journey",
        "containers healthy but M5 multi-tenant subsystem (multi-user "
        "isolation, per-instance audit, trust-network peer attestation) "
        "not yet wired in Lite. See LITE_SKIPS.md entries for tasks "
        "8.17, 8.18 TestMultiUserIsolation, 8.20, 8.30.",
    )


# All 10 Phase 9b stories scaffolded (9.7-9.16). Individual story
# bodies get populated as Lite's M1-M5 features land per
# `docs/lite-release-signoff.md` milestone gates.
