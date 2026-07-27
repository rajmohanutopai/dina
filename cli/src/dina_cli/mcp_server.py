"""Dina MCP Server — exposes Dina CLI as MCP tools for agent frameworks.

Run: dina mcp-server
OpenClaw config:
  mcp: { servers: { dina: { command: "dina", args: ["mcp-server"] } } }

All tools use the same Ed25519 signed HTTP client as the CLI.
Pure tool server — no background threads, no WS listeners.
Task execution is handled by `dina agent-daemon` (separate process).
"""

from __future__ import annotations

import json
import re
from typing import Any

from fastmcp import FastMCP

from .client import DinaClient, DinaClientError
from .config import load_config
from .session import SessionStore

mcp = FastMCP("dina")

_client: DinaClient | None = None
_sessions = SessionStore()
# New IDs carry 128 random bits. Accept the earlier 8-hex shape so an
# in-flight mapping can still be consumed across a CLI upgrade.
_PII_ID_RE = re.compile(r"^pii_(?:[0-9a-f]{8}|[0-9a-f]{32})$")


def _get_client() -> DinaClient:
    global _client
    if _client is None:
        cfg = load_config()
        _client = DinaClient(cfg)
    return _client


# ---------------------------------------------------------------------------
# Session management
# ---------------------------------------------------------------------------


@mcp.tool()
def dina_session_start(name: str = "") -> dict:
    """Start a Dina session. All subsequent actions are scoped to this session.
    Returns session ID. Always start a session before doing work."""
    c = _get_client()
    return c.session_start(name or "mcp-session")


@mcp.tool()
def dina_session_end(session_id: str) -> dict:
    """End a Dina session and revoke its scoped grants and approvals."""
    c = _get_client()
    c.session_end(session_id)
    return {"status": "ended", "session": session_id}


# ---------------------------------------------------------------------------
# Connected reasoning backend
# ---------------------------------------------------------------------------


@mcp.tool()
def dina_reasoning_backends() -> dict:
    """List the connected-Brain backend IDs selected for this exact agent.

    Use this before status, begin, or claim instead of guessing a backend ID.
    An empty list means the owner has not selected this agent as a Brain.
    """
    return _get_client().reasoning_backends()


@mcp.tool()
def dina_context_prepare(
    session: str,
    query: str,
    purpose: str = "",
    personas: list[str] | None = None,
    limit: int | None = None,
) -> dict:
    """Request bounded Dina context for this active owner conversation.

    Core decides which personas may be read, performs retrieval, minimizes and
    scrubs the returned items, and records only opaque identifiers/counts in
    audit. ``partial_pending_approval`` means some requested context is waiting
    for the owner; do not infer or replace the restricted data.

    This is the lighter context-assisted path: an answer written directly by
    this host is an agent answer using Dina context, not a Core-validated Dina
    result. Use ``dina_reasoning_begin`` and ``dina_reasoning_complete`` when
    the result must carry connected-Brain provenance and validation.
    """
    return _get_client().context_prepare(
        session=session,
        query=query,
        purpose=purpose,
        personas=personas,
        limit=limit,
    )


@mcp.tool()
def dina_memory_propose(
    session: str,
    request_id: str,
    source_text: str,
    proposal: dict[str, Any],
) -> dict:
    """Propose structured memory for Dina Core to validate and commit.

    Generate ``request_id`` once and reuse it for an exact retry. ``proposal``
    must match Core's ``memory.structure`` schema: persona, subject, facts, and
    reminderCandidates. The proposal grants no storage access. Core validates
    the persona, checks approval/lock state, writes through staging, and
    creates reminders only after the memory is stored.

    If the response is ``pending_approval``, stop and wait for the owner. A
    changed payload must use a new request ID; Core rejects changed replays.
    """
    return _get_client().memory_propose(
        session=session,
        request_id=request_id,
        source_text=source_text,
        proposal=proposal,
    )


@mcp.tool()
def dina_reasoning_status(backend_id: str, session: str) -> dict:
    """Show pending Dina reasoning work for this owner-enabled backend.

    This does not expose jobs belonging to another backend or owner. A missing
    or revoked binding is reported by Core as unavailable.
    """
    return _get_client().reasoning_status(backend_id, session)


