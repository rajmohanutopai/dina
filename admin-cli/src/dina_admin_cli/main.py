"""Click command groups for the Dina Admin CLI.

Commands: status, device {list,pair,revoke},
persona {list,create,unlock}, identity {show,sign}.

Runs inside the Core container via Unix socket.
Usage: docker compose exec core dina-admin ...
   or: ./dina-admin ...  (wrapper script)
"""

from __future__ import annotations

import json
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

        print_result(result, json_mode)
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
                    status_str = " [revoked]" if d.get("revoked") else ""
                    name = d.get("name", d.get("device_name", "?"))
                    click.echo(f"  {d.get('id', '?')}  {name}{status_str}")
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
                    click.echo(f"  {name}  (tier: {tier})")
    except AdminClientError as exc:
        print_error(str(exc), json_mode)
        ctx.exit(1)


@persona.command("create")
@click.option("--name", prompt=True, help="Persona name")
@click.option(
    "--tier",
    prompt=True,
    default="open",
    type=click.Choice(["open", "restricted", "locked"]),
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
