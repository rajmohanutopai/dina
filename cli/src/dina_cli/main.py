"""Click command group for the Dina CLI.

Commands: remember, recall, validate, validate-status, scrub, rehydrate,
draft, sign, audit.
"""

from __future__ import annotations

import json
import sys
import uuid
import webbrowser
from datetime import datetime, timezone

import click

from .client import DinaClient, DinaClientError
from .config import CONFIG_FILE, load_config, save_config
from .output import print_error, print_result
from .session import SessionStore

# Safe actions that auto-approve when Brain is unavailable.
_SAFE_ACTIONS = frozenset({
    "search", "lookup", "read", "query", "list", "recall", "remember",
})


def _make_client(ctx: click.Context) -> DinaClient:
    """Get or create the DinaClient from Click context."""
    if "client" not in ctx.obj:
        ctx.obj["client"] = DinaClient(ctx.obj["config"])
    return ctx.obj["client"]


@click.group()
@click.option("--json", "json_mode", is_flag=True, help="Machine-readable JSON output")
@click.pass_context
def cli(ctx: click.Context, json_mode: bool) -> None:
    """Dina CLI — encrypted memory, PII scrubbing, action gating."""
    ctx.ensure_object(dict)
    ctx.obj["json"] = json_mode
    ctx.obj["sessions"] = SessionStore()
    # Skip config loading for 'configure' — it runs before config exists.
    if ctx.invoked_subcommand == "configure":
        return
    try:
        ctx.obj["config"] = load_config()
    except click.UsageError:
        if json_mode:
            click.echo(json.dumps({"error": "Not configured. Run: dina configure"}), err=True)
        raise


# ── remember ──────────────────────────────────────────────────────────────


@cli.command()
@click.argument("text")
@click.option("--category", default="note", help="Category: fact, preference, decision, relationship, event, note")
@click.pass_context
def remember(ctx: click.Context, text: str, category: str) -> None:
    """Store a fact in the encrypted vault."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        result = client.vault_store(
            ctx.obj["config"].persona,
            {
                "type": "note",
                "summary": text,
                "body_text": text,
                "source": "dina-cli",
                "metadata": json.dumps({"category": category}),
            },
        )
        item_id = result.get("item_id", result.get("id", ""))
        print_result({"id": f"mem_{item_id[:8]}" if item_id else "mem_ok", "stored": True}, json_mode)
    except DinaClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


# ── recall ────────────────────────────────────────────────────────────────


@cli.command()
@click.argument("query")
@click.option("--limit", default=10, help="Max results to return")
@click.pass_context
def recall(ctx: click.Context, query: str, limit: int) -> None:
    """Search the encrypted vault."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        items = client.vault_query(ctx.obj["config"].persona, query, limit=limit)
        results = [
            {
                "id": it.get("ID", it.get("id", ""))[:12],
                "content": it.get("Summary", it.get("summary", "")),
                "category": _extract_category(it),
                "created": it.get("IngestedAt", it.get("timestamp", "")),
            }
            for it in items
        ]
        print_result(results, json_mode)
    except DinaClientError as exc:
        print_error(str(exc), json_mode)
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
@click.pass_context
def validate(ctx: click.Context, action: str, description: str, count: int, reversible: bool) -> None:
    """Check if an action is approved by user policy."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    config = ctx.obj["config"]
    val_id = f"val_{uuid.uuid4().hex[:8]}"

    try:
        result = client.process_event({
            "type": "agent_intent",
            "action": action,
            "target": description,
            "payload": {
                "action": action,
                "target": description,
                "count": count,
                "reversible": reversible,
            },
        })
        approved = result.get("approved", False)
        requires = result.get("requires_approval", False)

        if approved and not requires:
            status = "approved"
        elif requires:
            status = "pending_approval"
        else:
            status = "denied"

        # Store decision in KV for polling via validate-status
        decision = {"status": status, "action": action, "description": description}
        client.kv_set(f"approval:{val_id}", json.dumps(decision))

        output: dict = {"status": status, "id": val_id}
        if status == "pending_approval":
            output["dashboard_url"] = f"{config.core_url}/approvals/{val_id}"
        if result.get("risk"):
            output["risk"] = result["risk"]

        print_result(output, json_mode)

    except DinaClientError as exc:
        # Fallback: if Brain is unavailable, use conservative local policy
        if "Brain not configured" in str(exc) or "Cannot reach" in str(exc):
            if action in _SAFE_ACTIONS:
                status = "approved"
            else:
                status = "pending_approval"
            output = {"status": status, "id": val_id}
            if status == "pending_approval":
                output["dashboard_url"] = f"{config.core_url}/approvals/{val_id}"
                output["note"] = "Brain unavailable — conservative fallback"
            print_result(output, json_mode)
        else:
            print_error(str(exc), json_mode)
            ctx.exit(1)


# ── validate-status ───────────────────────────────────────────────────────


@cli.command("validate-status")
@click.argument("val_id")
@click.pass_context
def validate_status(ctx: click.Context, val_id: str) -> None:
    """Poll approval status for a pending action."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        raw = client.kv_get(f"approval:{val_id}")
        if raw is None:
            print_error(f"Approval {val_id} not found", json_mode)
            ctx.exit(1)
            return
        decision = json.loads(raw)
        decision["id"] = val_id
        print_result(decision, json_mode)
    except DinaClientError as exc:
        print_error(str(exc), json_mode)
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
        scrubbed = result.get("scrubbed", result.get("Scrubbed", text))
        entities = result.get("entities", result.get("Entities", []))

        session_id = sessions.new_id()
        if entities:
            sessions.save(session_id, entities)

        print_result({"scrubbed": scrubbed, "session": session_id}, json_mode)
    except DinaClientError as exc:
        print_error(str(exc), json_mode)
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
        client.vault_store(
            config.persona,
            {
                "type": "email_draft",
                "summary": f"Draft to {recipient}: {subject}" if subject else f"Draft to {recipient}",
                "body_text": content,
                "source": "dina-cli",
                "source_id": draft_id,
                "metadata": json.dumps({
                    "to": recipient,
                    "channel": channel,
                    "subject": subject,
                    "draft_id": draft_id,
                }),
            },
        )
        print_result({
            "draft_id": draft_id,
            "status": "pending_review",
            "dashboard_url": f"{config.core_url}/drafts/{draft_id}",
        }, json_mode)
    except DinaClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


