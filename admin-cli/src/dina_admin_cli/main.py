"""Click command groups for the Dina Admin CLI.

Commands: status, approvals {list,approve,deny},
device {list,pair,revoke}, persona {list,create,unlock},
identity {show,sign}, policy {list,set,reset}.

Runs inside the Core container via Unix socket.
Usage: docker compose exec core dina-admin ...
   or: ./dina-admin ...  (wrapper script)
"""

from __future__ import annotations

import json
import os
from typing import Any

import click

from .client import AdminClient, AdminClientError
from .config import load_config
from .output import print_error, print_result


def _load_cfg(ctx: click.Context):
    """Lazy-load config on first access."""
    if "config" not in ctx.obj:
        try:
            ctx.obj["config"] = load_config()
        except click.UsageError as exc:
            if ctx.obj.get("json"):
                click.echo(
                    json.dumps({"error": str(exc)}),
                    err=True,
                )
            raise
    return ctx.obj["config"]


def _make_client(ctx: click.Context) -> AdminClient:
    """Get or create the AdminClient from Click context."""
    if "client" not in ctx.obj:
        ctx.obj["client"] = AdminClient(_load_cfg(ctx))
    return ctx.obj["client"]


def _admin_version() -> str:
    """Read version from importlib metadata."""
    try:
        from importlib.metadata import version as pkg_version
        return pkg_version("dina-admin-cli")
    except Exception:
        return "dev"


@click.group()
@click.version_option(version=_admin_version(), prog_name="dina-admin")
@click.option("--json", "json_mode", is_flag=True, help="Machine-readable JSON output")
@click.pass_context
def cli(ctx: click.Context, json_mode: bool) -> None:
    """Dina Admin CLI — headless management for the Dina Home Node."""
    ctx.ensure_object(dict)
    ctx.obj["json"] = json_mode


# ── status ───────────────────────────────────────────────────────────────────


@cli.command()
@click.pass_context
def status(ctx: click.Context) -> None:
    """Show Home Node health, identity, and summary counts."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        result: dict[str, Any] = {}

        # Health
        try:
            client.healthz()
            result["core"] = "healthy"
        except AdminClientError:
            result["core"] = "unreachable"

        try:
            client.readyz()
            result["ready"] = True
        except AdminClientError:
            result["ready"] = False

        # DID
        try:
            did_doc = client.get_did()
            result["did"] = did_doc.get("id", did_doc.get("did", "unknown"))
        except AdminClientError:
            result["did"] = "unavailable"

        # Counts
        try:
            personas = client.list_personas()
            if isinstance(personas, dict):
                personas = personas.get("personas", [])
            result["personas"] = len(personas) if isinstance(personas, list) else "?"
        except AdminClientError:
            result["personas"] = "?"

        try:
            devices = client.list_devices()
            device_list = (
                devices.get("devices", []) if isinstance(devices, dict) else devices
            )
            result["devices"] = len(device_list) if isinstance(device_list, list) else "?"
        except AdminClientError:
            result["devices"] = "?"

        # LLM status from Brain healthz
        try:
            import urllib.request
            import json as _json
            brain_url = os.environ.get("DINA_BRAIN_URL", "http://brain:8200")
            req = urllib.request.Request(f"{brain_url}/healthz", method="GET")
            with urllib.request.urlopen(req, timeout=3) as resp:
                brain_health = _json.loads(resp.read())
            llm_models = brain_health.get("llm_models", {})
            llm_usage = brain_health.get("llm_usage", {})
            result["llm"] = brain_health.get("llm_router", "unavailable")
            result["llm_lite"] = llm_models.get("lite", "?")
            result["llm_primary"] = llm_models.get("primary", "?")
            result["llm_heavy"] = llm_models.get("heavy", "?")
            result["llm_calls"] = llm_usage.get("total_calls", 0)
        except Exception:
            result["llm"] = "unreachable"

        print_result(result, json_mode)
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


# ── inbox ─────────────────────────────────────────────────────────────────────


@cli.command()
@click.pass_context
def inbox(ctx: click.Context) -> None:
    """Show received D2D messages.

    \b
    Examples:
      dina-admin inbox
    """
    import base64

    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        data = client.inbox()
        messages = data.get("messages", [])
        if json_mode:
            print_result(messages, json_mode)
        elif not messages:
            click.echo("No messages.")
        else:
            # Resolve DIDs to contact names.
            did_names: dict[str, str] = {}
            try:
                contacts_resp = client._request("GET", "/v1/contacts")
                for c in contacts_resp.json().get("contacts", []):
                    did_names[c.get("did", "")] = c.get("name", "")
            except Exception:
                pass

            click.echo(f"  {len(messages)} message(s)\n")
            for m in messages:
                msg_type = m.get("type", "?")
                from_did = m.get("from", "?")
                sender = did_names.get(from_did, from_did[:30] + "...")
                quarantined = m.get("quarantined", False)
                raw_body = m.get("body", "")
                try:
                    body = base64.b64decode(raw_body).decode("utf-8", errors="replace")
                except Exception:
                    body = str(raw_body)
                q_flag = " [QUARANTINED]" if quarantined else ""
                click.echo(f"  {msg_type:25s} from {sender}{q_flag}")
                click.echo(f"    {body[:120]}")
                click.echo()
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


# ── ask ──────────────────────────────────────────────────────────────────────


@cli.command()
@click.argument("text", nargs=-1, required=True)
@click.pass_context
def ask(ctx: click.Context, text: tuple[str, ...]) -> None:
    """Query your vault — same as /ask on Telegram or dina ask on CLI.

    \b
    Examples:
      dina-admin ask What kind of tea do I like?
      dina-admin ask What is my FD status?
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    query = " ".join(text)
    try:
        result = client.ask(query)
        if json_mode:
            print_result(result, json_mode)
        else:
            content = (
                result.get("content", "")
                or result.get("response", "")
                or "No response."
            )
            if isinstance(content, dict):
                content = content.get("text", content.get("answer", str(content)))
            click.echo(content)
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


