"""Click command group for the Dina CLI.

Commands: status, remember, ask, validate, validate-status, scrub,
rehydrate, draft, audit, configure, unpair, session.
"""

from __future__ import annotations

import json
import os
import sys
import uuid
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import click
import httpx

from .client import DinaClient, DinaClientError
from .config import CONFIG_FILE, load_config, save_config, _load_saved
from . import config as _config_mod
from .output import print_error, print_error_with_trace, print_result, print_result_with_trace
from .session import SessionStore
from .signing import CLIIdentity

# Safe actions that auto-approve when Brain is unavailable.
_SAFE_ACTIONS = frozenset({
    "search", "lookup", "read", "query", "list", "recall", "remember",
})


def _load_cfg(ctx: click.Context):
    """Lazy-load config on first access."""
    if "config" not in ctx.obj:
        try:
            ctx.obj["config"] = load_config()
        except click.UsageError:
            if ctx.obj.get("json"):
                click.echo(json.dumps({"error": "Not configured. Run: dina configure"}), err=True)
            raise
    return ctx.obj["config"]


def _make_client(ctx: click.Context) -> DinaClient:
    """Get or create the DinaClient from Click context."""
    if "client" not in ctx.obj:
        ctx.obj["client"] = DinaClient(_load_cfg(ctx), verbose=ctx.obj.get("verbose", False))
    return ctx.obj["client"]


def _cli_version() -> str:
    """Read version from importlib metadata + git hash."""
    try:
        from importlib.metadata import version as pkg_version
        v = pkg_version("dina-agent")
    except Exception:
        v = "dev"
    try:
        import subprocess
        h = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"],
                                     stderr=subprocess.DEVNULL, timeout=2).decode().strip()
        if h:
            v = f"{v}+{h}"
    except Exception:
        pass
    return v


@click.group()
@click.version_option(version=_cli_version(), prog_name="dina-agent")
@click.option("--json", "json_mode", is_flag=True, help="Machine-readable JSON output")
@click.option("--verbose", "-v", is_flag=True, help="Show detailed request/response info")
@click.pass_context
def cli(ctx: click.Context, json_mode: bool, verbose: bool) -> None:
    """Dina CLI — encrypted memory, PII scrubbing, action gating."""
    ctx.ensure_object(dict)
    ctx.obj["json"] = json_mode
    ctx.obj["verbose"] = verbose
    ctx.obj["sessions"] = SessionStore()


# ── status ────────────────────────────────────────────────────────────────


@cli.command()
@click.pass_context
def status(ctx: click.Context) -> None:
    """Show pairing status and connectivity."""
    json_mode = ctx.obj["json"]
    result: dict[str, Any] = {}

    # Check keypair
    has_keypair = (_config_mod.IDENTITY_DIR / "ed25519_private.pem").exists()
    result["keypair"] = "present" if has_keypair else "missing"

    # Load saved config
    saved = _load_saved()
    core_url = os.environ.get("DINA_CORE_URL") or saved.get("core_url") or "http://localhost:8100"
    result["core_url"] = core_url
    result["device_name"] = saved.get("device_name", "")

    # Device DID
    if has_keypair:
        try:
            ident = CLIIdentity()
            ident.ensure_loaded()
            result["did"] = ident.did()
        except Exception:
            result["did"] = "error"
    else:
        result["did"] = ""

    # Connectivity + auth
    result["core_reachable"] = False
    result["authenticated"] = False
    try:
        health = httpx.get(f"{core_url}/healthz", timeout=5)
        result["core_reachable"] = health.status_code == 200
    except Exception:
        pass

    result["home_did"] = ""
    if has_keypair and result["core_reachable"]:
        try:
            client = _make_client(ctx)
            did_doc = client.did_get()
            result["authenticated"] = True
            result["home_did"] = did_doc.get("did", did_doc.get("id", ""))
        except Exception:
            pass

    result["paired"] = result["authenticated"]

    if json_mode:
        print_result(result, json_mode)
    else:
        if result["paired"]:
            click.echo("  Paired:    yes")
        elif has_keypair:
            click.echo("  Paired:    no (keypair exists but not registered with Core)")
        else:
            click.echo("  Paired:    no (run: dina configure && dina pair)")

        if result["did"]:
            click.echo(f"  Device:    {result['did']}")
        click.echo(f"  Dina:      {result['home_did'] or 'not connected'}")
        if result["device_name"]:
            click.echo(f"  Name:      {result['device_name']}")
        click.echo(f"  Core:      {result['core_url']}")

        if result["core_reachable"]:
            click.echo("  Reachable: yes")
        else:
            click.echo("  Reachable: no")


# ── remember ──────────────────────────────────────────────────────────────


@cli.command()
@click.argument("text")
@click.option("--category", default="note", help="Optional metadata label. Ex: fact, preference, decision, relationship, event, note")
@click.option("--session", required=True, help="Session ID (create with: dina session start)")
@click.pass_context
def remember(ctx: click.Context, text: str, category: str, session: str) -> None:
    """Store a fact via the staging pipeline.

    Requires an active session. Create one first:

    dina session start --name "my-session"

    dina remember --session sess-123 "My daughter's birthday is on April 7th"

    dina ask --session sess-123 "When is my daughter's birthday?"

    Dina checks all persona to get the data if this session has access.

    Classifies and stores in right persona vault.
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        source_id = f"cli-{uuid.uuid4().hex[:12]}"
        metadata = json.dumps({"category": category, "session": session})
        result = client.remember(text, session=session, source_id=source_id, metadata=metadata)
        status = result.get("status", "processing")
        message = result.get("message", "")
        item_id = result.get("id", "")
        output = {"status": status}
        if message:
            output["message"] = message
        if item_id and status not in ("stored",):
            output["id"] = item_id
            output["check"] = f"dina remember-status {item_id}"
        print_result_with_trace(output, json_mode, client.req_id)
    except DinaClientError as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)


@cli.command("remember-status")
@click.argument("item_id")
@click.pass_context
def remember_status(ctx: click.Context, item_id: str) -> None:
    """Check the status of a pending remember operation."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        result = client.remember_check(item_id)
        print_result_with_trace(result, json_mode, client.req_id)
    except DinaClientError as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)


# ── ask ──────────────────────────────────────────────────────────────────


