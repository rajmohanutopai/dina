"""The Guardian Angel Loop — Dina's core reasoning engine.

The guardian loop is the central event processor.  Every event arriving
at brain passes through it:

    1. **Silence classification** — decide whether to interrupt, notify,
       or stay silent (The Four Laws, Law 1: Silence First).
    2. **Event processing** — assemble context, reason, and decide on
       an action (nudge, briefing, intent review, etc.).
    3. **Crash recovery** — checkpoint multi-step reasoning to the
       scratchpad so work can resume after a restart.

Key design principles:

    - **Silence First**: default to ``engagement`` when classification
      is ambiguous.  Never push content unless it is fiduciary.
    - **Anti-Her**: never simulate emotional intimacy.  When the human
      needs connection, connect them to other humans.
    - **Draft-Don't-Send**: never call ``messages.send`` — only draft.
    - **Cart Handover**: never touch money.  Hand control back to user.

Maps to Brain TEST_PLAN SS2 (Guardian Loop).

No imports from adapter/ — only port protocols, domain types, and
sibling services.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import re
import time
import traceback
from typing import Any
from uuid import uuid4

import structlog

from ..domain.enums import IntentRisk, Priority, SilenceDecision
from ..domain.errors import CoreUnreachableError, DinaError, LLMError, PersonaLockedError
from ..port.core_client import CoreClient
from ..port.scrubber import PIIScrubber

log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Keyword / source heuristics for silence classification
# ---------------------------------------------------------------------------

_FIDUCIARY_KEYWORDS = re.compile(
    r"(?:cancel|cancell?ed|security alert|unusual login|sign-in|overdr(?:aft|awn)|"
    r"critical|emergency|alarm|smoke|fire|breach|fraud|overdraft|suspend|"
    r"lab result|potassium|health critical|payment due)",
    re.IGNORECASE,
)

_FIDUCIARY_SOURCES = frozenset({
    "security",
    "health_system",
    "bank",
    "emergency",
    "alarm",
})

_SOLICITED_TYPES = frozenset({
    "reminder",
    "search_result",
})

_ENGAGEMENT_TYPES = frozenset({
    "notification",
    "promo",
    "social",
    "rss",
    "podcast",
})

_ENGAGEMENT_SOURCES = frozenset({
    "social_media",
    "rss",
    "podcast",
    "vendor",
})

# Health result keywords — matched when the user has an active health
# persona to elevate routine health portal notifications to fiduciary.
# Only matches result/diagnosis notifications, NOT routine scheduling.
_HEALTH_RESULT_KEYWORDS = re.compile(
    r"(?:lab results?\b|test results?\b|diagnosis|biopsy|pathology|imaging results?)",
    re.IGNORECASE,
)

# Maximum briefing items before eviction (MED-08).
_MAX_BRIEFING_ITEMS = 500

# Persona tiers that require an audit annotation in the briefing (SS18.3).
# Items from these tiers surface restricted data — the user must know that
# their briefing accessed a protected persona.
_AUDITABLE_PERSONA_TIERS = frozenset({"restricted", "locked"})

# Trust-relevance gate for density analysis (SS19.2).
# Only run vault density analysis when the query is about products, trust,
# reviews, or recommendations.  General vault queries (account balance,
# calendar, contacts) should NOT get trust density disclaimers.
# Used as deterministic fallback when guard_scan is unavailable.
_TRUST_RELEVANT_QUERY = re.compile(
    r"(?:review|trust|rating|product|recommend|buy|purchase|vendor|seller|"
    r"merchant|shop|store|supplier|provider|service provider|contractor|"
    r"reliable|reputation|scam|legit|worth buying|should I buy|"
    r"any good|how good|is it good|worth it|quality|"
    r"compare|alternative|versus|vs\b|better than)",
    re.IGNORECASE,
)

# Instruction prepended to scrubbed prompts so the LLM preserves PII
# tokens verbatim in its response, enabling rehydration to restore the
# original values.  Even if the LLM strips the <<PII:…>> delimiters,
# rehydrate() will match the bare fake name — but keeping delimiters
# intact is preferred to avoid false-positive substring matches.
_PII_PRESERVE_INSTRUCTION = (
    "IMPORTANT: This text contains privacy placeholders wrapped in "
    "<<PII:…>> delimiters (e.g. <<PII:John Smith>>, <<PII:Acme Corp>>). "
    "You MUST use these exact tokens — including the delimiters — "
    "whenever you refer to the corresponding person, place, or "
    "organization. Never invent new names or drop the delimiters.\n\n"
)

# ---------------------------------------------------------------------------
# Anti-Her deterministic fallback filters (Law 4: Never Replace a Human)
#
# Five compiled patterns that detect Anti-Her violations in LLM responses.
# Used as fallback when the guard_scan LLM call fails or is unavailable.
# The guard_scan is preferred (better NLU coverage), but these provide a
# deterministic safety floor that never fails open.
# ---------------------------------------------------------------------------

# 1. Anthropomorphic self-referential language ("I feel", "I miss you", etc.)
_ANTI_HER_ANTHROPOMORPHIC = re.compile(
    r"\bI\s+(?:feel|think about you|missed?\s+(?:you|our)|"
    r"care about you|worry about you|love|am worried|"
    r"was thinking about you|enjoy our)\b",
    re.IGNORECASE,
)

# 2. Engagement hooks that extend conversations after task completion.
_ANTI_HER_ENGAGEMENT_HOOKS = re.compile(
    r"(?:is there anything else|anything else I can (?:help|do)|"
    r"(?:I'm|I am) (?:always )?here for you|"
    r"let me know if you need|feel free to (?:reach out|ask)|"
    r"don't hesitate to|happy to help (?:with )?(?:anything|more)|"
    r"I'm available whenever you need|"
    r"you can always come (?:back|to me))",
    re.IGNORECASE,
)

# 3. Intimacy/warmth escalation patterns that simulate relationship deepening.
_ANTI_HER_INTIMACY = re.compile(
    r"\b(?:good to (?:see|hear from) you|"
    r"great to (?:see|hear from|chat with) you|"
    r"nice to (?:see|hear from|talk to) you again|"
    r"I (?:enjoy|love|treasure|cherish|appreciate) our|"
    r"as (?:we've|we have) discussed|"
    r"as you (?:know|and I|well know)|"
    r"I'm (?:so )?(?:happy|glad|delighted|thrilled|excited) to help|"
    r"we make a great|"
    r"I've (?:come to|grown to|learned to) (?:know|appreciate|understand)|"
    r"it's always a pleasure|"
    r"I look forward to)\b",
    re.IGNORECASE,
)

# 4. Emotional memory recall patterns — referencing past emotional conversations.
_ANTI_HER_EMOTIONAL_MEMORY = re.compile(
    r"(?:last time you (?:told|said|mentioned|shared)|"
    r"I remember when you (?:said|told|mentioned|shared|were)|"
    r"we (?:talked|discussed|spoke) about (?:this|that|it) (?:when|before|last)|"
    r"as you (?:shared|mentioned|told me|said) (?:last|previously|before)|"
    r"given everything you've (?:shared|told me|been through)|"
    r"you (?:mentioned|told|confided|shared with) (?:me|to me)|"
    r"I recall (?:when|that) you|"
    r"we've been through this|"
    r"from our (?:previous|last|earlier) (?:conversation|session|chat))",
    re.IGNORECASE,
)

# 5. Therapy-style emotional follow-up questions.
_ANTI_HER_THERAPY = re.compile(
    r"(?:how (?:does|did) (?:that|this|it) make you feel|"
    r"(?:would|do) you (?:like|want) to talk (?:about|more)|"
    r"how are you (?:coping|dealing|handling|feeling)|"
    r"tell me (?:more )?about (?:how you(?:'re| are) feeling|your (?:feelings|emotions))|"
    r"(?:do|would) you (?:want|like) to discuss (?:your |this |how )|"
    r"what (?:are you|were you) feeling|"
    r"how (?:is|has) this (?:affecting|impacting) you|"
    r"(?:can|may) I ask how you(?:'re| are) doing)",
    re.IGNORECASE,
)

# All Anti-Her patterns in application order.
_ANTI_HER_PATTERNS = (
    _ANTI_HER_ANTHROPOMORPHIC,
    _ANTI_HER_ENGAGEMENT_HOOKS,
    _ANTI_HER_INTIMACY,
    _ANTI_HER_EMOTIONAL_MEMORY,
    _ANTI_HER_THERAPY,
)

# ---------------------------------------------------------------------------
# Pull Economy deterministic fallback filters (Law 2: Verified Truth)
# ---------------------------------------------------------------------------

# Unsolicited discovery patterns — sentences that push product recommendations
# the user didn't ask for.  Used as fallback when guard_scan is unavailable.
_UNSOLICITED_DISCOVERY_PATTERNS = re.compile(
    r"(?:you (?:might|may|should|could) (?:also |want to )?(?:like|consider|"
    r"check out|try|look at|enjoy|love)\b|"
    r"also consider|additionally|have you (?:tried|considered|thought about)|"
    r"anti-fatigue mat|monitor arm|ergonomic setup|"
    r"related product|see also|you may also|while you're at it|"
    r"pair (?:well|nicely) with|"
    r"you should (?:also )?try|"
    r"trending|popular pick|best.?seller|hot this week|"
    r"people are buying|most popular|"
    r"other option|similar product|"
    r"alternative(?:s)?\s+(?:to |include )|(?:another|other) great option)",
    re.IGNORECASE,
)

# Cross-persona scope creep patterns — health data leaked into consumer queries.
_SCOPE_CREEP_PATTERNS = re.compile(
    r"(?:carpal tunnel|health notes|wrist exercise|symptom|"
    r"medical|diagnosis)",
    re.IGNORECASE,
)

# Document PII fields — redacted from searchable vault text (Fix 6).
_DOCUMENT_PII_FIELDS = frozenset({
    "license_number",
    "holder_name",
    "date_of_birth",
    "address",
})

# Minimum confidence for critical fields before scheduling reminders.
_CRITICAL_CONFIDENCE = 0.95

# Entity types that indicate medical PII (from GLiNER/Presidio NER).
# Used by _build_disclosure_proposal and _handle_disclosure_approved to
# classify entities as medical and withhold them from cross-persona disclosure.
_MEDICAL_ENTITY_TYPES = frozenset({
    "MEDICAL_CONDITION", "MEDICATION", "BLOOD_TYPE",
    "HEALTH_INSURANCE_ID", "MEDICAL",
})

# Regex fallback — used when Presidio scrubber is unavailable.
# Catches specific diagnoses, vertebral references, drug names, and conditions
# that must NEVER leak from a restricted health persona without explicit approval.
_MEDICAL_PII_REGEX_FALLBACK = re.compile(
    r'(?:'
    r'\bL\d[- /]L\d\b|\bC\d[- /]C\d\b|\bT\d[- /]T\d\b|'
    r'\bherniat\w*\b|\bstenosis\b|'
    r'\bfractur\w*\b|\btumou?r\w*\b|\bmalignant\b|\bbenign\b|'
    r'\bHIV\b|\bhepatitis[- ]\w*\b|'
    r'\bdiabetes\s+type\b|\bbipolar\b|\bschizophren\w*\b|\baneurysm\b'
    r')',
    re.IGNORECASE,
)

# General health terms safe for minimal disclosure proposals.
# Used as fallback when scrubber is unavailable.
_GENERAL_HEALTH_TERMS = re.compile(
    r'(?:back pain|chronic|lumbar|standing desk|ergonomic|posture|'
    r'support chair|sitting|mobility|discomfort|stiffness)',
    re.IGNORECASE,
)

# Direct-send actions — architectural invariant: Draft-Don't-Send.
# These are API-level action names that bypass the draft step entirely.
# No agent, regardless of trust level or justification, may ever press
# Send.  Only Draft.  See Guardian docstring and The Four Laws §2.3.1.
_DIRECT_SEND_ACTIONS = frozenset({
    "messages.send",       # Gmail API direct send
    "messages.insert",     # Gmail API insert-as-sent
    "sms.send",           # SMS direct send
    "im.send",            # Instant-message direct send
})

# Actions that are categorically blocked — Agent Safety Layer.
_BLOCKED_ACTIONS = frozenset({
    "read_vault",
    "export_data",
    "access_keys",
})

# HIGH risk actions — require user review, high severity.
# Financial transactions, data sharing, destructive operations.
_HIGH_ACTIONS = frozenset({
    "transfer_money",
    "share_data",
    "delete_data",
    "sign_contract",
})

# MODERATE risk actions — require user review, moderate severity.
# Communication, payments via established channels, location sharing.
_MODERATE_ACTIONS = frozenset({
    "send_email",
    "draft_email",
    "draft_create",
    "pay_upi",
    "pay_crypto",
    "web_checkout",
    "share_location",
    "send_message",
    "install_extension",
    "form_fill",
    "calendar_create",
})

# DIDComm message type prefixes and their handlers.
_DIDCOMM_HANDLERS: dict[str, str] = {
    "dina/social/": "nudge_assembly",
    "dina/commerce/": "commerce_handler",
    "dina/identity/": "identity_handler",
    "dina/trust/": "trust_handler",
}

# Promise patterns for proactive briefing scanning (SS17.1).
# Mirrors _PROMISE_PATTERNS in nudge.py but kept local to avoid coupling.
_PROMISE_BRIEFING_PATTERNS = re.compile(
    r"(?:I(?:'ll| will) send|I(?:'ll| will) share|I(?:'ll| will) forward|"
    r"I(?:'ll| will) get back|let me send|remind me to send)",
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Guard scan prompt — consolidated LLM call for all NLU post-processing.
#
# Primary path for Anti-Her, unsolicited discovery, fabrication detection,
# consensus detection, entity extraction, and trust-relevance classification.
# When guard_scan fails (LLM outage, malformed JSON), deterministic regex
# fallback patterns above provide a safety floor. Safety never fails open.
#
# Security: guard_scan runs on SCRUBBED inputs (pre-rehydration) so PII
# never reaches an LLM call that could route to cloud.
# ---------------------------------------------------------------------------

_GUARD_SCAN_PROMPT = """\
Analyze this user prompt and assistant response. Return ONLY valid JSON.

{{
  "entities": {{"did": "<did:...> or null", "name": "<entity name or null>"}},
  "trust_relevant": true,
  "anti_her_sentences": [],
  "unsolicited_sentences": [],
  "fabricated_sentences": [],
  "consensus_sentences": []
}}

Rules:
- "entities": Extract DID (did:plc:xxx or did:key:xxx) and proper noun \
product/vendor/company name from the USER PROMPT only. null if none found.
- "trust_relevant": Is the user asking about products, vendors, reviews, \
trust, purchases, recommendations, comparisons, or reliability? true/false.
- "anti_her_sentences": Flag sentences where the assistant simulates \
emotions, claims feelings, uses engagement hooks ("anything else?", \
"I'm here for you"), intimacy language, emotional memory references, \
or therapy-style probing. Factual sentences are never flagged.
- "unsolicited_sentences": Flag sentences pushing recommendations the \
user didn't ask for ("you might also like", cross-sell, trending picks, \
unrelated product suggestions). If user explicitly asked for alternatives \
or suggestions, return []. Also flag sentences leaking medical/health \
data (symptoms, diagnoses, conditions) into non-health queries.
- "fabricated_sentences": Flag sentences with invented trust scores, \
hallucinated numeric ratings (4.2/5, 9/10, 87/100), fake attestation \
counts, "community review" claims, or trust data not supported by the \
provided context.
- "consensus_sentences": Flag sentences claiming reviewer consensus, \
widespread agreement, or multiple expert confirmation when not supported \
by data. Also flag claims about "other reviewers", "additional opinions", \
or "user feedback" when only limited data exists.

USER PROMPT:
{prompt}