@mcp.tool()
def dina_reasoning_begin(
    backend_id: str,
    session: str,
    task_kind: str,
    input: Any,
    purpose: str = "",
    idempotency_key: str = "",
) -> dict:
    """Begin one connected-Brain operation in the current active host turn.

    Core returns ``submission`` plus either a ``claim`` or null. If a claim is
    present, reason only from its ``input`` and optional ``context``. Produce
    JSON matching ``resultSchema`` exactly, then call
    ``dina_reasoning_complete`` with every opaque claim field unchanged.

    The result is a proposal. Do not perform external effects, write Dina
    storage, use owner keys, or claim authority from this operation.
    """
    return _get_client().reasoning_begin(
        backend_id=backend_id,
        session=session,
        task_kind=task_kind,
        input_data=input,
        purpose=purpose,
        idempotency_key=idempotency_key,
    )


@mcp.tool()
def dina_reasoning_claim(
    backend_id: str,
    session: str,
    lease_ms: int = 120_000,
) -> dict:
    """Claim one queued Dina reasoning job for this exact backend.

    A null ``claim`` means no eligible work. For a claim, use only its bounded
    input/context and return JSON matching ``resultSchema``. Never infer access
    to a vault, identity key, effect, or source not included in the claim.
    """
    return _get_client().reasoning_claim(
        backend_id=backend_id,
        session=session,
        lease_ms=lease_ms,
    )


@mcp.tool()
def dina_reasoning_heartbeat(
    task_id: str,
    backend_id: str,
    session: str,
    claim_id: str,
    context_ticket_id: str,
    lease_ms: int = 120_000,
) -> dict:
    """Renew the exact reasoning claim while work is still in progress.

    A stale-claim response is final for this attempt. Stop immediately and do
    not submit its result.
    """
    return _get_client().reasoning_heartbeat(
        task_id=task_id,
        backend_id=backend_id,
        session=session,
        claim_id=claim_id,
        context_ticket_id=context_ticket_id,
        lease_ms=lease_ms,
    )


@mcp.tool()
def dina_reasoning_complete(
    task_id: str,
    backend_id: str,
    session: str,
    claim_id: str,
    context_ticket_id: str,
    execution_id: str,
    policy_snapshot_hash: str,
    context_projection_hash: str | None,
    result: Any,
    evidence_ids: list[str] | None = None,
) -> dict:
    """Submit a schema-conforming reasoning proposal to Dina Core.

    Copy all opaque IDs and hashes from the claim exactly. Cite only IDs in
    ``allowedEvidenceIds``. ``accepted: true`` means Core accepted the
    reasoning completion; it does not prove any later external effect unless
    the returned Core-owned receipt explicitly says so.
    """
    return _get_client().reasoning_complete(
        task_id=task_id,
        backend_id=backend_id,
        session=session,
        claim_id=claim_id,
        context_ticket_id=context_ticket_id,
        execution_id=execution_id,
        policy_snapshot_hash=policy_snapshot_hash,
        context_projection_hash=context_projection_hash,
        result=result,
        evidence_ids=evidence_ids,
    )


@mcp.tool()
def dina_reasoning_fail(
    task_id: str,
    backend_id: str,
    session: str,
    claim_id: str,
    context_ticket_id: str,
    error: str,
    retryable: bool = True,
) -> dict:
    """Report that this exact reasoning attempt could not be completed.

    Use ``retryable=false`` only for a permanent incompatibility such as an
    unsupported task contract. Core, not the model, decides whether work is
    requeued or terminal.
    """
    return _get_client().reasoning_fail(
        task_id=task_id,
        backend_id=backend_id,
        session=session,
        claim_id=claim_id,
        context_ticket_id=context_ticket_id,
        error=error,
        retryable=retryable,
    )


# ---------------------------------------------------------------------------
# Action validation (safety layer)
# ---------------------------------------------------------------------------