# ── remember ─────────────────────────────────────────────────────────────────


@cli.command()
@click.argument("text", nargs=-1, required=True)
@click.pass_context
def remember(ctx: click.Context, text: tuple[str, ...]) -> None:
    """Store a memory — same as /remember on Telegram or dina remember on CLI.

    \b
    Examples:
      dina-admin remember My FD interest rate is now 7.8%
      dina-admin remember Team standup moved to Tuesday 10am
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    memory = " ".join(text)
    try:
        result = client.remember(memory)
        if json_mode:
            print_result(result, json_mode)
        else:
            status = result.get("status", "unknown")
            msg = result.get("message", "")
            if status == "stored":
                click.echo(f"Stored. {msg}")
            elif status == "needs_approval":
                click.echo(f"Needs approval. {msg}")
                item_id = result.get("id", "")
                if item_id:
                    click.echo(f"  Check: dina-admin approvals")
            elif status == "failed":
                click.echo(f"Failed. {msg}")
            else:
                click.echo(f"{status}: {msg}")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


# ── vault ─────────────────────────────────────────────────────────────────────


@cli.group()
def vault() -> None:
    """Search, list, and manage vault items.

    \b
    Examples:
      dina-admin vault list --persona general              # latest 20 items
      dina-admin vault list --persona health --offset 20   # next 20
      dina-admin vault search --persona general "tea"      # keyword search
      dina-admin vault delete <item-id> --persona general  # delete one item
    """


def _print_items(items: list, json_mode: bool) -> None:
    """Format vault items for display."""
    if json_mode:
        print_result(items, json_mode)
        return
    if not items:
        click.echo("No items found.")
        return
    for item in items:
        iid = item.get("id", "?")
        summary = item.get("summary", item.get("content_l0", ""))
        itype = item.get("type", "")
        if len(summary) > 100:
            summary = summary[:100] + "..."
        click.echo(f"  {iid}  [{itype}]  {summary}")
    click.echo(f"  ({len(items)} items)")


@vault.command("list")
@click.option("--persona", default="general", help="Persona to list (default: general)")
@click.option("--limit", default=20, help="Max results per page")
@click.option("--offset", default=0, help="Skip this many items (pagination)")
@click.pass_context
def vault_list(ctx: click.Context, persona: str, limit: int, offset: int) -> None:
    """List vault items (most recent first). Use --offset for pagination."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        items = client.vault_query(persona, query="", limit=limit, offset=offset)
        _print_items(items, json_mode)
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@vault.command("search")
@click.argument("query")
@click.option("--persona", default="general", help="Persona to search (default: general)")
@click.option("--mode", default="fts5", type=click.Choice(["fts5", "semantic", "hybrid"]), help="Search mode")
@click.option("--limit", default=20, help="Max results")
@click.option("--offset", default=0, help="Skip this many items (pagination)")
@click.pass_context
def vault_search(ctx: click.Context, query: str, persona: str, mode: str, limit: int, offset: int) -> None:
    """Search a persona vault for items matching a query."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        items = client.vault_query(persona, query=query, mode=mode, limit=limit, offset=offset)
        _print_items(items, json_mode)
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@vault.command("delete")
@click.argument("item_id")
@click.option("--persona", required=True, help="Persona the item belongs to")
@click.confirmation_option(prompt="Are you sure you want to delete this vault item?")
@click.pass_context
def vault_delete(ctx: click.Context, item_id: str, persona: str) -> None:
    """Delete a vault item by ID. Requires --persona."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        client.vault_delete(persona, item_id)
        if json_mode:
            print_result({"status": "deleted", "id": item_id}, json_mode)
        else:
            click.echo(f"Deleted: {item_id} from {persona}")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