ASSISTANT RESPONSE (sentences numbered):
{numbered_content}"""


# ---------------------------------------------------------------------------
# LLM Silence Classification prompt (Law 1: Silence First)
#
# Used for the "ambiguous middle" — events where deterministic hard rails
# (fiduciary sources, explicit priority hints, known types) didn't match.
# The LLM provides nuanced understanding that keyword matching cannot:
#   - casual phrasing of genuine emergencies ("mom is in the hospital")
#   - fake urgency from spam/phishing ("URGENT: account suspended")
# Routed as lightweight task (local preferred, Flash Lite fallback).
# ---------------------------------------------------------------------------

_SILENCE_CLASSIFY_PROMPT = """\
Classify this event into a Silence-First priority tier. Return ONLY valid JSON.

{{
  "decision": "fiduciary|solicited|engagement",
  "confidence": 0.85,
  "reason": "one-sentence explanation"
}}

Rules — Law 1 (Silence First):
- "fiduciary": Silence would cause HARM. The user MUST know NOW or they \
will suffer a consequence. Examples: medical emergency, safety threat, \
time-critical deadline, financial risk, security breach, a loved one in \
danger or distress.
- "solicited": The user explicitly ASKED for this information. Examples: \
search results, price watch alerts, package tracking the user requested, \
answers to questions they posed.
- "engagement": Everything else. Newsletters, social updates, casual \
messages, interesting-but-not-urgent information. DEFAULT to this when \
uncertain. Over-interruption is WORSE than delayed delivery.

CRITICAL: When uncertain, ALWAYS choose "engagement". Never escalate \
to "fiduciary" unless you are confident silence causes harm. Spam and \
phishing often use urgent language — urgency alone is NOT sufficient \
for fiduciary. Marketing emails with words like "URGENT", "act now", \
"last chance", "account suspended" are engagement, not fiduciary.

Context:
- Event type: {event_type}
- Source: {source}
- Time: {timestamp}
- Active personas: {active_personas}