# ── sign ──────────────────────────────────────────────────────────────────


@cli.command()
@click.argument("content")
@click.pass_context
def sign(ctx: click.Context, content: str) -> None:
    """Cryptographic signature with user's DID key."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        did_doc = client.did_get()
        data_hex = content.encode().hex()
        sig_result = client.did_sign(data_hex)
        print_result({
            "signed_by": did_doc.get("id", did_doc.get("did", "")),
            "signature": sig_result.get("signature", ""),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }, json_mode)
    except DinaClientError as exc:
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
        query = action_filter if action_filter else ""
        items = client.vault_query(
            ctx.obj["config"].persona,
            query,
            types=["email_draft", "note", "event", "message", "cart_handover"],
            limit=limit,
        )
        entries = [
            {
                "action": it.get("Type", it.get("type", "")),
                "summary": it.get("Summary", it.get("summary", "")),
                "source": it.get("Source", it.get("source", "")),
                "timestamp": it.get("IngestedAt", it.get("timestamp", "")),
            }
            for it in items
        ]
        print_result(entries, json_mode)
    except DinaClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


# ── configure ─────────────────────────────────────────────────────────────


@cli.command()
@click.pass_context
def configure(ctx: click.Context) -> None:
    """Set up connection to a Dina Home Node.

    Saves configuration to ~/.dina/cli/config.json.
    Environment variables override saved values.
    """
    click.echo("Dina CLI Configuration")
    click.echo("=" * 40)
    click.echo()

    # Load existing saved config for defaults
    from .config import _load_saved
    existing = _load_saved()

    core_url = click.prompt(
        "Core URL",
        default=existing.get("core_url", "http://localhost:8100"),
    )
    client_token = click.prompt(
        "Client token",
        default=existing.get("client_token", ""),
        hide_input=True,
        show_default=False,
        prompt_suffix=" (hidden): " if not existing.get("client_token") else " (press Enter to keep): ",
    )
    brain_url = click.prompt(
        "Brain URL",
        default=existing.get("brain_url", core_url.replace(":8100", ":8200")),
    )
    brain_token = click.prompt(
        "Brain token (optional, for validate/scrub tier-2)",
        default=existing.get("brain_token", ""),
        hide_input=True,
        show_default=False,
        prompt_suffix=" (hidden, press Enter to skip): ",
    )
    persona = click.prompt(
        "Default persona",
        default=existing.get("persona", "personal"),
    )

    values = {
        "core_url": core_url,
        "brain_url": brain_url,
        "client_token": client_token,
        "persona": persona,
    }
    if brain_token:
        values["brain_token"] = brain_token

    path = save_config(values)
    click.echo()
    click.echo(f"Configuration saved to {path}")

    # Test the connection
    click.echo()
    if click.confirm("Test connection now?", default=True):
        from .config import Config
        from .client import DinaClient, DinaClientError
        cfg = Config(
            core_url=core_url,
            brain_url=brain_url,
            client_token=client_token,
            brain_token=brain_token,
            persona=persona,
            timeout=10.0,
        )
        try:
            with DinaClient(cfg) as client:
                health = client._request(client._core, "GET", "/healthz")
                click.echo(f"  Core ({core_url}): Connected")
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
        click.echo("Ready. Try: dina recall \"hello\"")


# ── web ───────────────────────────────────────────────────────────────────


@cli.command()
@click.pass_context
def web(ctx: click.Context) -> None:
    """Open the Dina admin dashboard in your browser."""
    config = ctx.obj["config"]
    # Admin UI is served by Brain on the same port
    url = config.brain_url.rstrip("/") + "/admin/dashboard"
    click.echo(f"Opening {url}")
    webbrowser.open(url)