@cli.command()
@click.argument("query")
@click.option("--session", required=True, help="Session ID (create with: dina session start)")
@click.option("--timeout", default=300, type=int, help="Approval poll timeout in seconds (30–1800, default 300)")
@click.pass_context
def ask(ctx: click.Context, query: str, session: str, timeout: int) -> None:
    """Ask Dina a question - she reasons over your encrypted vault.

    Requires an active session. Create one first:

    dina session start --name "my-session"

    dina remember --session sess-123 "My daughter's birthday is on April 7th"

    dina ask --session sess-123 "When is my daughter's birthday?"

    Dina checks all persona to get the data if this session has access.
    
    If session does not have access, user should approve use through telegram/dina-admin
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        result = client.ask(query, session=session)

        # Check for async approval-wait (202 from Core)
        if result.get("status") == "pending_approval":
            request_id = result.get("request_id", "")
            persona = result.get("persona", "sensitive")

            if json_mode:
                print_result_with_trace(result, json_mode, client.req_id)
                return

            click.echo(
                f"Access to '{persona}' data requires approval.",
                err=True,
            )
            click.echo("A notification has been sent. Approve via Telegram or dina-admin.", err=True)
            click.echo(f"  req_id: {client.req_id}", err=True)

            if not request_id:
                # No request_id — can't poll. Old-style 403.
                ctx.exit(1)
                return

            click.echo("Awaiting approval...", err=True)

            import time
            timeout = min(max(timeout, 30), 1800)  # clamp: 30s min, 30min max
            elapsed = 0
            while elapsed < timeout:
                # Fast poll first 30s (user may approve quickly from Telegram),
                # then slow down — they're clearly not at the screen.
                interval = 5 if elapsed < 30 else 15
                time.sleep(interval)
                elapsed += interval
                try:
                    status = client.ask_status(request_id)
                except DinaClientError:
                    continue  # transient error, keep polling

                st = status.get("status", "")
                if st == "complete":
                    answer = status.get("content", "")
                    if answer:
                        click.echo(answer)
                    else:
                        click.echo("Completed but no content returned.")
                    return
                elif st == "denied":
                    click.echo("Access denied by user.", err=True)
                    ctx.exit(1)
                    return
                elif st == "failed":
                    click.echo(f"Request failed: {status.get('error', 'unknown')}", err=True)
                    ctx.exit(1)
                    return
                elif st == "expired":
                    click.echo("Request expired.", err=True)
                    ctx.exit(1)
                    return
                # else: still pending or resuming — keep polling

            click.echo("Timed out waiting for approval.", err=True)
            click.echo(f"Check later: dina ask-status {request_id}", err=True)
            ctx.exit(1)
            return

        # Check for structured error from Brain
        error_code = result.get("error_code", "")
        if error_code:
            if json_mode:
                print_result_with_trace(result, json_mode, client.req_id)
            else:
                _ERROR_MESSAGES = {
                    "llm_not_configured": "LLM not configured. Run 'dina-admin model list' to see options.",
                    "llm_auth_failed": "LLM authentication failed. Check your API key with 'dina-admin model status'.",
                    "llm_timeout": "LLM request timed out. Try again or check 'dina-admin model status'.",
                    "llm_unreachable": "LLM provider unreachable. Check network or 'dina-admin model status'.",
                }
                msg = result.get("message") or _ERROR_MESSAGES.get(error_code, f"Error: {error_code}")
                click.echo(msg, err=True)
                click.echo(f"  req_id: {client.req_id}", err=True)
            ctx.exit(1)
            return

        # Normal (immediate) response
        if json_mode:
            print_result_with_trace(result, json_mode, client.req_id)
        else:
            answer = result.get("content", result.get("response", ""))
            if answer:
                click.echo(answer)
            else:
                click.echo("I don't have any information about that yet.")
            click.echo(f"  req_id: {client.req_id}", err=True)
    except DinaClientError as exc:
        if "approval_required" in str(exc).lower():
            click.echo("Access to sensitive data requires approval.", err=True)
            click.echo("A notification has been sent. Approve via Telegram or dina-admin.", err=True)
        elif "persona locked" in str(exc).lower():
            click.echo("Some data is locked. Unlock on your Home Node: ./dina-admin persona unlock", err=True)
        else:
            print_error_with_trace(str(exc), json_mode, client.req_id)
        click.echo(f"  req_id: {client.req_id}", err=True)
        ctx.exit(1)


@cli.command("ask-status")
@click.argument("request_id")
@click.pass_context
def ask_status_cmd(ctx: click.Context, request_id: str) -> None:
    """Check the status of a pending ask request.

    Use this when 'dina ask' timed out waiting for approval. Pass the
    request_id that was printed at timeout.
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        status = client.ask_status(request_id)
        if json_mode:
            print_result_with_trace(status, json_mode, client.req_id)
        elif status.get("status") == "complete":
            answer = status.get("content", "")
            if answer:
                click.echo(answer)
            else:
                click.echo("Completed but no content.")
        elif status.get("status") == "denied":
            click.echo("Access was denied by user.")
        elif status.get("status") == "failed":
            click.echo(f"Failed: {status.get('error', 'unknown')}")
        elif status.get("status") == "expired":
            click.echo("Request expired.")
        else:
            click.echo(f"Status: {status.get('status', 'unknown')}")
    except DinaClientError as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)


def _extract_category(item: dict) -> str:
    """Extract category from vault item metadata."""
    raw = item.get("Metadata", item.get("metadata", ""))
    if isinstance(raw, str) and raw:
        try:
            return json.loads(raw).get("category", "note")
        except (json.JSONDecodeError, AttributeError):
            pass
    if isinstance(raw, dict):
        return raw.get("category", "note")
    return "note"


# ── validate ──────────────────────────────────────────────────────────────


@cli.command()
@click.argument("action")
@click.argument("description")
@click.option("--count", default=1, type=int, help="Number of items affected")
@click.option("--reversible", is_flag=True, help="Action is reversible")
@click.option("--session", required=True, help="Session ID (create with: dina session start)")
@click.option("--context", "context_json", default=None,
              help="JSON object with action details shown in approval notification "
                   "(e.g. '{\"to\":\"user@example.com\",\"subject\":\"Report\"}')")
