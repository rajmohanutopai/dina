"""Shared user-command service — transport-agnostic business logic.

This service handles contact management, trust publishing, trust queries,
status, and D2D send.  It is called by Telegram, admin CLI, and admin web UI.
Each transport adds its own access control, formatting, and confirmation flow.

All methods return plain Python dicts/strings — never Telegram or HTTP objects.
"""

from __future__ import annotations

import logging
import re
import urllib.parse
from dataclasses import dataclass
from typing import Any

log = logging.getLogger(__name__)

# ── Validation ──────────────────────────────────────────────────────────────

# Contact name: letters, numbers, spaces, hyphens, underscores. 1-30 chars.
_VALID_NAME = re.compile(r"^[A-Za-z0-9 _-]{1,30}$")

# DID format: did:plc:<base32 chars>
_VALID_DID = re.compile(r"^did:plc:[a-z2-7]{24,}$")


def validate_name(name: str) -> str | None:
    """Validate contact/product name. Returns error message or None if valid."""
    if not name:
        return "Name cannot be empty."
    if not _VALID_NAME.match(name):
        return "Name must be 1-30 characters: letters, numbers, spaces, hyphens only."
    return None


def validate_did(did: str) -> str | None:
    """Validate DID format. Returns error message or None if valid."""
    if not did:
        return "DID cannot be empty."
    if not _VALID_DID.match(did):
        return "Invalid DID format. Expected: did:plc:<base32> (e.g., did:plc:hi6cgfg6m2fhju4sbnl7xubr)"
    return None


# ── Result types ────────────────────────────────────────────────────────────

@dataclass
class CommandResult:
    """Outcome of a user command."""
    ok: bool
    message: str
    data: dict | None = None


# ── Service ─────────────────────────────────────────────────────────────────