# ── approvals ────────────────────────────────────────────────────────────────


@cli.group(invoke_without_command=True)
@click.pass_context
def approvals(ctx: click.Context) -> None:
    """Review and act on pending approval requests.

    When an agent needs access to a sensitive persona (health, finance),
    Core creates an approval request. The agent's command blocks until
    you approve or deny it here.

    \b
    Scopes (--scope on approve):
      session  Grant lasts until the agent's session ends. (default)
      single   One-shot — consumed on first use, then revoked.

    \b
    Examples:
      dina-admin approvals                           # list pending
      dina-admin approvals approve <id>              # approve (session scope)
      dina-admin approvals approve <id> --scope single  # single-use grant
      dina-admin approvals deny <id>                 # deny
    """
    if ctx.invoked_subcommand is None:
        ctx.invoke(approvals_list)


@approvals.command("list")
@click.pass_context
def approvals_list(ctx: click.Context) -> None:
    """List all pending approval requests."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        data = client.list_approvals()
        if json_mode:
            print_result(data, json_mode)
        else:
            if not data:
                click.echo("No pending approvals.")
            else:
                for a in data:
                    aid = a.get("id", "?")
                    persona = a.get("persona_id", a.get("persona", "?"))
                    action = a.get("action", "persona_access")
                    agent = a.get("client_did", "?")
                    reason = a.get("reason", "")
                    preview = a.get("preview", "")
                    session = a.get("session_id", "")
                    # Truncate long DIDs for display
                    if len(agent) > 24:
                        agent = agent[:20] + "..."
                    line = f"  {aid}  {action}  persona={persona}  agent={agent}"
                    if session:
                        line += f"  session={session}"
                    click.echo(line)
                    if reason:
                        click.echo(f'    reason="{reason}"')
                    if preview:
                        click.echo(f'    preview="{preview}"')
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@approvals.command("approve")
@click.argument("approval_id")
@click.option(
    "--scope", default="session",
    type=click.Choice(["single", "session"]),
    help="Grant scope: single request or full session (default: session)",
)
@click.pass_context
def approvals_approve(ctx: click.Context, approval_id: str, scope: str) -> None:
    """Approve a pending request by ID."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        data = client.approve(approval_id, scope)
        if json_mode:
            print_result(data, json_mode)
        else:
            click.echo(f"Approved: {approval_id} (scope={scope})")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@approvals.command("deny")
