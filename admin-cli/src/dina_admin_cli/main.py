"""Click command groups for the Dina Admin CLI.

Commands: status, approvals {list,approve,deny},
device {list,pair,revoke}, persona {list,create,unlock},
identity {show,sign}.

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


@click.group()
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
        r = client._request("GET", "/v1/intent/proposals")
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
                    state = "locked" if locked else "open"
                    click.echo(f"  {name}  (tier: {tier}, {state})")
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
    "--passphrase",
    prompt=True,
    hide_input=True,
    confirmation_prompt=True,
    help="Passphrase to protect this persona",
)
@click.pass_context
def persona_create(
    ctx: click.Context, name: str, tier: str, passphrase: str
) -> None:
    """Create a new persona."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        data = client.create_persona(name, tier, passphrase)
        print_result(data, json_mode)
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