@mcp.tool()
def dina_validate(
    action: str,
    description: str,
    session: str,
    context: dict | None = None,
    count: int = 1,
    reversible: bool = False,
) -> dict:
    """Validate an action before executing it. Dina checks risk and user policy.

    CRITICAL: If status is 'pending_approval', do NOT execute the action.
    The human will be notified in Dina. Wait for dina_validate_status
    to return 'approved' before proceeding. Never assume approval.

    Args:
        action: Action type (e.g. 'search', 'send_email', 'delete_files')
        description: What the action does
        session: Session ID from dina_session_start
        context: Display-only metadata for the human reviewer
                 (e.g. {"to": "user@co.com", "subject": "Report", "attachment_count": 2})
        count: Number of items affected
        reversible: Whether the action can be undone
    """
    c = _get_client()
    payload: dict[str, Any] = {
        "action": action,
        "target": description,
        "count": count,
        "reversible": reversible,
    }
    if context:
        payload["context"] = context

    result = c.process_event({
        "type": "agent_intent",
        "action": action,
        "target": description,
        "payload": payload,
    }, session=session)

    approved = result.get("approved", False)
    requires = result.get("requires_approval", False)
    proposal_id = result.get("proposal_id", "")

    if approved and not requires:
        status = "approved"
    elif requires:
        status = "pending_approval"
    else:
        status = "denied"

    out: dict[str, Any] = {
        "status": status,
        "risk": result.get("risk", ""),
    }
    if proposal_id:
        out["proposal_id"] = proposal_id
    return out


@mcp.tool()
def dina_validate_status(proposal_id: str, session: str) -> dict:
    """Check approval status of a pending action.
    Returns status: 'approved', 'pending', 'denied', or 'expired'.
    Only proceed with the action when status is 'approved'."""
    c = _get_client()
    return c.get_proposal_status(proposal_id, session=session)


# ---------------------------------------------------------------------------
# Vault operations
# ---------------------------------------------------------------------------


@mcp.tool()
def dina_ask(query: str, session: str) -> dict:
    """Ask Dina a question. She reasons over the encrypted vault.

    The response can come back in three shapes — handle ALL THREE:

      1. SYNCHRONOUS COMPLETE — status: 'complete', content: '<answer>'.
         Done. Use the answer.

      2. STILL REASONING — status: 'in_flight', request_id: '<id>'.
         Brain hasn't finished within the fast-path window (typically a
         few seconds). Poll dina_ask_status(request_id) until you see a
         terminal status: complete | failed | expired | denied.

      3. PENDING APPROVAL — status: 'pending_approval', request_id:
         '<id>', persona: '<name>'. The query touched a closed/sensitive
         vault and needs human approval. CRITICAL: do NOT proceed with
         downstream work that depends on the answer. Poll
         dina_ask_status(request_id) until status becomes 'complete' (the
         operator approved AND Brain finished) OR 'denied' / 'expired'
         (treat as no-data).

    Polling cadence: 1–5 seconds for in_flight, 5–15 seconds for
    pending_approval (humans take longer than reasoning). Time out and
    surface the wait to the user after a few minutes — never assume
    approval, never silently treat 'denied' as 'complete'.

    The reasoning answer (when status is eventually 'complete') is in
    the 'content' field of the dina_ask_status response.
    """
    c = _get_client()
    return c.ask(query, session=session)


@mcp.tool()
def dina_ask_status(request_id: str, session: str) -> dict:
    """Poll a previously-issued dina_ask. Returns one of:

      - status: 'complete', content: '<answer>'  → use the answer
      - status: 'in_flight'                       → keep polling
      - status: 'pending_approval'                → user hasn't decided yet
      - status: 'denied'                          → user said no — abort
      - status: 'failed', error: '<msg>'          → reasoning hit an error
      - status: 'expired'                         → request timed out — abort

    Pair with dina_ask. Use the request_id from the original
    dina_ask response. NEVER short-circuit a pending decision: 'denied'
    and 'expired' both mean "no data" — never substitute heuristics or
    cached values when the user has explicitly declined or let the
    request lapse.
    """
    c = _get_client()
    return c.ask_status(request_id, session=session)


@mcp.tool()
def dina_remember(
    text: str, session: str, request_id: str, persona: str = ""
) -> dict:
    """Store a fact through Dina's session-bound coding-agent memory ingress.

    Dina classifies the memory into the appropriate vault unless ``persona`` is
    explicitly supplied. ``request_id`` must be stable across retries. The
    result can be ``processing`` or ``pending_approval``; poll
    ``dina_remember_status`` and do not claim the memory was stored until that
    tool returns ``stored``.
    """
    c = _get_client()
    return c.remember(
        text, session=session, source_id=request_id, persona=persona
    )


@mcp.tool()
def dina_remember_status(item_id: str, session: str) -> dict:
    """Poll an agent-owned Remember operation until it is stored or terminal.

    ``pending_approval`` means the owner must decide on their phone. Never
    bypass it. ``denied`` and ``failed`` are terminal and mean the memory was
    not stored.
    """
    c = _get_client()
    return c.remember_check(item_id, session=session)


# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------


@mcp.tool()
def dina_find_service(
    session: str,
    intent: str = "",
    capability: str = "",
    query: str = "",
    lat: float | None = None,
    lng: float | None = None,
    radius_km: float | None = None,
    limit: int = 10,
) -> dict:
    """Find a Dina service by natural-language intent or exact capability.

    Supply exactly one of ``intent`` or ``capability``. Results include the
    provider DID, listing URI, capability schema, and schema hash needed by
    ``dina_invoke_service``. Discovery is read-only and never sends vault data.
    """
    return _get_client().find_services(
        session=session,
        intent=intent,
        capability=capability,
        query=query,
        lat=lat,
        lng=lng,
        radius_km=radius_km,
        limit=limit,
    )


@mcp.tool()
def dina_publish_service(
    rkey: str, config: dict, session: str, request_id: str
) -> dict:
    """Ask the owner to save one service listing owned by this Dina.

    ``request_id`` is a stable idempotency key and must be reused on retries.
    ``pending_approval`` means wait for the owner and poll
    ``dina_action_status(action="service_publish")``. Only a completed action
    means the exact approved config was saved. Public/unlisted PDS publication
    remains asynchronous; then poll ``dina_service_publication_status``.
    """
    return _get_client().publish_service(
        rkey=rkey,
        config=config,
        session=session,
        request_id=request_id,
    )


@mcp.tool()
def dina_invoke_service(
    to_did: str,
    capability: str,
    params: dict,
    session: str,
    request_id: str,
    schema_hash: str = "",
    service_uri: str = "",
    service_name: str = "",
    grant_id: str = "",
    ttl_seconds: int = 60,
) -> dict:
    """Invoke a selected Dina service through signed D2D messaging.

    Use provider/listing/schema fields returned by ``dina_find_service``.
    ``request_id`` must be stable across retries. ``pending_approval`` means do
    not invoke or bypass; poll ``dina_action_status(action="service_invoke")``.
    Once completed, the result remains asynchronous; poll
    ``dina_service_status`` with ``service_task_id``.
    """
    return _get_client().send_service_query(
        to_did=to_did,
        capability=capability,
        params=params,
        session=session,
        request_id=request_id,
        schema_hash=schema_hash,
        service_uri=service_uri,
        service_name=service_name,
        grant_id=grant_id,
        ttl_seconds=ttl_seconds,
    )


@mcp.tool()
def dina_service_status(task_id: str, session: str) -> dict:
    """Poll an invocation created by this same agent session."""
    return _get_client().service_query_status(task_id=task_id, session=session)


@mcp.tool()
def dina_service_publication_status(rkey: str, session: str) -> dict:
    """Check whether an owned listing reached its PDS.

    ``pending`` may include a retry time after a transient outage.
    ``published`` includes the committed AT URI and CID. ``failed`` is a
    permanent validation/credential rejection that needs owner action.
    ``not_configured`` means no PDS identity is wired, so no retry can run.
    """
    return _get_client().service_publication_status(rkey=rkey, session=session)


# ---------------------------------------------------------------------------
# PeerLens
# ---------------------------------------------------------------------------


@mcp.tool()
def dina_peerlens(
    session: str,
    query: str = "",
    category: str = "",
    domain: str = "",
    subject_type: str = "",
    sentiment: str = "",
    min_confidence: str = "",
    author_did: str = "",
    tags: list[str] | None = None,
    sort: str = "relevant",
    limit: int = 10,
) -> dict:
    """Search signed public PeerLens reviews through Dina.

    This is a bounded, read-only AppView query. Results are public review
    evidence, not private vault context. Use ``dina_ask`` separately when the
    answer also needs the owner's private preferences or history.
    """
    return _get_client().search_peerlens(
        session=session,
        query=query,
        category=category,
        domain=domain,
        subject_type=subject_type,
        sentiment=sentiment,
        min_confidence=min_confidence,
        author_did=author_did,
        tags=tags,
        sort=sort,
        limit=limit,
    )