@click.pass_context
def validate(ctx: click.Context, action: str, description: str, count: int,
             reversible: bool, session: str, context_json: str | None) -> None:
    """Check if an action is approved by user policy.

    \b
    The --context flag adds structured metadata to the approval notification.
    The human reviewing the action sees this context in Telegram.
    Example:
      dina validate --session ses_xxx send_email "Send report" \\
        --context '{"to":"user@co.com","subject":"Q4 Report","attachments":["report.pdf"]}'
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    config = ctx.obj["config"]

    # Parse optional context
    context: dict | None = None
    if context_json:
        try:
            context = json.loads(context_json)
        except json.JSONDecodeError:
            raise click.BadParameter(f"Invalid JSON: {context_json}", param_hint="--context")

    try:
        payload: dict = {
            "action": action,
            "target": description,
            "count": count,
            "reversible": reversible,
        }
        if context:
            payload["context"] = context

        result = client.process_event({
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

        output: dict = {"status": status}
        if proposal_id:
            output["id"] = proposal_id
        if status == "pending_approval" and proposal_id:
            output["dashboard_url"] = f"{config.core_url}/approvals/{proposal_id}"
        if result.get("risk"):
            output["risk"] = result["risk"]

        print_result_with_trace(output, json_mode, client.req_id)

    except DinaClientError as exc:
        # Fallback: if Core/Brain is unavailable, use conservative local policy
        if "Cannot reach" in str(exc) or "unavailable" in str(exc).lower():
            if action in _SAFE_ACTIONS:
                status = "approved"
            else:
                status = "pending_approval"
            output: dict = {"status": status}
            if status == "pending_approval":
                output["note"] = "Guardian unavailable — conservative fallback"
            print_result_with_trace(output, json_mode, client.req_id)
        else:
            print_error_with_trace(str(exc), json_mode, client.req_id)
            ctx.exit(1)


# ── validate-actions ──────────────────────────────────────────────────────


@cli.command("validate-actions")
@click.pass_context
def validate_actions(ctx: click.Context) -> None:
    """List all known actions with their current risk level.

    Returns the active policy so agents know which action names to use
    and what approval behavior to expect for each.
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        raw = client.kv_get("policy:action_risk")
        if raw is None:
            # No custom policy — use built-in defaults
            policy = {
                "blocked": ["access_keys", "export_data", "read_vault"],
                "high": ["delete_data", "share_data", "sign_contract", "transfer_money"],
                "moderate": [
                    "calendar_create", "draft_create", "draft_email", "form_fill",
                    "install_extension", "pay_crypto", "pay_upi", "research",
                    "send_email", "send_message", "share_location", "web_checkout",
                ],
            }
        else:
            policy = json.loads(raw)

        if json_mode:
            # Flat list with action→risk mapping for programmatic use
            actions = {}
            for risk in ("blocked", "high", "moderate", "safe"):
                for action in policy.get(risk, []):
                    actions[action] = risk
            print_result({"actions": actions, "default_risk": "safe"}, json_mode)
        else:
            click.echo("Action Risk Levels")
            click.echo("==================")
            for risk in ("blocked", "high", "moderate", "safe"):
                for action in sorted(policy.get(risk, [])):
                    click.echo(f"  {action:<30} {risk.upper()}")
            click.echo(f"  {'(unlisted actions)':<30} SAFE")
    except DinaClientError as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)


# ── validate-status ───────────────────────────────────────────────────────


@cli.command("validate-status")
@click.argument("proposal_id")
@click.option("--session", default="", help="Session ID (same as validate)")
@click.pass_context
def validate_status(ctx: click.Context, proposal_id: str, session: str) -> None:
    """Poll approval status for a pending action.

    Uses the proposal_id returned by `dina validate` to query the real
    Guardian proposal lifecycle (not a static KV snapshot).
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        result = client.get_proposal_status(proposal_id, session=session)
        result.setdefault("id", proposal_id)
        print_result_with_trace(result, json_mode, client.req_id)
    except DinaClientError as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)


# ── scrub ─────────────────────────────────────────────────────────────────


@cli.command()
@click.argument("text")
@click.pass_context
def scrub(ctx: click.Context, text: str) -> None:
    """Remove PII from text, return scrubbed text + session ID."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    sessions: SessionStore = ctx.obj["sessions"]
    try:
        result = client.pii_scrub(text)
        scrubbed = result.get("scrubbed", text)
        entities = result.get("entities", [])

        session_id = sessions.new_id()
        if entities:
            sessions.save(session_id, entities)

        print_result_with_trace({"scrubbed": scrubbed, "pii_id": session_id}, json_mode, client.req_id)
    except DinaClientError as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)


# ── rehydrate ─────────────────────────────────────────────────────────────


@cli.command()
@click.argument("text")
@click.option("--session", "session_id", required=True, help="Session ID from scrub")
@click.pass_context
def rehydrate(ctx: click.Context, text: str, session_id: str) -> None:
    """Restore PII from a scrub session (local only, no network call)."""
    json_mode = ctx.obj["json"]
    sessions: SessionStore = ctx.obj["sessions"]
    try:
        restored = sessions.rehydrate(text, session_id)
        print_result({"restored": restored}, json_mode)
    except FileNotFoundError:
        print_error(f"Session {session_id} not found", json_mode)
        ctx.exit(1)


# ── draft ─────────────────────────────────────────────────────────────────


@cli.command()
@click.argument("content")
@click.option("--to", "recipient", required=True, help="Recipient address")
@click.option("--channel", required=True, type=click.Choice(["email", "sms", "slack", "whatsapp"]))
@click.option("--subject", default="", help="Message subject (email)")
@click.pass_context
def draft(ctx: click.Context, content: str, recipient: str, channel: str, subject: str) -> None:
    """Stage a message for human review."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    config = ctx.obj["config"]
    draft_id = f"drf_{uuid.uuid4().hex[:8]}"

    try:
        # Route through Brain — Brain decides persona routing for drafts
        client.ask(
            f"Draft a message to {recipient} via {channel}"
            + (f" with subject '{subject}'" if subject else "")
            + f": {content}",
        )
        # Stage the draft metadata for Brain classification + vault persistence.
        client.staging_ingest({
            "type": "email_draft",
            "summary": f"Draft to {recipient}: {subject}" if subject else f"Draft to {recipient}",
            "body": content,
            "source": "dina-cli",
            "source_id": draft_id,
            "sender": "user",
            "metadata": json.dumps({
                "to": recipient,
                "channel": channel,
                "subject": subject,
                "draft_id": draft_id,
            }),
        })
        print_result_with_trace({
            "draft_id": draft_id,
            "status": "pending_review",
            "dashboard_url": f"{config.core_url}/drafts/{draft_id}",
        }, json_mode, client.req_id)
    except DinaClientError as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)


# ── sign ──────────────────────────────────────────────────────────────────


@cli.command(hidden=True)  # Internal plumbing — use dina-admin identity sign
@click.argument("content")
@click.pass_context
def sign(ctx: click.Context, content: str) -> None:
    """Cryptographic signature with user's DID key.

    Signs locally using the CLI's Ed25519 private key — no server round-trip.
    """
    from .signing import CLIIdentity

    json_mode = ctx.obj["json"]
    try:
        identity = CLIIdentity()
        identity.ensure_loaded()
        signature = identity.sign_data(content.encode())
        print_result({
            "signed_by": identity.did(),
            "signature": signature,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }, json_mode)
    except FileNotFoundError:
        print_error("No keypair found. Run 'dina configure' first.", json_mode)
        ctx.exit(1)
    except Exception as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


# ── audit ─────────────────────────────────────────────────────────────────


@cli.command()
@click.option("--limit", default=20, help="Max entries to return")
@click.option("--action", "action_filter", default="", help="Filter by action type")
@click.pass_context
def audit(ctx: click.Context, limit: int, action_filter: str) -> None:
    """View recent agent activity log."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        # Use audit endpoint, not vault query
        resp = client._request(
            client._core, "GET", "/v1/audit/query",
            params={"action": action_filter, "limit": str(limit)} if action_filter else {"limit": str(limit)},
        )
        items = resp.json().get("entries", [])
        if json_mode:
            print_result_with_trace(items, json_mode, client.req_id)
        else:
            if not items:
                click.echo("No audit entries.")
            else:
                for it in items:
                    ts = it.get("timestamp", "")
                    action = it.get("action", "")
                    persona = it.get("persona", "")
                    requester = it.get("requester", "")
                    reason = it.get("reason", "")
                    line = f"  {ts}  {action}"
                    if persona:
                        line += f"  persona={persona}"
                    if requester:
                        line += f"  by={requester}"
                    if reason:
                        line += f"  ({reason})"
                    click.echo(line)
    except DinaClientError as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)