@click.argument("approval_id")
@click.pass_context
def approvals_deny(ctx: click.Context, approval_id: str) -> None:
    """Deny a pending request by ID."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        data = client.deny(approval_id)
        if json_mode:
            print_result(data, json_mode)
        else:
            click.echo(f"Denied: {approval_id}")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


# ── intent (agent intent proposals) ──────────────────────────────────────────


@cli.group()
def intent() -> None:
    """Manage agent intent proposals (approve/deny research delegation)."""


@intent.command("list")
@click.pass_context
def intent_list(ctx: click.Context) -> None:
    """List pending intent proposals."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        r = client._request("GET", "/v1/intent/proposals/")
        proposals = r.json().get("proposals", [])
        if json_mode:
            click.echo(json.dumps(proposals, indent=2))
        elif not proposals:
            click.echo("No pending intent proposals.")
        else:
            click.echo(f"{'ID':<40} {'Action':<15} {'Risk':<10} {'Agent DID'}")
            for p in proposals:
                click.echo(
                    f"{p.get('id', '?'):<40} {p.get('action', '?'):<15} "
                    f"{p.get('risk', '?'):<10} {p.get('agent_did', '?')[:30]}"
                )
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@intent.command("approve")
@click.argument("proposal_id")
@click.pass_context
def intent_approve(ctx: click.Context, proposal_id: str) -> None:
    """Approve an intent proposal by ID."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        r = client._request("POST", f"/v1/intent/proposals/{proposal_id}/approve")
        if json_mode:
            click.echo(json.dumps(r.json(), indent=2))
        else:
            click.echo(f"Approved: {proposal_id}")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@intent.command("deny")
@click.argument("proposal_id")
@click.option("--reason", default="denied by admin", help="Reason for denial")
@click.pass_context
def intent_deny(ctx: click.Context, proposal_id: str, reason: str) -> None:
    """Deny an intent proposal by ID."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        r = client._request(
            "POST", f"/v1/intent/proposals/{proposal_id}/deny",
            json={"reason": reason},
        )
        if json_mode:
            click.echo(json.dumps(r.json(), indent=2))
        else:
            click.echo(f"Denied: {proposal_id}")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


# ── device ───────────────────────────────────────────────────────────────────


@cli.group()
def device() -> None:
    """Manage paired devices."""


@device.command("list")
@click.pass_context
def device_list(ctx: click.Context) -> None:
    """List all paired devices."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        data = client.list_devices()
        devices = data.get("devices", []) if isinstance(data, dict) else data
        if json_mode:
            print_result(devices, json_mode)
        else:
            if not devices:
                click.echo("No paired devices.")
            else:
                for d in devices:
                    did = d.get("token_id", d.get("id", "?"))
                    name = d.get("name", d.get("device_name", "?"))
                    device_did = d.get("did", "")
                    auth = d.get("auth_type", "")
                    revoked = " [revoked]" if d.get("revoked") else ""
                    click.echo(f"  {did}  {name}{revoked}")
                    if device_did:
                        click.echo(f"         DID:  {device_did}")
                    if auth:
                        click.echo(f"         Auth: {auth}")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@device.command("pair")
@click.pass_context
def device_pair(ctx: click.Context) -> None:
    """Generate a 6-digit pairing code for a new device."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        data = client.initiate_pairing()
        if json_mode:
            print_result(data, json_mode)
        else:
            code = data.get("code", "?")
            expires = data.get("expires_in", 300)
            click.echo(f"Pairing code: {code}")
            click.echo(f"Expires in {expires} seconds.")
            click.echo()
            click.echo("Enter this code on the new device.")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@device.command("revoke")
@click.argument("device_id")
@click.pass_context
def device_revoke(ctx: click.Context, device_id: str) -> None:
    """Revoke a paired device by ID."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        client.revoke_device(device_id)
        print_result({"status": "revoked", "device_id": device_id}, json_mode)
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


# ── persona ──────────────────────────────────────────────────────────────────


@cli.group()
def persona() -> None:
    """Manage personas (cryptographic compartments)."""


@persona.command("list")
@click.pass_context
def persona_list(ctx: click.Context) -> None:
    """List all personas."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        data = client.list_personas()
        if json_mode:
            print_result(data, json_mode)
        else:
            if not data:
                click.echo("No personas.")
            else:
                for p in data:
                    name = p.get("name", p.get("id", "?"))
                    tier = p.get("tier", "?")
                    locked = p.get("locked", False)
                    desc = p.get("description", "")
                    state = "locked" if locked else "open"
                    line = f"  {name}  (tier: {tier}, {state})"
                    if desc:
                        line += f"  — {desc}"
                    click.echo(line)
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@persona.command("create")
@click.option("--name", prompt=True, help="Persona name")
@click.option(
    "--tier",
    prompt=True,
    default="standard",
    type=click.Choice(["default", "standard", "sensitive", "locked"]),
    help="Persona tier",
)
@click.option(
    "--description",
    default="",
    help="What data belongs here (helps AI classify correctly)",
)
@click.option(
    "--passphrase",
    prompt=True,
    hide_input=True,
    confirmation_prompt=True,
    help="Passphrase to protect this persona",
)
@click.pass_context
def persona_create(
    ctx: click.Context, name: str, tier: str, description: str, passphrase: str
) -> None:
    """Create a new persona."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        data = client.create_persona(name, tier, passphrase, description)
        print_result(data, json_mode)
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@persona.command("edit")
@click.option("--name", required=True, help="Persona to edit")
@click.option("--description", default="", help="New description (classification hint)")
@click.pass_context
def persona_edit(ctx: click.Context, name: str, description: str) -> None:
    """Edit a persona's metadata (description, etc.)."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    if not description:
        click.echo("Nothing to change. Use --description to set a classification hint.")
        return
    try:
        data = client.edit_persona(name, description=description)
        if json_mode:
            print_result(data, json_mode)
        else:
            click.echo(f"Updated: {name}")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@persona.command("unlock")