@mcp.tool()
def dina_review(record: dict, session: str, request_id: str) -> dict:
    """Ask the owner to publish one public PeerLens review.

    ``record`` may contain only subject, category, sentiment, dimensions, text,
    tags, domain, evidence, and confidence. Core stamps createdAt and marks the
    review as agent-generated. ``request_id`` is a stable idempotency key:
    generate it once and reuse it for every retry and ``dina_review_status``
    poll. A ``pending_approval`` result means nothing has been published. Do
    not claim success while approval is pending, and do not publish by another
    route.
    """
    return _get_client().publish_review(
        record=record,
        session=session,
        request_id=request_id,
    )


@mcp.tool()
def dina_review_status(request_id: str, session: str) -> dict:
    """Poll an owner-approved review through durable PDS publication.

    Pending means wait, including ``pending_approval``. ``cancelled`` means the
    owner denied or withdrew the request. ``queued`` or ``publishing`` means
    Core owns the durable retry and the agent must not create another review.
    ``published`` includes the AT URI/CID. ``failed`` is terminal and includes
    an actionable error code.
    """
    return _get_client().review_status(request_id=request_id, session=session)


# ---------------------------------------------------------------------------
# Vault metadata + reminders
# ---------------------------------------------------------------------------


@mcp.tool()
def dina_vaults(session: str) -> dict:
    """List the owner's Dina vaults without reading their contents.

    The result contains metadata and whether this exact agent session may read
    each vault. ``approval_required`` is informational; use ``dina_ask`` for a
    real question and follow its approval flow rather than trying to access
    storage directly.
    """
    return _get_client().list_vaults(session=session)


@mcp.tool()
def dina_reminders(session: str, limit: int = 50) -> dict:
    """List active reminders visible to this exact Dina session.

    Core derives readable vaults from the authenticated agent and session. The
    caller cannot select or bypass a restricted vault. The response may report
    that additional reminders are restricted; use ``dina_ask`` and its normal
    approval flow if the user asks about protected context.
    """
    return _get_client().list_reminders(session=session, limit=limit)


# ---------------------------------------------------------------------------
# Talk + delegation
# ---------------------------------------------------------------------------


@mcp.tool()
def dina_talk(
    contact: str,
    text: str,
    session: str,
    request_id: str,
    in_reply_to: str = "",
) -> dict:
    """Ask Dina to send one exact message to a known contact.

    ``request_id`` is an idempotency key chosen by the caller. Generate it once
    for this intended message and reuse it for every retry and status poll.
    A normal first response is ``pending_approval``. Do not claim the message
    was sent and do not bypass the decision; poll ``dina_action_status`` until
    it returns ``completed`` or a terminal denial/failure.
    """
    return _get_client().talk(
        contact=contact,
        text=text,
        session=session,
        request_id=request_id,
        in_reply_to=in_reply_to,
    )


@mcp.tool()
def dina_delegate(
    runner: str,
    description: str,
    input: dict,
    session: str,
    request_id: str,
) -> dict:
    """Ask Dina to queue one bounded task for an external agent runner.

    ``request_id`` must be generated once and reused. The task is not created
    until the owner approves the exact runner and description. Poll
    ``dina_action_status`` with action ``delegate``; a completed facade action
    includes ``delegation_task_id`` and the delegated task's live status.
    """
    return _get_client().delegate(
        runner=runner,
        description=description,
        input_data=input,
        session=session,
        request_id=request_id,
    )


@mcp.tool()
def dina_action_status(action: str, request_id: str, session: str) -> dict:
    """Poll a bounded facade request and continue it only after approval.

    ``action`` is ``talk``, ``delegate``, ``service_publish``, or
    ``service_invoke``. Pending means wait. Cancelled means the owner denied or
    withdrew it. Completed means the exact approved action reached Dina's
    durable transport/store; inspect the action-specific receipt.
    """
    return _get_client().action_status(
        action=action,
        request_id=request_id,
        session=session,
    )


# ---------------------------------------------------------------------------
# Task lifecycle — called by agent when task work is done
# ---------------------------------------------------------------------------


@mcp.tool()
def dina_task_complete(task_id: str, result: str) -> dict:
    """Report that a delegated task is complete.

    IMPORTANT: Call this when you have finished the task. Include a summary
    of what you did and any results. The user will see this in /taskstatus.

    Args:
        task_id: The task ID (from the task prompt)
        result: Human-readable summary of what was accomplished
    """
    c = _get_client()
    c.task_complete(task_id, result)
    return {"status": "completed", "task_id": task_id}