# ── configure ─────────────────────────────────────────────────────────────


@cli.command()
@click.option(
    "--role", default="user", type=click.Choice(["user", "agent"]),
    help="Device role: 'user' (personal CLI) or 'agent' (OpenClaw/bot)",
)
@click.option(
    "--config", "config_file", default=None, type=click.Path(exists=True),
    help="Non-interactive: JSON config file with keys: core_url, device_name, config_location, pairing_code",
)
@click.option("--headless", is_flag=True, default=False, help="Non-interactive mode with CLI flags (no prompts)")
@click.option("--core-url", default=None, help="[headless] Core URL (e.g. http://localhost:8100)")
@click.option("--device-name", default=None, help="[headless] Device name")
@click.option("--pairing-code", default=None, help="[headless] Pairing code from dina-admin device pair")
@click.option("--config-dir", default=None, help="[headless] Config directory (default: .dina/cli in cwd)")
@click.pass_context
def configure(
    ctx: click.Context, role: str, config_file: str | None,
    headless: bool, core_url: str | None, device_name: str | None,
    pairing_code: str | None, config_dir: str | None,
) -> None:
    """Set up connection to a Dina Home Node.

    \b
    Interactive (default):
      dina configure
      dina configure --role agent

    \b
    Headless (no prompts — for automation/CI):
      dina configure --headless --core-url http://localhost:8100 \\
        --pairing-code 123456 --device-name sanity-agent --role agent

    \b
    Non-interactive (JSON config file):
      dina configure --config setup.json

    \b
    JSON config file format:
      {
        "core_url": "http://localhost:9100",
        "device_name": "my-device",
        "config_location": "local",       // "local", "global", or "/custom/path"
        "pairing_code": "123456",          // from dina-admin device pair
        "generate_keypair": true           // true = always generate new keypair
      }
    """
    # ── Headless mode: all params from CLI flags, zero prompts ──
    if headless:
        _configure_headless(
            core_url=core_url or "http://localhost:8100",
            device_name=device_name or _default_device_name(),
            role=role,
            pairing_code=pairing_code or "",
            config_dir_path=config_dir,
        )
        return

    # Load non-interactive config if provided.
    cfg_input: dict = {}
    if config_file:
        cfg_input = json.loads(Path(config_file).read_text())

    if cfg_input:
        role = cfg_input.get("role", role)

    click.echo("Dina CLI Configuration")
    click.echo("=" * 40)
    click.echo()

    # Config location: local (this directory), global (~), or custom path.
    from .config import _GLOBAL_CONFIG_DIR, _LOCAL_CONFIG_DIR, set_config_dir
    cwd = Path.cwd()
    home = Path.home()

    if cfg_input:
        loc = cfg_input.get("config_location", "global")
        if loc == "local":
            set_config_dir(_LOCAL_CONFIG_DIR)
        elif loc == "global":
            set_config_dir(_GLOBAL_CONFIG_DIR)
        else:
            set_config_dir(Path(loc) / ".dina" / "cli")
        click.echo(f"  Config: {loc}")
    else:
        choice = click.prompt(
            "Config location",
            type=click.Choice(["local", "global", "custom"]),
            default="global",
        )
        if choice == "local":
            set_config_dir(_LOCAL_CONFIG_DIR)
            click.echo(f"  Config stored in: {cwd}")
        elif choice == "global":
            set_config_dir(_GLOBAL_CONFIG_DIR)
            click.echo(f"  Config stored in: {home}")
        else:
            custom_parent = Path(click.prompt("Parent directory", default=str(cwd)))
            set_config_dir(custom_parent / ".dina" / "cli")
            click.echo(f"  Config stored in: {custom_parent}")

    # Load existing saved config for defaults
    from .config import _load_saved
    existing = _load_saved()

    if cfg_input:
        core_url = cfg_input.get("core_url", existing.get("core_url", "http://localhost:8100"))
        device_name = cfg_input.get("device_name", existing.get("device_name") or _default_device_name())
        click.echo(f"  Core URL: {core_url}")
        click.echo(f"  Device: {device_name}")
    else:
        core_url = click.prompt(
            "Core URL",
            default=existing.get("core_url", "http://localhost:8100"),
        )
        device_name = click.prompt(
            "Device name",
            default=existing.get("device_name") or _default_device_name(),
        )
    click.echo()
    if cfg_input:
        _configure_signature_noninteractive(core_url, device_name, role, cfg_input)
    else:
        _configure_signature(core_url, device_name, role)

    values: dict[str, Any] = {
        "core_url": core_url,
        "device_name": device_name,
        "role": role,
    }

    path = save_config(values)
    click.echo()
    click.echo(f"Configuration saved to {path}")

    # Test the connection
    test_connection = cfg_input.get("test_connection", True) if cfg_input else click.confirm("Test connection now?", default=True)
    if test_connection:
        click.echo()
        from .config import Config
        cfg = Config(
            core_url=core_url,
            timeout=10.0,
            device_name=device_name,
        )
        try:
            with DinaClient(cfg) as client:
                client._request(client._core, "GET", "/healthz")
                click.echo(f"  Core ({core_url}): Connected")
                click.echo(f"  Auth: Ed25519 signing (DID: {client._identity.did()})")
                try:
                    did_doc = client.did_get()
                    did = did_doc.get("id", did_doc.get("did", ""))
                    if did:
                        click.echo(f"  Identity: {did}")
                except DinaClientError:
                    pass
        except DinaClientError as exc:
            click.echo(f"  Core ({core_url}): {exc}", err=True)
        click.echo()
        click.echo("Ready. Try:")
        click.echo("  dina session start --name \"my first session\"")
        click.echo("  dina ask --session <session-id> \"hello\"")