class UserCommandService:
    """Transport-agnostic user command handler.

    Parameters
    ----------
    core:
        CoreClient (adapter/core_http.py) — HTTP client for dina-core.
    pds_publisher:
        Optional PDSPublisher for trust record publishing.
    """

    def __init__(self, core: Any, pds_publisher: Any = None) -> None:
        self._core = core
        self._pds_publisher = pds_publisher

    @property
    def pds_publisher(self) -> Any:
        return self._pds_publisher

    @pds_publisher.setter
    def pds_publisher(self, pub: Any) -> None:
        self._pds_publisher = pub

    # ── Status ──────────────────────────────────────────────────────────

    async def get_status(self) -> CommandResult:
        """Return DID, health status, and version."""
        try:
            resp = await self._core._request("GET", "/healthz")
            health = resp.json()
            did = "unknown"
            try:
                did_resp = await self._core._request("GET", "/v1/did")
                did = did_resp.json().get("id", "unknown")
            except Exception:
                pass
            return CommandResult(
                ok=True,
                message="OK",
                data={
                    "did": did,
                    "status": health.get("status", "?"),
                    "version": health.get("version", "?"),
                },
            )
        except Exception as exc:
            return CommandResult(ok=False, message=f"Health check failed: {exc}")

    # ── Contact Management ──────────────────────────────────────────────

    async def list_contacts(self) -> CommandResult:
        """List all contacts."""
        try:
            resp = await self._core._request("GET", "/v1/contacts")
            contacts = resp.json().get("contacts", [])
            return CommandResult(ok=True, message="OK", data={"contacts": contacts})
        except Exception as exc:
            return CommandResult(ok=False, message=f"Failed to list contacts: {exc}")

    _VALID_RELATIONSHIPS = frozenset({
        "spouse", "child", "parent", "sibling", "friend",
        "colleague", "acquaintance", "unknown",
    })
    _VALID_RESPONSIBILITIES = frozenset({
        "household", "care", "financial", "external",
    })

    async def add_contact(
        self, name: str, did: str, relationship: str = "unknown",
    ) -> CommandResult:
        """Add a contact. Validates name and DID before adding."""
        err = validate_name(name)
        if err:
            return CommandResult(ok=False, message=err)
        err = validate_did(did)
        if err:
            return CommandResult(ok=False, message=err)

        # Check duplicate
        existing = await self.resolve_contact_did(name)
        if existing:
            return CommandResult(
                ok=False,
                message=f"Contact '{name}' already exists. Delete it first or use a different name.",
            )

        body: dict = {"did": did, "name": name, "trust_level": "verified"}
        if relationship and relationship != "unknown":
            if relationship not in self._VALID_RELATIONSHIPS:
                return CommandResult(
                    ok=False,
                    message=f"Invalid relationship. Valid: {', '.join(sorted(self._VALID_RELATIONSHIPS))}",
                )
            body["relationship"] = relationship

        try:
            await self._core._request("POST", "/v1/contacts", json=body)
            return CommandResult(
                ok=True,
                message=f"Contact added: {name}",
                data={"name": name, "did": did, "relationship": relationship},
            )
        except Exception as exc:
            return CommandResult(ok=False, message=f"Failed to add contact: {exc}")

    async def set_relationship(self, name: str, relationship: str) -> CommandResult:
        """Set the relationship type for an existing contact.

        Also recomputes data_responsibility unless it was explicitly overridden.
        """
        if relationship not in self._VALID_RELATIONSHIPS:
            return CommandResult(
                ok=False,
                message=f"Invalid relationship. Valid: {', '.join(sorted(self._VALID_RELATIONSHIPS))}",
            )

        did = await self.resolve_contact_did(name)
        if not did:
            return CommandResult(ok=False, message=f"Contact '{name}' not found.")

        try:
            await self._core._request(
                "PUT", f"/v1/contacts/{urllib.parse.quote(did, safe='')}",
                json={"relationship": relationship},
            )
            return CommandResult(
                ok=True,
                message=f"Relationship for {name} set to {relationship}.",
            )
        except Exception as exc:
            return CommandResult(ok=False, message=f"Failed to update: {exc}")

    async def set_responsibility(self, name: str, data_responsibility: str) -> CommandResult:
        """Explicitly set data_responsibility for a contact.

        Overrides the auto-derived default. 'self' is not allowed.
        """
        if data_responsibility not in self._VALID_RESPONSIBILITIES:
            return CommandResult(
                ok=False,
                message=f"Invalid responsibility. Valid: {', '.join(sorted(self._VALID_RESPONSIBILITIES))}",
            )

        did = await self.resolve_contact_did(name)
        if not did:
            return CommandResult(ok=False, message=f"Contact '{name}' not found.")

        try:
            await self._core._request(
                "PUT", f"/v1/contacts/{urllib.parse.quote(did, safe='')}",
                json={"data_responsibility": data_responsibility},
            )
            return CommandResult(
                ok=True,
                message=f"Data responsibility for {name} set to {data_responsibility}.",
            )
        except Exception as exc:
            return CommandResult(ok=False, message=f"Failed to update: {exc}")

    async def add_alias(self, name: str, alias: str) -> CommandResult:
        """Add an alias for a contact."""
        alias = alias.strip()
        if not alias or len(alias) < 2:
            return CommandResult(ok=False, message="Alias must be at least 2 characters.")

        did = await self.resolve_contact_did(name)
        if not did:
            return CommandResult(ok=False, message=f"Contact '{name}' not found.")

        try:
            await self._core.add_alias(did, alias)
            return CommandResult(
                ok=True,
                message=f"Alias '{alias}' added for {name}.",
            )
        except Exception as exc:
            msg = str(exc)
            if "conflicts" in msg or "already belongs" in msg:
                return CommandResult(ok=False, message=msg)
            return CommandResult(ok=False, message=f"Failed to add alias: {exc}")

    async def remove_alias(self, name: str, alias: str) -> CommandResult:
        """Remove an alias from a contact."""
        did = await self.resolve_contact_did(name)
        if not did:
            return CommandResult(ok=False, message=f"Contact '{name}' not found.")

        try:
            await self._core.remove_alias(did, alias)
            return CommandResult(ok=True, message=f"Alias '{alias}' removed from {name}.")
        except Exception as exc:
            return CommandResult(ok=False, message=f"Failed to remove alias: {exc}")

    async def delete_contact(self, name: str) -> CommandResult:
        """Delete a contact by name."""
        err = validate_name(name)
        if err:
            return CommandResult(ok=False, message=err)

        # Find DID by name (includes broken entries)
        did = None
        try:
            resp = await self._core._request("GET", "/v1/contacts")
            for c in resp.json().get("contacts", []):
                display = c.get("display_name", "") or c.get("name", "")
                cdid = c.get("did", "")
                if display.lower() == name.lower() and cdid:
                    did = cdid
                    break
        except Exception:
            pass

        if not did:
            return CommandResult(ok=False, message=f"Contact '{name}' not found.")

        # Try DID-based delete first, fall back to name-based if DID has
        # path-unsafe characters (e.g. slashes from an earlier bug).
        try:
            await self._core._request(
                "DELETE",
                f"/v1/contacts/{urllib.parse.quote(did, safe='')}",
            )
            return CommandResult(ok=True, message=f"Deleted: {name}")
        except Exception:
            try:
                await self._core._request(
                    "DELETE",
                    f"/v1/contacts/by-name/{urllib.parse.quote(name, safe='')}",
                )
                return CommandResult(ok=True, message=f"Deleted: {name}")
            except Exception as exc:
                log.warning("contact_delete_failed", extra={"name": name, "did": did, "error": str(exc)})
                return CommandResult(ok=False, message="Could not delete. Contact may need manual cleanup.")

    async def cleanup_contacts(self) -> CommandResult:
        """Delete contacts with broken DIDs (not starting with did:plc:).

        Uses URL-safe DID encoding for deletion.  If the DID itself
        contains path-unsafe characters (e.g. slashes from an earlier
        bug), falls back to ``DELETE /v1/contacts/by-name/{name}``.
        """
        try:
            resp = await self._core._request("GET", "/v1/contacts")
            contacts = resp.json().get("contacts", [])
            removed = 0
            failed = []
            for c in contacts:
                cdid = c.get("did", "")
                cname = c.get("display_name", "") or c.get("name", "")
                if cdid and not cdid.startswith("did:plc:"):
                    try:
                        await self._core._request(
                            "DELETE",
                            f"/v1/contacts/{urllib.parse.quote(cdid, safe='')}",
                        )
                        removed += 1
                    except Exception:
                        # DID may contain path-breaking chars (slashes).
                        # Try name-based delete as fallback.
                        try:
                            await self._core._request(
                                "DELETE",
                                f"/v1/contacts/by-name/{urllib.parse.quote(cname, safe='')}",
                            )
                            removed += 1
                        except Exception:
                            failed.append(cname or cdid[:30])
            msg = f"Cleaned up {removed} broken contact(s)."
            if failed:
                msg += f" Could not remove: {', '.join(failed)}"
            return CommandResult(ok=True, message=msg)
        except Exception as exc:
            return CommandResult(ok=False, message=f"Cleanup failed: {exc}")

    async def resolve_contact_did(self, name: str) -> str | None:
        """Resolve a contact display name to a valid DID."""
        try:
            resp = await self._core._request("GET", "/v1/contacts")
            contacts = resp.json().get("contacts", [])
            for c in contacts:
                display = c.get("display_name", "") or c.get("name", "")
                did = c.get("did", "")
                if display.lower() == name.lower() and did.startswith("did:plc:"):
                    return did
        except Exception:
            pass
        return None

    # ── Trust Operations ────────────────────────────────────────────────

    async def query_trust(self, name_or_did: str) -> CommandResult:
        """Query trust profile for a name or DID (read-only)."""
        did = name_or_did.strip()
        display_name = did

        if not did.startswith("did:"):
            err = validate_name(did)
            if err:
                return CommandResult(ok=False, message=err)
            resolved = await self.resolve_contact_did(did)
            if not resolved:
                return CommandResult(ok=False, message=f"Could not resolve '{did}'.")
            display_name = did
            did = resolved
        else:
            err = validate_did(did)
            if err:
                return CommandResult(ok=False, message=err)

        try:
            profile = await self._core.query_trust_profile(did)
        except Exception:
            profile = None

        if not profile:
            return CommandResult(ok=False, message=f"No trust data found for {display_name}.")

        return CommandResult(
            ok=True,
            message="OK",
            data={
                "display_name": display_name,
                "did": did,
                "score": profile.get("overallTrustScore", "?"),
                "total_attestations": profile.get("attestationSummary", {}).get("total", 0),
                "positive_attestations": profile.get("attestationSummary", {}).get("positive", 0),
                "vouch_count": profile.get("vouchCount", 0),
            },
        )

    async def publish_vouch(self, name: str, reason: str) -> CommandResult:
        """Publish a vouch to the Trust Network. Resolves name → DID first."""
        err = validate_name(name)
        if err:
            return CommandResult(ok=False, message=err)
        if not reason.strip():
            return CommandResult(ok=False, message="Reason cannot be empty.")

        did = await self.resolve_contact_did(name)
        if not did:
            return CommandResult(ok=False, message=f"Contact '{name}' not found.")

        if not self._pds_publisher:
            return CommandResult(ok=False, message="Trust publishing not configured (no PDS connection).")

        try:
            result = await self._pds_publisher.publish_vouch(
                subject_did=did, text=reason.strip(),
            )
            return CommandResult(
                ok=True,
                message=f"Published vouch for {name}.",
                data={"name": name, "did": did, "uri": result.get("uri", "?")},
            )
        except Exception as exc:
            log.warning("trust_publish_failed", extra={"cmd": "vouch", "error": str(exc)})
            return CommandResult(ok=False, message=f"Publish failed: {exc}")

    async def publish_review(self, product: str, review_text: str) -> CommandResult:
        """Publish a product review to the Trust Network."""
        err = validate_name(product)
        if err:
            return CommandResult(ok=False, message=err)
        if not review_text.strip():
            return CommandResult(ok=False, message="Review text cannot be empty.")

        if not self._pds_publisher:
            return CommandResult(ok=False, message="Trust publishing not configured (no PDS connection).")

        try:
            result = await self._pds_publisher.publish_review(
                subject_name=product, text=review_text.strip(),
            )
            return CommandResult(
                ok=True,
                message=f"Published review of {product}.",
                data={"product": product, "uri": result.get("uri", "?")},
            )
        except Exception as exc:
            log.warning("trust_publish_failed", extra={"cmd": "review", "error": str(exc)})
            return CommandResult(ok=False, message=f"Publish failed: {exc}")

    async def publish_flag(self, target: str, reason: str) -> CommandResult:
        """Publish a flag against a name or DID on the Trust Network."""
        if not reason.strip():
            return CommandResult(ok=False, message="Reason cannot be empty.")

        # Resolve: try as contact name, fallback to raw DID
        did = await self.resolve_contact_did(target)
        if not did and target.startswith("did:"):
            err = validate_did(target)
            if err:
                return CommandResult(ok=False, message=err)
            did = target
        elif not did:
            return CommandResult(ok=False, message=f"Could not resolve '{target}'. Use a contact name or DID.")

        if not self._pds_publisher:
            return CommandResult(ok=False, message="Trust publishing not configured (no PDS connection).")

        try:
            result = await self._pds_publisher.publish_flag(
                subject_did=did, text=reason.strip(),
            )
            return CommandResult(
                ok=True,
                message=f"Flagged {target}.",
                data={"target": target, "did": did, "uri": result.get("uri", "?")},
            )
        except Exception as exc:
            log.warning("trust_publish_failed", extra={"cmd": "flag", "error": str(exc)})
            return CommandResult(ok=False, message=f"Publish failed: {exc}")

    # ── D2D Send ────────────────────────────────────────────────────────

    async def send_d2d(
        self, contact_name: str, message_text: str, llm: Any,
    ) -> CommandResult:
        """Classify and send a D2D message. Requires LLM for classification."""
        import base64
        import json
        import datetime as _dt

        err = validate_name(contact_name)
        if err:
            return CommandResult(ok=False, message=err)
        if not message_text.strip():
            return CommandResult(ok=False, message="Message cannot be empty.")

        # Resolve contact → DID
        contact_did = None
        try:
            resp = await self._core._request("GET", "/v1/contacts")
            for c in resp.json().get("contacts", []):
                if c.get("name", "").lower() == contact_name.lower():
                    contact_did = c.get("did")
                    contact_name = c.get("name")  # canonical case
                    break
        except Exception:
            pass

        if not contact_did:
            return CommandResult(ok=False, message=f"Contact '{contact_name}' not found.")

        # Classify message type
        try:
            now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            classify_prompt = (
                f"You are classifying a Dina-to-Dina message.\n"
                f"Today: {now}\n"
                f"Sender wants to tell {contact_name}: \"{message_text}\"\n\n"
                f"Classify into one of these v1 message types and structure the body:\n"
                f"- presence.signal: status updates, arriving, leaving, ETA\n"
                f"  Body: {{\"status\": \"arriving|leaving|delayed\", \"eta_minutes\": N, \"location_label\": \"...\"}}\n"
                f"- coordination.request: proposing plans, asking availability\n"
                f"  Body: {{\"action\": \"propose_time|ask_availability|ask_confirmation\", \"context\": \"...\"}}\n"
                f"- coordination.response: accepting, declining plans\n"
                f"  Body: {{\"action\": \"accept|decline|counter_propose\", \"note\": \"...\"}}\n"
                f"- social.update: sharing life events, personal news\n"
                f"  Body: {{\"text\": \"...\", \"category\": \"life_event|context|profile\"}}\n"
                f"- safety.alert: warnings about scams, compromised accounts\n"
                f"  Body: {{\"message\": \"...\", \"severity\": \"low|medium|high|critical\"}}\n\n"
                f"Respond with JSON only:\n"
                f"{{\"type\": \"<message_type>\", \"body\": {{...}}}}"
            )
            resp = await llm.route(
                task_type="classification",
                prompt=classify_prompt,
                messages=[
                    {"role": "system", "content": "Classify D2D message type. JSON only."},
                    {"role": "user", "content": classify_prompt},
                ],
            )
            raw = resp.get("content", "").strip()
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            classified = json.loads(raw)
            msg_type = classified.get("type", "social.update")
            body = classified.get("body", {"text": message_text})
        except Exception:
            msg_type = "social.update"
            body = {"text": message_text, "category": "context"}

        # Send via Core — embed correlation_id for end-to-end tracing.
        try:
            import structlog as _structlog
            ctx = _structlog.contextvars.get_contextvars()
            corr_id = ctx.get("request_id", "")
            if corr_id:
                body["_correlation_id"] = corr_id

            body_b64 = base64.b64encode(json.dumps(body).encode()).decode()
            await self._core._request("POST", "/v1/msg/send", json={
                "to": contact_did,
                "body": body_b64,
                "type": msg_type,
            })
            type_label = {
                "presence.signal": "Presence",
                "coordination.request": "Coordination",
                "coordination.response": "Response",
                "social.update": "Social update",
                "safety.alert": "Safety alert",
                "trust.vouch.request": "Trust request",
            }.get(msg_type, msg_type)
            return CommandResult(
                ok=True,
                message=f"Sent to {contact_name}: {type_label}",
                data={"contact": contact_name, "type": msg_type, "text": message_text},
            )
        except Exception as exc:
            error_msg = str(exc)
            if "not a contact" in error_msg:
                return CommandResult(ok=False, message=f"{contact_name} is not in your contacts.")
            elif "egress blocked" in error_msg:
                return CommandResult(ok=False, message=f"Sending to {contact_name} is blocked by your policy.")
            else:
                log.warning("d2d_send_failed", extra={"contact": contact_name, "error": error_msg})
                return CommandResult(ok=False, message=f"Could not deliver message to {contact_name}. Please try again later.")