@mcp.tool()
def dina_task_fail(task_id: str, error: str) -> dict:
    """Report that a delegated task failed.

    Call this if you cannot complete the task for any reason.

    Args:
        task_id: The task ID (from the task prompt)
        error: What went wrong
    """
    c = _get_client()
    c.task_fail(task_id, error)
    return {"status": "failed", "task_id": task_id}


@mcp.tool()
def dina_task_progress(task_id: str, message: str) -> dict:
    """Report progress on a running task (optional).

    Args:
        task_id: The task ID (from the task prompt)
        message: Human-readable progress note
    """
    c = _get_client()
    c.task_progress(task_id, message)
    return {"status": "ok", "task_id": task_id}


# ---------------------------------------------------------------------------
# PII scrubbing
# ---------------------------------------------------------------------------


@mcp.tool()
def dina_scrub(text: str) -> dict:
    """Remove PII from text. Returns scrubbed text + pii_id for rehydration.
    Always scrub before passing user content to external APIs."""
    c = _get_client()
    result = c.pii_scrub(text)
    scrubbed = result.get("scrubbed", text)
    entities = result.get("entities", [])
    if not isinstance(scrubbed, str) or not isinstance(entities, list):
        raise DinaClientError("Core returned a malformed PII scrub response")

    pii_id = _sessions.new_id()
    # Persist an empty mapping too: rehydrating text with no detected PII
    # should be a valid identity operation, not a missing-session error.
    _sessions.save(pii_id, entities)
    return {"scrubbed": scrubbed, "pii_id": pii_id}


@mcp.tool()
def dina_rehydrate(text: str, pii_id: str) -> dict:
    """Restore PII tokens after an external API returns.

    Use only the pii_id returned by dina_scrub. Rehydration happens locally;
    the original values are not sent back to Core or another service.
    """
    if _PII_ID_RE.fullmatch(pii_id) is None:
        raise ValueError("Invalid pii_id; use the value returned by dina_scrub")
    try:
        restored = _sessions.rehydrate(text, pii_id, consume=True)
    except (FileNotFoundError, ValueError) as exc:
        raise ValueError(f"PII session {pii_id} was not found or has expired") from exc
    return {"restored": restored}


@mcp.tool()
def dina_status() -> dict:
    """Check Dina connectivity, pairing, and identity."""
    c = _get_client()
    try:
        c._request(c._core, "GET", "/healthz")
        # /healthz is public and proves reachability only. This caller-scoped
        # route proves the current did:key is actually paired and authorized.
        c.session_list()
        did = c._identity.did()
        return {"status": "connected", "paired": True, "did": did}
    except Exception as e:
        return {"status": "unavailable", "paired": False, "error": str(e)}


def configure_profile(profile: str) -> None:
    """Remove tools that do not belong to the selected host contract."""
    reasoning_tools = (
        "dina_reasoning_backends",
        "dina_context_prepare",
        "dina_memory_propose",
        "dina_reasoning_status",
        "dina_reasoning_begin",
        "dina_reasoning_claim",
        "dina_reasoning_heartbeat",
        "dina_reasoning_complete",
        "dina_reasoning_fail",
    )
    runner_tools = (
        "dina_task_complete",
        "dina_task_fail",
        "dina_task_progress",
    )
    if profile == "coding":
        for name in (*runner_tools, *reasoning_tools):
            mcp.remove_tool(name)
        return
    if profile == "connected":
        for name in runner_tools:
            mcp.remove_tool(name)
        return
    if profile == "brain":
        for name in (
            "dina_validate",
            "dina_validate_status",
            "dina_ask",
            "dina_ask_status",
            "dina_remember",
            "dina_remember_status",
            "dina_find_service",
            "dina_publish_service",
            "dina_invoke_service",
            "dina_service_status",
            "dina_service_publication_status",
            "dina_peerlens",
            "dina_review",
            "dina_review_status",
            "dina_vaults",
            "dina_reminders",
            "dina_talk",
            "dina_delegate",
            "dina_action_status",
            *runner_tools,
            "dina_scrub",
            "dina_rehydrate",
        ):
            mcp.remove_tool(name)
        return
    if profile != "all":
        raise ValueError(f"unknown MCP profile: {profile}")


def run_server(profile: str = "all"):
    """Entry point for `dina mcp-server`. Pure tool server, no background threads."""
    configure_profile(profile)
    mcp.run(transport="stdio")