@cli.command()
@click.pass_context
def unpair(ctx: click.Context) -> None:
    """Unpair this device from the Home Node.

    Revokes the device registration on Core and removes the local
    device_id. The keypair is kept — run `dina configure` to re-pair.
    """
    json_mode = ctx.obj["json"]
    saved = _load_saved()
    device_id = saved.get("device_id", "")
    core_url = os.environ.get("DINA_CORE_URL") or saved.get("core_url") or "http://localhost:8100"

    if not device_id:
        msg = "No device_id saved. Already unpaired or never paired."
        if json_mode:
            print_result({"status": "not_paired", "message": msg}, json_mode)
        else:
            click.echo(f"  {msg}")
        return

    has_keypair = (_config_mod.IDENTITY_DIR / "ed25519_private.pem").exists()
    if not has_keypair:
        # Can't sign the revoke request — just clear local state
        saved.pop("device_id", None)
        save_config(saved)
        if json_mode:
            print_result({"status": "cleared", "message": "Local state cleared (no keypair to revoke on Core)"}, json_mode)
        else:
            click.echo("  No keypair — cleared local device_id.")
            click.echo("  Revoke on Core manually: dina-admin device revoke")
        return

    ident = CLIIdentity()
    ident.ensure_loaded()

    try:
        did, ts, nonce, sig = ident.sign_request("DELETE", f"/v1/devices/{device_id}", b"")
        resp = httpx.delete(
            f"{core_url}/v1/devices/{device_id}",
            headers={"X-DID": did, "X-Timestamp": ts, "X-Nonce": nonce, "X-Signature": sig},
            timeout=10.0,
        )
        if resp.status_code in (200, 204):
            saved.pop("device_id", None)
            save_config(saved)
            if json_mode:
                print_result({"status": "unpaired", "device_id": device_id}, json_mode)
            else:
                click.echo(f"  Unpaired: {device_id}")
                click.echo("  Re-pair with: dina configure")
        elif resp.status_code == 404:
            saved.pop("device_id", None)
            save_config(saved)
            if json_mode:
                print_result({"status": "not_found", "device_id": device_id}, json_mode)
            else:
                click.echo(f"  Device {device_id} not found on Core (already revoked?).")
        else:
            if json_mode:
                print_error(f"HTTP {resp.status_code}: {resp.text[:100]}", json_mode)
            else:
                click.echo(f"  Unpair failed: HTTP {resp.status_code}", err=True)
            ctx.exit(1)
    except httpx.ConnectError:
        if json_mode:
            print_error(f"Cannot reach Core at {core_url}", json_mode)
        else:
            click.echo(f"  Cannot reach Core at {core_url}.", err=True)
            click.echo("  Revoke manually: dina-admin device revoke", err=True)
        ctx.exit(1)


def _default_device_name() -> str:
    """Generate a default device name from hostname."""
    import platform
    return f"{platform.node()}-cli"


def _configure_headless(
    core_url: str, device_name: str, role: str,
    pairing_code: str, config_dir_path: str | None,
) -> None:
    """Headless configure: all params from CLI flags, zero prompts."""
    from .config import set_config_dir
    from .signing import CLIIdentity

    # Set config directory
    if config_dir_path:
        cfg_dir = Path(config_dir_path) / ".dina" / "cli"
    else:
        cfg_dir = Path.cwd() / ".dina" / "cli"
    set_config_dir(cfg_dir)

    click.echo(f"  Config dir: {cfg_dir}")
    click.echo(f"  Core URL: {core_url}")
    click.echo(f"  Device: {device_name}")
    click.echo(f"  Role: {role}")

    # Generate keypair (always fresh in headless mode)
    identity = CLIIdentity()
    if identity.exists:
        _try_unpair(core_url, identity)
    click.echo("  Generating Ed25519 keypair...")
    identity.generate()
    click.echo(f"  DID: {identity.did()}")

    # Pair with Core
    if pairing_code:
        _pair_with_key(core_url, identity, device_name, role, pairing_code=pairing_code)
    else:
        click.echo("  No --pairing-code provided — skipping pairing.")

    # Save config
    values: dict[str, Any] = {
        "core_url": core_url,
        "device_name": device_name,
        "role": role,
    }
    path = save_config(values)
    click.echo(f"  Configuration saved to {path}")

    # Quick health check
    try:
        resp = httpx.get(f"{core_url}/healthz", timeout=5.0)
        if resp.status_code == 200:
            click.echo(f"  Core: Connected")
        else:
            click.echo(f"  Core: {resp.status_code}", err=True)
    except Exception as exc:
        click.echo(f"  Core: unreachable ({exc})", err=True)


def _try_unpair(core_url: str, identity: Any) -> None:
    """Best-effort unpair: revoke the current device from Core."""
    saved = _load_saved()
    device_id = saved.get("device_id", "")
    if not device_id:
        click.echo("  No device_id saved — skipping unpair.")
        return
    click.echo(f"  Unpairing old device ({device_id})...")
    try:
        did, ts, nonce, sig = identity.sign_request("DELETE", f"/v1/devices/{device_id}", b"")
        resp = httpx.delete(
            f"{core_url}/v1/devices/{device_id}",
            headers={"X-DID": did, "X-Timestamp": ts, "X-Nonce": nonce, "X-Signature": sig},
            timeout=10.0,
        )
        if resp.status_code in (200, 204, 404):
            click.echo("  Old device revoked.")
        else:
            click.echo(f"  Unpair returned {resp.status_code} — continuing anyway.")
    except Exception as exc:
        click.echo(f"  Could not reach Core to unpair: {exc}")
        click.echo("  Continuing — revoke the old device manually: dina-admin device revoke")
    # Clear device_id from config
    saved.pop("device_id", None)
    save_config(saved)


def _configure_signature_noninteractive(
    core_url: str, device_name: str, role: str, cfg: dict,
) -> None:
    """Non-interactive keypair generation and pairing from config file."""
    from .signing import CLIIdentity

    identity = CLIIdentity()

    if cfg.get("generate_keypair", True) or not identity.exists:
        if identity.exists:
            _try_unpair(core_url, identity)
        click.echo("  Generating Ed25519 keypair...")
        identity.generate()
        click.echo(f"  DID: {identity.did()}")

    pairing_code = cfg.get("pairing_code", "")
    if pairing_code:
        _pair_with_key(core_url, identity, device_name, role, pairing_code=pairing_code)
    else:
        click.echo("  No pairing_code in config — skipping pairing.")


def _configure_signature(core_url: str, device_name: str, role: str = "user") -> None:
    """Generate keypair and pair with Core using Ed25519 public key."""
    from .signing import CLIIdentity

    identity = CLIIdentity()

    if identity.exists:
        click.echo(f"  Keypair exists: {identity.did()}")
        if not click.confirm("  Generate a new keypair?", default=False):
            # Re-pair with existing key
            _pair_with_key(core_url, identity, device_name, role)
            return
        # Unpair old device before generating new keypair
        _try_unpair(core_url, identity)

    click.echo("  Generating Ed25519 keypair...")
    identity.generate()
    click.echo(f"  DID: {identity.did()}")
    click.echo(f"  Keypair saved to {identity._dir}")
    click.echo()

    _pair_with_key(core_url, identity, device_name, role)


def _pair_with_key(
    core_url: str, identity: Any, device_name: str,
    role: str = "user", pairing_code: str = "",
) -> None:
    """Register the public key with Core using a pairing code."""
    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        if not pairing_code:
            click.echo("  Enter the pairing code from your Home Node.")
            click.echo("  (Generate one by running: ./dina-admin device pair)")
            pairing_code = click.prompt("  Pairing code")

        click.echo("  Registering device...")
        try:
            resp = httpx.post(
                f"{core_url}/v1/pair/complete",
                json={
                    "code": pairing_code,
                    "device_name": device_name,
                    "public_key_multibase": identity.public_key_multibase(),
                    "role": role,
                },
                timeout=10.0,
            )
            resp.raise_for_status()
            data = resp.json()
            device_id = data.get("device_id", "")
            click.echo(f"  Paired! Device ID: {device_id or 'ok'}")
            node_did = data.get("node_did", "")
            if node_did:
                click.echo(f"  Dina: {node_did}")
            # Save device_id so we can unpair later
            if device_id:
                saved = _load_saved()
                saved["device_id"] = device_id
                save_config(saved)
            return  # success
        except httpx.ConnectError:
            click.echo(f"  Cannot reach Core at {core_url}.", err=True)
            click.echo("  Check that your Home Node is running and the URL is correct.", err=True)
            click.echo("  Keypair saved. Pair later with: dina configure", err=True)
            return
        except httpx.HTTPStatusError:
            remaining = max_attempts - attempt
            if remaining > 0:
                click.echo(f"  Pairing failed. Check that the code is correct and the Home Node is reachable.", err=True)
                click.echo(f"  {remaining} attempt(s) remaining.", err=True)
                click.echo()
            else:
                click.echo("  Pairing failed after 3 attempts.", err=True)
                click.echo("  Check that you are connecting to the correct Home Node.", err=True)
                click.echo("  Keypair saved. Try again with: dina configure", err=True)


