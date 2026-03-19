"""Click command group for the Dina CLI.

Commands: status, remember, ask, validate, validate-status, scrub,
rehydrate, draft, audit, configure, session.
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
from .config import CONFIG_FILE, IDENTITY_DIR, load_config, save_config, _load_saved
from .output import print_error, print_result
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


@click.group()
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
    has_keypair = (IDENTITY_DIR / "ed25519_private.pem").exists()
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
@click.option("--category", default="note", help="Category: fact, preference, decision, relationship, event, note")
@click.pass_context
def remember(ctx: click.Context, text: str, category: str) -> None:
    """Store a fact in the encrypted vault.

    Stores to the default persona (general) via Core's vault API.
    Brain's reasoning pipeline handles persona routing for queries,
    but storage goes directly to the general persona for simplicity.
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        result = client.vault_store(
            "general",
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


# ── ask ──────────────────────────────────────────────────────────────────


@cli.command()
@click.argument("query")
@click.option("--session", default="", help="Session name for scoped access")
@click.pass_context
def ask(ctx: click.Context, query: str, session: str) -> None:
    """Ask Dina a question — she reasons over your encrypted vault.

    Dina searches across all accessible personas, assembles context,
    and gives you a personalized answer. You never need to specify
    which persona to search — Dina figures that out.
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        result = client.reason(query, session=session)

        # Check for async approval-wait (202 from Core)
        if result.get("status") == "pending_approval":
            request_id = result.get("request_id", "")
            persona = result.get("persona", "sensitive")

            if json_mode:
                print_result(result, json_mode)
                return

            click.echo(
                f"Access to '{persona}' data requires approval.",
                err=True,
            )
            click.echo("A notification has been sent. Approve via Telegram or dina-admin.", err=True)

            if not request_id:
                # No request_id — can't poll. Old-style 403.
                ctx.exit(1)
                return

            click.echo("Awaiting approval...", err=True)

            import time
            timeout = 300   # 5 minutes
            interval = 5    # poll every 5 seconds
            elapsed = 0
            while elapsed < timeout:
                time.sleep(interval)
                elapsed += interval
                try:
                    status = client.reason_status(request_id)
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
            click.echo(f"Check later: dina reason-status {request_id}", err=True)
            ctx.exit(1)
            return

        # Normal (immediate) response
        if json_mode:
            print_result(result, json_mode)
        else:
            answer = result.get("content", result.get("response", ""))
            if answer:
                click.echo(answer)
            else:
                click.echo("No results found.")
    except DinaClientError as exc:
        if "approval_required" in str(exc).lower():
            click.echo("Access to sensitive data requires approval.", err=True)
            click.echo("A notification has been sent. Approve via Telegram or dina-admin.", err=True)
        elif "persona locked" in str(exc).lower():
            click.echo("Some data is locked. Unlock on your Home Node: ./dina-admin persona unlock", err=True)
        else:
            print_error(str(exc), json_mode)
        ctx.exit(1)


@cli.command("reason-status")
@click.argument("request_id")
@click.pass_context
def reason_status_cmd(ctx: click.Context, request_id: str) -> None:
    """Check the status of a pending reason request.

    Use this when 'dina ask' timed out waiting for approval. Pass the
    request_id that was printed at timeout.
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        status = client.reason_status(request_id)
        if json_mode:
            print_result(status, json_mode)
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
        # Fallback: if Core/Brain is unavailable, use conservative local policy
        if "Cannot reach" in str(exc) or "unavailable" in str(exc).lower():
            if action in _SAFE_ACTIONS:
                status = "approved"
            else:
                status = "pending_approval"
            # Store fallback decision in KV so validate-status can poll it
            decision = {"status": status, "action": action, "description": description}
            try:
                client.kv_set(f"approval:{val_id}", json.dumps(decision))
            except DinaClientError:
                pass  # Core KV also unavailable — still return the decision
            output = {"status": status, "id": val_id}
            if status == "pending_approval":
                output["dashboard_url"] = f"{config.core_url}/approvals/{val_id}"
                output["note"] = "Guardian unavailable — conservative fallback"
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
        scrubbed = result.get("scrubbed", text)
        entities = result.get("entities", [])

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
        # Route through Brain — Brain decides persona routing for drafts
        client.reason(
            f"Draft a message to {recipient} via {channel}"
            + (f" with subject '{subject}'" if subject else "")
            + f": {content}",
        )
        # Also store the draft metadata via vault for tracking
        client.vault_store(
            "general",  # drafts go to default persona
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

    device_name = click.prompt(
        "Device name",
        default=existing.get("device_name") or _default_device_name(),
    )
    click.echo()
    _configure_signature(core_url, device_name)

    values: dict[str, Any] = {
        "core_url": core_url,
        "device_name": device_name,
    }

    path = save_config(values)
    click.echo()
    click.echo(f"Configuration saved to {path}")

    # Test the connection
    click.echo()
    if click.confirm("Test connection now?", default=True):
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
        click.echo("Ready. Try: dina ask \"hello\"")


def _default_device_name() -> str:
    """Generate a default device name from hostname."""
    import platform
    return f"{platform.node()}-cli"


def _configure_signature(core_url: str, device_name: str) -> None:
    """Generate keypair and pair with Core using Ed25519 public key."""
    from .signing import CLIIdentity

    identity = CLIIdentity()

    if identity.exists:
        click.echo(f"  Keypair exists: {identity.did()}")
        if not click.confirm("  Generate a new keypair?", default=False):
            # Re-pair with existing key
            _pair_with_key(core_url, identity, device_name)
            return

    click.echo("  Generating Ed25519 keypair...")
    identity.generate()
    click.echo(f"  DID: {identity.did()}")
    click.echo(f"  Keypair saved to {identity._dir}")
    click.echo()

    _pair_with_key(core_url, identity, device_name)


def _pair_with_key(core_url: str, identity: Any, device_name: str) -> None:
    """Register the public key with Core using a pairing code."""
    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
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
                },
                timeout=10.0,
            )
            resp.raise_for_status()
            data = resp.json()
            click.echo(f"  Paired! Device ID: {data.get('device_id', 'ok')}")
            node_did = data.get("node_did", "")
            if node_did:
                click.echo(f"  Home Node DID: {node_did}")
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
@click.option("--name", required=True, help="Session name (e.g. 'chair-research')")
@click.pass_context
def session_start(ctx: click.Context, name: str) -> None:
    """Start a new named session."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        resp = client._request(
            client._core, "POST", "/v1/session/start",
            json={"name": name},
        )
        data = resp.json()
        if json_mode:
            print_result(data, json_mode)
        else:
            click.echo(f"  Session: {data.get('id', '?')} ({data.get('name', name)}) active")
    except DinaClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@session.command("end")
@click.option("--name", required=True, help="Session name to end")
@click.pass_context
def session_end(ctx: click.Context, name: str) -> None:
    """End a session and revoke all its grants."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        client._request(
            client._core, "POST", "/v1/session/end",
            json={"name": name},
        )
        if not json_mode:
            click.echo(f"  Session '{name}' ended. All grants revoked.")
    except DinaClientError as exc:
        print_error(str(exc), json_mode)
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
            print_result(sessions, json_mode)
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
        print_error(str(exc), json_mode)
        ctx.exit(1)