@click.option("--name", prompt="Persona name", help="Persona to unlock")
@click.option("--passphrase", prompt=True, hide_input=True, help="Passphrase")
@click.pass_context
def persona_unlock(ctx: click.Context, name: str, passphrase: str) -> None:
    """Unlock a persona's vault."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        data = client.unlock_persona(name, passphrase)
        print_result(data, json_mode)
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


# ── identity ─────────────────────────────────────────────────────────────────


@cli.group()
def identity() -> None:
    """Node identity and signing."""


@identity.command("show")
@click.pass_context
def identity_show(ctx: click.Context) -> None:
    """Show the node's DID document."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        data = client.get_did()
        print_result(data, json_mode)
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@identity.command("sign")
@click.argument("data")
@click.pass_context
def identity_sign(ctx: click.Context, data: str) -> None:
    """Sign data with the node's Ed25519 key."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        result = client.sign_data(data)
        print_result(result, json_mode)
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


# ── security ─────────────────────────────────────────────────────────────────


@cli.group()
def security() -> None:
    """Manage startup security mode (auto-start vs manual passphrase)."""


@security.command("auto-start")
def security_auto_start() -> None:
    """Store passphrase locally — Dina starts without prompting.

    This command is handled by the host-side dina-admin wrapper.
    Run: ./dina-admin security auto-start
    """
    click.echo("This command must be run from the host (not inside the container).")
    click.echo("Run: ./dina-admin security auto-start")


@security.command("manual-start")
def security_manual_start() -> None:
    """Require passphrase on each start (most secure).

    This command is handled by the host-side dina-admin wrapper.
    Run: ./dina-admin security manual-start
    """
    click.echo("This command must be run from the host (not inside the container).")
    click.echo("Run: ./dina-admin security manual-start")


@security.command("status")
def security_status() -> None:
    """Show current startup security mode.

    This command is handled by the host-side dina-admin wrapper.
    Run: ./dina-admin security status
    """
    click.echo("This command must be run from the host (not inside the container).")
    click.echo("Run: ./dina-admin security status")


# ── model ────────────────────────────────────────────────────────────────────


@cli.group()
def model() -> None:
    """Manage LLM models and providers."""


@model.command("list")
def model_list() -> None:
    """Show available LLM models and providers.

    This command is handled by the host-side dina-admin wrapper.
    Run: ./dina-admin model list
    """
    click.echo("This command must be run from the host (not inside the container).")
    click.echo("Run: ./dina-admin model list")


@model.command("status")
def model_status() -> None:
    """Show which models are currently active.

    This command is handled by the host-side dina-admin wrapper.
    Run: ./dina-admin model status
    """
    click.echo("This command must be run from the host (not inside the container).")
    click.echo("Run: ./dina-admin model status")


@model.command("set")
@click.argument("env_var")
@click.argument("model_id")
def model_set(env_var: str, model_id: str) -> None:
    """Set a model override (e.g. GEMINI_MODEL gemini-2.5-flash).

    This command is handled by the host-side dina-admin wrapper.
    Run: ./dina-admin model set <ENV_VAR> <model_id>
    """
    click.echo("This command must be run from the host (not inside the container).")
    click.echo(f"Run: ./dina-admin model set {env_var} {model_id}")


# ── trace ────────────────────────────────────────────────────────────────────


@cli.command()
@click.argument("req_id")
@click.pass_context
def trace(ctx: click.Context, req_id: str) -> None:
    """Show request trace timeline."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        resp = client._request("GET", f"/v1/trace/{req_id}")
        data = resp.json()
        events = data.get("events", [])
        if json_mode:
            click.echo(json.dumps(data, indent=2))
            return
        if not events:
            click.echo(f"No trace found for {req_id}")
            return
        base_ts = events[0]["ts_ms"]
        for e in events:
            offset = e["ts_ms"] - base_ts
            detail = json.loads(e["detail"]) if isinstance(e["detail"], str) else e["detail"]
            parts = [f"{k}={v}" for k, v in detail.items()]
            click.echo(
                f"  [+{offset}ms]  {e['component']:<6} {e['step']:<20} {' '.join(parts)}"
            )
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