# ── init-identity ────────────────────────────────────────────────────

_IDENTITY_DIR = Path.home() / ".dina" / "cli" / "identity"


@cli.command("init-identity", hidden=True)  # Admin operation — use dina-admin
@click.option("--restore-mnemonic", is_flag=True, help="Restore from a 24-word recovery phrase")
@click.option("--restore-hex", is_flag=True, help="Restore from a 64-char hex seed")
@click.pass_context
def init_identity(ctx: click.Context, restore_mnemonic: bool, restore_hex: bool) -> None:
    """Generate or restore an identity seed, wrap it with a passphrase.

    The raw seed never touches disk. It is wrapped with AES-256-GCM using an
    Argon2id-derived key, and only the encrypted blob is stored.

    Output files (in ~/.dina/cli/identity/):
      wrapped_seed.bin      60 bytes (nonce + ciphertext + GCM tag)
      master_seed.salt    16 bytes (Argon2id salt)

    Use 'dina bootstrap-server' to upload these to your Home Node.
    """
    from . import seed_wrap

    json_mode = ctx.obj["json"]
    out_dir = _IDENTITY_DIR

    # Check if already wrapped
    if (out_dir / "wrapped_seed.bin").exists():
        if not click.confirm("Identity seed already wrapped. Overwrite?", default=False):
            click.echo("Aborted.")
            return

    # --- Step 1: Obtain the seed ---
    seed: bytes

    if restore_mnemonic:
        click.echo()
        click.echo("Enter your 24-word recovery phrase (space-separated):")
        while True:
            raw = click.prompt("  >")
            words = raw.strip().split()
            try:
                seed = seed_wrap.mnemonic_to_seed(words)
                click.echo(click.style("  [ok] Seed restored from recovery phrase", fg="green"))
                break
            except ValueError as exc:
                click.echo(click.style(f"  Error: {exc}", fg="yellow"))
                if not click.confirm("  Try again?", default=True):
                    ctx.exit(1)
                    return

    elif restore_hex:
        click.echo()
        hex_input = click.prompt("Enter your 64-character hex seed").strip()
        if len(hex_input) != 64:
            click.echo(click.style(f"Error: expected 64 hex chars, got {len(hex_input)}", fg="red"), err=True)
            ctx.exit(1)
            return
        try:
            seed = bytes.fromhex(hex_input)
        except ValueError:
            click.echo(click.style("Error: invalid hex characters", fg="red"), err=True)
            ctx.exit(1)
            return
        click.echo(click.style("  [ok] Seed loaded from hex", fg="green"))

    else:
        # Generate new seed
        seed = seed_wrap.generate_seed()
        click.echo(click.style("  [ok] Generated new identity (256-bit seed)", fg="green"))

        # Show mnemonic
        mnemonic = seed_wrap.seed_to_mnemonic(seed)
        click.echo()
        click.echo(click.style("  Your Recovery Phrase:", bold=True))
        click.echo()
        for i in range(0, 24, 4):
            line = "    ".join(f"{i+j+1:2d}. {mnemonic[i+j]:<12s}" for j in range(4))
            click.echo(f"    {line}")
        click.echo()
        click.echo(click.style("  SAVE THIS! Write it down on paper.", fg="red", bold=True))
        click.echo(click.style("  Do not store it digitally.", fg="red"))

        # Verify 3 random words
        click.echo()
        click.echo(click.style("  Let's verify you saved it.", bold=True))
        import random
        positions = sorted(random.sample(range(24), 3))
        all_correct = True
        for pos in positions:
            answer = click.prompt(f"  Word #{pos + 1}").strip().lower()
            if answer != mnemonic[pos]:
                all_correct = False
                break

        if all_correct:
            click.echo(click.style("  [ok] Recovery phrase verified", fg="green"))
        else:
            click.echo()
            click.echo(click.style("  Mismatch. Showing the phrase one more time:", fg="yellow"))
            click.echo()
            for i in range(0, 24, 4):
                line = "    ".join(f"{i+j+1:2d}. {mnemonic[i+j]:<12s}" for j in range(4))
                click.echo(f"    {line}")
            click.echo()
            click.echo(click.style("  Write it down now. This is your last chance.", fg="red", bold=True))
            click.prompt("  Press Enter when saved", default="", show_default=False)

    # --- Step 2: Passphrase ---
    click.echo()
    click.echo(click.style("  Choose a passphrase to encrypt your identity seed:", bold=True))
    click.echo("  (minimum 8 characters)")
    while True:
        passphrase = click.prompt("  Passphrase", hide_input=True)
        if len(passphrase) < 8:
            click.echo(click.style("  Passphrase must be at least 8 characters", fg="yellow"))
            continue
        confirm = click.prompt("  Confirm", hide_input=True)
        if passphrase != confirm:
            click.echo(click.style("  Passphrases do not match — try again", fg="yellow"))
            continue
        break

    # --- Step 3: Wrap ---
    click.echo("  Encrypting seed (Argon2id + AES-256-GCM)...")
    wrapped, salt = seed_wrap.wrap(seed, passphrase)
    seed_wrap.save_wrapped(wrapped, salt, out_dir)

    # Zero sensitive variables
    seed = b"\x00" * 32
    passphrase = "\x00" * len(passphrase)
    del seed, passphrase

    click.echo(click.style("  [ok] Identity seed encrypted", fg="green"))
    click.echo(click.style("  [ok] Raw seed zeroed from memory", fg="green"))
    click.echo()
    click.echo(f"  Files saved to {out_dir}/")
    click.echo(f"    wrapped_seed.bin      (60 bytes)")
    click.echo(f"    master_seed.salt    (16 bytes)")
    click.echo()
    click.echo("  Next: upload to your Home Node with:")
    click.echo(click.style("    dina bootstrap-server --host user@mynode.example", fg="cyan"))


# ── bootstrap-server ─────────────────────────────────────────────────


@cli.command("bootstrap-server", hidden=True)  # Admin operation — use dina-admin
@click.option("--host", "ssh_host", help="SSH destination (user@host)")
@click.option("--remote-dir", default="/opt/dina/secrets", show_default=True,
              help="Remote directory for secrets on the server")