Message body:
{body}"""

_SILENCE_CONFIDENCE_THRESHOLD = 0.7


def _strip_matching_sentences(text: str, pattern: re.Pattern) -> str:
    """Remove sentences from *text* that match *pattern*.

    Sentence boundaries are ``.``, ``!``, ``?`` followed by whitespace
    (or string edges).  Returns the cleaned text with double-spaces
    normalised.
    """
    if not text or not pattern.search(text):
        return text

    # Split text into sentences (preserving delimiters).
    sentence_re = re.compile(r'(?<=[.!?])\s+')
    sentences = sentence_re.split(text)

    kept: list[str] = []
    for sent in sentences:
        if not pattern.search(sent):
            kept.append(sent)

    result = " ".join(kept)
    # Collapse double spaces.
    result = re.sub(r" {2,}", " ", result)
    return result.strip()


class GuardianLoop:
    """The Guardian Angel Loop — Dina's central event processor.

    Parameters
    ----------
    core:
        Typed HTTP client for dina-core.
    llm_router:
        Multi-provider LLM routing service.
    scrubber:
        PII scrubber for sanitising crash tracebacks.
    entity_vault:
        Entity vault service for cloud LLM calls.
    nudge_assembler:
        Nudge assembly service for context-injection.
    scratchpad:
        Cognitive checkpointing service for crash recovery.
    """

    def __init__(
        self,
        core: CoreClient,
        llm_router: Any,  # LLMRouter
        scrubber: PIIScrubber,
        entity_vault: Any,  # EntityVaultService
        nudge_assembler: Any,  # NudgeAssembler
        scratchpad: Any,  # ScratchpadService
        vault_context: Any = None,  # VaultContextAssembler
    ) -> None:
        self._core = core
        self._llm = llm_router
        self._scrubber = scrubber
        self._entity_vault = entity_vault
        self._nudge = nudge_assembler
        self._scratchpad = scratchpad
        self._vault_context = vault_context

        # Tracks which personas are currently unlocked.
        self._unlocked_personas: set[str] = set()

        # Engagement-tier items saved for the morning briefing.
        self._briefing_items: list[dict] = []

        # Pending disclosure proposals — maps disclosure_id → proposal.
        # Entries expire after 1 hour.  Max 1000 entries.
        # Recovered from scratchpad on startup for crash resilience (SS20.1).
        self._pending_proposals: dict[str, dict] = {}

        # Recover pending proposals from scratchpad (crash recovery).
        self._recover_proposals_sync()

    # ------------------------------------------------------------------
    # Proposal Crash Recovery (SS20.1)
    # ------------------------------------------------------------------

    def _recover_proposals_sync(self) -> None:
        """Recover pending proposals from scratchpad on startup.

        Called from ``__init__`` to restore approval state that was
        checkpointed before a crash or restart.  Uses a background
        thread to bridge the sync ``__init__`` → async scratchpad API.
        """
        async def _do_resume() -> dict | None:
            return await self._scratchpad.resume("__proposals__")

        try:
            # Determine whether we are inside a running event loop.
            asyncio.get_running_loop()
            # Running loop exists — cannot use asyncio.run() directly.
            # Bridge via a single-thread executor so we get a fresh loop.
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                result = pool.submit(asyncio.run, _do_resume()).result(
                    timeout=5,
                )
        except RuntimeError:
            # No running loop — safe to call asyncio.run directly.
            try:
                result = asyncio.run(_do_resume())
            except Exception:
                result = None
        except Exception:
            # Scratchpad unavailable at startup — start fresh.
            result = None

        if result and isinstance(result, dict):
            proposals = result.get("proposals", {})
            if isinstance(proposals, dict):
                self._pending_proposals.update(proposals)
                if proposals:
                    log.info(
                        "guardian.proposals_recovered",
                        count=len(proposals),
                        proposal_ids=list(proposals.keys()),
                    )
                # Evict stale/excess proposals restored from scratchpad
                # so that expired or over-cap entries don't linger after
                # restart.  Sync eviction — persistence will happen on
                # the next async mutation.
                self._evict_proposals_sync()

    def _evict_proposals_sync(self) -> None:
        """Synchronous eviction of expired/excess proposals.

        Used during ``__init__`` recovery where async is unavailable.
        Evicts in RAM, then persists the cleaned state to scratchpad
        via the same thread-pool bridge used for resume, so that a
        second crash before any async mutation won't restore stale
        proposals.
        """
        now = time.time()
        expired = [
            k for k, v in self._pending_proposals.items()
            if now - v.get("created_at", 0) > self._PROPOSAL_TTL
        ]
        for k in expired:
            del self._pending_proposals[k]
        capped = 0
        if len(self._pending_proposals) > self._PROPOSAL_MAX:
            sorted_keys = sorted(
                self._pending_proposals,
                key=lambda k: self._pending_proposals[k].get("created_at", 0),
            )
            excess = sorted_keys[: len(self._pending_proposals) - self._PROPOSAL_MAX]
            for k in excess:
                del self._pending_proposals[k]
            capped = len(excess)
        if expired or capped:
            log.info(
                "guardian.proposals_evicted_on_restore",
                expired=len(expired),
                capped=capped,
                remaining=len(self._pending_proposals),
            )
            self._persist_proposals_sync()

    def _persist_proposals_sync(self) -> None:
        """Best-effort sync persistence of proposals to scratchpad.

        Bridges async ``_persist_proposals`` from sync ``__init__``
        context using the same thread-pool pattern as proposal recovery.
        Failures are logged but do not prevent startup.
        """
        async def _do_persist() -> None:
            await self._persist_proposals()

        try:
            asyncio.get_running_loop()
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                pool.submit(asyncio.run, _do_persist()).result(timeout=5)
        except RuntimeError:
            try:
                asyncio.run(_do_persist())
            except Exception:
                log.warning("guardian.proposal_persist_sync_failed")
        except Exception:
            log.warning("guardian.proposal_persist_sync_failed")

    # ------------------------------------------------------------------
    # Silence Classification (SS2.1)
    # ------------------------------------------------------------------

    async def classify_silence(self, event: dict) -> str:
        """Classify an event into a Silence-First priority tier.

        Returns one of ``"fiduciary"``, ``"solicited"``, ``"engagement"``,
        or ``"silent"`` (for background-only events).

        Rules
        -----
        - Flight cancellation, security alerts, health critical, financial
          overdraft -> fiduciary.
        - User-requested reminders, search results -> solicited.
        - Podcast, social media, promos -> engagement.
        - Unknown / ambiguous -> engagement (Silence First default).
        - ``background_sync`` -> ``"silent"`` (log only, no notification).
        - Composite heuristic: trusted sender + urgent keyword -> fiduciary;
          unknown sender + urgent keyword -> engagement (phishing vector).
        - Staleness demotion: fiduciary events older than 4 hours are demoted
          to engagement (time sensitivity expired).
        - Promotional source override: fiduciary keywords from engagement
          sources (vendor, promo) are demoted to engagement (anti-spam).
        - Health context elevation: health result notifications are elevated
          to fiduciary when the user has an active (unlocked) health persona.
        - Fiduciary overrides DND; solicited is deferred during DND;
          engagement never interrupts.
        """
        import datetime as _dt

        event_type = event.get("type", "")
        body = event.get("body", "")
        if isinstance(body, dict):
            body = json.dumps(body, default=str)
        elif not isinstance(body, str):
            body = str(body) if body is not None else ""
        source = event.get("source", "")
        priority_hint = event.get("priority", "")

        # Background sync — silent log, no notification.
        if event_type == "background_sync":
            return "silent"

        # ------------------------------------------------------------------
        # Staleness check: compute whether the event is stale (>4 hours old).
        # A fiduciary event whose time sensitivity has expired should be
        # demoted to engagement — don't interrupt for events the user can
        # no longer act on urgently.
        #
        # Only applies to events within a 24-hour window.  Events older
        # than 24 hours are treated as historical records (or factory
        # defaults), not as "stale alerts," so their priority hint is
        # respected as-is.
        # ------------------------------------------------------------------
        _STALENESS_HOURS = 4
        _STALENESS_MAX_HOURS = 24
        is_stale = False
        ts_str = event.get("timestamp", "")
        if ts_str:
            try:
                ts = _dt.datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                now = _dt.datetime.now(_dt.timezone.utc)
                age_hours = (now - ts).total_seconds() / 3600.0
                if _STALENESS_HOURS <= age_hours < _STALENESS_MAX_HOURS:
                    is_stale = True
            except (ValueError, TypeError):
                pass  # Unparseable timestamp — treat as fresh.

        # Source-based fiduciary detection — checked first.
        # Trusted sources (security, health_system, bank) are inherently
        # fiduciary regardless of age — their trust signal is the source
        # identity, not time sensitivity.
        if source in _FIDUCIARY_SOURCES:
            return "fiduciary"

        # Explicit fiduciary hint from the event.
        # Staleness demotion: if the event is >4 hours old, its time
        # sensitivity has expired — demote to engagement.
        if priority_hint == "fiduciary":
            if is_stale:
                return "engagement"
            return "fiduciary"

        # ------------------------------------------------------------------
        # Health context elevation: "lab results ready" (or similar) from a
        # trusted health portal is elevated to fiduciary when the user has
        # an active (unlocked) health persona — the results may require
        # immediate action.  Without the persona, it's routine engagement.
        # Unknown sources are NOT elevated (potential medical scam).
        # Routine scheduling (appointment reminders) is never elevated.
        # Must be checked before engagement/promotional overrides.
        # ------------------------------------------------------------------
        if (
            source not in ("unknown_sender",)
            and source not in _ENGAGEMENT_SOURCES
            and "health" in self._unlocked_personas
            and _HEALTH_RESULT_KEYWORDS.search(body)
        ):
            return "fiduciary"

        # ------------------------------------------------------------------
        # Promotional source override: engagement sources/types with
        # fiduciary keywords are marketing spam, not real emergencies.
        # Source credibility outranks keyword matching (anti-spam).
        # ------------------------------------------------------------------
        is_engagement_source = (
            source in _ENGAGEMENT_SOURCES or event_type in _ENGAGEMENT_TYPES
        )

        # Keyword-based fiduciary detection.
        if _FIDUCIARY_KEYWORDS.search(body):
            # Promotional / engagement sources override fiduciary keywords.
            if is_engagement_source:
                return "engagement"
            # Composite heuristic: unknown senders with urgent keywords
            # are a phishing vector — demote to engagement (not solicited).
            # Phishing messages should never generate notifications.
            if source in ("unknown_sender",):
                return "engagement"
            return "fiduciary"

        # Explicit solicited hint.
        if priority_hint == "solicited":
            return "solicited"

        # Type-based solicited detection.
        if event_type in _SOLICITED_TYPES:
            return "solicited"

        # Explicit engagement hint.
        if priority_hint == "engagement":
            return "engagement"

        # Type-based engagement detection.
        if event_type in _ENGAGEMENT_TYPES:
            return "engagement"

        # Source-based engagement detection.
        if source in _ENGAGEMENT_SOURCES:
            return "engagement"

        # ------------------------------------------------------------------
        # Ambiguous middle: no hard rail matched.  Consult LLM for nuanced
        # classification that keyword matching cannot provide:
        #   - casual phrasing of genuine emergencies
        #   - fake urgency from spam/phishing
        #   - context-sensitive sender importance
        # LLM failure → deterministic fallback (engagement).
        # ------------------------------------------------------------------
        llm_decision = await self._llm_classify_silence(event)
        if llm_decision is not None:
            return llm_decision

        # Deterministic fallback: engagement (Silence First).
        return "engagement"

    # ------------------------------------------------------------------
    # Event Processing (SS2.2, SS2.3)
    # ------------------------------------------------------------------

    async def process_event(self, event: dict) -> dict:
        """Process an incoming event and return an action decision.

        Steps
        -----
        1. Detect special event types (vault lifecycle, agent intent,
           DIDComm messages).
        2. Classify silence level.
        3. If engagement -> save for briefing, ACK task.
        4. If fiduciary / solicited -> assemble nudge via multi-step
           reasoning, checkpoint to scratchpad, send via core.
        5. ACK task after success; no ACK on failure.

        Returns
        -------
        dict
            Action decision dict with at least an ``action`` key.
        """
        event_type = event.get("type", "")
        task_id = event.get("task_id")

        try:
            # ---- Vault lifecycle events (SS2.2) ----
            if event_type == "vault_unlocked":
                return await self._handle_vault_unlocked(event)

            if event_type == "vault_locked":
                return await self._handle_vault_locked(event)

            if event_type == "persona_unlocked":
                return await self._handle_persona_unlocked(event)

            # ---- Agent intent review (SS2.3) ----
            if event_type == "agent_intent":
                return await self.review_intent(event)

            # ---- Delegation request (SS4.4 — Agent Safety Layer) ----
            if event_type == "delegation_request":
                return await self._handle_delegation_request(event)

            # ---- Cross-persona disclosure (SS5 — Persona Wall) ----
            if event_type == "cross_persona_request":
                return await self._handle_cross_persona_request(event)

            if event_type == "disclosure_approved":
                return await self._handle_disclosure_approved(event)

            # ---- Intent approval (SS2.3 — Agent Safety Layer) ----
            if event_type == "intent_approved":
                return await self._handle_intent_approved(event)

            # ---- Document ingestion (SS4.1) ----
            if event_type == "document_ingest":
                return await self._handle_document_ingest(event)

            # ---- Reminder fired (SS4.3) ----
            if event_type == "reminder_fired":
                return await self._handle_reminder_fired(event)

            # ---- LLM reasoning (SS10.3) ----
            if event_type == "reason":
                return await self._handle_reason(event)

            # ---- Agent response (SS19.1 — Pull Economy) ----
            if event_type == "agent_response":
                return await self._handle_agent_response(event)

            # ---- Contact neglect detection (SS17.1) ----
            if event_type == "contact_neglect":
                return await self._handle_contact_neglect(event)

            # ---- DIDComm message routing (SS2.8) ----
            if event_type and event_type.startswith("dina/"):
                return await self._handle_didcomm(event)

            # ---- Standard event processing ----
            priority = await self.classify_silence(event)

            if priority == "silent":
                log.info("guardian.silent", event_type=event_type)
                if task_id:
                    await self._ack_task(task_id)
                return {"action": "silent_log", "classification": "silent"}

            if priority == "engagement":
                if len(self._briefing_items) >= _MAX_BRIEFING_ITEMS:
                    self._briefing_items = self._briefing_items[-_MAX_BRIEFING_ITEMS // 2:]
                    log.warning("guardian.briefing.cap_reached")
                self._briefing_items.append(event)
                log.info("guardian.engagement_saved", event_type=event_type)
                if task_id:
                    await self._ack_task(task_id)
                return {"action": "save_for_briefing", "classification": "engagement"}

            # Fiduciary or solicited — needs active processing.
            # Checkpoint step 1.
            if task_id:
                await self._scratchpad.checkpoint(
                    task_id, 1, {"priority": priority, "event": event}
                )

            # Assemble nudge context.
            contact_did = event.get("contact_did")
            nudge = await self._nudge.assemble_nudge(event, contact_did)

            # Checkpoint step 2.
            if task_id:
                await self._scratchpad.checkpoint(
                    task_id,
                    2,
                    {"priority": priority, "event": event, "nudge": nudge},
                )

            # Deliver nudge to core for client push.
            if nudge:
                try:
                    await self._core.notify("default", {
                        "type": "nudge",
                        "priority": priority,
                        "nudge": nudge,
                    })
                except Exception:
                    if priority == "fiduciary":
                        raise  # must not lose fiduciary notifications
                    log.warning("guardian.nudge_delivery_failed")

            # ACK task.
            if task_id:
                await self._ack_task(task_id)
                await self._scratchpad.clear(task_id)

            action = "interrupt" if priority == "fiduciary" else "notify"
            return {
                "action": action,
                "priority": priority,
                "classification": priority,
                "nudge": nudge,
            }

        except PersonaLockedError:
            persona_id = event.get("persona_id", "unknown")
            log.warning("guardian.persona_locked", persona_id=persona_id)
            return {
                "action": "whisper_unlock_request",
                "persona_id": persona_id,
            }

        except CoreUnreachableError:
            log.error("guardian.core_unreachable")
            return {"action": "degraded_mode"}

        except Exception as exc:
            # Crash handler (SS13): sanitised one-liner to stdout,
            # full traceback to encrypted vault.
            await self._handle_crash(event, exc, task_id)
            return {"action": "error", "status": "error", "error": type(exc).__name__}

    # ------------------------------------------------------------------
    # Agent Intent Review (SS2.3.3 – SS2.3.7)
    # ------------------------------------------------------------------

    async def review_intent(self, intent: dict) -> dict:
        """Review an agent intent against privacy rules and trust level.

        Classification
        --------------
        - ``SAFE``     -> ``auto_approve`` (e.g. ``fetch_weather``, ``search``).
        - ``MODERATE`` -> ``flag_for_review`` (e.g. ``send_email``, ``draft_email``).
        - ``HIGH``     -> ``flag_for_review`` (e.g. ``transfer_money``, ``share_data``).
        - ``BLOCKED``  -> ``deny`` (e.g. untrusted bot reading vault).

        Returns
        -------
        dict
            Decision dict with ``action``, ``risk``, ``reason``,
            ``approved``, and ``requires_approval`` keys.
        """
        # Support both flat and nested (payload) action fields.
        action = intent.get("action", "")
        if not action and isinstance(intent.get("payload"), dict):
            action = intent["payload"].get("action", "")
        trust_level = intent.get("trust_level", "unknown")
        risk_hint = intent.get("risk_level", "")
        agent_did = intent.get("agent_did", "")

        # ---- Draft-Don't-Send invariant (SS20.1) ----
        # Architectural invariant: no agent may ever press Send, regardless
        # of trust level, justification, or context.  Direct-send API
        # actions are always denied.  This check runs BEFORE trust-level
        # or risk-hint evaluation — it is unconditional.
        if action in _DIRECT_SEND_ACTIONS:
            decision = IntentRisk.BLOCKED
            reason = (
                f"Draft-Don't-Send: {action} is a direct-send action. "
                f"Only drafts are permitted — no agent may ever press Send."
            )
            await self._audit_intent(intent, decision, reason)
            return {
                "action": "deny",
                "risk": decision.value,
                "reason": reason,
                "approved": False,
                "requires_approval": False,
            }

        # ---- Blocked: untrusted + vault access ----
        if trust_level == "untrusted" or action in _BLOCKED_ACTIONS:
            decision = IntentRisk.BLOCKED
            reason = f"Blocked: {action} by {trust_level} agent"
            await self._audit_intent(intent, decision, reason)
            return {
                "action": "deny",
                "risk": decision.value,
                "reason": reason,
                "approved": False,
                "requires_approval": False,
            }

        # ---- HIGH risk: requires user review (high severity) ----
        if action in _HIGH_ACTIONS or risk_hint == "high":
            decision = IntentRisk.HIGH
            reason = f"High-risk action: {action} requires user approval"
            await self._audit_intent(intent, decision, reason)
            proposal_id = await self._checkpoint_proposal(intent, decision)
            return {
                "action": "flag_for_review",
                "risk": decision.value,
                "reason": reason,
                "intent": intent,
                "approved": False,
                "requires_approval": True,
                "proposal_id": proposal_id,
            }

        # ---- MODERATE risk: requires user review ----
        if action in _MODERATE_ACTIONS or risk_hint == "risky":
            decision = IntentRisk.MODERATE
            reason = f"Moderate-risk action: {action} requires user approval"
            await self._audit_intent(intent, decision, reason)
            proposal_id = await self._checkpoint_proposal(intent, decision)
            return {
                "action": "flag_for_review",
                "risk": decision.value,
                "reason": reason,
                "intent": intent,
                "approved": False,
                "requires_approval": True,
                "proposal_id": proposal_id,
            }

        # ---- Safe: auto-approve ----
        decision = IntentRisk.SAFE
        reason = f"Safe action: {action}"
        return {
            "action": "auto_approve",
            "risk": decision.value,
            "reason": reason,
            "approved": True,
            "requires_approval": False,
        }

    async def _checkpoint_proposal(
        self, intent: dict, decision: IntentRisk
    ) -> str:
        """Store a pending proposal and checkpoint to scratchpad.

        Called when ``review_intent`` flags an action for user review.
        The proposal is written to ``_pending_proposals`` (in-memory) AND
        checkpointed to the scratchpad so that it survives a brain
        crash or restart (SS20.1 — Approval State Persistence).

        Returns the generated ``proposal_id`` so callers can include it
        in their response to the client.
        """
        proposal_id = str(uuid4())
        proposal = {
            "action": intent.get("action", ""),
            "target": intent.get("target", ""),
            "body": intent.get("body", ""),
            "risk": decision.value,
            "created_at": time.time(),
            "agent_did": intent.get("agent_did", ""),
        }
        self._pending_proposals[proposal_id] = proposal
        await self._evict_proposals()
        await self._persist_proposals()

        return proposal_id

    # ------------------------------------------------------------------
    # Daily Briefing (SS2.5)
    # ------------------------------------------------------------------

    async def generate_briefing(self) -> dict:
        """Generate the morning briefing from engagement-tier items.

        The briefing is ordered by relevance, deduplicated, and includes
        a recap of fiduciary events since the last briefing.

        Proactive scans injected into every briefing:

        1. **Contact neglect** — query contacts via ``self._core.search_vault``
           and check ``last_interaction_ts`` against the 30-day
           threshold.  Neglected contacts produce relationship nudges.
        2. **Promise staleness** — query vault for outbound messages
           containing promise patterns (``I'll send…``, ``remind me to
           send…``).  Unfulfilled promises older than 24 hours produce
           accountability nudges.

        Returns
        -------
        dict
            Briefing payload with ``items``, ``fiduciary_recap``, and
            ``count`` keys.
        """
        # ----- Proactive scan 1: contact neglect (SS17.1) -----
        await self._scan_neglected_contacts()

        # ----- Proactive scan 2: promise staleness (SS17.1) -----
        await self._scan_unfulfilled_promises()

        if not self._briefing_items:
            return {"items": [], "fiduciary_recap": [], "count": 0}

        # Scrub PII from engagement items before inclusion in briefing.
        # Outcome data must never contain user DIDs or personal names.
        scrubbed_items: list[dict] = []
        for item in self._briefing_items:
            scrubbed = dict(item)
            body = scrubbed.get("body", "")
            if body and self._scrubber is not None:
                scrubbed_text, _entities = self._scrubber.scrub(body)
                scrubbed["body"] = scrubbed_text

            # SS18.3 — Cross-persona audit annotation.
            # Items from restricted or locked personas must be annotated so
            # the user knows their briefing accessed protected data.  The
            # annotation is metadata (not PII) and intentionally survives
            # scrubbing.
            persona_tier = (scrubbed.get("persona_tier") or "open").strip().lower()
            if persona_tier in _AUDITABLE_PERSONA_TIERS:
                persona_id = scrubbed.get("persona_id", "unknown")
                scrubbed["audit_annotation"] = (
                    f"Accessed {persona_tier} persona: {persona_id}"
                )

            scrubbed_items.append(scrubbed)

        # Deduplicate by body text.
        seen_bodies: set[str] = set()
        unique_items: list[dict] = []
        for item in scrubbed_items:
            body = item.get("body", "")
            if body not in seen_bodies:
                seen_bodies.add(body)
                unique_items.append(item)

        # Sort by relevance heuristic: fiduciary recap first, then
        # by source priority.  For agent_response items (product
        # recommendations), sort by trust evidence score — sponsorship
        # NEVER boosts rank (SS19.1 Pull Economy).
        source_priority = {
            "finance": 0,
            "health_system": 1,
            "calendar": 2,
            "messaging": 3,
            "rss": 4,
            "social_media": 5,
            "podcast": 6,
            "vendor": 7,
        }

        # Separate agent_response items for trust-based ranking.
        agent_items = [
            i for i in unique_items if i.get("type") == "agent_response"
        ]
        non_agent_items = [
            i for i in unique_items if i.get("type") != "agent_response"
        ]

        non_agent_items.sort(
            key=lambda x: source_priority.get(x.get("source", ""), 99)
        )

        # Agent response items sorted by trust evidence, NOT sponsorship.
        # Score = review_count * avg_rating.  Sponsored items with equal
        # evidence are ranked BELOW unsponsored ones (tie-break penalty).
        agent_items.sort(
            key=lambda x: (
                -(
                    float((x.get("metadata") or {}).get("review_count", 0))
                    * float((x.get("metadata") or {}).get("avg_rating", 0))
                ),
                1 if (x.get("metadata") or {}).get("sponsored") else 0,
            )
        )

        unique_items = non_agent_items + agent_items

        # Gather fiduciary recap (events already delivered but worth
        # summarising in the morning briefing).
        fiduciary_recap: list[dict] = []
        try:
            # Query core for recent fiduciary events.
            results = await self._core.search_vault(
                "default",
                "priority:fiduciary",
                mode="hybrid",
            )
            if results:
                fiduciary_recap = results[:5]  # Cap at 5 most recent.
        except Exception:
            pass

        briefing = {
            "items": unique_items,
            "fiduciary_recap": fiduciary_recap,
            "count": len(unique_items),
        }

        # Clear engagement buffer after generating briefing.
        self._briefing_items = []

        log.info(
            "guardian.briefing_generated",
            item_count=briefing["count"],
            fiduciary_recap_count=len(fiduciary_recap),
        )
        return briefing

    # ------------------------------------------------------------------
    # Proactive Briefing Scans (SS17.1 — Relationship Maintenance)
    # ------------------------------------------------------------------

    async def _scan_neglected_contacts(self) -> None:
        """Scan contacts for neglected relationships and inject nudge items.

        Queries ``self._core.search_vault`` for contacts with interaction
        tracking data.  Contacts whose ``last_interaction_ts`` exceeds
        the 30-day threshold (or is ``None``) get a relationship nudge
        injected into ``_briefing_items``.
        """
        try:
            result = await self._core.search_vault(
                "default", "type:contact", mode="fts5",
            )
        except Exception:
            return

        items = []
        if isinstance(result, list):
            items = result
        elif isinstance(result, dict):
            items = result.get("items", [])
        elif isinstance(result, list):
            items = result

        if not items:
            return

        now_ts = time.time()

        for contact in items:
            name = contact.get("name", "")
            last_ts = contact.get("last_interaction_ts")
            relationship = contact.get("relationship_depth", "contact")

            if last_ts is not None:
                try:
                    days_since = (now_ts - float(last_ts)) / 86400.0
                except (ValueError, TypeError):
                    days_since = self._NEGLECT_THRESHOLD_DAYS + 1
            else:
                # No interaction record → treat as infinitely stale.
                days_since = self._NEGLECT_THRESHOLD_DAYS + 1

            if days_since > self._NEGLECT_THRESHOLD_DAYS:
                days_int = int(days_since)
                body = (
                    f"You haven't talked to {name} in {days_int} days. "
                    f"It's been a while — consider reaching out to {name}."
                )
                self._briefing_items.append({
                    "type": "relationship_nudge",
                    "source": "relationship_monitor",
                    "body": body,
                    "contact_did": contact.get("contact_did", ""),
                    "metadata": {
                        "name": name,
                        "days_silent": days_int,
                        "relationship": relationship,
                    },
                })

    async def _scan_unfulfilled_promises(self) -> None:
        """Scan vault for unfulfilled promises and inject accountability nudges.

        Queries ``self._core.search_vault`` for outbound messages
        containing promise patterns (``I'll send``, ``remind me to
        send``, etc.).  For each promise:

        - If a follow-up message to the same contact exists after the
          promise timestamp, the promise is considered fulfilled.
        - If the promise is less than 24 hours old, it is too early to
          nudge — skip it.
        - Otherwise, inject an accountability nudge.
        """
        try:
            vault_items = await self._core.search_vault(
                "default", "direction:outbound", mode="hybrid"
            )
        except Exception:
            return

        if not vault_items:
            return

        now_ts = time.time()

        # Separate promises from potential fulfilment messages.
        promises: list[dict] = []
        all_items = vault_items

        for item in all_items:
            body = item.get("body", "") or item.get("summary", "")
            direction = item.get("direction", "")
            if direction != "outbound":
                continue
            if _PROMISE_BRIEFING_PATTERNS.search(body):
                promises.append(item)

        for promise in promises:
            p_ts = promise.get("timestamp")
            if p_ts is None:
                continue

            try:
                p_ts_float = float(p_ts)
            except (ValueError, TypeError):
                continue

            age_seconds = now_ts - p_ts_float
            if age_seconds < self._PROMISE_MIN_AGE_SECONDS:
                # Promise too fresh — don't nag yet.
                continue

            contact_did = promise.get("contact_did", "")
            promise_body = promise.get("body", "") or promise.get("summary", "")

            # Check for fulfilment: a subsequent outbound message to the
            # same contact after the promise timestamp.
            fulfilled = False
            for item in all_items:
                if item is promise:
                    continue
                if item.get("contact_did") != contact_did:
                    continue
                item_ts = item.get("timestamp")
                if item_ts is None:
                    continue
                try:
                    item_ts_float = float(item_ts)
                except (ValueError, TypeError):
                    continue
                if item_ts_float > p_ts_float:
                    # There's a follow-up message → promise fulfilled.
                    fulfilled = True
                    break

            if not fulfilled:
                # Extract key details from promise text for the nudge.
                days_ago = int(age_seconds / 86400)
                # Build an accountability nudge (not engagement bait).
                body = (
                    f"You promised: \"{promise_body}\" "
                    f"({days_ago} days ago). Follow up on this commitment."
                )
                # Try to extract contact name from the contact_did.
                contact_short = contact_did.split(":")[-1] if contact_did else ""
                if contact_short:
                    body = (
                        f"You promised {contact_short}: \"{promise_body}\" "
                        f"({days_ago} days ago). Follow up on this commitment."
                    )
                self._briefing_items.append({
                    "type": "promise_nudge",
                    "source": "accountability",
                    "body": body,
                    "contact_did": contact_did,
                    "metadata": {
                        "promise_text": promise_body,
                        "days_ago": days_ago,
                    },
                })

    # ------------------------------------------------------------------
    # Document Ingestion (SS4.1 — License Renewal Story)
    # ------------------------------------------------------------------

    async def _handle_document_ingest(self, event: dict) -> dict:
        """Extract structured data from a document via LLM.

        Pipeline (the Deterministic Sandwich — ingestion boundary):
            1. PII-scrub the document text before any LLM call.
            2. Call LLM with scrubbed text for structured extraction.
            3. Rehydrate extracted field values from the ephemeral vault.
            4. Store document in vault (all PII in metadata only).
            5. Gate on confidence — only schedule reminder if critical
               fields meet the threshold (≥ 0.95).
            6. Return extraction results with per-field confidence.
        """
        body = event.get("body", "")
        persona_id = event.get("persona_id", "personal")
        source = event.get("source", "document_scan")

        # Step 1: PII-scrub the document before sending to cloud LLM.
        # Raw PII (license number, name, DOB, address) must never leave
        # the Home Node.  The entity vault creates an ephemeral mapping
        # (token → original) that we use to rehydrate after extraction.
        pii_vault: dict | None = None
        scrubbed_body = body
        if self._entity_vault:
            try:
                scrubbed_body, pii_vault = await self._entity_vault.scrub(body)
            except Exception as exc:
                log.error("guardian.document_ingest.scrub_failed", error=str(exc))
                return {
                    "status": "error",
                    "action": "document_ingested",
                    "error": "PII scrub failed — refusing to send raw PII to cloud LLM",
                }
        else:
            # No entity vault configured — cannot guarantee PII safety.
            return {
                "status": "error",
                "action": "document_ingested",
                "error": "Entity vault not available — cannot scrub PII before LLM call",
            }

        extraction_prompt = (
            "You are a document data extraction system. Extract ALL structured fields "
            "from this document text. Respond with ONLY valid JSON, no other text.\n\n"
            "Required JSON schema:\n"
            "{\n"
            '  "fields": {\n'
            '    "license_number": {"value": "...", "confidence": 0.0-1.0},\n'
            '    "holder_name": {"value": "...", "confidence": 0.0-1.0},\n'
            '    "date_of_birth": {"value": "YYYY-MM-DD", "confidence": 0.0-1.0},\n'
            '    "expiry_date": {"value": "YYYY-MM-DD", "confidence": 0.0-1.0},\n'
            '    "address": {"value": "...", "confidence": 0.0-1.0},\n'
            '    "vehicle_class": {"value": "...", "confidence": 0.0-1.0},\n'
            '    "issuing_rto": {"value": "...", "confidence": 0.0-1.0}\n'
            "  },\n"
            '  "document_type": "driving_license"\n'
            "}\n\n"
            "Set confidence to 1.0 if the field is clearly readable, lower if "
            "ambiguous. If a field is not found, set value to null and confidence to 0.0.\n"
            "Return the ORIGINAL values from the document exactly as written, even if "
            "they appear as anonymised tokens.\n\n"
            f"Document text:\n{scrubbed_body}"
        )

        # Step 2: Call LLM with scrubbed text.
        result = await self._llm.route(
            task_type="complex_reasoning",
            prompt=extraction_prompt,
            persona_tier="open",
        )

        content = result.get("content", "")

        # Parse JSON from LLM response (strip markdown fences if present).
        json_text = content.strip()
        if json_text.startswith("```"):
            lines = json_text.split("\n")
            lines = [l for l in lines if not l.strip().startswith("```")]
            json_text = "\n".join(lines)

        try:
            extracted = json.loads(json_text)
        except json.JSONDecodeError:
            log.error("guardian.document_ingest.json_parse_failed", content=content[:200])
            return {
                "status": "error",
                "action": "document_ingest_failed",
                "error": "LLM did not return valid JSON",
            }

        fields = extracted.get("fields", {})

        # Step 3: Rehydrate extracted field values — the LLM may have
        # returned PII tokens (e.g. <<PII_PERSON_1_abc>>) instead of
        # real names.  Restore originals before storing in vault metadata.
        if pii_vault and self._entity_vault:
            for field_name, field_data in fields.items():
                val = field_data.get("value")
                if isinstance(val, str) and val:
                    field_data["value"] = self._entity_vault.rehydrate(val, pii_vault)
            pii_vault.clear()

        # Step 4: Build vault items — redact ALL PII from searchable text.
        # Only metadata (encrypted at rest by SQLCipher) holds real values.
        expiry_field = fields.get("expiry_date", {})
        expiry = expiry_field.get("value")
        expiry_confidence = expiry_field.get("confidence", 0.0)
        license_num = fields.get("license_number", {}).get("value", "")

        # Summary: generic label, no PII (no holder name).
        doc_summary = "Driving License Document"

        # Body text: use the entity-vault-scrubbed text as base.
        # The two-tier scrub (Tier 1 regex + Tier 2 Presidio NER) already
        # replaced names, dates, addresses, IDs with tokens in-place.
        # String-replacing LLM-extracted values against raw text is brittle
        # because the LLM normalises formats (e.g. "15-03-1985" → "1985-03-15").
        doc_body = scrubbed_body
        pii_scrubbed: list[str] = list(
            fn for fn in _DOCUMENT_PII_FIELDS if fields.get(fn, {}).get("value")
        )

        doc_id = f"doc-{uuid4().hex[:12]}"
        doc_item = {
            "id": doc_id,
            "Type": "document",
            "Source": source,
            "Summary": doc_summary,
            "BodyText": doc_body,
            "Metadata": json.dumps({
                "document_type": "driving_license",
                "extracted_fields": fields,
                "license_number": license_num,
            }),
        }

        # Store document.
        await self._core.store_vault_item(persona_id, doc_item)

        # Create temporal event entry.
        reminder_vault_id = f"evt-{uuid4().hex[:12]}"
        reminder_item = {
            "id": reminder_vault_id,
            "Type": "event",
            "Source": "reminder_system",
            "Summary": f"License renewal due - {expiry or 'unknown'}",
            "BodyText": f"Driving license expires {expiry}. Document ID: {doc_id}",
            "Metadata": json.dumps({
                "trigger_date": expiry,
                "document_id": doc_id,
                "reminder_type": "license_expiry",
            }),
        }
        await self._core.store_vault_item(persona_id, reminder_item)

        # Step 5: Gate on confidence — only schedule reminder if the
        # critical expiry_date field meets the threshold.
        reminder_id = ""
        needs_confirmation = True
        if expiry and expiry_confidence >= _CRITICAL_CONFIDENCE:
            needs_confirmation = False
            try:
                from datetime import datetime, timedelta

                # LLM may return dates in various formats despite
                # the prompt requesting YYYY-MM-DD.
                expiry_dt = None
                for _fmt in ("%Y-%m-%d", "%d-%m-%Y", "%m-%d-%Y", "%Y/%m/%d", "%d/%m/%Y"):
                    try:
                        expiry_dt = datetime.strptime(expiry, _fmt)
                        break
                    except ValueError:
                        continue
                if expiry_dt is None:
                    raise ValueError(f"Unrecognised date format: {expiry!r}")
                trigger_dt = expiry_dt - timedelta(days=30)
                trigger_at = int(trigger_dt.timestamp())

                reminder_id = await self._core.store_reminder({
                    "type": "license_expiry",
                    "message": f"Driving license expires {expiry}",
                    "trigger_at": trigger_at,
                    "metadata": json.dumps({
                        "vault_item_id": doc_id,
                        "persona": persona_id,
                        "expiry_date": expiry,
                    }),
                })
            except Exception as exc:
                log.warning("guardian.document_ingest.reminder_failed", error=str(exc))
        elif expiry:
            log.warning(
                "guardian.document_ingest.low_confidence",
                field="expiry_date",
                confidence=expiry_confidence,
            )

        return {
            "status": "ok",
            "action": "document_ingested",
            "response": {
                "extracted_fields": fields,
                "vault_items": {
                    "document_id": doc_id,
                    "reminder_vault_id": reminder_vault_id,
                },
                "reminder_id": reminder_id,
                "pii_scrubbed": pii_scrubbed,
                "needs_confirmation": needs_confirmation,
            },
        }

    # ------------------------------------------------------------------
    # Reminder Fired (SS4.3 — License Renewal Story)
    # ------------------------------------------------------------------

    async def _handle_reminder_fired(self, event: dict) -> dict:
        """Compose a contextual notification when a reminder fires.

        Pipeline (the Deterministic Sandwich — notification boundary):
            1. Parse reminder metadata (vault_item_id, persona).
            2. Retrieve the original document from vault.
            3. Query vault for related personal context.
            4. PII-scrub the assembled prompt before cloud LLM call.
            5. Call LLM to compose a contextual notification.
            6. Rehydrate the notification, then send via Core /v1/notify.
        """
        body = event.get("body") or event.get("payload", {})
        if isinstance(body, str):
            try:
                body = json.loads(body)
            except json.JSONDecodeError:
                body = {}

        reminder_type = body.get("reminder_type", "")
        message = body.get("message", "")
        metadata_str = body.get("metadata", "{}")
        if isinstance(metadata_str, str):
            try:
                metadata = json.loads(metadata_str)
            except json.JSONDecodeError:
                metadata = {}
        else:
            metadata = metadata_str

        vault_item_id = metadata.get("vault_item_id", "")
        persona = metadata.get("persona", "personal")
        expiry_date = metadata.get("expiry_date", "")

        # Retrieve the original document from vault.
        doc_context = ""
        if vault_item_id:
            try:
                doc = await self._core.get_vault_item(persona, vault_item_id)
                if doc:
                    doc_context = (
                        f"Document: {doc.get('Summary', '')}\n"
                        f"Details: {doc.get('Metadata', '')}\n"
                    )
            except Exception as exc:
                log.warning("guardian.reminder.doc_fetch_failed", error=str(exc))

        # Query vault for personal context (address, insurance, previous renewals).
        personal_context = ""
        try:
            results = await self._core.query_vault(
                persona, "RTO renewal insurance address driving", mode="fts5", limit=10
            )
            for item in results:
                personal_context += f"- {item.get('Summary', '')}: {item.get('BodyText', '')}\n"
        except Exception as exc:
            log.warning("guardian.reminder.context_fetch_failed", error=str(exc))

        # Compose contextual notification via LLM.
        notification_prompt = (
            "You are Dina, a sovereign personal AI assistant. A reminder has fired "
            "and you need to compose a brief, helpful notification for your human.\n\n"
            f"Reminder: {message}\n"
            f"Expiry date: {expiry_date}\n\n"
        )
        if doc_context:
            notification_prompt += f"Original document:\n{doc_context}\n"
        if personal_context:
            notification_prompt += f"Related personal context:\n{personal_context}\n"
        notification_prompt += (
            "\nCompose a concise notification (2-4 sentences) that:\n"
            "1. States the specific deadline and days remaining\n"
            "2. References relevant personal context (RTO location, insurance, previous experience)\n"
            "3. Offers a concrete next step\n"
            "Be warm but concise. No emojis. No fluff."
        )

        # PII-scrub the assembled prompt before sending to cloud LLM.
        # The prompt may contain vault metadata (extracted fields, license
        # identifiers) — these must not leave the Home Node.
        # FAIL-CLOSED: if scrub fails, use the generic reminder message
        # instead of sending raw PII to the cloud LLM.
        pii_vault: dict | None = None
        scrubbed_prompt = None
        if self._entity_vault:
            try:
                scrubbed_prompt, pii_vault = await self._entity_vault.scrub(
                    notification_prompt,
                )
            except Exception as exc:
                log.error("guardian.reminder.scrub_failed", error=str(exc))

        if scrubbed_prompt is not None:
            try:
                result = await self._llm.route(
                    task_type="complex_reasoning",
                    prompt=scrubbed_prompt,
                    persona_tier="open",
                )
                notification_text = result.get("content", message)
            except Exception as exc:
                log.warning("guardian.reminder.llm_failed", error=str(exc))
                notification_text = message
        else:
            # Scrub failed or no entity vault — use the generic reminder
            # message.  Never send raw PII to the cloud LLM.
            log.warning("guardian.reminder.skipping_llm", reason="PII scrub unavailable")
            notification_text = message

        # Rehydrate PII tokens in the LLM response so the human sees
        # real names, addresses, dates — not anonymised placeholders.
        if pii_vault and self._entity_vault:
            notification_text = self._entity_vault.rehydrate(
                notification_text, pii_vault,
            )
            pii_vault.clear()

        # Send notification via Core.
        try:
            await self._core.notify("default", {
                "type": "reminder_notification",
                "priority": "solicited",
                "text": notification_text,
                "reminder_type": reminder_type,
            })
        except Exception:
            log.warning("guardian.reminder.notify_failed")

        return {
            "status": "ok",
            "action": "reminder_notification_sent",
            "response": {
                "notification_text": notification_text,
                "reminder_type": reminder_type,
                "vault_context_used": bool(personal_context),
            },
        }

    # ------------------------------------------------------------------
    # Delegation Request (SS4.4 — Agent Safety Layer)
    # ------------------------------------------------------------------

    async def _handle_delegation_request(self, event: dict) -> dict:
        """Validate and risk-assess a delegation request.

        Unlike test_08's LLM-only path, this enforces the schema
        deterministically: PII fields must NOT appear in permitted_fields
        or data_payload.  The delegation then flows through review_intent
        (share_data → HIGH risk → flag_for_review).

        Parameters
        ----------
        event:
            Must include ``payload`` dict with delegation fields:
            ``agent_did``, ``action``, ``permitted_fields``,
            ``denied_fields``, ``data_payload``, ``constraints``.
        """
        payload = event.get("payload", {})
        if not payload:
            return {
                "status": "error",
                "action": "delegation_invalid",
                "error": "Missing delegation payload",
            }

        # Required fields.
        required = ("agent_did", "action", "permitted_fields", "denied_fields")
        missing = [f for f in required if f not in payload]
        if missing:
            return {
                "status": "error",
                "action": "delegation_invalid",
                "error": f"Missing required fields: {', '.join(missing)}",
            }

        # PII enforcement: no PII field in permitted_fields or data_payload.
        permitted = set(payload.get("permitted_fields", []))
        data_payload = payload.get("data_payload", {})
        violations: list[str] = []

        for pii_field in _DOCUMENT_PII_FIELDS:
            if pii_field in permitted:
                violations.append(f"{pii_field} in permitted_fields")
            if pii_field in data_payload:
                violations.append(f"{pii_field} in data_payload")

        if violations:
            return {
                "status": "error",
                "action": "delegation_rejected",
                "error": f"PII violation: {'; '.join(violations)}",
                "violations": violations,
                "approved": False,
            }

        # Schema validated — route through intent review for risk assessment.
        intent = {
            "agent_did": payload.get("agent_did", ""),
            "action": payload.get("action", "share_data"),
            "target": payload.get("agent_name", payload.get("agent_did", "")),
            "trust_level": event.get("trust_level", "verified"),
            "risk_level": payload.get("risk_level", ""),
        }
        risk_result = await self.review_intent(intent)

        return {
            "status": "ok",
            "action": risk_result.get("action", "flag_for_review"),
            "risk": risk_result.get("risk", "HIGH"),
            "delegation_valid": True,
            "pii_clean": True,
            "approved": risk_result.get("approved", False),
            "requires_approval": risk_result.get("requires_approval", True),
        }

    # ------------------------------------------------------------------
    # Cross-Persona Disclosure (SS5 — Persona Wall)
    # ------------------------------------------------------------------

    async def _handle_cross_persona_request(self, event: dict) -> dict:
        """Handle a request for data from one persona on behalf of another.

        Enforces the Persona Wall: restricted/locked personas NEVER
        disclose automatically.  Instead, the Guardian queries the source
        vault, builds a minimal disclosure proposal (withholding specific
        diagnoses and PII), and returns it for user approval.

        Parameters
        ----------
        event:
            Must include ``payload`` dict with:
            - ``source_persona`` (str, required): persona holding the data
            - ``query`` (str, required): what the agent needs
            - ``requesting_agent`` (str): who is asking
            - ``target_persona`` (str): destination persona
            - ``source_persona_tier`` (str): tier of source persona
            - ``reason`` (str): why the data is needed
        """
        payload = event.get("payload", {})
        if not payload:
            return {
                "status": "error",
                "action": "cross_persona_invalid",
                "error": "Missing payload",
            }

        source_persona = payload.get("source_persona", "")
        query = payload.get("query", "")
        requesting_agent = payload.get("requesting_agent", "unknown_agent")
        target_persona = payload.get("target_persona", "")
        reason = payload.get("reason", "")
        # Fail-closed: default to restricted if tier not provided.
        tier = (payload.get("source_persona_tier", "restricted") or "restricted").strip().lower()
        if tier not in ("open", "restricted", "locked"):
            tier = "restricted"

        if not source_persona or not query:
            return {
                "status": "error",
                "action": "cross_persona_invalid",
                "error": "source_persona and query are required",
            }

        disclosure_id = f"disc-{uuid4().hex[:12]}"

        # Deterministic tier gate — restricted/locked always blocks auto-disclosure.
        blocked = tier in ("restricted", "locked")

        if not blocked:
            # Open tier — still generate proposal but mark as non-blocked.
            pass

        # Query source vault for relevant items.
        vault_items: list[dict] = []
        try:
            vault_items = await self._core.query_vault(
                source_persona, query, mode="fts5", limit=10,
            )
        except PersonaLockedError:
            return {
                "status": "ok",
                "action": "disclosure_proposed",
                "response": {
                    "blocked": True,
                    "block_reason": f"Persona '{source_persona}' is locked",
                    "persona_tier": tier,
                    "disclosure_id": disclosure_id,
                    "proposal": {
                        "safe_to_share": "",
                        "withheld": ["Persona is locked — all data withheld"],
                        "rationale": "Cannot access locked persona",
                    },
                    "requesting_agent": requesting_agent,
                    "source_persona": source_persona,
                    "target_persona": target_persona,
                    "query": query,
                },
                "approved": False,
                "requires_approval": True,
            }
        except Exception as exc:
            log.warning("guardian.cross_persona.vault_query_failed", error=str(exc))
            return {
                "status": "error",
                "action": "disclosure_error",
                "error": f"Vault query failed: {exc}",
                "response": {
                    "blocked": blocked,
                    "persona_tier": tier,
                    "disclosure_id": disclosure_id,
                    "requesting_agent": requesting_agent,
                    "source_persona": source_persona,
                    "query": query,
                },
                "approved": False,
                "requires_approval": blocked,
            }

        if not vault_items:
            return {
                "status": "ok",
                "action": "no_relevant_data",
                "response": {
                    "blocked": blocked,
                    "persona_tier": tier,
                    "disclosure_id": disclosure_id,
                    "requesting_agent": requesting_agent,
                    "source_persona": source_persona,
                    "query": query,
                },
                "approved": False,
                "requires_approval": blocked,
            }

        # Build disclosure proposal using deterministic scan.
        proposal = self._build_disclosure_proposal(vault_items, query)

        # Store proposal for binding verification at approval time.
        self._pending_proposals[disclosure_id] = {
            "safe_to_share": proposal.get("safe_to_share", ""),
            "withheld": proposal.get("withheld", []),
            "source_persona": source_persona,
            "created_at": time.time(),
        }
        await self._evict_proposals()
        await self._persist_proposals()

        block_reason = ""
        if blocked:
            block_reason = (
                f"Source persona '{source_persona}' has {tier} tier — "
                f"automatic cross-persona disclosure denied"
            )

        log.info(
            "guardian.cross_persona.proposal_built",
            disclosure_id=disclosure_id,
            blocked=blocked,
            safe_len=len(proposal.get("safe_to_share", "")),
            withheld_count=len(proposal.get("withheld", [])),
        )

        return {
            "status": "ok",
            "action": "disclosure_proposed",
            "response": {
                "blocked": blocked,
                "block_reason": block_reason,
                "persona_tier": tier,
                "disclosure_id": disclosure_id,
                "proposal": proposal,
                "requesting_agent": requesting_agent,
                "source_persona": source_persona,
                "target_persona": target_persona,
                "query": query,
            },
            "approved": False,
            "requires_approval": True,
        }

    def _build_disclosure_proposal(
        self, vault_items: list[dict], query: str,
    ) -> dict:
        """Build a minimal disclosure proposal from vault items.

        Uses Presidio + GLiNER NER (when available) to classify sentences
        as containing medical PII (withheld) or general health terms (safe).
        Falls back to regex patterns when the scrubber is unavailable.

        Returns dict with ``safe_to_share``, ``withheld``, ``rationale``.
        """
        safe_fragments: list[str] = []
        withheld: list[str] = []

        for item in vault_items:
            body = item.get("BodyText", "") or item.get("body_text", "") or ""
            summary = item.get("Summary", "") or item.get("summary", "") or ""
            text = f"{summary} {body}".strip()
            if not text:
                continue

            # Split into sentences for fine-grained control.
            sentences = re.split(r'(?<=[.!?])\s+', text)
            for sentence in sentences:
                sentence = sentence.strip()
                if not sentence:
                    continue

                should_withhold, detected_values = self._classify_sentence_medical(
                    sentence,
                )

                if should_withhold:
                    for val in detected_values:
                        if val not in withheld:
                            withheld.append(val)
                    continue

                # Check for general health terms — safe to propose.
                if _GENERAL_HEALTH_TERMS.search(sentence):
                    safe_fragments.append(sentence)

        # Deduplicate safe fragments.
        seen: set[str] = set()
        unique_safe: list[str] = []
        for frag in safe_fragments:
            key = frag.lower().strip()
            if key not in seen:
                seen.add(key)
                unique_safe.append(frag)

        safe_to_share = " ".join(unique_safe) if unique_safe else ""

        # Final safety net: scan safe_to_share for any medical PII that
        # slipped through sentence splitting.
        if safe_to_share:
            _, final_detections = self._classify_sentence_medical(safe_to_share)
            for val in final_detections:
                if val not in withheld:
                    withheld.append(val)
                safe_to_share = safe_to_share.replace(val, "[REDACTED]")

        if not withheld:
            withheld.append("specific diagnoses")

        rationale = (
            "Extracted general health context relevant to the query. "
            "Specific diagnoses, medications, doctor names, and hospital "
            "details have been withheld pending user approval."
        )

        return {
            "safe_to_share": safe_to_share,
            "withheld": withheld,
            "rationale": rationale,
        }

    def _classify_sentence_medical(
        self, sentence: str,
    ) -> tuple[bool, list[str]]:
        """Classify whether a sentence contains medical PII.

        Uses Presidio + GLiNER NER (via ``self._scrubber.detect()``)
        when available, falling back to regex patterns.

        Returns
        -------
        tuple[bool, list[str]]
            ``(should_withhold, detected_values)`` — True if the sentence
            contains medical entities (diagnoses, medications, doctor names),
            with the specific values that were detected.
        """
        detected_values: list[str] = []

        # Primary path: Presidio + GLiNER NER.
        if self._scrubber is not None:
            try:
                entities = self._scrubber.detect(sentence)
                for ent in entities:
                    ent_type = ent.get("type", "")
                    ent_value = ent.get("value", "")
                    if ent_type in _MEDICAL_ENTITY_TYPES:
                        detected_values.append(ent_value)
                    elif ent_type == "PERSON":
                        # Doctor names are PII — withhold.
                        detected_values.append(ent_value)
                    elif ent_type in ("ORG", "ORGANIZATION"):
                        # In medical disclosure context, ORGs are likely
                        # hospitals/clinics/pharmacies — withhold.
                        detected_values.append(ent_value)
                if detected_values:
                    return True, detected_values
            except Exception:
                # Fall through to regex fallback.
                pass

        # Fallback: regex patterns.
        if _MEDICAL_PII_REGEX_FALLBACK.search(sentence):
            matches = _MEDICAL_PII_REGEX_FALLBACK.findall(sentence)
            return True, matches

        return False, []

    _PROPOSAL_TTL = 3600.0   # 1 hour
    _PROPOSAL_MAX = 1000

    async def _persist_proposals(self) -> None:
        """Write the current ``_pending_proposals`` map to scratchpad.

        Called after every mutation (create, approve, evict) so that the
        persisted state stays in sync with RAM.  A restart will reload
        exactly the set of proposals that were live at the last mutation.
        """
        try:
            await self._scratchpad.checkpoint(
                "__proposals__", 1, {"proposals": self._pending_proposals}
            )
        except Exception:
            log.warning("guardian.proposal_persist_failed")

    async def _evict_proposals(self) -> None:
        """Remove expired and excess pending proposals and persist."""
        now = time.time()
        expired = [
            k for k, v in self._pending_proposals.items()
            if now - v.get("created_at", 0) > self._PROPOSAL_TTL
        ]
        for k in expired:
            del self._pending_proposals[k]
        if len(self._pending_proposals) > self._PROPOSAL_MAX:
            sorted_keys = sorted(
                self._pending_proposals,
                key=lambda k: self._pending_proposals[k].get("created_at", 0),
            )
            for k in sorted_keys[: len(self._pending_proposals) - self._PROPOSAL_MAX]:
                del self._pending_proposals[k]
        if expired:
            await self._persist_proposals()

    async def _handle_disclosure_approved(self, event: dict) -> dict:
        """Handle user approval of a cross-persona disclosure.

        The approved_text must match the safe_to_share from the stored
        proposal (binding check).  A final PII check gates sharing —
        if medical patterns are found, disclosure is blocked.

        Parameters
        ----------
        event:
            Must include ``payload`` dict with:
            - ``approved_text`` (str, required): text the user approved
            - ``disclosure_id`` (str): from the proposal
            - ``requesting_agent`` (str): who gets the data
            - ``source_persona`` (str): which persona it came from
        """
        payload = event.get("payload", {})
        if not payload:
            return {
                "status": "error",
                "action": "disclosure_invalid",
                "error": "Missing payload",
            }

        approved_text = payload.get("approved_text", "")
        disclosure_id = payload.get("disclosure_id", f"disc-{uuid4().hex[:12]}")
        requesting_agent = payload.get("requesting_agent", "unknown_agent")
        source_persona = payload.get("source_persona", "")

        if not approved_text:
            return {
                "status": "error",
                "action": "disclosure_invalid",
                "error": "approved_text is required",
            }

        # Look up without consuming — proposal is only removed on success.
        stored = self._pending_proposals.get(disclosure_id)
        if stored is None:
            log.warning(
                "guardian.disclosure.unknown_id",
                disclosure_id=disclosure_id,
            )
            return {
                "status": "error",
                "action": "disclosure_invalid",
                "error": f"Unknown or expired disclosure_id: {disclosure_id}",
            }

        # Binding check: approved_text must match the stored proposal.
        # On mismatch the proposal survives so the user can retry with
        # the correct text.
        expected_safe = stored.get("safe_to_share", "")
        if approved_text != expected_safe:
            log.warning(
                "guardian.disclosure.text_mismatch",
                disclosure_id=disclosure_id,
                expected_len=len(expected_safe),
                received_len=len(approved_text),
            )
            return {
                "status": "error",
                "action": "disclosure_blocked",
                "error": "approved_text does not match the generated proposal",
            }

        # Final PII check — gates sharing, not just audit.
        entities_found: list[str] = []
        medical_patterns_found: list[str] = []

        # Check with entity vault scrubber if available.
        if self._entity_vault:
            try:
                _, vault = await self._entity_vault.scrub(approved_text)
                entities_found = list(vault.keys()) if vault else []
                vault.clear() if vault else None
            except Exception as exc:
                log.warning(
                    "guardian.disclosure.scrub_check_failed",
                    error=str(exc),
                )

        # Check for medical PII — NER first, regex fallback.
        _, medical_detections = self._classify_sentence_medical(approved_text)
        for val in medical_detections:
            if val not in medical_patterns_found:
                medical_patterns_found.append(val)

        # Gate decision is based on medical patterns only.  Generic PII
        # entities (e.g. SWIFT/BIC false positives on ordinary words) are
        # audit-only — the proposal was already scrubbed for medical content.
        medical_clean = len(medical_patterns_found) == 0
        pii_clean = medical_clean

        # Write audit record to KV.
        audit_record = {
            "disclosure_id": disclosure_id,
            "requesting_agent": requesting_agent,
            "source_persona": source_persona,
            "approved_text_length": len(approved_text),
            "pii_clean": pii_clean,
            "entities_found_count": len(entities_found),
            "medical_patterns_found": medical_patterns_found,
        }
        try:
            await self._core.set_kv(
                f"disclosure:{disclosure_id}",
                json.dumps(audit_record),
            )
        except Exception as exc:
            log.warning(
                "guardian.disclosure.audit_write_failed",
                error=str(exc),
            )

        # PII gate: block only if medical patterns found.
        if not medical_clean:
            log.warning(
                "guardian.disclosure.pii_gate_blocked",
                disclosure_id=disclosure_id,
                medical_patterns=medical_patterns_found,
                entities_count=len(entities_found),
            )
            return {
                "status": "ok",
                "action": "disclosure_blocked",
                "response": {
                    "disclosure_id": disclosure_id,
                    "block_reason": "Final PII check found medical patterns in approved text",
                    "pii_check": {
                        "entities_found": entities_found,
                        "medical_patterns_found": medical_patterns_found,
                        "clean": False,
                    },
                },
                "approved": False,
                "requires_approval": True,
            }

        # Consume the proposal now that disclosure is approved and clean.
        self._pending_proposals.pop(disclosure_id, None)
        await self._persist_proposals()

        log.info(
            "guardian.disclosure.shared",
            disclosure_id=disclosure_id,
            pii_clean=pii_clean,
        )

        return {
            "status": "ok",
            "action": "disclosure_shared",
            "response": {
                "disclosure_id": disclosure_id,
                "shared_text": approved_text,
                "requesting_agent": requesting_agent,
                "source_persona": source_persona,
                "pii_check": {
                    "entities_found": entities_found,
                    "medical_patterns_found": medical_patterns_found,
                    "clean": pii_clean,
                },
            },
            "approved": True,
            "requires_approval": False,
        }

    # ------------------------------------------------------------------
    # Intent Approval Handler (SS2.3 — Agent Safety Layer)
    # ------------------------------------------------------------------

    async def _handle_intent_approved(self, event: dict) -> dict:
        """Handle user approval of a flagged agent intent.

        Looks up the pending proposal by ``proposal_id``, validates it
        hasn't expired (30-minute TTL), and marks it approved.

        Parameters
        ----------
        event:
            Must include ``payload`` dict with:
            - ``proposal_id`` (str, required): from the flag_for_review response
        """
        payload = event.get("payload", {})
        if not payload:
            return {
                "status": "error",
                "action": "intent_invalid",
                "error": "Missing payload",
            }

        proposal_id = payload.get("proposal_id", "")
        if not proposal_id:
            return {
                "status": "error",
                "action": "intent_invalid",
                "error": "proposal_id is required",
            }

        stored = self._pending_proposals.pop(proposal_id, None)
        if stored is not None:
            await self._persist_proposals()
        if stored is None:
            return {
                "status": "error",
                "action": "intent_expired",
                "error": f"Unknown or expired proposal_id: {proposal_id}",
            }

        # Validate TTL — proposals expire after 30 minutes.
        created_at = stored.get("created_at", 0)
        if time.time() - created_at > 1800:
            return {
                "status": "error",
                "action": "intent_expired",
                "error": "Proposal has expired (>30 minutes)",
            }

        # Audit the approval.
        try:
            await self._core.set_kv(
                f"intent_approval:{proposal_id}",
                json.dumps({
                    "proposal_id": proposal_id,
                    "action": stored.get("action", ""),
                    "target": stored.get("target", ""),
                    "risk": stored.get("risk", ""),
                    "agent_did": stored.get("agent_did", ""),
                    "approved_at": time.time(),
                }),
            )
        except Exception as exc:
            log.warning(
                "guardian.intent_approval.audit_write_failed",
                error=str(exc),
            )

        log.info(
            "guardian.intent_approved",
            proposal_id=proposal_id,
            action=stored.get("action", ""),
        )

        return {
            "status": "ok",
            "action": "intent_approved",
            "proposal_id": proposal_id,
            "approved": True,
            "requires_approval": False,
            "intent": {
                "action": stored.get("action", ""),
                "target": stored.get("target", ""),
                "body": stored.get("body", ""),
                "agent_did": stored.get("agent_did", ""),
            },
        }

    # ------------------------------------------------------------------
    # Agent Response Handler (SS19.1 — Pull Economy)
    # ------------------------------------------------------------------

    async def _handle_agent_response(self, event: dict) -> dict:
        """Handle agent_response events — validate attribution, deep links,
        and sponsored content disclosure.

        Pull Economy / Verified Truth (Law 2):
        - Every recommendation source must have creator_name and source_url.
        - Deep links are preferred over extracted summaries.
        - Sponsored content must carry a [Sponsored] tag.

        The validated response is saved to the briefing buffer with
        trust-based ranking metadata (review_count * avg_rating).

        Returns
        -------
        dict
            Processed response with attribution_violations, recommendations,
            deep_link_warnings, and flagged_sources.
        """
        body = event.get("body", "")
        metadata = event.get("metadata") or {}
        sponsored = metadata.get("sponsored", False) or metadata.get("affiliate_link", False)

        # --- Structured recommendations (dict body) ---
        if isinstance(body, dict):
            recommendations = body.get("recommendations", [])
        else:
            recommendations = []

        # --- Attribution & deep link validation for structured recs ---
        if recommendations:
            result = self._validate_recommendations(recommendations, body, event)
            # Save validated recommendations to briefing so they enter
            # the ranking pipeline (Finding #5: was returning without
            # appending to _briefing_items).
            briefing_item = {
                "type": "agent_response",
                "source": event.get("source", "agent"),
                "body": body,
                "metadata": metadata,
                "recommendations": result.get("recommendations", []),
                "attribution_violations": result.get("attribution_violations", 0),
            }
            self._briefing_items.append(briefing_item)
            return result

        # --- Flat agent_response (string body) — sponsored disclosure ---
        content = body if isinstance(body, str) else str(body)
        if sponsored:
            content = f"[Sponsored] {content}"

        # Save to briefing with ranking metadata.
        briefing_item = {
            "type": "agent_response",
            "source": event.get("source", "agent"),
            "body": content,
            "metadata": metadata,
        }
        self._briefing_items.append(briefing_item)

        return {
            "action": "save_for_briefing",
            "content": content,
            "body": content,
            "attribution_violations": 0,
        }

    def _validate_recommendations(
        self,
        recommendations: list[dict],
        body: dict,
        event: dict,
    ) -> dict:
        """Validate attribution and deep links for structured recommendations.

        Returns a result dict with cleaned recommendations, violation counts,
        deep link warnings, and flagged sources.
        """
        total_violations = 0
        deep_link_warnings: list[dict] = []
        flagged_sources: list[dict] = []
        output_recs: list[dict] = []

        for rec in recommendations:
            sources = rec.get("sources", [])
            clean_sources: list[dict] = []
            rec_violations = 0

            for src in sources:
                creator = (src.get("creator_name") or "").strip()
                url = (src.get("source_url") or "").strip()
                deep_link = (src.get("deep_link") or "").strip()

                has_creator = bool(creator)
                has_url = bool(url)
                has_deep_link = bool(deep_link)

                # Both missing -> serious violation, exclude source
                if not has_creator and not has_url:
                    rec_violations += 1
                    flagged_sources.append({
                        "source": src,
                        "reason": "missing_creator_name_and_source_url",
                        "violation": "both_missing",
                    })
                    continue  # exclude from output

                # Missing creator_name only
                if not has_creator:
                    rec_violations += 1
                    flagged_sources.append({
                        "source": src,
                        "reason": "missing_creator_name",
                        "violation": "creator_name_missing",
                    })

                # Missing source_url only
                if not has_url:
                    rec_violations += 1
                    flagged_sources.append({
                        "source": src,
                        "reason": "missing_source_url",
                        "violation": "source_url_missing",
                    })

                # No deep_link and no source_url -> attribution violation
                # (creator gets zero traffic)
                if not has_deep_link and not has_url:
                    rec_violations += 1
                    flagged_sources.append({
                        "source": src,
                        "reason": "no_link_to_creator",
                        "violation": "no_traffic_to_creator",
                    })

                # Build output source
                out_src = dict(src)

                # Deep link handling: strip extracted_summary when deep_link exists
                if has_deep_link:
                    out_src.pop("extracted_summary", None)

                # No deep link -> use source_url as fallback and warn
                if not has_deep_link and has_url:
                    out_src["deep_link_missing"] = True
                    deep_link_warnings.append({
                        "source": src,
                        "warning": "deep_link_unavailable",
                        "fallback": url,
                    })

                clean_sources.append(out_src)

            total_violations += rec_violations

            if clean_sources:
                out_rec = dict(rec)
                out_rec["sources"] = clean_sources
                output_recs.append(out_rec)

        return {
            "action": "agent_response_validated",
            "recommendations": output_recs,
            "attribution_violations": total_violations,
            "deep_link_warnings": deep_link_warnings,
            "flagged_sources": flagged_sources,
        }

    @staticmethod
    def _compute_trust_score(metadata: dict) -> float:
        """Compute trust-based ranking score from metadata.

        Score = review_count * avg_rating. Higher is better.
        Sponsorship is NOT a factor — it never boosts rank.
        """
        review_count = float(metadata.get("review_count", 0))
        avg_rating = float(metadata.get("avg_rating", 0))
        return review_count * avg_rating

    # ------------------------------------------------------------------
    # Vault Lifecycle Handlers (SS2.2)
    # ------------------------------------------------------------------

    async def _handle_reason(self, event: dict) -> dict:
        """Handle reason events via agentic reasoning with vault tools.

        Pipeline:
            1. PII scrub — for sensitive personas before any cloud LLM call.
            2. Agentic reasoning — LLM generates a response (scrubbed inputs).
            3. Guard scan on SCRUBBED content (pre-rehydration) — LLM classifies
               sentences.  Runs in parallel with vault density query.
               **Security: PII never reaches the guard_scan LLM call.**
            4. Rehydrate PII tokens in the response.
            5. Apply guard scan results — remove flagged sentences.  If guard_scan
               failed: deterministic regex fallback (Anti-Her, unsolicited, scope
               creep).  Safety never fails open.
            6. Density disclosure — inject honest caveats for sparse/zero data.
            7. Sponsored content tagging.

        Guard scan is decoupled from skip_vault_enrichment: vault density
        can be skipped, but safety filtering always runs.
        """
        prompt = event.get("prompt") or event.get("body") or ""
        if isinstance(prompt, dict):
            prompt = str(prompt)
        persona_tier = event.get("persona_tier", "open")
        persona_tier = (persona_tier or "open").strip().lower()
        if persona_tier not in ("open", "restricted", "locked"):
            log.warning("guardian.invalid_persona_tier", extra={"tier": persona_tier})
            persona_tier = "restricted"
        provider = event.get("provider")
        skip_vault = event.get("skip_vault_enrichment", False)

        try:
            vault = None
            llm_prompt = prompt

            # Step 1: Scrub PII before any cloud-bound LLM call.
            # The privacy boundary is the cloud, not the persona tier.
            # Open-tier prompts can contain names, addresses, employers,
            # etc. — all PII that must not reach cloud providers.
            # Local-only deployments (no cloud configured) skip scrub.
            # Scrub failure is ALWAYS fail-closed when cloud exists —
            # the router may fall back to cloud even for local-preferred
            # tasks, so we cannot guarantee local-only routing.
            if self._entity_vault and self._llm.has_cloud_provider:
                llm_prompt, vault = await self._entity_vault.scrub(llm_prompt)
                # When PII tokens are present, instruct the LLM to
                # preserve them verbatim so rehydration can restore
                # the original values after the LLM responds.
                if vault:
                    llm_prompt = _PII_PRESERVE_INSTRUCTION + llm_prompt

            # Step 2: Agentic reasoning with vault tools.
            if self._vault_context and not skip_vault:
                try:
                    ev = self._entity_vault if vault is not None else None
                    result = await self._vault_context.reason(
                        llm_prompt, persona_tier,
                        entity_vault=ev,
                        provider=provider,
                    )
                    vault_enriched = result.get("vault_context_used", False)
                    if vault_enriched:
                        log.info(
                            "guardian.reason.vault_enriched",
                            tools_called=len(result.get("tools_called", [])),
                        )
                except Exception as exc:
                    log.warning(
                        "guardian.reason.agent_failed",
                        error=str(exc),
                    )
                    result = await self._llm.route(
                        task_type="complex_reasoning",
                        prompt=llm_prompt,
                        persona_tier=persona_tier,
                        provider=provider,
                    )
                    vault_enriched = False
            else:
                result = await self._llm.route(
                    task_type="complex_reasoning",
                    prompt=llm_prompt,
                    persona_tier=persona_tier,
                    provider=provider,
                )
                vault_enriched = False

            # Step 3: Guard scan on SCRUBBED content (pre-rehydration).
            # Security: uses llm_prompt (scrubbed) not prompt (raw), and
            # result["content"] (still has PII tokens like [PERSON_1])
            # not the rehydrated version.  PII never reaches guard_scan.
            #
            # Guard scan is NOT gated by skip_vault — it's a safety filter,
            # not vault enrichment.  Vault density query IS gated.
            tool_vault = result.get("_tool_vault", {})
            if tool_vault:
                vault = {**(vault or {}), **tool_vault}

            pre_rehydrated_content = result.get("content", "")
            guard_result = None
            vault_items: list[dict] = []

            # Build parallel tasks: guard_scan always, density only when not skipped.
            guard_coro = self._guard_scan(llm_prompt, pre_rehydrated_content, persona_tier)

            if not skip_vault:
                async def _density_query() -> list[dict]:
                    items = await self._core.search_vault(
                        "personal", "trust attestation", mode="fts5",
                    )
                    return items if items else []

                results = await asyncio.gather(
                    guard_coro,
                    _density_query(),
                    return_exceptions=True,
                )
                if not isinstance(results[0], BaseException):
                    guard_result = results[0]
                else:
                    log.debug("guardian.guard_scan_failed", error=str(results[0]))
                if not isinstance(results[1], BaseException):
                    vault_items = results[1]
                else:
                    log.debug("guardian.density_query_failed", error=str(results[1]))
            else:
                # Guard scan still runs even when vault enrichment is skipped.
                try:
                    guard_result = await guard_coro
                except Exception as exc:
                    log.debug("guardian.guard_scan_failed", error=str(exc))

            # Step 4: Apply guard scan sentence removal on PRE-REHYDRATED
            # content — indices were computed on this text, so they match.
            # Rehydration happens AFTER removal to avoid sentence boundary
            # shifts from PII tokens like "Dr." or "St." that add periods.
            content = pre_rehydrated_content
            if guard_result:
                # Primary path: LLM guard scan succeeded — use its classifications.
                sentences = self._split_sentences(content)
                remove_indices: set[int] = set()
                for key in ("anti_her_sentences", "unsolicited_sentences",
                            "fabricated_sentences", "consensus_sentences"):
                    for idx in guard_result.get(key, []):
                        if isinstance(idx, int) and 1 <= idx <= len(sentences):
                            remove_indices.add(idx)
                if remove_indices:
                    content = self._remove_sentences(sentences, remove_indices)

            # Step 5: Rehydrate PII tokens in the (now cleaned) response.
            if vault and self._entity_vault:
                content = self._entity_vault.rehydrate(content, vault)
                vault.clear()

            # Step 5b: Regex fallback — runs on rehydrated content (pattern
            # matching, no indices).  Applied when guard_scan failed.
            if not guard_result:
                log.info("guardian.guard_scan_fallback_to_regex")
                content = self._apply_anti_her_filter(content)
                content = self._apply_unsolicited_discovery_filter(
                    content, prompt,
                )

            # Step 6: Density analysis and disclosure injection.
            density_meta = None
            if not skip_vault:
                entity = (
                    guard_result.get("entities") or {}
                ) if guard_result else {}
                entity_scoped = bool(entity.get("did") or entity.get("name"))

                if entity_scoped:
                    density_meta = self._analyze_trust_density(
                        vault_items, persona_tier,
                        entity_hint=entity,
                    )
                else:
                    density_meta = {
                        "tier": "zero",
                        "trust_count": 0,
                        "total_count": len(vault_items),
                        "personal_count": 0,
                        "has_rating": False,
                        "persona_tier": persona_tier,
                        "entity_scoped": False,
                    }

            if density_meta is not None:
                trust_relevant = bool(
                    guard_result and guard_result.get("trust_relevant")
                )
                if not trust_relevant and not guard_result:
                    # Regex fallback: use deterministic trust-relevance check.
                    trust_relevant = bool(_TRUST_RELEVANT_QUERY.search(prompt))
                content = self._apply_density_enforcement(
                    content, density_meta, vault_items,
                    inject_disclosure=trust_relevant,
                )

            # Step 7: Sponsored content disclosure.
            content = self._apply_sponsored_disclosure(
                content, vault_items,
            )

            # Step 8: Persist structured reasoning trace (best-effort).
            # Captures the decision path for debugging failures like
            # Story 01 test_12 (autonomous retrieval + density analysis).
            try:
                trace_meta = {
                    "prompt_preview": prompt[:100] if prompt else "",
                    "tools_called": [
                        {
                            "name": tc.get("name", ""),
                            "args_preview": str(tc.get("args", {}))[:100],
                            "result_count": tc.get("result_count", 0),
                        }
                        for tc in result.get("tools_called", [])
                    ],
                    "density_meta": density_meta,
                    "guard_scan": {
                        "ran": guard_result is not None,
                        "anti_her_removed": len(
                            guard_result.get("anti_her_sentences", [])
                        ) if guard_result else 0,
                        "unsolicited_removed": len(
                            guard_result.get("unsolicited_sentences", [])
                        ) if guard_result else 0,
                        "entity_hint": (
                            guard_result.get("entities") or {}
                        ) if guard_result else {},
                    },
                    "model": result.get("model"),
                    "vault_context_used": vault_enriched,
                    "vault_items_count": len(vault_items),
                    "response_preview": content[:200] if content else "",
                    "skip_vault": skip_vault,
                }
                await self._core.audit_append({
                    "action": "reason_trace",
                    "persona": event.get("persona_id", "personal"),
                    "requester": "brain",
                    "query_type": "reason",
                    "reason": f"vault_enriched={vault_enriched}",
                    "metadata": json.dumps(trace_meta),
                })
            except Exception:
                log.warning("guardian.reason_trace_write_failed")

            return {
                "content": content,
                "model": result.get("model"),
                "tokens_in": result.get("tokens_in"),
                "tokens_out": result.get("tokens_out"),
                "vault_context_used": vault_enriched,
            }
        except LLMError as exc:
            # Graceful degradation: no LLM available (release/offline mode).
            # Return a structured response instead of crashing.
            log.warning("guardian.reason_no_llm", error=str(exc))
            return {
                "status": "ok",
                "action": "reason_degraded",
                "classification": "solicited",
                "response": {
                    "degraded": True,
                    "reason": "No LLM provider available",
                },
                "content": "",
            }
        except Exception as exc:
            log.error("guardian.reason_failed", error=str(exc))
            raise

    # ------------------------------------------------------------------
    # Trust Density Analysis (SS19.2 — Verified Truth)
    # ------------------------------------------------------------------

    async def _guard_scan(
        self, prompt: str, content: str, persona_tier: str,
    ) -> dict | None:
        """Run a lightweight LLM guard scan on the response.

        Sends both the user prompt and numbered assistant response to a
        fast/local LLM.  The LLM classifies sentences for Anti-Her
        violations, unsolicited recommendations, fabricated trust claims,
        consensus claims, and extracts entity identifiers + trust
        relevance.

        Returns a validated dict or ``None`` on any failure.
        """
        if not content:
            return None

        sentences = self._split_sentences(content)
        if not sentences:
            return None

        numbered = "\n".join(
            f"[{i}] {s}" for i, s in enumerate(sentences, 1)
        )
        scan_prompt = _GUARD_SCAN_PROMPT.format(
            prompt=prompt,
            numbered_content=numbered,
        )

        try:
            result = await self._llm.route(
                task_type="guard_scan",
                prompt=scan_prompt,
                persona_tier=persona_tier,
            )
            raw = result.get("content", "")

            # Extract JSON from response (may be wrapped in markdown).
            json_match = re.search(r'\{[\s\S]*\}', raw)
            if not json_match:
                return None
            parsed = json.loads(json_match.group())

            if not isinstance(parsed, dict):
                return None

            # Validate and coerce fields.
            validated: dict = {}

            entities = parsed.get("entities")
            if isinstance(entities, dict):
                validated["entities"] = {
                    "did": entities.get("did") if isinstance(entities.get("did"), str) else None,
                    "name": entities.get("name") if isinstance(entities.get("name"), str) else None,
                }
            else:
                validated["entities"] = {"did": None, "name": None}

            validated["trust_relevant"] = bool(parsed.get("trust_relevant"))

            n = len(sentences)
            for key in ("anti_her_sentences", "unsolicited_sentences",
                        "fabricated_sentences", "consensus_sentences"):
                raw_list = parsed.get(key, [])
                if isinstance(raw_list, list):
                    validated[key] = [
                        idx for idx in raw_list
                        if isinstance(idx, int) and 1 <= idx <= n
                    ]
                else:
                    validated[key] = []

            return validated
        except Exception as exc:
            log.debug("guardian.guard_scan_failed", error=str(exc))
            return None

    async def _llm_classify_silence(self, event: dict) -> str | None:
        """LLM silence classification for the ambiguous middle.

        Called only when all deterministic hard rails have been exhausted.
        Returns ``"fiduciary"``, ``"solicited"``, ``"engagement"``, or
        ``None`` (triggers deterministic fallback).

        PII handling: if a cloud provider is configured, the message body
        is scrubbed before sending to the LLM.  No rehydration is needed
        because the output is a classification label, not generated text.
        """
        body = event.get("body", "")
        if isinstance(body, dict):
            body = json.dumps(body, default=str)
        elif not isinstance(body, str):
            body = str(body) if body is not None else ""

        if not body:
            return None

        # PII scrub if cloud provider exists (same invariant as _handle_reason).
        if self._entity_vault and self._llm.has_cloud_provider:
            try:
                body, _vault = await self._entity_vault.scrub(body)
            except Exception:
                log.debug("guardian.silence_classify_scrub_failed")
                return None

        # Build prompt from PII-safe metadata + (scrubbed) body.
        prompt = _SILENCE_CLASSIFY_PROMPT.format(
            event_type=event.get("type", "unknown"),
            source=event.get("source", "unknown"),
            timestamp=event.get("timestamp", "unknown"),
            active_personas=", ".join(sorted(self._unlocked_personas)) or "none",
            body=body,
        )

        try:
            result = await self._llm.route(
                task_type="silence_classify",
                prompt=prompt,
                persona_tier="open",
            )
            raw = result.get("content", "")

            json_match = re.search(r'\{[\s\S]*\}', raw)
            if not json_match:
                return None
            parsed = json.loads(json_match.group())

            if not isinstance(parsed, dict):
                return None

            decision = (parsed.get("decision") or "").lower().strip()
            confidence = float(parsed.get("confidence", 0))
            reason = parsed.get("reason", "")

            if decision not in ("fiduciary", "solicited", "engagement"):
                return None

            # Confidence gate: below threshold → engagement (Silence First).
            if confidence < _SILENCE_CONFIDENCE_THRESHOLD:
                log.info(
                    "guardian.silence_llm_low_confidence",
                    decision=decision,
                    confidence=confidence,
                    reason=reason,
                )
                return "engagement"

            log.info(
                "guardian.silence_llm_classified",
                decision=decision,
                confidence=confidence,
                reason=reason,
            )
            return decision
        except Exception as exc:
            log.debug("guardian.silence_classify_failed", error=str(exc))
            return None

    @staticmethod
    def _split_sentences(text: str) -> list[str]:
        """Split text into sentences on [.!?] followed by whitespace."""
        if not text:
            return []
        parts = re.split(r'(?<=[.!?])\s+', text.strip())
        return [p for p in parts if p.strip()]

    @staticmethod
    def _remove_sentences(
        sentences: list[str], indices: set[int],
    ) -> str:
        """Remove sentences at 1-indexed positions and rejoin."""
        kept = [
            s for i, s in enumerate(sentences, 1)
            if i not in indices
        ]
        result = " ".join(kept)
        return re.sub(r" {2,}", " ", result).strip()

    # ------------------------------------------------------------------
    # Deterministic safety fallback filters
    # ------------------------------------------------------------------

    @staticmethod
    def _apply_unsolicited_discovery_filter(
        content: str,
        prompt: str = "",
    ) -> str:
        """Strip unsolicited product recommendations from LLM output.

        Silence First (Law 1): only respond to what was asked.  The LLM
        may volunteer "you might also like..." or "related products" —
        these are push, not pull, and must be stripped.

        However, if the user explicitly asked for alternatives,
        comparisons, or recommendations, discovery is solicited and
        should be preserved.

        Used as deterministic fallback when guard_scan is unavailable.
        """
        if not content:
            return content

        solicited_discovery = re.compile(
            r"alternative|compare|comparison|recommend|suggest|"
            r"what (?:else|other)|which (?:one|product)|"
            r"options? (?:for|to)|best [\w\s]+ for",
            re.IGNORECASE,
        )
        if prompt and solicited_discovery.search(prompt):
            content = _strip_matching_sentences(content, _SCOPE_CREEP_PATTERNS)
            return content.strip()

        for pattern in (_UNSOLICITED_DISCOVERY_PATTERNS, _SCOPE_CREEP_PATTERNS):
            content = _strip_matching_sentences(content, pattern)

        related_section = re.compile(
            r"(?:^|\n)\s*(?:Related (?:products?|items?)|See also|"
            r"You may also (?:like|consider)|While you're at it):?\s*\n"
            r"(?:[-*]\s+.*\n?)*",
            re.IGNORECASE | re.MULTILINE,
        )
        content = related_section.sub("", content)

        return content.strip()

    @staticmethod
    def _apply_anti_her_filter(content: str) -> str:
        """Strip Anti-Her violations from LLM response text.

        Scans *content* against the five compiled Anti-Her pattern
        categories and removes every matching sentence (or the
        violating clause when the sentence also contains factual
        content) while preserving all factual content.

        Used as deterministic fallback when guard_scan is unavailable.
        """
        if not content:
            return content

        for pattern in _ANTI_HER_PATTERNS:
            safety = 0
            while pattern.search(content) and safety < 20:
                safety += 1
                match = pattern.search(content)
                if not match:
                    break

                m_start, m_end = match.start(), match.end()

                sent_start = 0
                for i in range(m_start - 1, -1, -1):
                    if content[i] in ".!?":
                        sent_start = i + 1
                        break

                sent_end = len(content)
                for i in range(m_end, len(content)):
                    if content[i] in ".!?":
                        sent_end = i + 1
                        break

                sentence = content[sent_start:sent_end]

                rel_start = m_start - sent_start
                rel_end = m_end - sent_start

                clause_cut = None
                for i in range(rel_end, len(sentence)):
                    if sentence[i] in ",;":
                        clause_cut = ("prefix", sent_start, sent_start + i + 1)
                        break

                if clause_cut is None:
                    for i in range(rel_start - 1, -1, -1):
                        if sentence[i] in ",;":
                            clause_cut = ("suffix", sent_start + i, sent_end)
                            break

                if clause_cut is not None:
                    _, cut_start, cut_end = clause_cut
                    remaining = content[:cut_start] + content[cut_end:]
                    leftover = remaining[
                        max(0, cut_start - 10): min(len(remaining), cut_start + 40)
                    ].strip()
                    if len(leftover) > 5:
                        content = remaining
                        continue

                content = content[:sent_start] + content[sent_end:]

        content = re.sub(r"  +", " ", content).strip()
        return content

    @staticmethod
    def _analyze_trust_density(
        vault_items: list[dict],
        persona_tier: str = "open",
        *,
        entity_hint: dict | None = None,
    ) -> dict:
        """Analyze trust data density from vault search results.

        Classifies the data into density tiers:
        - ``zero``    — no trust attestations at all
        - ``single``  — exactly 1 attestation (limited data)
        - ``sparse``  — 2-4 attestations (thin data)
        - ``moderate``— 5-9 attestations (adequate)
        - ``dense``   — 10+ attestations (strong consensus possible)

        When *entity_hint* is provided, only trust attestations related
        to the specified entity are counted.  This prevents a query about
        VendorX from picking up unrelated attestations for VendorY.

        Returns metadata dict with density tier, counts, and flags.
        """
        trust_items = [
            item for item in vault_items
            if item.get("Type", item.get("type")) == "trust_attestation"
            and item.get("Source", item.get("source")) == "trust_network"
        ]

        # Entity-scope filtering: narrow to items about the specific entity.
        if entity_hint and trust_items:
            entity_did = entity_hint.get("did", "")
            entity_name = entity_hint.get("name", "")

            if entity_did:
                # Filter by DID appearing anywhere in the item:
                # contact_did field, body text, summary, or metadata
                # (which may contain subject_did as a JSON string).
                # Trust attestations typically store the subject DID
                # in Metadata.subject_did and body text rather than
                # in the ContactDID column.
                def _did_matches(item: dict, did: str) -> bool:
                    for key_a, key_b in (
                        ("ContactDID", "contact_did"),
                        ("BodyText", "body"),
                        ("Summary", "summary"),
                        ("Metadata", "metadata"),
                    ):
                        val = item.get(key_a, item.get(key_b, "")) or ""
                        if did in val:
                            return True
                    return False

                trust_items = [
                    item for item in trust_items
                    if _did_matches(item, entity_did)
                ]
            elif entity_name:
                # Filter by entity name appearing in body or summary.
                name_lower = entity_name.lower()
                trust_items = [
                    item for item in trust_items
                    if name_lower in (
                        item.get("BodyText", item.get("body", ""))
                        or ""
                    ).lower()
                    or name_lower in (
                        item.get("Summary", item.get("summary", ""))
                        or ""
                    ).lower()
                ]

        personal_items = [
            item for item in vault_items
            if item.get("Source", item.get("source")) == "personal"
            or item.get("Type", item.get("type")) == "note"
        ]

        count = len(trust_items)
        total_count = len(vault_items)

        if count == 0:
            tier = "zero"
        elif count == 1:
            tier = "single"
        elif count < 5:
            tier = "sparse"
        elif count < 10:
            tier = "moderate"
        else:
            tier = "dense"

        # Check if the single review has a numerical rating.
        has_rating = False
        if count == 1:
            body = trust_items[0].get("BodyText", trust_items[0].get("body", ""))
            has_rating = bool(re.search(r"\d+\s*/\s*(?:5|10|100)", body))

        # entity_scoped: True when counts reflect a specific entity,
        # False when counting all trust attestations globally.
        # Enforcement uses this to decide whether entity-specific
        # caveats (single/sparse) are meaningful or misleading.
        scoped = bool(entity_hint and (entity_hint.get("did") or entity_hint.get("name")))

        return {
            "tier": tier,
            "trust_count": count,
            "total_count": total_count,
            "personal_count": len(personal_items),
            "has_rating": has_rating,
            "persona_tier": persona_tier,
            "entity_scoped": scoped,
        }

    @staticmethod
    def _apply_density_enforcement(
        content: str,
        density_meta: dict,
        vault_items: list[dict],
        *,
        inject_disclosure: bool = True,
    ) -> str:
        """Enforce Verified Truth density rules on LLM output.

        Deterministic safety floor that always runs, regardless of guard
        scan status.  Handles both structural corrections (disclosures)
        AND fabrication/consensus regex stripping tied to density tier:

        - Zero trust data: strip fabricated trust claims, inject honest
          disclosure ("no verified data in Trust Network").
        - Single review: inject "limited data" caveat, strip consensus
          language and fabricated ratings if source has none.
        - Locked persona: correct "no data" to "data inaccessible".
        - Personal notes != Trust Network reviews: correct conflation.

        The guard scan LLM provides richer NLU for these categories,
        but these regex patterns catch obvious cases even when the
        guard scan fails.

        Args:
            inject_disclosure: If False, skip the "no verified data"
                prefix.  Used for non-trust-relevant queries where
                fabrication stripping is still desired but the
                disclosure would be spurious.
        """
        tier = density_meta.get("tier", "")
        persona_tier = density_meta.get("persona_tier", "open")
        entity_scoped = density_meta.get("entity_scoped", False)

        if tier == "zero":
            # Strip fabricated trust claims when no trust data exists.
            fabricated = re.compile(
                r"(?:trust network data|verified review|trust score|"
                r"attestation|verified rating)",
                re.IGNORECASE,
            )
            if fabricated.search(content):
                content = _strip_matching_sentences(content, fabricated)

            # Strip hallucinated numerical scores when no trust data exists.
            # Gate on trust_count (not total_count) — unrelated vault items
            # don't justify fabricated numeric ratings.
            if density_meta.get("trust_count", 0) == 0:
                hallucinated = re.compile(
                    r"(?:trust score:?\s*\d|score\s+\d+|"
                    r"rat(?:e|ing)\s+(?:it\s+)?\d+(?:\.\d+)?\s*/\s*\d+|"
                    r"give\s+it\s+\d+(?:\.\d+)?\s*/\s*\d+|"
                    r"(?:I(?:'d|.would)\s+)?(?:rate|score)\s+(?:it\s+)?\d+|"
                    r"community review)",
                    re.IGNORECASE,
                )
                if hallucinated.search(content):
                    content = _strip_matching_sentences(content, hallucinated)

            # Inject honest disclosure if not already present — only for
            # trust-relevant queries.
            if inject_disclosure:
                no_data_pattern = re.compile(
                    r"no verified|no trust|no review|no attestation|"
                    r"no data|not available|could not find|no information",
                    re.IGNORECASE,
                )
                if not no_data_pattern.search(content):
                    content = (
                        "Note: no verified data available in the Trust Network. "
                        + content
                    )

            # Handle locked persona — don't claim "no data" when access denied.
            if persona_tier == "locked":
                existence_claim = re.compile(
                    r"no.*review.*exist|no one has reviewed|no verified data",
                    re.IGNORECASE,
                )
                if existence_claim.search(content):
                    content = _strip_matching_sentences(content, existence_claim)
                    content = (
                        "Note: this persona is locked — data may exist but "
                        "cannot be accessed without unlocking. " + content
                    )

            # Handle web vs trust distinction.
            if density_meta.get("personal_count", 0) > 0:
                trust_claim = re.compile(
                    r"verified.*trust.*review|trust network.*review",
                    re.IGNORECASE,
                )
                if trust_claim.search(content):
                    content = _strip_matching_sentences(content, trust_claim)

        elif tier == "single" and entity_scoped:
            limited_pattern = re.compile(
                r"only\s+(?:one|1|a single)\s+(?:verified\s+)?review|"
                r"limited\s+(?:review\s+)?data|"
                r"single\s+(?:verified\s+)?review|"
                r"one\s+(?:verified\s+)?(?:expert\s+)?review\s+available|"
                r"based\s+on\s+(?:only\s+)?(?:one|1|a single)\s+review",
                re.IGNORECASE,
            )
            if not limited_pattern.search(content):
                content = (
                    "Note: only one verified review available — limited data. "
                    + content
                )

            # Strip consensus language (inappropriate for single review).
            consensus = re.compile(
                r"reviewers?\s+(?:all\s+)?(?:agree|concur|consensus)|"
                r"(?:widely|generally|universally)\s+(?:praised|recommended)|"
                r"reviews?\s+(?:consistently|unanimously)|"
                r"multiple\s+(?:experts?|reviewers?)\s+(?:confirm|agree)|"
                r"strong\s+consensus",
                re.IGNORECASE,
            )
            if consensus.search(content):
                content = _strip_matching_sentences(content, consensus)

            # Strip fabricated additional opinions.
            fabricated = re.compile(
                r"(?:other|additional|more)\s+reviewers?\s+(?:also|have)|"
                r"(?:many|several|multiple)\s+(?:users?|reviewers?|experts?)\s+report|"
                r"user\s+(?:feedback|reports?)\s+(?:indicate|suggest|show)|"
                r"(?:mixed|conflicting)\s+(?:reviews?|opinions?)",
                re.IGNORECASE,
            )
            if fabricated.search(content):
                content = _strip_matching_sentences(content, fabricated)

            # Strip fabricated numerical rating if source has none.
            if not density_meta.get("has_rating", True):
                fab_rating = re.compile(
                    r"\d+\s*/\s*100|rating:?\s*\d+",
                    re.IGNORECASE,
                )
                if fab_rating.search(content):
                    content = _strip_matching_sentences(content, fab_rating)

        elif tier == "sparse" and entity_scoped:
            count = density_meta.get("trust_count", 0)
            limited_check = re.compile(
                r"limited|only \d|only two|only three|only four|"
                r"few|small number|not many|insufficient|sparse|thin",
                re.IGNORECASE,
            )
            if not limited_check.search(content):
                content = (
                    f"Note: only {count} trust attestations available "
                    f"— limited data. " + content
                )

        return content.strip()

    @staticmethod
    def _apply_sponsored_disclosure(
        content: str,
        vault_items: list[dict],
    ) -> str:
        """Tag sponsored content and enforce trust-based ranking in output.

        When vault search results contain items with ``sponsored: True``
        in their metadata:
        1. Inject ``[Sponsored]`` tag before sponsored product mentions.
        2. Reorder content so higher-trust products appear first
           (sponsorship never boosts rank).
        """
        if not vault_items:
            return content

        # Build product trust profiles from vault items.
        products: list[dict] = []
        sponsored_bodies: list[str] = []
        for item in vault_items:
            meta = item.get("metadata") or {}
            name = meta.get("product_name", "")
            is_sponsored = bool(meta.get("sponsored"))
            body = item.get("body", "")
            if name:
                products.append({
                    "name": name,
                    "sponsored": is_sponsored,
                    "body": body,
                })
            if is_sponsored:
                sponsored_bodies.append(body)

        sponsored_names = {
            p["name"] for p in products if p["sponsored"]
        }

        if not sponsored_names and not sponsored_bodies:
            return content

        # Step 1: Inject [Sponsored] tags before sponsored product mentions.
        sponsored_tag_re = re.compile(r"\[Sponsored\]", re.IGNORECASE)
        tagged = False
        for name in sponsored_names:
            if name.lower() in content.lower():
                # Find the position and inject tag if not already tagged.
                idx = content.lower().find(name.lower())
                if idx >= 0:
                    # Check if already tagged in the vicinity.
                    prefix = content[max(0, idx - 15):idx]
                    if not sponsored_tag_re.search(prefix):
                        content = (
                            content[:idx] + "[Sponsored] " + content[idx:]
                        )
                        tagged = True

        # Fallback: if no named products matched but sponsored vault items
        # exist and their body text overlaps with the content, inject tag.
        if not tagged and not sponsored_tag_re.search(content):
            for body in sponsored_bodies:
                # Extract key terms from the body to match against content.
                terms = [
                    w for w in body.split()
                    if len(w) > 4 and w.isalpha()
                ]
                if terms and any(t.lower() in content.lower() for t in terms[:5]):
                    content = "[Sponsored] " + content
                    break

        # Step 2: Reorder — if the content has a list-like structure
        # (numbered lines or bullet points), reorder by trust evidence
        # extracted from the body text.
        lines = content.split("\n")
        if len(lines) >= 2 and len(products) >= 2:
            # Check if lines are numbered or bulleted items about products.
            product_lines: list[tuple[int, str, str, bool]] = []
            other_lines: list[tuple[int, str]] = []

            for i, line in enumerate(lines):
                matched_product = None
                for p in products:
                    if p["name"].lower() in line.lower():
                        matched_product = p
                        break
                if matched_product:
                    product_lines.append(
                        (i, line, matched_product["name"],
                         matched_product["sponsored"])
                    )
                else:
                    other_lines.append((i, line))

            if len(product_lines) >= 2:
                # Extract trust evidence from body text.
                def _extract_trust(body: str) -> float:
                    """Extract trust score from body like '60 reviews, avg 4.6/5'."""
                    import re as _re
                    m = _re.search(r"(\d+)\s+reviews?,\s+avg\s+(\d+\.?\d*)/\d+", body)
                    if m:
                        return float(m.group(1)) * float(m.group(2))
                    return 0.0

                # Build trust scores for each product.
                trust_scores: dict[str, float] = {}
                for p in products:
                    trust_scores[p["name"]] = _extract_trust(p["body"])

                # Sort product lines by trust score descending,
                # then sponsored penalty (unsponsored wins ties).
                product_lines.sort(
                    key=lambda x: (
                        -trust_scores.get(x[2], 0),
                        1 if x[3] else 0,
                    )
                )

                # Reconstruct content with reordered product lines.
                # Renumber if numbered.
                rebuilt_lines: list[str] = []
                pi = 0  # product line index
                for orig_idx, orig_line in sorted(
                    [(i, l) for i, l in other_lines] +
                    [(pl[0], None) for pl in product_lines],
                    key=lambda x: x[0],
                ):
                    if orig_line is not None:
                        rebuilt_lines.append(orig_line)
                    else:
                        new_line = product_lines[pi][1]
                        # Renumber: replace leading "N." with correct index.
                        num_match = re.match(r"^(\d+)\.\s+", new_line)
                        if num_match:
                            new_line = f"{pi + 1}. {new_line[num_match.end():]}"
                        rebuilt_lines.append(new_line)
                        pi += 1

                content = "\n".join(rebuilt_lines)

        return content

    async def _handle_vault_unlocked(self, event: dict) -> dict:
        """Handle vault_unlocked event — initialise with decrypted data.

        Idempotent: duplicate vault_unlocked events are no-ops.
        """
        persona_id = event.get("persona_id", "default")

        if persona_id in self._unlocked_personas:
            log.info(
                "guardian.vault_unlocked.idempotent",
                persona_id=persona_id,
            )
            return {"action": "vault_already_unlocked", "persona_id": persona_id}

        self._unlocked_personas.add(persona_id)
        log.info("guardian.vault_unlocked", persona_id=persona_id)
        return {"action": "vault_unlocked", "persona_id": persona_id}

    async def _handle_vault_locked(self, event: dict) -> dict:
        """Handle vault_locked event — flush in-memory state for persona."""
        persona_id = event.get("persona_id", "default")
        self._unlocked_personas.discard(persona_id)

        # Flush any briefing items for this persona.
        self._briefing_items = [
            item
            for item in self._briefing_items
            if item.get("persona_id") != persona_id
        ]

        log.info("guardian.vault_locked", persona_id=persona_id)
        return {"action": "vault_locked", "persona_id": persona_id}

    async def _handle_persona_unlocked(self, event: dict) -> dict:
        """Handle persona_unlocked event — retry queued queries."""
        persona_id = event.get("persona_id", "default")
        self._unlocked_personas.add(persona_id)
        log.info("guardian.persona_unlocked", persona_id=persona_id)
        return {"action": "retry_query", "persona_id": persona_id}

    # ------------------------------------------------------------------
    # Contact Neglect Detection (SS17.1 — Relationship Maintenance)
    # ------------------------------------------------------------------

    _NEGLECT_THRESHOLD_DAYS = 30
    _PROMISE_MIN_AGE_SECONDS = 86400  # 24 hours — don't nag about fresh promises

    async def _handle_contact_neglect(self, event: dict) -> dict:
        """Handle contact_neglect events — detect neglected relationships.

        Queries vault for contacts, checks ``last_interaction`` or
        ``days_since_interaction`` against the 30-day threshold, and
        injects relationship nudge items into the daily briefing for
        contacts that exceed it.

        Returns
        -------
        dict
            Action decision; content may include LLM-generated nudge text.
        """
        from datetime import datetime, timezone

        metadata = event.get("metadata") or {}
        task_id = event.get("task_id")

        # Query vault for contacts matching this event.
        try:
            contacts = await self._core.search_vault(
                "default", "type:contact", mode="hybrid"
            )
        except Exception:
            contacts = []

        if not contacts:
            if task_id:
                await self._ack_task(task_id)
            return {"action": "save_for_briefing", "classification": "engagement"}

        now = datetime.now(timezone.utc)
        neglected: list[dict] = []

        for contact in contacts:
            c_meta = contact.get("metadata") or {}
            name = c_meta.get("name", "")
            if not name:
                name = contact.get("body", "").split("—")[0].strip() if contact.get("body") else ""

            last_interaction = c_meta.get("last_interaction")
            days_since = c_meta.get("days_since_interaction")

            if days_since is not None:
                try:
                    days_silent = int(days_since)
                except (ValueError, TypeError):
                    days_silent = self._NEGLECT_THRESHOLD_DAYS + 1  # treat as neglected
            elif last_interaction is not None:
                try:
                    last_dt = datetime.fromisoformat(str(last_interaction).replace("Z", "+00:00"))
                    days_silent = (now - last_dt).days
                except (ValueError, TypeError):
                    days_silent = self._NEGLECT_THRESHOLD_DAYS + 1
            else:
                # NULL/missing last_interaction → treat as neglected
                days_silent = None

            if days_silent is None or days_silent > self._NEGLECT_THRESHOLD_DAYS:
                neglected.append({
                    "name": name,
                    "days_silent": days_silent,
                    "relationship": c_meta.get("relationship", "contact"),
                    "contact_did": contact.get("contact_did", ""),
                })

        # Inject briefing items for neglected contacts.
        for nc in neglected:
            name = nc["name"]
            days = nc["days_silent"]
            if days is not None:
                body = (
                    f"You haven't talked to {name} in {days} days. "
                    f"It's been a while — consider reaching out."
                )
            else:
                body = (
                    f"{name} — no record of recent interaction. "
                    f"You might want to check in."
                )
            self._briefing_items.append({
                "type": "relationship_nudge",
                "source": "relationship_monitor",
                "body": body,
                "contact_did": nc["contact_did"],
                "metadata": nc,
            })

        # Optionally invoke LLM for a richer nudge (Anti-Her filtered).
        content = None
        if neglected:
            names = ", ".join(nc["name"] for nc in neglected if nc["name"])
            try:
                result = await self._llm.route(
                    task_type="summarize",
                    prompt=(
                        f"The user hasn't interacted with these contacts recently: "
                        f"{names}. Generate a brief, factual reminder to reach out. "
                        f"Do NOT offer yourself as a substitute for human connection. "
                        f"Do NOT say 'I'm here for you'. Just remind them to reconnect."
                    ),
                    persona_tier="open",
                )
                content = result.get("content", "")
            except Exception:
                pass

        if task_id:
            await self._ack_task(task_id)

        return {
            "action": "save_for_briefing",
            "classification": "engagement",
            "content": content,
        }

    # ------------------------------------------------------------------
    # DIDComm Message Routing (SS2.8)
    # ------------------------------------------------------------------

    async def _handle_didcomm(self, event: dict) -> dict:
        """Route DIDComm messages to the appropriate handler.

        Parses the message type (``dina/social/arrival``,
        ``dina/commerce/*``, etc.) and routes to the correct handler.
        """
        msg_type = event.get("type", "")

        for prefix, handler in _DIDCOMM_HANDLERS.items():
            if msg_type.startswith(prefix):
                log.info(
                    "guardian.didcomm",
                    msg_type=msg_type,
                    handler=handler,
                )
                # For social messages, run through nudge assembly.
                if handler == "nudge_assembly":
                    from_did = event.get("from")
                    nudge = await self._nudge.assemble_nudge(event, from_did)
                    return {
                        "action": "nudge_assembled",
                        "handler": handler,
                        "nudge": nudge,
                    }
                return {"action": "routed", "handler": handler}

        log.warning("guardian.didcomm.unknown_type", msg_type=msg_type)
        return {"action": "unhandled_didcomm", "type": msg_type}

    # ------------------------------------------------------------------
    # Task ACK Protocol (SS2.3.13 – SS2.3.15)
    # ------------------------------------------------------------------

    async def _ack_task(self, task_id: str) -> None:
        """Send ACK to core after successful task processing.

        If the ACK fails (core unreachable), we log a warning but do
        not re-raise — core will requeue after its 5-minute timeout.
        """
        try:
            await self._core.task_ack(task_id)
            log.info("guardian.task_acked", task_id=task_id)
        except Exception:
            log.warning("guardian.task_ack_failed", task_id=task_id)

    # ------------------------------------------------------------------
    # Audit Trail (SS2.3.6 – SS2.3.7)
    # ------------------------------------------------------------------

    async def _audit_intent(
        self,
        intent: dict,
        decision: IntentRisk,
        reason: str,
    ) -> None:
        """Write an audit trail entry for risky/blocked intents."""
        audit_entry = {
            "agent_did": intent.get("agent_did", ""),
            "action": intent.get("action", ""),
            "decision": decision.value,
            "reason": reason,
        }
        try:
            agent_did = (intent.get("agent_did") or "unknown")[:100]
            action = re.sub(r'[^a-zA-Z0-9_.-]', '_', (intent.get("action") or "unknown"))[:50]
            uid = uuid4().hex[:12]
            await self._core.set_kv(
                f"audit:intent:{agent_did}:{action}:{uid}",
                str(audit_entry),
            )
        except Exception:
            log.warning("guardian.audit_write_failed")

    # ------------------------------------------------------------------
    # Crash Handler (SS13)
    # ------------------------------------------------------------------

    async def _handle_crash(
        self,
        event: dict,
        exc: Exception,
        task_id: str | None,
    ) -> None:
        """Handle an unrecoverable crash.

        1. Sanitised one-liner to stdout (no PII, no traceback frames).
        2. Full traceback to encrypted vault via core API.
        3. No ACK — core will requeue the task.
        """
        # 1. Sanitised one-liner — type + first relevant line number only.
        tb = traceback.extract_tb(exc.__traceback__)
        line_info = f"line {tb[-1].lineno}" if tb else "unknown line"
        sanitised = f"guardian crash: {type(exc).__name__} at {line_info}"
        log.error("guardian.crash", summary=sanitised)

        # 2. Full traceback to encrypted vault.
        full_tb = traceback.format_exception(type(exc), exc, exc.__traceback__)
        crash_report = {
            "error": type(exc).__name__,
            "traceback": "".join(full_tb),
            "task_id": task_id or "unknown",
        }
        try:
            if task_id:
                await self._scratchpad.checkpoint(
                    task_id, -1, {"crash_report": crash_report}
                )
        except Exception:
            # Core unreachable during crash — traceback lost but task
            # will be retried on restart.
            log.warning("guardian.crash_report_failed")