# ── policy (action risk policy) ──────────────────────────────────────────

# ── channel (notification channels) ──────────────────────────────────────


@cli.group()
def channel() -> None:
    """Manage notification channels (Telegram, WhatsApp, etc.).

    \b
    Examples:
      dina-admin channel add telegram --token <bot-token> --user-id <id>
      dina-admin channel list
      dina-admin channel remove telegram
    """


@channel.command("add")
@click.argument("channel_type", type=click.Choice(["telegram"]))
@click.option("--token", required=True, help="Bot token (from @BotFather for Telegram)")
@click.option("--user-id", default="", help="Owner's user ID (Telegram numeric ID)")
@click.option("--group-id", default="", help="Group chat ID (optional)")
@click.pass_context
def channel_add(ctx: click.Context, channel_type: str, token: str, user_id: str, group_id: str) -> None:
    """Add a notification channel. Requires container restart to take effect."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        # Store in KV for Brain to read
        channel_config = {
            "type": channel_type,
            "token": token,
            "user_id": user_id,
            "group_id": group_id,
            "enabled": True,
        }
        client.set_kv(f"admin:channel:{channel_type}", json.dumps(channel_config))

        # Also write to .env so it survives Docker restarts.
        # The dina-admin wrapper runs inside the container, so we write
        # to a KV key that the host-side script can read.
        env_vars = {}
        if channel_type == "telegram":
            env_vars["DINA_TELEGRAM_TOKEN"] = token
            if user_id:
                env_vars["DINA_TELEGRAM_ALLOWED_USERS"] = user_id
            if group_id:
                env_vars["DINA_TELEGRAM_ALLOWED_GROUPS"] = group_id

        # Store env vars in KV so the host-side dina-admin wrapper can
        # read them and update .env.
        client.set_kv("admin:channel_env_pending", json.dumps(env_vars))

        if json_mode:
            print_result({"status": "added", "channel": channel_type, "restart_required": True}, json_mode)
        else:
            click.echo(f"  Channel added: {channel_type}")
            click.echo(f"  Token: {token[:8]}...{token[-4:]}")
            if user_id:
                click.echo(f"  User ID: {user_id}")
            click.echo()
            click.echo("  Restart required to activate:")
            click.echo("    docker compose restart brain")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@channel.command("list")
@click.pass_context
def channel_list(ctx: click.Context) -> None:
    """List configured notification channels."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        channels = []
        for ch_type in ["telegram"]:
            raw = client.get_kv(f"admin:channel:{ch_type}")
            if raw:
                cfg = json.loads(raw)
                cfg["channel"] = ch_type
                # Mask token for display
                token = cfg.get("token", "")
                if len(token) > 12:
                    cfg["token_masked"] = f"{token[:8]}...{token[-4:]}"
                else:
                    cfg["token_masked"] = "***"
                del cfg["token"]
                channels.append(cfg)

        if json_mode:
            print_result(channels, json_mode)
        elif not channels:
            click.echo("  No channels configured.")
            click.echo("  Add one: dina-admin channel add telegram --token <token> --user-id <id>")
        else:
            for ch in channels:
                status = "enabled" if ch.get("enabled") else "disabled"
                click.echo(f"  {ch['channel']}  ({status})")
                click.echo(f"    token: {ch['token_masked']}")
                if ch.get("user_id"):
                    click.echo(f"    user_id: {ch['user_id']}")
                if ch.get("group_id"):
                    click.echo(f"    group_id: {ch['group_id']}")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@channel.command("remove")