@click.option("--local-dir", type=click.Path(exists=False),
              help="Copy to a local path instead of SSH (self-hosted)")
@click.option("--identity-dir", type=click.Path(exists=True), default=None,
              help="Local identity directory (default: ~/.dina/cli/identity/)")
@click.pass_context
def bootstrap_server(ctx: click.Context, ssh_host: str | None, remote_dir: str,
                     local_dir: str | None, identity_dir: str | None) -> None:
    """Upload wrapped identity seed to a Dina Home Node.

    The server never sees the raw seed — only the encrypted blob and salt
    are transferred. Requires 'dina init-identity' first.

    \b
    Two modes:
      SSH:   dina bootstrap-server --host user@mynode.example
      Local: dina bootstrap-server --local-dir /path/to/dina/secrets
    """
    import shutil
    import subprocess
    from pathlib import Path
    from . import seed_wrap

    src_dir = Path(identity_dir) if identity_dir else _IDENTITY_DIR

    # Verify wrapped files exist locally
    wrapped_path = src_dir / "wrapped_seed.bin"
    salt_path = src_dir / "master_seed.salt"
    if not wrapped_path.exists() or not salt_path.exists():
        click.echo(click.style(
            "Error: No wrapped seed found. Run 'dina init-identity' first.",
            fg="red",
        ), err=True)
        ctx.exit(1)
        return

    # Verify file sizes
    if wrapped_path.stat().st_size != 60:
        click.echo(click.style("Error: wrapped_seed.bin is not 60 bytes — file may be corrupted", fg="red"), err=True)
        ctx.exit(1)
        return
    if salt_path.stat().st_size != 16:
        click.echo(click.style("Error: master_seed.salt is not 16 bytes — file may be corrupted", fg="red"), err=True)
        ctx.exit(1)
        return

    click.echo(f"  Source: {src_dir}/")
    click.echo(f"    wrapped_seed.bin   ({wrapped_path.stat().st_size} bytes)")
    click.echo(f"    master_seed.salt ({salt_path.stat().st_size} bytes)")
    click.echo()

    if local_dir:
        # Local copy mode
        dest = Path(local_dir)
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(wrapped_path), str(dest / "wrapped_seed.bin"))
        shutil.copy2(str(salt_path), str(dest / "master_seed.salt"))
        click.echo(click.style(f"  [ok] Copied to {dest}/", fg="green"))

    elif ssh_host:
        # SSH/SCP mode
        click.echo(f"  Uploading to {ssh_host}:{remote_dir}/")

        # Create remote directory
        mkdir_cmd = ["ssh", ssh_host, f"mkdir -p {remote_dir} && chmod 700 {remote_dir}"]
        result = subprocess.run(mkdir_cmd, capture_output=True, text=True)
        if result.returncode != 0:
            click.echo(click.style(f"  Error creating remote directory: {result.stderr.strip()}", fg="red"), err=True)
            ctx.exit(1)
            return

        # SCP the files
        scp_cmd = [
            "scp", "-q",
            str(wrapped_path), str(salt_path),
            f"{ssh_host}:{remote_dir}/",
        ]
        result = subprocess.run(scp_cmd, capture_output=True, text=True)
        if result.returncode != 0:
            click.echo(click.style(f"  Error: {result.stderr.strip()}", fg="red"), err=True)
            ctx.exit(1)
            return

        # Set permissions on remote
        chmod_cmd = ["ssh", ssh_host,
                     f"chmod 600 {remote_dir}/wrapped_seed.bin {remote_dir}/master_seed.salt"]
        subprocess.run(chmod_cmd, capture_output=True)

        click.echo(click.style("  [ok] Uploaded to server", fg="green"))

    else:
        click.echo(click.style(
            "Error: specify --host (SSH) or --local-dir (local copy)",
            fg="red",
        ), err=True)
        ctx.exit(1)
        return

    # Ask about seed password mode
    click.echo()
    click.echo(click.style("  Seed password mode:", bold=True))
    click.echo("    1) Maximum Security — enter passphrase on every restart")
    click.echo("    2) Server Mode — store passphrase for unattended boot")
    mode = click.prompt("  Choice", type=click.IntRange(1, 2), default=1)

    if mode == 2:
        pw = click.prompt("  Enter seed passphrase (to store on server)", hide_input=True)
        if local_dir:
            dest = Path(local_dir)
            pw_path = dest / "seed_password"
            fd = os.open(str(pw_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                os.write(fd, pw.encode("utf-8"))
            finally:
                os.close(fd)
        elif ssh_host:
            # Write passphrase to remote file via ssh
            write_cmd = ["ssh", ssh_host,
                         f"printf '%s' '{pw}' > {remote_dir}/seed_password && "
                         f"chmod 600 {remote_dir}/seed_password"]
            subprocess.run(write_cmd, capture_output=True)
        click.echo(click.style("  [ok] Passphrase stored on server (Server Mode)", fg="green"))
    else:
        # Create empty seed_password file (Docker Secrets needs it)
        if local_dir:
            dest = Path(local_dir)
            (dest / "seed_password").touch(mode=0o600)
        elif ssh_host:
            subprocess.run(
                ["ssh", ssh_host, f"touch {remote_dir}/seed_password && chmod 600 {remote_dir}/seed_password"],
                capture_output=True,
            )

    click.echo()
    click.echo(click.style("  Done!", bold=True))
    if mode == 1:
        click.echo("  Start your node with:")
        click.echo(click.style("    DINA_SEED_PASSWORD=<passphrase> docker compose up -d", fg="cyan"))
    else:
        click.echo("  Start your node with:")
        click.echo(click.style("    docker compose up -d", fg="cyan"))


# ── web ───────────────────────────────────────────────────────────────────


@cli.command(hidden=True)  # Admin operation — use dina-admin web
@click.pass_context
def web(ctx: click.Context) -> None:
    """Open the Dina admin dashboard in your browser."""
    config = _load_cfg(ctx)
    # Core proxies /admin to Brain
    url = config.core_url.rstrip("/") + "/admin/dashboard"
    click.echo(f"Opening {url}")
    webbrowser.open(url)


# ── session ──────────────────────────────────────────────────────────────


@cli.group()
def session() -> None:
    """Manage agent sessions (named workspaces with scoped access grants)."""


@session.command("start")
@click.option("--name", default="", help="Optional description (e.g. 'chair-research')")
@click.pass_context
def session_start(ctx: click.Context, name: str) -> None:
    """Start a new session. Returns a session ID for use with --session."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        resp = client._request(
            client._core, "POST", "/v1/session/start",
            json={"name": name},
        )
        data = resp.json()
        if json_mode:
            print_result_with_trace(data, json_mode, client.req_id)
        else:
            click.echo(f"  Session: {data.get('id', '?')} ({data.get('name', name)}) active")
    except DinaClientError as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)


@session.command("end")
@click.argument("session_id")
@click.pass_context
def session_end(ctx: click.Context, session_id: str) -> None:
    """End a session and revoke all its grants."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        client._request(
            client._core, "POST", "/v1/session/end",
            json={"id": session_id},
        )
        if not json_mode:
            click.echo(f"  Session '{session_id}' ended. All grants revoked.")
    except DinaClientError as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)