@click.argument("channel_type", type=click.Choice(["telegram"]))
@click.confirmation_option(prompt="Remove this channel?")
@click.pass_context
def channel_remove(ctx: click.Context, channel_type: str) -> None:
    """Remove a notification channel. Requires container restart."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        # Clear KV
        client.set_kv(f"admin:channel:{channel_type}", "")
        # Queue env removal
        client.set_kv("admin:channel_env_pending", json.dumps({
            f"DINA_TELEGRAM_TOKEN": "",
            f"DINA_TELEGRAM_ALLOWED_USERS": "",
            f"DINA_TELEGRAM_ALLOWED_GROUPS": "",
        }))
        if json_mode:
            print_result({"status": "removed", "channel": channel_type}, json_mode)
        else:
            click.echo(f"  Channel removed: {channel_type}")
            click.echo("  Restart required: docker compose restart brain")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


# ── policy (action risk policy) ──────────────────────────────────────────

_POLICY_KV_KEY = "admin:action_risk_policy"
_VALID_RISK_LEVELS = ("safe", "moderate", "high", "blocked")

# Default policy — mirrors the module-level frozensets in guardian.py.
_DEFAULT_POLICY: dict[str, list[str]] = {
    "blocked": ["access_keys", "export_data", "read_vault"],
    "high": ["delete_data", "share_data", "sign_contract", "transfer_money"],
    "moderate": [
        "calendar_create", "draft_create", "draft_email", "form_fill",
        "install_extension", "pay_crypto", "pay_upi", "research",
        "send_email", "send_message", "share_location", "web_checkout",
    ],
}


@cli.group()
def policy() -> None:
    """Manage the action risk policy (which actions are safe/moderate/high/blocked).

    \b
    Examples:
      dina-admin policy list                          # show current policy
      dina-admin policy set send_email high           # escalate send_email to high
      dina-admin policy set research safe             # downgrade research to safe
      dina-admin policy reset                         # restore defaults
    """


def _load_policy(client: AdminClient) -> dict:
    """Load the current policy from KV, or return defaults."""
    raw = client.get_kv(_POLICY_KV_KEY)
    if raw:
        return json.loads(raw)
    return dict(_DEFAULT_POLICY)


def _save_policy(client: AdminClient, pol: dict) -> None:
    """Persist the policy to KV (admin + agent-readable copy)."""
    value = json.dumps(pol)
    client.set_kv(_POLICY_KV_KEY, value)
    # Agent-readable copy — admin: prefix blocks device-scoped callers,
    # so we also write to policy: prefix for dina validate-actions.
    client.set_kv("policy:action_risk", value)


@policy.command("list")
@click.pass_context
def policy_list(ctx: click.Context) -> None:
    """Show the current action risk policy."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        pol = _load_policy(client)
        if json_mode:
            print_result(pol, json_mode)
            return

        click.echo("Action Risk Policy")
        click.echo("==================")
        for level, label in [
            ("blocked", "BLOCKED (always denied)"),
            ("high", "HIGH (requires user approval, high severity)"),
            ("moderate", "MODERATE (requires user approval)"),
            ("safe", "SAFE (auto-approved)"),
        ]:
            actions = sorted(pol.get(level, []))
            click.echo()
            click.echo(f"{label}:")
            for a in actions:
                click.echo(f"  - {a}")
            if not actions:
                click.echo("  (none)")
        click.echo()
        click.echo("Unlisted actions default to SAFE.")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@policy.command("set")
@click.argument("action")
@click.argument("risk", type=click.Choice(_VALID_RISK_LEVELS))
@click.pass_context
def policy_set(ctx: click.Context, action: str, risk: str) -> None:
    """Move an action to a risk level (safe/moderate/high/blocked)."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        pol = _load_policy(client)

        # Remove the action from all existing levels
        for level in ("blocked", "high", "moderate", "safe"):
            actions = pol.get(level, [])
            if action in actions:
                actions.remove(action)
                pol[level] = actions

        # Add to the target level
        pol.setdefault(risk, []).append(action)
        pol[risk] = sorted(set(pol[risk]))

        _save_policy(client, pol)
        if json_mode:
            print_result({"action": action, "risk": risk, "status": "updated"}, json_mode)
        else:
            click.echo(f"Updated: {action} -> {risk.upper()}")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@policy.command("reset")
@click.confirmation_option(prompt="Reset action risk policy to defaults?")
@click.pass_context
def policy_reset(ctx: click.Context) -> None:
    """Reset the action risk policy to factory defaults."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        _save_policy(client, dict(_DEFAULT_POLICY))
        if json_mode:
            print_result({"status": "reset", "policy": _DEFAULT_POLICY}, json_mode)
        else:
            click.echo("Policy reset to defaults.")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


# ── export / import ──────────────────────────────────────────────────────────


@cli.command("export")
@click.option("--passphrase", required=True, help="Passphrase to encrypt the archive")
@click.option("--dest", default="default", help="Export destination name (default: 'default')")
@click.pass_context
def export_cmd(ctx: click.Context, passphrase: str, dest: str) -> None:
    """Export all vault data to an encrypted .dina archive.

    \b
    Examples:
      dina-admin export --passphrase "my-secret"
      dina-admin export --passphrase "my-secret" --dest backup-2026
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        resp = client._request(
            "POST",
            "/v1/export",
            json={"passphrase": passphrase, "dest_path": dest},
        )
        data = resp.json()
        if json_mode:
            print_result(data, json_mode)
        else:
            archive = data.get("archive_path", "?")
            click.echo(f"Exported: {archive}")
            click.echo("Archive encrypted (AES-256-GCM + Argon2id).")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@cli.command("import")
@click.argument("archive_path")
@click.option("--passphrase", required=True, help="Passphrase used during export")
@click.option("--force", is_flag=True, help="Overwrite existing data without confirmation")
@click.pass_context
def import_cmd(ctx: click.Context, archive_path: str, passphrase: str, force: bool) -> None:
    """Import vault data from a .dina archive.

    \b
    Examples:
      dina-admin import dina-export.dina --passphrase "my-secret"
      dina-admin import /backups/dina-export.dina --passphrase "my-secret" --force
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        resp = client._request(
            "POST",
            "/v1/import",
            json={
                "archive_path": archive_path,
                "passphrase": passphrase,
                "force": force,
            },
        )
        data = resp.json()
        if json_mode:
            print_result(data, json_mode)
        else:
            personas = data.get("persona_count", "?")
            files = data.get("files_restored", "?")
            click.echo(f"Imported: {files} files, {personas} personas.")
            if data.get("requires_restart"):
                click.echo("Restart required to load imported data.")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


# ── msgbox / appview config ──────────────────────────────────────────────────

_MSGBOX_KV_KEY = "admin:msgbox_url"
_APPVIEW_KV_KEY = "admin:appview_url"


@cli.group()
def msgbox() -> None:
    """Configure the D2D message relay/mailbox endpoint."""


@msgbox.command("set")
@click.argument("url")
@click.pass_context
def msgbox_set(ctx: click.Context, url: str) -> None:
    """Set the MsgBox URL (e.g., ws://msgbox.dina.dev:7700).

    \b
    Examples:
      dina-admin msgbox set ws://msgbox.dina.dev:7700
      dina-admin msgbox set ws://host.docker.internal:7700
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        client.set_kv(_MSGBOX_KV_KEY, url)
        if json_mode:
            print_result({"msgbox_url": url}, json_mode)
        else:
            click.echo(f"MsgBox URL set: {url}")
            click.echo("Takes effect on next Core restart.")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@msgbox.command("show")
@click.pass_context
def msgbox_show(ctx: click.Context) -> None:
    """Show the configured MsgBox URL."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        value = client.get_kv(_MSGBOX_KV_KEY)
        if json_mode:
            print_result({"msgbox_url": value or ""}, json_mode)
        elif value:
            click.echo(f"MsgBox URL: {value}")
        else:
            click.echo("MsgBox URL: not configured")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@cli.group()
def appview() -> None:
    """Configure the Trust Network AppView endpoint."""


@appview.command("set")
@click.argument("url")
@click.pass_context
def appview_set(ctx: click.Context, url: str) -> None:
    """Set the AppView URL (e.g., https://appview.dina.dev).

    \b
    Examples:
      dina-admin appview set https://appview.dina.dev
      dina-admin appview set http://localhost:3000
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        client.set_kv(_APPVIEW_KV_KEY, url)
        if json_mode:
            print_result({"appview_url": url}, json_mode)
        else:
            click.echo(f"AppView URL set: {url}")
            click.echo("Takes effect on next Core restart.")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@appview.command("show")
@click.pass_context
def appview_show(ctx: click.Context) -> None:
    """Show the configured AppView URL."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        value = client.get_kv(_APPVIEW_KV_KEY)
        if json_mode:
            print_result({"appview_url": value or ""}, json_mode)
        elif value:
            click.echo(f"AppView URL: {value}")
        else:
            click.echo("AppView URL: not configured")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)