@session.command("list")
@click.pass_context
def session_list(ctx: click.Context) -> None:
    """List active sessions."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        resp = client._request(client._core, "GET", "/v1/sessions")
        data = resp.json()
        sessions = data.get("sessions", [])
        if json_mode:
            print_result_with_trace(sessions, json_mode, client.req_id)
        elif not sessions:
            click.echo("  No active sessions.")
        else:
            click.echo(f"  {'ID':<16} {'Name':<20} {'Status':<10} {'Grants'}")
            for s in sessions:
                grants = ", ".join(
                    g.get("persona_id", "?") for g in s.get("grants", [])
                ) or "none"
                click.echo(
                    f"  {s.get('id', '?'):<16} {s.get('name', '?'):<20} "
                    f"{s.get('status', '?'):<10} {grants}"
                )
    except DinaClientError as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)



# ── task (OpenClaw delegation) ──────────────────────────────────────────


@cli.command()
@click.argument("description")
@click.option("--dry-run", is_flag=True, help="Validate intent without executing")
@click.option("--timeout", default=300, type=int, help="Approval poll timeout in seconds (30–1800, default 300)")
@click.pass_context
def task(ctx: click.Context, description: str, dry_run: bool, timeout: int) -> None:
    """Delegate an autonomous task to OpenClaw.

    Dina validates the task-level intent once (research -> moderate, requires
    approval). After approval, OpenClaw runs autonomously and calls back
    to Dina (ask, validate, remember) at its own discretion.

    Requires OpenClaw Gateway: DINA_OPENCLAW_URL + DINA_OPENCLAW_TOKEN.
    """
    _load_cfg(ctx)
    config = ctx.obj["config"]
    json_mode = ctx.obj["json"]

    if not config.openclaw_url:
        raise click.UsageError(
            "OpenClaw not configured. Set DINA_OPENCLAW_URL or run 'dina configure'."
        )

    if config.role != "agent":
        raise click.UsageError(
            "dina task requires agent role. Re-pair with: dina configure --role agent"
        )

    from .openclaw import OpenClawClient, OpenClawError

    client = _make_client(ctx)
    session_name = f"task-{uuid.uuid4().hex[:8]}"

    try:
        # 1. Start scoped session.
        client.session_start(session_name)
        if not json_mode:
            click.echo(f"  Session: {session_name}")

        # 2. Validate the delegation intent.
        decision = client.process_event({
            "type": "agent_intent",
            "action": "research",
            "target": description[:200],
        }, session=session_name)

        action = decision.get("action", "")

        if action == "deny":
            msg = decision.get("reason", "blocked")
            if json_mode:
                print_result_with_trace({"status": "denied", "reason": msg}, json_mode, client.req_id)
            else:
                print_error_with_trace(f"Task denied: {msg}", json_mode, client.req_id)
            return

        if dry_run:
            status = "requires_approval" if decision.get("requires_approval") else "approved"
            proposal_id = decision.get("proposal_id", "")
            if json_mode:
                r = {"status": status, "dry_run": True}
                if proposal_id:
                    r["proposal_id"] = proposal_id
                print_result_with_trace(r, json_mode, client.req_id)
            else:
                click.echo(f"  [dry-run] Validation: {status}")
                if proposal_id:
                    click.echo(f"  [dry-run] Proposal: {proposal_id}")
                click.echo("  [dry-run] Would invoke OpenClaw after approval.")
            return

        if decision.get("requires_approval"):
            proposal_id = decision.get("proposal_id", "")
            if not json_mode:
                click.echo(f"  Task requires approval (proposal: {proposal_id})")
                click.echo(f"  Approve with: dina-admin intent approve {proposal_id}")

            # Poll for approval (fast then slow, configurable timeout).
            import time
            timeout = min(max(timeout, 30), 1800)  # clamp: 30s min, 30min max
            elapsed = 0
            while elapsed < timeout:
                interval = 5 if elapsed < 30 else 15
                time.sleep(interval)
                elapsed += interval
                try:
                    status = client.proposal_status(proposal_id)
                except DinaClientError:
                    continue
                s = status.get("status", "pending")
                if s == "approved":
                    if not json_mode:
                        click.echo("  Approved!")
                    break
                if s in ("denied", "expired"):
                    reason = status.get("decision_reason", s)
                    if json_mode:
                        print_result_with_trace({"status": s, "reason": reason}, json_mode, client.req_id)
                    else:
                        print_error_with_trace(f"Task {s}: {reason}", json_mode, client.req_id)
                    return
            else:
                print_error_with_trace(f"Approval timeout ({timeout}s). Retry later.", json_mode, client.req_id)
                return

        # 3. Invoke OpenClaw.
        if not json_mode:
            click.echo(f"  Delegating to OpenClaw: {description}")

        # Construct OpenClaw client with real paired device identity.
        # Fail fast if identity is broken — unsigned Gateway calls will
        # produce confusing auth errors downstream.
        identity = client._identity
        try:
            device_did = identity.did()
            _identity_ref = identity  # capture for lambda closure
            sign_fn = lambda data: bytes.fromhex(_identity_ref.sign_data(data))
        except Exception as exc:
            raise click.UsageError(
                f"Cannot load device identity for OpenClaw handshake: {exc}. "
                f"Re-pair with: dina configure --role agent"
            ) from exc
        openclaw = OpenClawClient(
            config.openclaw_url,
            token=config.openclaw_token,
            device_id=device_did,
            device_name=config.device_name or "dina-cli",
            sign_fn=sign_fn,
        )
        try:
            result = openclaw.run_task(description, dina_session=session_name)
        except OpenClawError as exc:
            print_error_with_trace(f"OpenClaw error: {exc}", json_mode, client.req_id)
            return
        finally:
            openclaw.close()

        # 4. Store final summary via staging (auto-caveated for agent-role CLI).
        summary = result.get("summary", description[:200])
        client.staging_ingest({
            "source": "openclaw",
            "source_id": f"task-{uuid.uuid4().hex[:12]}",
            "type": "note",
            "summary": f"Task result: {summary}",
            "body": json.dumps(result.get("data", result), indent=2)[:50000],
            "metadata": json.dumps({"task": description, "session": session_name}),
        }, session=session_name)

        # 5. Display.
        print_result_with_trace(result, json_mode, client.req_id)

    except DinaClientError as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)
    finally:
        try:
            client.session_end(session_name)
        except Exception:
            pass


# ── MCP Server ───────────────────────────────────────────────────────────


@cli.command("mcp-server")
def mcp_server() -> None:
    """Run Dina as an MCP server (stdio transport).

    \b
    For OpenClaw:
      mcp.servers.dina = { command: "dina", args: ["mcp-server"] }

    \b
    For Claude Code:
      claude mcp add dina -- dina mcp-server
    """
    from .mcp_server import run_server
    run_server()
