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

from . import __version__
from .client import DinaClient, DinaClientError
from .config import CONFIG_FILE, load_config, save_config, _load_saved
from . import config as _config_mod
from .output import (
    print_error,
    print_error_with_trace,
    print_result,
    print_result_with_trace,
)
from .session import SessionStore
from .signing import CLIIdentity

# Safe actions that auto-approve when Brain is unavailable.
_SAFE_ACTIONS = frozenset(
    {
        "search",
        "lookup",
        "read",
        "query",
        "list",
        "recall",
        "remember",
    }
)


def _load_cfg(ctx: click.Context):
    """Lazy-load config on first access."""
    if "config" not in ctx.obj:
        try:
            ctx.obj["config"] = load_config()
        except click.UsageError:
            if ctx.obj.get("json"):
                click.echo(
                    json.dumps({"error": "Not configured. Run: dina configure"}),
                    err=True,
                )
            raise
    return ctx.obj["config"]


def _make_client(ctx: click.Context) -> DinaClient:
    """Get or create the DinaClient from Click context."""
    if "client" not in ctx.obj:
        ctx.obj["client"] = DinaClient(
            _load_cfg(ctx), verbose=ctx.obj.get("verbose", False)
        )
    return ctx.obj["client"]


def _cli_version() -> str:
    """Return the release version bundled with this CLI.

    Published wheels also carry the git tree digest of cli/ at publish time
    (scripts/release/publish_cli.sh writes _build.py), so the version is
    verifiable against the repo, not just a hand-maintained string.
    """
    try:
        from ._build import TREE  # generated at publish; absent in dev checkouts

        return f"{__version__} (tree {TREE})"
    except ImportError:
        return __version__


@click.group()
@click.version_option(version=_cli_version(), prog_name="dina-agent")
@click.option("--json", "json_mode", is_flag=True, help="Machine-readable JSON output")
@click.option(
    "--verbose", "-v", is_flag=True, help="Show detailed request/response info"
)
@click.pass_context
def cli(ctx: click.Context, json_mode: bool, verbose: bool) -> None:
    """Dina CLI — encrypted memory, PII scrubbing, action gating."""
    ctx.ensure_object(dict)
    ctx.obj["json"] = json_mode
    ctx.obj["verbose"] = verbose
    ctx.obj["sessions"] = SessionStore()


# ── coding-agent host setup ───────────────────────────────────────────────


@cli.group("agent-host")
def agent_host() -> None:
    """Set up Dina for a supported coding-agent host."""


@agent_host.command("setup")
@click.option(
    "--host",
    type=click.Choice(["claude-code", "codex"], case_sensitive=False),
    required=True,
)
@click.option("--status", "status_only", is_flag=True)
@click.option("--ensure", is_flag=True)
@click.option("--local-only", is_flag=True)
@click.option("--pds-handle", default=None)
@click.option("--pds-email", default=None)
@click.pass_context
def agent_host_setup(
    ctx: click.Context,
    host: str,
    status_only: bool,
    ensure: bool,
    local_only: bool,
    pds_handle: str | None,
    pds_email: str | None,
) -> None:
    """Install or repair Home Node and connect the selected coding host."""
    from .agent_host_setup import AgentHostSetup, AgentHostSetupError
    from .home_node import HomeNodeError

    selected_modes = sum(
        (
            bool(status_only),
            bool(ensure),
            bool(local_only),
            bool(pds_handle),
        )
    )
    if selected_modes > 1:
        raise click.UsageError(
            "Choose exactly one of --status, --ensure, --local-only, or "
            "--pds-handle."
        )
    if pds_email and not pds_handle:
        raise click.UsageError("--pds-email requires --pds-handle.")

    try:
        setup = AgentHostSetup(host)
        if status_only:
            result = setup.status()
        elif ensure:
            result = setup.ensure()
        else:
            result = setup.install(
                local_only=local_only,
                pds_handle=pds_handle,
                pds_email=pds_email,
            )
        if ctx.obj["json"]:
            click.echo(json.dumps(result))
            return
        if result.get("ready"):
            click.echo(f"Dina is ready for {host}.")
            home = result.get("home_node")
            if isinstance(home, dict) and home.get("owner_url"):
                click.echo(f"Owner: {home['owner_url']}")
            for step in result.get("next_steps", []):
                click.echo(f"- {step}")
            return
        click.echo("Dina setup is not complete.")
        if result.get("needs_identity_choice"):
            click.echo("Choose local-only setup or provide a public PDS handle.")
    except (AgentHostSetupError, HomeNodeError, OSError) as exc:
        if isinstance(exc, AgentHostSetupError):
            code = exc.code
        elif isinstance(exc, HomeNodeError):
            code = "home_node_setup_failed"
        else:
            code = "setup_failed"
        result = {
            "kind": "setup_error",
            "host": host,
            "ready": False,
            "code": code,
            "message": str(exc),
        }
        if ctx.obj["json"]:
            click.echo(json.dumps(result))
        else:
            click.echo(f"Error: {exc}", err=True)
        ctx.exit(2)


# ── home-node ──────────────────────────────────────────────────────────────


@cli.group("home-node")
def home_node() -> None:
    """Install and supervise the plugin-owned Home Node Lite."""


def _home_node_manager():
    from .home_node import HomeNodeManager

    return HomeNodeManager()


def _home_node_fail(ctx: click.Context, exc: Exception) -> None:
    if ctx.obj["json"]:
        click.echo(json.dumps({"error": str(exc)}), err=True)
    else:
        click.echo(f"Error: {exc}", err=True)
    ctx.exit(1)


def _enrollment_result(enrollment) -> dict[str, Any]:
    return {
        "status": enrollment.status,
        "device_id": enrollment.device_id,
        "agent_did": enrollment.agent_did,
        "home_did": enrollment.home_did,
        "config_dir": enrollment.config_dir,
    }


def _reasoning_selection_result(selection) -> dict[str, Any]:
    return {
        "status": selection.status,
        "backend_id": selection.backend_id,
        "principal_did": selection.principal_did,
        "policy_version": selection.policy_version,
        "selected": selection.selected,
        "reason": selection.reason,
    }


def _print_home_node_status(
    ctx: click.Context,
    status,
    enrollment=None,
    reasoning_selection=None,
) -> None:
    result = {
        "installed": status.installed,
        "running": status.running,
        "core_healthy": status.core_healthy,
        "brain_healthy": status.brain_healthy,
        "core_url": status.core_url,
        "brain_url": status.brain_url,
        "install_dir": status.install_dir,
        "release_version": status.release_version,
        "autostart_enabled": status.autostart_enabled,
    }
    if enrollment is not None:
        result["agent_enrollment"] = _enrollment_result(enrollment)
    if reasoning_selection is not None:
        result["reasoning_backend"] = _reasoning_selection_result(reasoning_selection)
    if ctx.obj["json"]:
        click.echo(json.dumps(result))
        return
    click.echo(f"  Installed: {'yes' if status.installed else 'no'}")
    click.echo(f"  Running:   {'yes' if status.running else 'no'}")
    click.echo(f"  Autostart: {'yes' if status.autostart_enabled else 'no'}")
    click.echo(
        f"  Core:      {status.core_url} ({'healthy' if status.core_healthy else 'offline'})"
    )
    click.echo(
        f"  Brain:     {status.brain_url} ({'healthy' if status.brain_healthy else 'offline'})"
    )
    click.echo(f"  State:     {status.install_dir}")
    if status.release_version:
        click.echo(f"  Release:   {status.release_version}")
    if enrollment is not None:
        click.echo(f"  Agent:     {enrollment.status} ({enrollment.agent_did})")
        click.echo(f"  CLI state: {enrollment.config_dir}")
    if reasoning_selection is not None:
        label = (
            reasoning_selection.backend_id
            if reasoning_selection.selected
            else reasoning_selection.reason
        )
        click.echo(f"  Brain:     {reasoning_selection.status} ({label})")


def _read_home_node_recovery_entropy(recovery_file: Path | None) -> bytes:
    """Read a recovery phrase without accepting it through argv or env."""
    from . import seed_wrap

    if recovery_file is None:
        phrase = click.prompt(
            "Recovery phrase",
            hide_input=True,
            confirmation_prompt=False,
            type=str,
        )
    else:
        path = recovery_file.expanduser()
        if path.is_symlink() or not path.is_file():
            raise click.UsageError("Recovery file must be a regular, non-symlink file.")
        if os.name != "nt" and path.stat().st_mode & 0o077:
            raise click.UsageError(
                "Recovery file is accessible to group/other users; run chmod 600 first."
            )
        lines = [
            line.strip()
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        if len(lines) != 1:
            raise click.UsageError(
                "Recovery file must contain exactly one non-comment mnemonic line."
            )
        phrase = lines[0]
    try:
        return seed_wrap.mnemonic_to_seed(phrase.strip().lower().split())
    except ValueError as exc:
        raise click.UsageError(str(exc)) from exc


def _prompt_archive_passphrase(*, confirm: bool, err: bool = False) -> str:
    passphrase = click.prompt(
        "Archive passphrase",
        hide_input=True,
        confirmation_prompt=confirm,
        type=str,
        err=err,
    )
    if not passphrase:
        raise click.UsageError("Archive passphrase must not be empty.")
    return passphrase


@home_node.command("install")
@click.option(
    "--release",
    "release_version",
    default=None,
    help="Exact native Home Node release version (default: this CLI version)",
)
@click.option(
    "--bundle",
    "bundle_path",
    type=click.Path(path_type=Path),
    default=None,
    help="Install a local native release archive instead of downloading one",
)
@click.option(
    "--endpoint-mode",
    type=click.Choice(["test", "release"]),
    default="release",
    show_default=True,
)
@click.option(
    "--core-port", type=click.IntRange(1, 65535), default=8100, show_default=True
)
@click.option(
    "--brain-port", type=click.IntRange(1, 65535), default=8200, show_default=True
)
@click.option(
    "--pds-handle",
    default=None,
    help="Existing or new public handle used when network publishing is enabled",
)
@click.option("--pds-email", default=None, help="Optional PDS account email")
@click.option(
    "--restore-identity",
    is_flag=True,
    help="Restore an existing identity; securely prompt for its recovery phrase",
)
@click.option(
    "--recovery-file",
    type=click.Path(path_type=Path),
    default=None,
    help="Mode-0600 recovery phrase file for non-interactive restore",
)
@click.option(
    "--no-start", is_flag=True, help="Install the native runtime without starting it"
)
@click.option(
    "--no-enroll",
    is_flag=True,
    help="Do not enroll this machine as the Home Node's coding agent",
)
@click.option(
    "--use-enrolled-agent-as-brain",
    is_flag=True,
    help="Owner-select the enrolled coding agent as the foreground reasoning Brain",
)
@click.option(
    "--agent-config-dir",
    type=click.Path(path_type=Path),
    default=None,
    help="Exact dina-agent config directory (default: DINA_CONFIG_DIR or ~/.dina/cli)",
)
@click.option("--wait", "wait_timeout", type=float, default=120.0, show_default=True)
@click.pass_context
def home_node_install(
    ctx: click.Context,
    release_version: str | None,
    bundle_path: Path | None,
    endpoint_mode: str,
    core_port: int,
    brain_port: int,
    pds_handle: str | None,
    pds_email: str | None,
    restore_identity: bool,
    recovery_file: Path | None,
    no_start: bool,
    no_enroll: bool,
    use_enrolled_agent_as_brain: bool,
    agent_config_dir: Path | None,
    wait_timeout: float,
) -> None:
    """Install Home Node Lite without a Dina source checkout."""
    from .home_node import DEFAULT_RELEASE, HomeNodeError

    restore_requested = restore_identity or recovery_file is not None
    if restore_requested and not pds_handle:
        raise click.UsageError(
            "--restore-identity/--recovery-file requires the existing --pds-handle "
            "so Core can rebind to the same did:plc."
        )
    if pds_email and not pds_handle:
        raise click.UsageError("--pds-email requires --pds-handle.")
    if use_enrolled_agent_as_brain and (no_start or no_enroll):
        raise click.UsageError(
            "--use-enrolled-agent-as-brain requires a started, enrolled coding agent."
        )
    recovered_seed = (
        _read_home_node_recovery_entropy(recovery_file) if restore_requested else None
    )

    try:
        manager = _home_node_manager()
        status = manager.install(
            release_version=release_version
            or os.environ.get("DINA_HOME_NODE_RELEASE", DEFAULT_RELEASE),
            bundle_path=bundle_path,
            endpoint_mode=endpoint_mode,
            core_port=core_port,
            brain_port=brain_port,
            pds_handle=pds_handle,
            pds_email=pds_email,
            start=not no_start and recovered_seed is None,
            wait_timeout=wait_timeout,
        )
        if recovered_seed is not None:
            manager.restore_identity_seed(recovered_seed)
            if not no_start:
                status = manager.start(wait_timeout=wait_timeout)
        enrollment = None
        reasoning_selection = None
        if not no_start and not no_enroll:
            from .home_node_enrollment import HomeNodeAgentEnroller

            enrollment = HomeNodeAgentEnroller(
                manager,
                config_dir=agent_config_dir,
            ).enroll()
            if use_enrolled_agent_as_brain:
                from .home_node_reasoning import HomeNodeReasoningSelector

                reasoning_selection = HomeNodeReasoningSelector(manager).select(
                    enrollment
                )
        _print_home_node_status(ctx, status, enrollment, reasoning_selection)
        if not no_start and not ctx.obj["json"]:
            click.echo(f"  Owner:     {status.core_url}/owner")
            if no_enroll:
                click.echo(
                    "\nHome Node is installed. Agent enrollment was skipped; run "
                    "`dina home-node enroll-agent` when ready."
                )
            else:
                click.echo(
                    "\nHome Node is installed and this coding agent is enrolled."
                )
    except HomeNodeError as exc:
        _home_node_fail(ctx, exc)


@home_node.command("enroll-agent")
@click.option(
    "--config-dir",
    type=click.Path(path_type=Path),
    default=None,
    help="Exact dina-agent config directory (default: DINA_CONFIG_DIR or ~/.dina/cli)",
)
@click.option(
    "--use-as-brain",
    is_flag=True,
    help="Owner-select this exact enrolled coding agent as the foreground reasoning Brain",
)
@click.pass_context
def home_node_enroll_agent(
    ctx: click.Context,
    config_dir: Path | None,
    use_as_brain: bool,
) -> None:
    """Enroll this machine as a coding-scoped agent of the local Home Node."""
    from .home_node import HomeNodeError
    from .home_node_enrollment import HomeNodeAgentEnroller

    try:
        manager = _home_node_manager()
        enrollment = HomeNodeAgentEnroller(
            manager,
            config_dir=config_dir,
        ).enroll()
        reasoning_selection = None
        if use_as_brain:
            from .home_node_reasoning import HomeNodeReasoningSelector

            reasoning_selection = HomeNodeReasoningSelector(manager).select(enrollment)
        if ctx.obj["json"]:
            if reasoning_selection is None:
                click.echo(json.dumps(_enrollment_result(enrollment)))
            else:
                click.echo(
                    json.dumps(
                        {
                            "agent_enrollment": _enrollment_result(enrollment),
                            "reasoning_backend": _reasoning_selection_result(
                                reasoning_selection
                            ),
                        }
                    )
                )
        else:
            click.echo(f"  Agent:     {enrollment.status}")
            click.echo(f"  DID:       {enrollment.agent_did}")
            click.echo(f"  Home Node: {enrollment.home_did}")
            click.echo(f"  CLI state: {enrollment.config_dir}")
            if reasoning_selection is not None:
                click.echo(
                    "  Brain:     "
                    f"{reasoning_selection.status}"
                    + (
                        f" ({reasoning_selection.backend_id})"
                        if reasoning_selection.backend_id
                        else ""
                    )
                )
    except HomeNodeError as exc:
        _home_node_fail(ctx, exc)


@home_node.command("upgrade")
@click.option(
    "--release",
    "release_version",
    required=True,
    help="Native Home Node release version to verify and activate",
)
@click.option(
    "--bundle",
    "bundle_path",
    type=click.Path(path_type=Path),
    default=None,
    help="Use a local native release archive instead of downloading one",
)
@click.option("--wait", "wait_timeout", type=float, default=120.0, show_default=True)
@click.pass_context
def home_node_upgrade(
    ctx: click.Context,
    release_version: str,
    bundle_path: Path | None,
    wait_timeout: float,
) -> None:
    """Upgrade Home Node with vault backup and automatic rollback."""
    from .home_node import HomeNodeError

    try:
        status = _home_node_manager().upgrade(
            release_version=release_version,
            bundle_path=bundle_path,
            wait_timeout=wait_timeout,
        )
        _print_home_node_status(ctx, status)
        if not ctx.obj["json"]:
            click.echo(
                "\nHome Node upgrade passed health checks. The prior vault "
                "snapshot was removed."
            )
    except HomeNodeError as exc:
        _home_node_fail(ctx, exc)


@home_node.command("backup")
@click.argument("destination", type=click.Path(path_type=Path))
@click.option(
    "--overwrite",
    is_flag=True,
    help="Replace an existing destination file",
)
@click.option("--wait", "wait_timeout", type=float, default=120.0, show_default=True)
@click.pass_context
def home_node_backup(
    ctx: click.Context,
    destination: Path,
    overwrite: bool,
    wait_timeout: float,
) -> None:
    """Create a passphrase-encrypted portable .dina data backup."""
    from .home_node import HomeNodeError

    passphrase = _prompt_archive_passphrase(confirm=True, err=ctx.obj["json"])
    try:
        output = _home_node_manager().export_archive(
            destination,
            passphrase,
            overwrite=overwrite,
            wait_timeout=wait_timeout,
        )
        if ctx.obj["json"]:
            click.echo(json.dumps({"backup_created": True, "path": str(output)}))
        else:
            click.echo(f"Encrypted Home Node backup created: {output}")
            click.echo(
                "Identity recovery words are separate and are not stored in this archive."
            )
    except HomeNodeError as exc:
        _home_node_fail(ctx, exc)


@home_node.command("verify-backup")
@click.argument("archive_file", type=click.Path(path_type=Path))
@click.pass_context
def home_node_verify_backup(ctx: click.Context, archive_file: Path) -> None:
    """Verify a .dina backup and passphrase without restoring it."""
    from .home_node import HomeNodeError

    passphrase = _prompt_archive_passphrase(confirm=False, err=ctx.obj["json"])
    try:
        _home_node_manager().verify_archive(archive_file, passphrase)
        if ctx.obj["json"]:
            click.echo(json.dumps({"valid": True, "path": str(archive_file)}))
        else:
            click.echo("Backup is valid and the passphrase is correct.")
    except HomeNodeError as exc:
        _home_node_fail(ctx, exc)


@home_node.command("restore-backup")
@click.argument("archive_file", type=click.Path(path_type=Path))
@click.option(
    "--force",
    is_flag=True,
    help="Overwrite existing user data instead of requiring a clean Home Node",
)
@click.option("--yes", is_flag=True, help="Confirm destructive --force restore")
@click.option("--wait", "wait_timeout", type=float, default=120.0, show_default=True)
@click.pass_context
def home_node_restore_backup(
    ctx: click.Context,
    archive_file: Path,
    force: bool,
    yes: bool,
    wait_timeout: float,
) -> None:
    """Restore a portable .dina backup into this Home Node identity."""
    from .home_node import HomeNodeError

    if force and not yes:
        if ctx.obj["json"]:
            raise click.UsageError("--force with --json requires --yes.")
        click.confirm(
            "Overwrite current portable user data with this backup?",
            abort=True,
        )
    passphrase = _prompt_archive_passphrase(confirm=False, err=ctx.obj["json"])
    try:
        _home_node_manager().import_archive(
            archive_file,
            passphrase,
            force=force,
            wait_timeout=wait_timeout,
        )
        if ctx.obj["json"]:
            click.echo(json.dumps({"restored": True, "path": str(archive_file)}))
        else:
            click.echo("Home Node backup restored successfully.")
            click.echo(
                "Paired devices, credentials, live grants, sessions, and pending "
                "work were not restored and must be re-established."
            )
    except HomeNodeError as exc:
        _home_node_fail(ctx, exc)


@home_node.command("ensure")
@click.option(
    "--if-installed",
    is_flag=True,
    help="Recover an existing install; do nothing when not installed",
)
@click.option("--quiet", is_flag=True, help="Suppress successful output")
@click.option("--wait", "wait_timeout", type=float, default=120.0, show_default=True)
@click.pass_context
def home_node_ensure(
    ctx: click.Context, if_installed: bool, quiet: bool, wait_timeout: float
) -> None:
    """Ensure the Home Node is installed and healthy."""
    from .home_node import HomeNodeError

    try:
        status = _home_node_manager().ensure(
            if_installed=if_installed,
            wait_timeout=wait_timeout,
        )
        if status is not None and not quiet:
            _print_home_node_status(ctx, status)
    except HomeNodeError as exc:
        _home_node_fail(ctx, exc)


@home_node.command("start")
@click.option("--wait", "wait_timeout", type=float, default=120.0, show_default=True)
@click.pass_context
def home_node_start(ctx: click.Context, wait_timeout: float) -> None:
    """Start an installed Home Node and wait for readiness."""
    from .home_node import HomeNodeError

    try:
        _print_home_node_status(
            ctx, _home_node_manager().start(wait_timeout=wait_timeout)
        )
    except HomeNodeError as exc:
        _home_node_fail(ctx, exc)


@home_node.command("stop")
@click.pass_context
def home_node_stop(ctx: click.Context) -> None:
    """Stop the Home Node without deleting configuration or vault data."""
    from .home_node import HomeNodeError

    try:
        _print_home_node_status(ctx, _home_node_manager().stop())
    except HomeNodeError as exc:
        _home_node_fail(ctx, exc)


@home_node.command("status")
@click.pass_context
def home_node_status(ctx: click.Context) -> None:
    """Show installation and health state."""
    from .home_node import HomeNodeError

    try:
        _print_home_node_status(ctx, _home_node_manager().status())
    except HomeNodeError as exc:
        _home_node_fail(ctx, exc)


@home_node.command("logs")
@click.option("--follow", "-f", is_flag=True)
@click.option("--tail", type=click.IntRange(1, 10000), default=200, show_default=True)
@click.pass_context
def home_node_logs(ctx: click.Context, follow: bool, tail: int) -> None:
    """Show native supervisor, Core, and Brain logs."""
    from .home_node import HomeNodeError

    try:
        ctx.exit(_home_node_manager().logs(follow=follow, tail=tail))
    except HomeNodeError as exc:
        _home_node_fail(ctx, exc)


def _require_human_terminal() -> None:
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        raise click.UsageError(
            "This authority-revealing command only runs in an interactive human terminal."
        )


@home_node.command("show-owner-capability")
def home_node_show_owner_capability() -> None:
    """Show the owner-console key in an interactive human terminal."""
    from .home_node import HomeNodeError

    _require_human_terminal()
    try:
        value = _home_node_manager().read_owner_capability()
    except HomeNodeError as exc:
        raise click.ClickException(str(exc)) from exc
    click.echo("Owner capability (do not paste this into an agent conversation):")
    click.echo(value)


@home_node.command("show-recovery-phrase")
def home_node_show_recovery_phrase() -> None:
    """Show and optionally remove Core's first-boot recovery phrase."""
    from .home_node import HomeNodeError

    _require_human_terminal()
    manager = _home_node_manager()
    try:
        phrase = manager.read_recovery_phrase()
        if phrase is None:
            click.echo("No plaintext recovery phrase remains in the Home Node.")
            return
        click.echo("Recovery phrase (record it offline; never share it with an agent):")
        click.echo(phrase)
        if click.confirm(
            "Have you recorded it and want to remove Core's plaintext copy?",
            default=False,
        ):
            manager.remove_recovery_phrase()
            click.echo("Plaintext recovery phrase removed.")
    except HomeNodeError as exc:
        raise click.ClickException(str(exc)) from exc


@home_node.command("uninstall")
@click.option(
    "--purge-data",
    is_flag=True,
    help="Also destroy encrypted vault data, keys, and installation files",
)
@click.option(
    "--yes", is_flag=True, help="Confirm destructive --purge-data non-interactively"
)
@click.pass_context
def home_node_uninstall(ctx: click.Context, purge_data: bool, yes: bool) -> None:
    """Remove native runtime code; preserve vault data unless explicitly purged."""
    from .home_node import HomeNodeError

    if purge_data and not yes:
        click.confirm(
            "Permanently delete Home Node vault data, keys, and installation files?",
            abort=True,
        )
    try:
        manager = _home_node_manager()
        managed_cleanup = None
        if purge_data:
            from .home_node_enrollment import prepare_managed_enrollment_cleanup

            managed_cleanup = prepare_managed_enrollment_cleanup(manager)
        manager.uninstall(purge_data=purge_data)
        cleanup_report = (
            managed_cleanup.apply_report() if managed_cleanup is not None else None
        )
        credentials_removed = (
            cleanup_report.removed if cleanup_report is not None else False
        )
        cleanup_failures = (
            [
                {"config_dir": failure.config_dir, "code": failure.code}
                for failure in cleanup_report.failures
            ]
            if cleanup_report is not None
            else []
        )
        if ctx.obj["json"]:
            click.echo(
                json.dumps(
                    {
                        "uninstalled": True,
                        "data_purged": purge_data,
                        "managed_agent_credentials_removed": credentials_removed,
                        "managed_agent_cleanup_failures": cleanup_failures,
                    }
                )
            )
        elif purge_data:
            click.echo("Home Node runtime and vault data were permanently removed.")
            if credentials_removed:
                click.echo("Installer-managed coding-agent credentials were removed.")
            for failure in cleanup_failures:
                click.echo(
                    "Warning: managed coding-agent credentials could not be removed "
                    f"from {failure['config_dir']}. Remove that directory manually.",
                    err=True,
                )
        else:
            click.echo(
                "Home Node runtime code was removed. Vault data, keys, and "
                "configuration were preserved; run `dina home-node install` "
                "to restore the native runtime."
            )
        if cleanup_failures:
            ctx.exit(2)
    except HomeNodeError as exc:
        _home_node_fail(ctx, exc)


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
    core_url = (
        os.environ.get("DINA_CORE_URL")
        or saved.get("core_url")
        or "http://localhost:8100"
    )
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
    transport_mode = (
        os.environ.get("DINA_TRANSPORT") or saved.get("transport_mode") or "msgbox"
    )
    result["core_reachable"] = False
    result["authenticated"] = False
    result["home_did"] = ""

    if transport_mode == "msgbox":
        # For msgbox mode the Core has no direct HTTP port. Health proves relay
        # reachability only; it is public and therefore cannot prove this key is
        # paired. Use the caller-scoped session list as the authenticated probe.
        if has_keypair:
            try:
                client = _make_client(ctx)
                client._request(client._core, "GET", "/healthz")
                result["core_reachable"] = True
                client.session_list()
                result["authenticated"] = True
                # Agents cannot read the admin-only DID route. Prefer the
                # configured Home Node DID, then best-effort the owner route.
                result["home_did"] = (
                    os.environ.get("DINA_HOMENODE_DID")
                    or saved.get("homenode_did")
                    or ""
                )
                try:
                    did_doc = client.did_get()
                    result["home_did"] = did_doc.get("did", did_doc.get("id", ""))
                except Exception:
                    pass
            except Exception:
                pass
    else:
        try:
            health = httpx.get(f"{core_url}/healthz", timeout=5)
            result["core_reachable"] = health.status_code == 200
        except Exception:
            pass

        if has_keypair and result["core_reachable"]:
            try:
                client = _make_client(ctx)
                client.session_list()
                result["authenticated"] = True
                result["home_did"] = (
                    os.environ.get("DINA_HOMENODE_DID")
                    or saved.get("homenode_did")
                    or ""
                )
                try:
                    did_doc = client.did_get()
                    result["home_did"] = did_doc.get("did", did_doc.get("id", ""))
                except Exception:
                    pass
            except Exception:
                pass

    result["paired"] = result["authenticated"]
    result["transport"] = transport_mode

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
        click.echo(f"  Transport: {transport_mode}")

        if result["core_reachable"]:
            click.echo("  Reachable: yes")
        else:
            click.echo("  Reachable: no")


# ── remember ──────────────────────────────────────────────────────────────


@cli.command()
@click.argument("text")
@click.option(
    "--category",
    default="note",
    help="Optional metadata label. Ex: fact, preference, decision, relationship, event, note",
)
@click.option(
    "--session", required=True, help="Session ID (create with: dina session start)"
)
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
        result = client.remember(
            text, session=session, source_id=source_id, metadata=metadata
        )
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
    except (DinaClientError, ValueError) as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)


@cli.command("remember-status")
@click.argument("item_id")
@click.option(
    "--session", required=True, help="Session ID used for the original remember request"
)
@click.pass_context
def remember_status(ctx: click.Context, item_id: str, session: str) -> None:
    """Check the status of a pending remember operation."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        result = client.remember_check(item_id, session=session)
        print_result_with_trace(result, json_mode, client.req_id)
    except DinaClientError as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)


# ── ask ──────────────────────────────────────────────────────────────────


@cli.command()
@click.argument("query")
@click.option(
    "--session", required=True, help="Session ID (create with: dina session start)"
)
@click.option(
    "--timeout",
    default=300,
    type=int,
    help="Approval poll timeout in seconds (30–1800, default 300)",
)
@click.pass_context
def ask(ctx: click.Context, query: str, session: str, timeout: int) -> None:
    """Ask Dina a question - she reasons over your encrypted vault.

    Requires an active session. Create one first:

    dina session start --name "my-session"

    dina remember --session sess-123 "My daughter's birthday is on April 7th"

    dina ask --session sess-123 "When is my daughter's birthday?"

    Dina checks all persona to get the data if this session has access.

    If session does not have access, the owner approves it in the Dina app
    (Activity → Needs action).
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        result = client.ask(query, session=session)

        # Two async cases from Core now produce a 202 with request_id:
        #   - pending_approval: sensitive persona needs human approval
        #   - in_flight:        Brain is still reasoning (service queries,
        #                       long tool loops) — too slow for the sync write
        #                       timeout, so Core asks us to poll.
        result_status = result.get("status", "")
        if result_status in ("pending_approval", "in_flight"):
            request_id = result.get("request_id", "")
            persona = result.get("persona", "sensitive")

            if json_mode:
                print_result_with_trace(result, json_mode, client.req_id)
                return

            if result_status == "pending_approval":
                click.echo(f"Access to '{persona}' data requires approval.", err=True)
                click.echo(
                    "A notification has been sent. Open the Dina app → Activity → Needs action to approve.",
                    err=True,
                )
                banner = "Awaiting approval..."
                # Poll intervals: be patient — user may take minutes.
                fast_interval, slow_interval, fast_window = 5, 15, 30
            else:  # in_flight
                banner = "Still reasoning..."
                # Poll intervals: reasoning finishes in seconds–tens of seconds.
                fast_interval, slow_interval, fast_window = 1, 3, 15
            click.echo(f"  req_id: {client.req_id}", err=True)

            if not request_id:
                # No request_id — can't poll. Old-style 403.
                ctx.exit(1)
                return

            click.echo(banner, err=True)

            import time

            timeout = min(max(timeout, 30), 1800)  # clamp: 30s min, 30min max
            elapsed = 0
            # F-2 follow-up: track the LAST observed server-side status so
            # we can (a) re-banner when the state transitions mid-poll
            # (in_flight → pending_approval after the agentic loop bails,
            # or back to in_flight after the user approves and the loop
            # resumes), and (b) tailor the timeout message based on what
            # the CLI was actually waiting on at the end. The old loop
            # locked banner + timeout-message to the INITIAL status, so
            # a slow ask that later started waiting for human approval
            # showed "Still reasoning..." for minutes — misleading.
            last_st = result_status
            while elapsed < timeout:
                interval = fast_interval if elapsed < fast_window else slow_interval
                time.sleep(interval)
                elapsed += interval
                try:
                    status = client.ask_status(request_id, session=session)
                except DinaClientError:
                    continue  # transient error, keep polling

                st = status.get("status", "")
                if st == "complete":
                    # Response uses `answer: {text: "..."}` (Brain pipeline)
                    # or flat `content: "..."` (legacy paths).
                    raw_answer = status.get("answer") or {}
                    answer = (
                        raw_answer.get("text", "")
                        if isinstance(raw_answer, dict)
                        else str(raw_answer)
                    ) or status.get("content", "")
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
                    click.echo(
                        f"Request failed: {status.get('error', 'unknown')}", err=True
                    )
                    ctx.exit(1)
                    return
                elif st == "expired":
                    click.echo("Request expired.", err=True)
                    ctx.exit(1)
                    return
                # Mid-poll state transition: re-banner + re-tune intervals
                # so the operator sees an accurate "what we're waiting for"
                # signal. The timeout budget stays as the user originally
                # set it; if you ran `dina ask --timeout 30` and the loop
                # transitioned to pending_approval, you still bail at 30s
                # — but the bail message will correctly say "still
                # awaiting approval" instead of "still reasoning".
                if st != last_st:
                    if st == "pending_approval":
                        click.echo(
                            "Awaiting approval... (open the Dina app and tap Approve)",
                            err=True,
                        )
                        # Slow the poll: humans don't tap inside one second.
                        fast_interval, slow_interval, fast_window = 5, 15, 30
                    elif st == "in_flight" and last_st == "pending_approval":
                        click.echo("Approved — reasoning...", err=True)
                        # Tighten the poll: the LLM should resume promptly.
                        fast_interval, slow_interval, fast_window = 1, 3, 15
                    last_st = st
                # else: still pending / in_flight / resuming — keep polling

            # Honest timeout messaging: report what we were actually waiting
            # on when we gave up, not what the very first response said.
            if last_st == "pending_approval":
                click.echo("Timed out waiting for approval.", err=True)
            else:
                click.echo("Timed out waiting for reasoning to complete.", err=True)
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
                    "llm_not_configured": "LLM not configured. Set up a provider in the Dina app (AI providers).",
                    "llm_auth_failed": "LLM authentication failed. Check the provider's API key in the Dina app (AI providers).",
                    "llm_timeout": "LLM request timed out. Try again, or check the provider in the Dina app (AI providers).",
                    "llm_unreachable": "LLM provider unreachable. Check the network, or the provider in the Dina app (AI providers).",
                }
                msg = result.get("message") or _ERROR_MESSAGES.get(
                    error_code, f"Error: {error_code}"
                )
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
            click.echo(
                "A notification has been sent. Open the Dina app → Activity → Needs action to approve.",
                err=True,
            )
        elif "persona locked" in str(exc).lower():
            click.echo("Some data is locked. Unlock it in the Dina app.", err=True)
        else:
            print_error_with_trace(str(exc), json_mode, client.req_id)
        click.echo(f"  req_id: {client.req_id}", err=True)
        ctx.exit(1)


@cli.command("ask-status")
@click.argument("request_id")
@click.option("--session", required=True, help="Session ID used for the original ask")
@click.pass_context
def ask_status_cmd(ctx: click.Context, request_id: str, session: str) -> None:
    """Check the status of a pending ask request.

    Use this when 'dina ask' timed out waiting for approval. Pass the
    request_id that was printed at timeout.
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        status = client.ask_status(request_id, session=session)
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
@click.option(
    "--session", required=True, help="Session ID (create with: dina session start)"
)
@click.option(
    "--context",
    "context_json",
    default=None,
    help="JSON object with action details shown in approval notification "
    '(e.g. \'{"to":"user@example.com","subject":"Report"}\')',
)
@click.pass_context
def validate(
    ctx: click.Context,
    action: str,
    description: str,
    count: int,
    reversible: bool,
    session: str,
    context_json: str | None,
) -> None:
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
            raise click.BadParameter(
                f"Invalid JSON: {context_json}", param_hint="--context"
            )

    try:
        payload: dict = {
            "action": action,
            "target": description,
            "count": count,
            "reversible": reversible,
        }
        if context:
            payload["context"] = context

        result = client.process_event(
            {
                "type": "agent_intent",
                "action": action,
                "target": description,
                "payload": payload,
            },
            session=session,
        )
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
                "high": [
                    "delete_data",
                    "share_data",
                    "sign_contract",
                    "transfer_money",
                ],
                "moderate": [
                    "calendar_create",
                    "draft_create",
                    "draft_email",
                    "form_fill",
                    "install_extension",
                    "pay_crypto",
                    "pay_upi",
                    "research",
                    "send_email",
                    "send_message",
                    "share_location",
                    "web_checkout",
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
        # Persist an empty mapping too so a no-PII scrub can still be
        # rehydrated as an identity operation.
        sessions.save(session_id, entities)

        print_result_with_trace(
            {"scrubbed": scrubbed, "pii_id": session_id}, json_mode, client.req_id
        )
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
        restored = sessions.rehydrate(text, session_id, consume=True)
        print_result({"restored": restored}, json_mode)
    except (FileNotFoundError, ValueError):
        print_error(f"Session {session_id} not found or expired", json_mode)
        ctx.exit(1)


# ── draft ─────────────────────────────────────────────────────────────────


@cli.command()
@click.argument("content")
@click.option("--to", "recipient", required=True, help="Recipient address")
@click.option(
    "--channel", required=True, type=click.Choice(["email", "sms", "slack", "whatsapp"])
)
@click.option("--subject", default="", help="Message subject (email)")
@click.pass_context
def draft(
    ctx: click.Context, content: str, recipient: str, channel: str, subject: str
) -> None:
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
        client.staging_ingest(
            {
                "type": "email_draft",
                "summary": (
                    f"Draft to {recipient}: {subject}"
                    if subject
                    else f"Draft to {recipient}"
                ),
                "body": content,
                "source": "dina-cli",
                "source_id": draft_id,
                "sender": "user",
                "metadata": json.dumps(
                    {
                        "to": recipient,
                        "channel": channel,
                        "subject": subject,
                        "draft_id": draft_id,
                    }
                ),
            }
        )
        print_result_with_trace(
            {
                "draft_id": draft_id,
                "status": "pending_review",
                "dashboard_url": f"{config.core_url}/drafts/{draft_id}",
            },
            json_mode,
            client.req_id,
        )
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
        print_result(
            {
                "signed_by": identity.did(),
                "signature": signature,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
            json_mode,
        )
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
        items = client.audit_query(limit=limit, action=action_filter).get("entries", [])
        if json_mode:
            print_result_with_trace(items, json_mode, client.req_id)
        else:
            if not items:
                click.echo("No audit entries.")
            else:
                for it in items:
                    ts = it.get("timestamp", "")
                    action = it.get("action", "")
                    tool = it.get("tool", "")
                    risk = it.get("risk", "")
                    outcome = it.get("outcome", "")
                    reason = it.get("reason", "")
                    line = f"  {ts}  {action}"
                    if tool:
                        line += f"  tool={tool}"
                    if risk or outcome:
                        line += f"  {risk}/{outcome}".rstrip("/")
                    if reason:
                        line += f"  ({reason})"
                    click.echo(line)
    except DinaClientError as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)


# ── configure ─────────────────────────────────────────────────────────────


@cli.command()
@click.option(
    "--role",
    default="user",
    type=click.Choice(["user", "agent"]),
    help="Device role: 'user' (personal CLI) or 'agent' (OpenClaw/bot)",
)
@click.option(
    "--config",
    "config_file",
    default=None,
    type=click.Path(exists=True),
    help="Non-interactive: JSON config file with keys: core_url, device_name, config_location, pairing_code",
)
@click.option(
    "--headless",
    is_flag=True,
    default=False,
    help="Non-interactive mode with CLI flags (no prompts)",
)
@click.option(
    "--core-url", default=None, help="[headless] Core URL (e.g. http://localhost:8100)"
)
@click.option(
    "--msgbox-url",
    default=None,
    help="[headless] MsgBox WebSocket URL (e.g. wss://mailbox.example.com/ws)",
)
@click.option(
    "--homenode-did",
    default=None,
    help="[headless] DID of the paired Home Node (did:plc:...)",
)
@click.option(
    "--transport",
    "transport_mode",
    default=None,
    type=click.Choice(["direct", "msgbox", "auto"]),
    help="[headless] Transport mode: direct | msgbox | auto (default: msgbox)",
)
@click.option("--device-name", default=None, help="[headless] Device name")
@click.option(
    "--pairing-code",
    default=None,
    help="[headless] Owner-issued pairing code",
)
@click.option(
    "--config-dir",
    default=None,
    help="[headless] Config directory (default: .dina/cli in cwd)",
)
@click.option(
    "--setup-code",
    default=None,
    help="An owner-issued `dina1:…` setup code. Mobile runners obtain it from "
    "the Dina app (Settings → Agents); coding integrations obtain a "
    "coding-scope code from Home Node Lite. Carries relay URL, Home Node "
    "DID, transport, device name and pairing code in one string. "
    "Individual flags override its fields.",
)
@click.pass_context
def configure(
    ctx: click.Context,
    role: str,
    config_file: str | None,
    headless: bool,
    core_url: str | None,
    msgbox_url: str | None,
    homenode_did: str | None,
    transport_mode: str | None,
    device_name: str | None,
    pairing_code: str | None,
    config_dir: str | None,
    setup_code: str | None,
) -> None:
    """Set up connection to a Dina Home Node.

    \b
    Interactive (default — paste an owner-issued setup code):
      dina configure
      dina configure --role agent

    \b
    Headless (no prompts — for automation/CI):
      dina configure --headless --setup-code 'dina1:…' --role agent
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
    # `--setup-code` works in BOTH modes: decode it up front and let it
    # supply defaults; explicit flags still win field-by-field.
    setup = None
    if setup_code is not None:
        from .setup_code import SetupCodeError, parse_setup_code

        try:
            setup = parse_setup_code(setup_code)
        except SetupCodeError as exc:
            raise click.UsageError(f"--setup-code rejected: {exc}")
        msgbox_url = msgbox_url or setup.msgbox_url
        homenode_did = homenode_did or setup.homenode_did
        transport_mode = transport_mode or setup.transport
        device_name = device_name or (setup.device_name or None)
        pairing_code = pairing_code or setup.code

    # ── Headless mode: all params from CLI flags, zero prompts ──
    if headless:
        _configure_headless(
            core_url=core_url or "http://localhost:8100",
            msgbox_url=msgbox_url or "",
            homenode_did=homenode_did or "",
            transport_mode=(transport_mode or "msgbox"),
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

    # ── Quick paste: one setup code replaces every connection prompt ──
    # The owner-issued code bundles relay URL + Home Node DID + transport +
    # suggested name + pairing code into one `dina1:…` string. Pasting it here
    # skips straight to keypair + pairing. Enter falls through to manual
    # prompts. Skipped when `--setup-code` supplied it on the command line.
    if setup is None and not cfg_input:
        from .setup_code import SetupCodeError, looks_like_setup_code, parse_setup_code

        pasted = click.prompt(
            "Paste the owner-issued Dina setup code,\n"
            "or press Enter to set up manually",
            default="",
            show_default=False,
        ).strip()
        if pasted:
            try:
                setup = parse_setup_code(pasted)
            except SetupCodeError as exc:
                if looks_like_setup_code(pasted):
                    # It WAS a setup code, just a broken one — make the user
                    # re-copy rather than silently dropping into manual mode
                    # with half-remembered values.
                    raise click.UsageError(f"Setup code rejected: {exc}")
                click.echo(
                    f"  Not a setup code ({exc}) — continuing with manual setup."
                )
        if setup is not None:
            # Same field-by-field merge as the --setup-code flag path:
            # explicit flags win, the pasted string fills the rest.
            msgbox_url = msgbox_url or setup.msgbox_url
            homenode_did = homenode_did or setup.homenode_did
            transport_mode = transport_mode or setup.transport
            device_name = device_name or (setup.device_name or None)
            pairing_code = pairing_code or setup.code
    if setup is not None:
        click.echo("  Setup code accepted:")
        click.echo(f"    MsgBox:    {msgbox_url}")
        click.echo(f"    Home Node: {homenode_did}")
        click.echo(f"    Transport: {transport_mode}")
        click.echo(f"    Device:    {device_name or _default_device_name()}")
        click.echo("    Pairing:   code embedded ✓")
        click.echo()

    # Config location: local (this directory), global (~), or custom path.
    from .config import _GLOBAL_CONFIG_DIR, set_config_dir

    cwd = Path.cwd()
    home = Path.home()
    local_config_dir = cwd / ".dina" / "cli"

    if cfg_input:
        loc = cfg_input.get("config_location", "global")
        if loc == "local":
            set_config_dir(local_config_dir)
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
            set_config_dir(local_config_dir)
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
        core_url = cfg_input.get(
            "core_url", existing.get("core_url", "http://localhost:8100")
        )
        device_name = cfg_input.get(
            "device_name", existing.get("device_name") or _default_device_name()
        )
        msgbox_url = cfg_input.get("msgbox_url", existing.get("msgbox_url", ""))
        homenode_did = cfg_input.get("homenode_did", existing.get("homenode_did", ""))
        transport_mode_val = cfg_input.get(
            "transport_mode",
            existing.get("transport_mode", "msgbox"),
        )
        click.echo(f"  Core URL: {core_url}")
        click.echo(f"  MsgBox: {msgbox_url or '(none)'}")
        click.echo(f"  Home Node: {homenode_did or '(none)'}")
        click.echo(f"  Transport: {transport_mode_val}")
        click.echo(f"  Device: {device_name}")
    elif setup is not None:
        # Everything came in the setup code (pasted or --setup-code, with
        # explicit flags already merged in) — no further prompts.
        core_url = core_url or existing.get("core_url", "http://localhost:8100")
        transport_mode_val = transport_mode or "msgbox"
        device_name = (
            device_name or existing.get("device_name") or _default_device_name()
        )
    else:
        core_url = click.prompt(
            "Core URL",
            default=existing.get("core_url", "http://localhost:8100"),
        )
        # MsgBox transport is mandatory for mobile / NAT'd deployments.
        # Prompt even if blank — users on LAN can accept "" to force direct.
        msgbox_url = click.prompt(
            "MsgBox WebSocket URL (wss://... — required for mobile / NAT'd Home Nodes)",
            default=existing.get("msgbox_url", ""),
            show_default=bool(existing.get("msgbox_url")),
        )
        homenode_did_default = existing.get("homenode_did", "")
        homenode_did = click.prompt(
            "Home Node DID (did:plc:... — required if MsgBox URL is set)",
            default=homenode_did_default,
            show_default=bool(homenode_did_default),
        )
        if msgbox_url and not homenode_did:
            raise click.UsageError(
                "Home Node DID is required when MsgBox URL is set — the relay "
                "needs it to route your requests to the right node."
            )
        transport_mode_val = click.prompt(
            "Transport mode",
            type=click.Choice(["direct", "msgbox", "auto"]),
            default=existing.get("transport_mode", "msgbox"),
        )
        if transport_mode_val == "msgbox" and not (msgbox_url and homenode_did):
            raise click.UsageError(
                "transport=msgbox requires both MsgBox URL and Home Node DID"
            )
        device_name = click.prompt(
            "Device name",
            default=existing.get("device_name") or _default_device_name(),
        )
    click.echo()
    if cfg_input:
        _configure_signature_noninteractive(
            core_url,
            device_name,
            role,
            cfg_input,
            msgbox_url=msgbox_url,
            homenode_did=homenode_did,
            transport_mode=transport_mode_val,
        )
    else:
        _configure_signature(
            core_url,
            device_name,
            role,
            msgbox_url=msgbox_url,
            homenode_did=homenode_did,
            transport_mode=transport_mode_val,
            pairing_code=pairing_code or "",
        )

    values: dict[str, Any] = {
        "core_url": core_url,
        "device_name": device_name,
        "role": role,
        "msgbox_url": msgbox_url,
        "homenode_did": homenode_did,
        "transport_mode": transport_mode_val,
    }

    # `_pair_with_key` persists the server-issued device_id. Preserve it (and
    # unrelated runner settings) when writing the connection fields.
    path = save_config({**_load_saved(), **values})
    click.echo()
    click.echo(f"Configuration saved to {path}")

    # Test the connection
    test_connection = (
        cfg_input.get("test_connection", True)
        if cfg_input
        else click.confirm("Test connection now?", default=True)
    )
    if test_connection:
        click.echo()
        from .config import Config

        # Build the test config with the SELECTED transport (mode + relay
        # fields), not just core_url. The product default is now MsgBox-only,
        # so a bare `Config(core_url=...)` would default to transport=msgbox
        # with no relay URL and the probe would falsely fail even after a
        # valid MsgBox setup. DinaClient then routes the /healthz probe
        # through whichever transport the user chose.
        cfg = Config(
            core_url=core_url,
            timeout=10.0,
            device_name=device_name,
            msgbox_url=msgbox_url,
            homenode_did=homenode_did,
            transport_mode=transport_mode_val,
        )
        # Human-readable label for whichever transport actually carries the
        # probe — "MsgBox" vs the direct Core URL.
        probe_target = (
            f"MsgBox ({msgbox_url})"
            if transport_mode_val == "msgbox"
            or (transport_mode_val == "auto" and msgbox_url and not core_url)
            else f"Core ({core_url})"
        )
        try:
            with DinaClient(cfg) as client:
                client._request(client._core, "GET", "/healthz")
                click.echo(f"  {probe_target}: Connected")
                click.echo(f"  Auth: Ed25519 signing (DID: {client._identity.did()})")
                try:
                    did_doc = client.did_get()
                    did = did_doc.get("id", did_doc.get("did", ""))
                    if did:
                        click.echo(f"  Identity: {did}")
                except DinaClientError:
                    pass
        except DinaClientError as exc:
            click.echo(f"  {probe_target}: {exc}", err=True)
        click.echo()
        click.echo("Ready. Try:")
        click.echo('  dina session start --name "my first session"')
        click.echo('  dina ask --session <session-id> "hello"')


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

    has_keypair = (_config_mod.IDENTITY_DIR / "ed25519_private.pem").exists()
    if not has_keypair:
        # Can't sign the revoke request — just clear local bookkeeping.
        saved.pop("device_id", None)
        save_config(saved)
        if json_mode:
            print_result(
                {
                    "status": "cleared",
                    "message": "Local state cleared (no keypair to revoke on Core)",
                },
                json_mode,
            )
        else:
            click.echo("  No keypair — cleared local device_id.")
            click.echo("  Revoke in the Dina app: Settings → Agents → Revoke access.")
        return

    try:
        # Use the configured transport. MsgBox is the production default, and
        # a NAT'd/mobile Home Node is not reachable through core_url directly.
        client = DinaClient(load_config())
        # Self-revocation deliberately carries no caller-supplied device id.
        # Core derives the device from this request's Ed25519-authenticated DID,
        # so a coding agent cannot revoke or probe another paired device.
        resp = client._request(client._core, "DELETE", "/v1/devices/self")
        if resp.status_code in (200, 204):
            saved.pop("device_id", None)
            save_config(saved)
            if json_mode:
                print_result(
                    {"status": "unpaired", "device_id": device_id or None},
                    json_mode,
                )
            else:
                click.echo(f"  Unpaired: {device_id or 'current device'}")
                click.echo("  Re-pair with: dina configure")
        elif resp.status_code == 404:
            saved.pop("device_id", None)
            save_config(saved)
            if json_mode:
                print_result(
                    {"status": "not_found", "device_id": device_id or None},
                    json_mode,
                )
            else:
                click.echo(
                    f"  {device_id or 'Current device'} not found on Core "
                    "(already revoked?)."
                )
        else:
            if json_mode:
                print_error(f"HTTP {resp.status_code}: {resp.text[:100]}", json_mode)
            else:
                click.echo(f"  Unpair failed: HTTP {resp.status_code}", err=True)
            ctx.exit(1)
    except (DinaClientError, click.UsageError) as exc:
        if json_mode:
            print_error(f"Cannot reach Core: {exc}", json_mode)
        else:
            click.echo(f"  Cannot reach Core: {exc}", err=True)
            click.echo(
                "  Revoke in the Dina app: Settings → Agents → Revoke access.", err=True
            )
        ctx.exit(1)


def _default_device_name() -> str:
    """Generate a default device name from hostname."""
    import platform

    return f"{platform.node()}-cli"


def _configure_headless(
    core_url: str,
    msgbox_url: str,
    homenode_did: str,
    transport_mode: str,
    device_name: str,
    role: str,
    pairing_code: str,
    config_dir_path: str | None,
) -> None:
    """Headless configure: all params from CLI flags, zero prompts."""
    from .config import set_config_dir
    from .signing import CLIIdentity

    # Validate transport requirements up front so the error surfaces before
    # we generate keys or attempt to pair.
    if transport_mode not in ("direct", "msgbox", "auto"):
        raise click.UsageError(
            f"--transport must be direct|msgbox|auto (got {transport_mode!r})"
        )
    if transport_mode == "msgbox" and (not msgbox_url or not homenode_did):
        raise click.UsageError(
            "--transport=msgbox requires both --msgbox-url and --homenode-did"
        )

    # Set config directory
    if config_dir_path:
        cfg_dir = Path(config_dir_path) / ".dina" / "cli"
    else:
        cfg_dir = Path.cwd() / ".dina" / "cli"
    set_config_dir(cfg_dir)

    click.echo(f"  Config dir: {cfg_dir}")
    click.echo(f"  Core URL: {core_url}")
    if msgbox_url:
        click.echo(f"  MsgBox: {msgbox_url}")
    if homenode_did:
        click.echo(f"  Home Node: {homenode_did}")
    click.echo(f"  Transport: {transport_mode}")
    click.echo(f"  Device: {device_name}")
    click.echo(f"  Role: {role}")

    # Generate keypair (always fresh in headless mode). Pass transport
    # params so pair/unpair route through MsgBox when direct HTTP to Core
    # isn't reachable (mobile, NAT'd).
    identity = CLIIdentity()
    if identity.exists:
        _try_unpair(
            core_url,
            identity,
            msgbox_url=msgbox_url,
            homenode_did=homenode_did,
            transport_mode=transport_mode,
        )
    click.echo("  Generating Ed25519 keypair...")
    identity.generate()
    click.echo(f"  DID: {identity.did()}")

    # Pair with Core
    if pairing_code:
        _pair_with_key(
            core_url,
            identity,
            device_name,
            role,
            pairing_code=pairing_code,
            msgbox_url=msgbox_url,
            homenode_did=homenode_did,
            transport_mode=transport_mode,
        )
    else:
        click.echo("  No --pairing-code provided — skipping pairing.")

    # Save config
    values: dict[str, Any] = {
        "core_url": core_url,
        "device_name": device_name,
        "role": role,
        "msgbox_url": msgbox_url,
        "homenode_did": homenode_did,
        "transport_mode": transport_mode,
    }
    # `_pair_with_key` persists the server-issued device_id. Preserve it (and
    # unrelated runner settings) when writing the connection fields.
    path = save_config({**_load_saved(), **values})
    click.echo(f"  Configuration saved to {path}")

    # Quick health check — route through the SELECTED transport, not a raw
    # direct /healthz. With MsgBox-only as the default, probing core_url
    # directly would misreport a perfectly good MsgBox setup as "unreachable"
    # (the Core isn't reachable directly when it's behind a relay).
    from .config import Config

    probe_target = (
        f"MsgBox ({msgbox_url})"
        if transport_mode == "msgbox"
        or (transport_mode == "auto" and msgbox_url and not core_url)
        else f"Core ({core_url})"
    )
    try:
        cfg = Config(
            core_url=core_url,
            timeout=5.0,
            device_name=device_name,
            msgbox_url=msgbox_url,
            homenode_did=homenode_did,
            transport_mode=transport_mode,
        )
        with DinaClient(cfg) as client:
            client._request(client._core, "GET", "/healthz")
            click.echo(f"  {probe_target}: Connected")
    except DinaClientError as exc:
        click.echo(f"  {probe_target}: unreachable ({exc})", err=True)
    except Exception as exc:
        click.echo(f"  {probe_target}: unreachable ({exc})", err=True)


def _build_pairing_transport(
    core_url: str,
    msgbox_url: str = "",
    homenode_did: str = "",
    transport_mode: str = "msgbox",
    identity: Any = None,
):
    """Build a Transport for use during pairing/unpairing.

    Unlike DinaClient this doesn't need an authenticated identity — pairing
    is unsigned and the Transport's signing path is bypassed for /v1/pair/.
    msgbox-mode still needs the CLI identity (envelope from_did is the CLI's
    fresh did:key, and that binds to the body's public_key_multibase in
    VerifyPairingIdentityBinding on the server).
    """
    from .transport import MsgBoxTransport, DirectTransport, select_transport

    # Route through the same selector DinaClient uses. When the CLI has a
    # fresh identity (pairing), inject it so envelope from_did is correct.
    if transport_mode == "msgbox":
        if not msgbox_url or not homenode_did:
            raise click.UsageError(
                "transport=msgbox requires --msgbox-url and --homenode-did"
            )
        return MsgBoxTransport(
            msgbox_url, homenode_did, identity=identity, timeout=15.0
        )
    if transport_mode == "direct":
        if not core_url:
            raise click.UsageError("transport=direct requires --core-url")
        return DirectTransport(core_url, timeout=15.0)
    # auto — mirror select_transport's logic but inject identity for the msgbox case.
    if core_url:
        try:
            health = httpx.get(f"{core_url.rstrip('/')}/healthz", timeout=2.0)
            if health.status_code == 200:
                return DirectTransport(core_url, timeout=15.0)
        except (httpx.ConnectError, httpx.TimeoutException):
            pass
    if msgbox_url and homenode_did:
        return MsgBoxTransport(
            msgbox_url, homenode_did, identity=identity, timeout=15.0
        )
    # Fall back to direct with a reachable-URL check — lets the raw-HTTP
    # request give a clearer error than "Home Node unreachable".
    return DirectTransport(core_url or "http://localhost:8100", timeout=15.0)


def _try_unpair(
    core_url: str,
    identity: Any,
    msgbox_url: str = "",
    homenode_did: str = "",
    transport_mode: str = "msgbox",
) -> None:
    """Revoke the current key before replacing it.

    Key rotation must not orphan live authority. If Core cannot confirm the
    revoke, keep the existing local identity/config and stop reconfiguration.
    """
    saved = _load_saved()
    device_id = saved.get("device_id", "")
    click.echo(f"  Unpairing old device ({device_id or identity.did()})...")
    try:
        # Revoke against the connection that authorized this key, not the new
        # destination currently being entered. Otherwise a Home Node switch
        # would probe the new node and leave the old authority alive.
        old_core_url = str(saved.get("core_url") or core_url)
        old_msgbox_url = str(saved.get("msgbox_url") or msgbox_url)
        old_homenode_did = str(saved.get("homenode_did") or homenode_did)
        old_transport_mode = str(saved.get("transport_mode") or transport_mode)
        transport = _build_pairing_transport(
            old_core_url,
            old_msgbox_url,
            old_homenode_did,
            old_transport_mode,
            identity=identity,
        )
        path = "/v1/devices/self"
        did, ts, nonce, sig = identity.sign_request("DELETE", path, b"")
        resp = transport.request(
            "DELETE",
            path,
            headers={
                "X-DID": did,
                "X-Timestamp": ts,
                "X-Nonce": nonce,
                "X-Signature": sig,
            },
            body=None,
        )
        if resp.status in (200, 204, 404):
            click.echo("  Old device revoked.")
        else:
            raise click.ClickException(
                f"Core could not revoke the old device (HTTP {resp.status}). "
                "Reconfiguration stopped so its key is not orphaned. Revoke "
                "the device from the owner UI, then retry."
            )
    except click.ClickException:
        raise
    except Exception as exc:
        raise click.ClickException(
            "Could not confirm revocation of the old device. Reconfiguration "
            "stopped so its key is not orphaned. Restore Home Node connectivity "
            "or revoke the device from the owner UI, then retry."
        ) from exc
    # Clear device_id from config
    saved.pop("device_id", None)
    save_config(saved)


def _configure_signature_noninteractive(
    core_url: str,
    device_name: str,
    role: str,
    cfg: dict,
    msgbox_url: str = "",
    homenode_did: str = "",
    transport_mode: str = "msgbox",
) -> None:
    """Non-interactive keypair generation and pairing from config file."""
    from .signing import CLIIdentity

    identity = CLIIdentity()

    if cfg.get("generate_keypair", True) or not identity.exists:
        if identity.exists:
            _try_unpair(
                core_url,
                identity,
                msgbox_url=msgbox_url,
                homenode_did=homenode_did,
                transport_mode=transport_mode,
            )
        click.echo("  Generating Ed25519 keypair...")
        identity.generate()
        click.echo(f"  DID: {identity.did()}")

    pairing_code = cfg.get("pairing_code", "")
    if pairing_code:
        _pair_with_key(
            core_url,
            identity,
            device_name,
            role,
            pairing_code=pairing_code,
            msgbox_url=msgbox_url,
            homenode_did=homenode_did,
            transport_mode=transport_mode,
        )
    else:
        click.echo("  No pairing_code in config — skipping pairing.")


def _configure_signature(
    core_url: str,
    device_name: str,
    role: str = "user",
    msgbox_url: str = "",
    homenode_did: str = "",
    transport_mode: str = "msgbox",
    pairing_code: str = "",
) -> None:
    """Generate keypair and pair with Core using Ed25519 public key.

    `pairing_code` is pre-filled when the user pasted a setup code —
    `_pair_with_key` then skips its own prompt (and falls back to
    prompting if that embedded code is rejected, e.g. expired).
    """
    from .signing import CLIIdentity

    identity = CLIIdentity()

    if identity.exists:
        click.echo(f"  Keypair exists: {identity.did()}")
        if not click.confirm("  Generate a new keypair?", default=False):
            # Re-pair with existing key
            _pair_with_key(
                core_url,
                identity,
                device_name,
                role,
                pairing_code=pairing_code,
                msgbox_url=msgbox_url,
                homenode_did=homenode_did,
                transport_mode=transport_mode,
            )
            return
        # Unpair old device before generating new keypair
        _try_unpair(
            core_url,
            identity,
            msgbox_url=msgbox_url,
            homenode_did=homenode_did,
            transport_mode=transport_mode,
        )

    click.echo("  Generating Ed25519 keypair...")
    identity.generate()
    click.echo(f"  DID: {identity.did()}")
    click.echo(f"  Keypair saved to {identity._dir}")
    click.echo()

    _pair_with_key(
        core_url,
        identity,
        device_name,
        role,
        pairing_code=pairing_code,
        msgbox_url=msgbox_url,
        homenode_did=homenode_did,
        transport_mode=transport_mode,
    )


def _pair_with_key(
    core_url: str,
    identity: Any,
    device_name: str,
    role: str = "user",
    pairing_code: str = "",
    msgbox_url: str = "",
    homenode_did: str = "",
    transport_mode: str = "msgbox",
) -> None:
    """Register the public key with Core using a pairing code.

    Routes the POST /v1/pair/complete call through the configured transport
    (direct HTTP or MsgBox WebSocket). Mobile / NAT'd clients that can't
    reach Core directly pass transport_mode="msgbox" + msgbox_url +
    homenode_did — the envelope's from_did (the fresh did:key) plus the
    body's public_key_multibase identify the caller to Core via
    VerifyPairingIdentityBinding. Pairing-path envelopes are also tagged
    subtype=pair for the MsgBox IP rate-limit bucket.
    """
    from .transport import TransportError
    import json as _json

    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        if not pairing_code:
            click.echo("  Enter the owner-issued pairing code from your Home Node.")
            pairing_code = click.prompt("  Pairing code")

        click.echo("  Registering device...")
        try:
            transport = _build_pairing_transport(
                core_url,
                msgbox_url,
                homenode_did,
                transport_mode,
                identity=identity,
            )
            body_dict = {
                "code": pairing_code,
                "device_name": device_name,
                "public_key_multibase": identity.public_key_multibase(),
                "role": role,
            }
            resp = transport.request(
                "POST",
                "/v1/pair/complete",
                headers={"Content-Type": "application/json"},
                body=_json.dumps(body_dict),
            )
            if resp.status >= 400:
                # Treat like the old HTTPStatusError branch.
                remaining = max_attempts - attempt
                if remaining > 0:
                    click.echo(
                        "  Pairing failed. Check that the code is correct and "
                        "the Home Node is reachable.",
                        err=True,
                    )
                    click.echo(f"  {remaining} attempt(s) remaining.", err=True)
                    click.echo()
                    pairing_code = ""  # prompt again
                    continue
                click.echo("  Pairing failed after 3 attempts.", err=True)
                return
            try:
                data = _json.loads(resp.body) if resp.body else {}
            except (_json.JSONDecodeError, ValueError):
                data = {}
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
        except TransportError as exc:
            click.echo(f"  Cannot reach Core: {exc}", err=True)
            click.echo(
                "  Check that your Home Node is running and the URL is correct.",
                err=True,
            )
            click.echo("  Keypair saved. Pair later with: dina configure", err=True)
            return


# ── init (one-command agent quickstart) ──────────────────────────────


@cli.command("init")
@click.option(
    "--setup-code",
    default=None,
    help="An owner-issued `dina1:…` setup code. Mobile runners obtain it from "
    "the Dina app; coding integrations obtain a coding-scope code from "
    "Home Node Lite. Prompted for if omitted.",
)
@click.option(
    "--role",
    default="agent",
    type=click.Choice(["user", "agent"]),
    help="Device role (default: agent — init is the agent-host quickstart)",
)
@click.option(
    "--yes",
    is_flag=True,
    default=False,
    help="Install the skill for all detected platforms without prompting",
)
@click.option(
    "--skip-skill",
    is_flag=True,
    default=False,
    help="Pair only; don't touch any agent platform configs",
)
@click.pass_context
def init_cmd(
    ctx: click.Context, setup_code: str | None, role: str, yes: bool, skip_skill: bool
) -> None:
    """One-command quickstart: pair with your Dina, then teach this machine's agents to use it.

    \b
    Step 1 — Pair: `dina configure` with an owner-issued setup code.
             Skipped if this host is already paired — re-pair explicitly
             with `dina configure`.
    Step 2 — Skill: detect agent platforms (Claude Code, OpenClaw, Codex,
             Gemini CLI) and install the Dina skill into each one you
             confirm. Same transparency contract as `dina skill install`.
    """
    from .config import _load_saved
    from .signing import CLIIdentity

    saved = _load_saved()
    identity = CLIIdentity()
    # `device_id` is the local receipt from a completed pairing. Endpoint + key
    # alone is insufficient: `dina unpair` deliberately keeps both while
    # clearing device_id after remote self-revocation.
    if (
        identity.exists
        and bool(saved.get("device_id"))
        and (saved.get("msgbox_url") or saved.get("core_url"))
    ):
        click.echo(f"Step 1 — Pair: already paired ({identity.did()}).")
        click.echo("  Re-pair explicitly with: dina configure")
    else:
        click.echo("Step 1 — Pair with your Dina")
        ctx.invoke(configure, role=role, setup_code=setup_code)

    click.echo()
    if skip_skill:
        click.echo("Step 2 — Skill: skipped (--skip-skill).")
        return
    click.echo("Step 2 — Teach this machine's agents to use Dina")
    ctx.invoke(skill_install, target_keys=(), dry_run=False, yes=yes)


# ── skill (agent platform integration) ───────────────────────────────


@cli.group()
def skill() -> None:
    """Teach an agent platform to route through Dina.

    One canonical skill document, rendered per platform: Claude Code and
    OpenClaw get a full SKILL.md in their skills directory; Codex and
    Gemini CLI get a thin managed block in AGENTS.md / GEMINI.md.
    """


@skill.command("show")
@click.option(
    "--thin",
    is_flag=True,
    default=False,
    help="Print the thin variant (trigger rules only)",
)
@click.option(
    "--target",
    default=None,
    type=click.Choice(["claude-code", "openclaw", "codex", "gemini"]),
    help="Print exactly what `skill install` would write for this platform",
)
def skill_show(thin: bool, target: str | None) -> None:
    """Print the Dina skill to stdout (paste anywhere an agent reads instructions)."""
    from .skill import skill_body_full, skill_body_thin, target_by_key

    if target is not None:
        t = target_by_key(target)
        assert t is not None  # constrained by click.Choice
        click.echo(t.render(), nl=False)
        return
    click.echo(skill_body_thin() if thin else skill_body_full(), nl=False)


@skill.command("install")
@click.option(
    "--target",
    "target_keys",
    multiple=True,
    type=click.Choice(["claude-code", "openclaw", "codex", "gemini"]),
    help="Install only for this platform (repeatable). Skips detection.",
)
@click.option(
    "--dry-run",
    is_flag=True,
    default=False,
    help="Show what would be written, write nothing",
)
@click.option(
    "--yes",
    is_flag=True,
    default=False,
    help="Install for all detected platforms without prompting",
)
def skill_install(target_keys: tuple[str, ...], dry_run: bool, yes: bool) -> None:
    """Detect agent platforms on this machine and install the Dina skill.

    \b
    Transparency contract (this command edits your agents' configuration —
    the exact class of action Dina exists to gate):
      - every path is printed BEFORE anything is written
      - --dry-run previews without writing
      - nothing is installed for a platform you didn't confirm
      - AGENTS.md / GEMINI.md edits stay inside the marked Dina block;
        everything outside it is preserved byte-for-byte
    """
    from .skill import detect_targets, install_target, target_by_key

    home = Path.home()
    if target_keys:
        targets = [t for k in target_keys if (t := target_by_key(k)) is not None]
    else:
        targets = detect_targets(home)
        if not targets:
            click.echo(
                "No agent platforms detected (~/.claude, ~/.openclaw, ~/.codex, ~/.gemini)."
            )
            click.echo(
                "Use --target <platform> to install anyway, or `dina skill show` to copy the text."
            )
            return
        click.echo("Detected agent platforms:")
        for t in targets:
            click.echo(f"  {t.label:<12} → {t.path(home)}")
        click.echo()
        if not yes and not dry_run:
            targets = [
                t
                for t in targets
                if click.confirm(f"Install Dina skill for {t.label}?", default=True)
            ]
            if not targets:
                click.echo("Nothing selected.")
                return

    for t in targets:
        result = install_target(t, home, dry_run=dry_run)
        verb = {
            "created": "created",
            "updated": "updated",
            "unchanged": "already up to date",
            "dry-run": "would write",
        }[result.action]
        click.echo(f"  {t.label:<12} {verb}: {result.path}")

    if dry_run:
        click.echo("\nDry run — nothing was written.")
    else:
        click.echo(
            "\nDone. The skill text always matches this CLI version; re-run after upgrading dina-agent."
        )


# ── init-identity ────────────────────────────────────────────────────

_IDENTITY_DIR = Path.home() / ".dina" / "cli" / "identity"


@cli.command("init-identity", hidden=True)  # Admin operation — use dina-admin
@click.option(
    "--restore-mnemonic", is_flag=True, help="Restore from a 24-word recovery phrase"
)
@click.option("--restore-hex", is_flag=True, help="Restore from a 64-char hex seed")
@click.pass_context
def init_identity(
    ctx: click.Context, restore_mnemonic: bool, restore_hex: bool
) -> None:
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
        if not click.confirm(
            "Identity seed already wrapped. Overwrite?", default=False
        ):
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
                click.echo(
                    click.style("  [ok] Seed restored from recovery phrase", fg="green")
                )
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
            click.echo(
                click.style(
                    f"Error: expected 64 hex chars, got {len(hex_input)}", fg="red"
                ),
                err=True,
            )
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
        click.echo(
            click.style("  [ok] Generated new identity (256-bit seed)", fg="green")
        )

        # Show mnemonic
        mnemonic = seed_wrap.seed_to_mnemonic(seed)
        click.echo()
        click.echo(click.style("  Your Recovery Phrase:", bold=True))
        click.echo()
        for i in range(0, 24, 4):
            line = "    ".join(f"{i+j+1:2d}. {mnemonic[i+j]:<12s}" for j in range(4))
            click.echo(f"    {line}")
        click.echo()
        click.echo(
            click.style("  SAVE THIS! Write it down on paper.", fg="red", bold=True)
        )
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
            click.echo(
                click.style(
                    "  Mismatch. Showing the phrase one more time:", fg="yellow"
                )
            )
            click.echo()
            for i in range(0, 24, 4):
                line = "    ".join(
                    f"{i+j+1:2d}. {mnemonic[i+j]:<12s}" for j in range(4)
                )
                click.echo(f"    {line}")
            click.echo()
            click.echo(
                click.style(
                    "  Write it down now. This is your last chance.",
                    fg="red",
                    bold=True,
                )
            )
            click.prompt("  Press Enter when saved", default="", show_default=False)

    # --- Step 2: Passphrase ---
    click.echo()
    click.echo(
        click.style("  Choose a passphrase to encrypt your identity seed:", bold=True)
    )
    click.echo("  (minimum 8 characters)")
    while True:
        passphrase = click.prompt("  Passphrase", hide_input=True)
        if len(passphrase) < 8:
            click.echo(
                click.style("  Passphrase must be at least 8 characters", fg="yellow")
            )
            continue
        confirm = click.prompt("  Confirm", hide_input=True)
        if passphrase != confirm:
            click.echo(
                click.style("  Passphrases do not match — try again", fg="yellow")
            )
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
    click.echo(
        click.style("    dina bootstrap-server --host user@mynode.example", fg="cyan")
    )


# ── bootstrap-server ─────────────────────────────────────────────────


@cli.command("bootstrap-server", hidden=True)  # Admin operation — use dina-admin
@click.option("--host", "ssh_host", help="SSH destination (user@host)")
@click.option(
    "--remote-dir",
    default="/opt/dina/secrets",
    show_default=True,
    help="Remote directory for secrets on the server",
)
@click.option(
    "--local-dir",
    type=click.Path(exists=False),
    help="Copy to a local path instead of SSH (self-hosted)",
)
@click.option(
    "--identity-dir",
    type=click.Path(exists=True),
    default=None,
    help="Local identity directory (default: ~/.dina/cli/identity/)",
)
@click.pass_context
def bootstrap_server(
    ctx: click.Context,
    ssh_host: str | None,
    remote_dir: str,
    local_dir: str | None,
    identity_dir: str | None,
) -> None:
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
        click.echo(
            click.style(
                "Error: No wrapped seed found. Run 'dina init-identity' first.",
                fg="red",
            ),
            err=True,
        )
        ctx.exit(1)
        return

    # Verify file sizes
    if wrapped_path.stat().st_size != 60:
        click.echo(
            click.style(
                "Error: wrapped_seed.bin is not 60 bytes — file may be corrupted",
                fg="red",
            ),
            err=True,
        )
        ctx.exit(1)
        return
    if salt_path.stat().st_size != 16:
        click.echo(
            click.style(
                "Error: master_seed.salt is not 16 bytes — file may be corrupted",
                fg="red",
            ),
            err=True,
        )
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
        mkdir_cmd = [
            "ssh",
            ssh_host,
            f"mkdir -p {remote_dir} && chmod 700 {remote_dir}",
        ]
        result = subprocess.run(mkdir_cmd, capture_output=True, text=True)
        if result.returncode != 0:
            click.echo(
                click.style(
                    f"  Error creating remote directory: {result.stderr.strip()}",
                    fg="red",
                ),
                err=True,
            )
            ctx.exit(1)
            return

        # SCP the files
        scp_cmd = [
            "scp",
            "-q",
            str(wrapped_path),
            str(salt_path),
            f"{ssh_host}:{remote_dir}/",
        ]
        result = subprocess.run(scp_cmd, capture_output=True, text=True)
        if result.returncode != 0:
            click.echo(
                click.style(f"  Error: {result.stderr.strip()}", fg="red"), err=True
            )
            ctx.exit(1)
            return

        # Set permissions on remote
        chmod_cmd = [
            "ssh",
            ssh_host,
            f"chmod 600 {remote_dir}/wrapped_seed.bin {remote_dir}/master_seed.salt",
        ]
        subprocess.run(chmod_cmd, capture_output=True)

        click.echo(click.style("  [ok] Uploaded to server", fg="green"))

    else:
        click.echo(
            click.style(
                "Error: specify --host (SSH) or --local-dir (local copy)",
                fg="red",
            ),
            err=True,
        )
        ctx.exit(1)
        return

    # Ask about seed password mode
    click.echo()
    click.echo(click.style("  Seed password mode:", bold=True))
    click.echo("    1) Maximum Security — enter passphrase on every restart")
    click.echo("    2) Server Mode — store passphrase for unattended boot")
    mode = click.prompt("  Choice", type=click.IntRange(1, 2), default=1)

    if mode == 2:
        pw = click.prompt(
            "  Enter seed passphrase (to store on server)", hide_input=True
        )
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
            write_cmd = [
                "ssh",
                ssh_host,
                f"printf '%s' '{pw}' > {remote_dir}/seed_password && "
                f"chmod 600 {remote_dir}/seed_password",
            ]
            subprocess.run(write_cmd, capture_output=True)
        click.echo(
            click.style("  [ok] Passphrase stored on server (Server Mode)", fg="green")
        )
    else:
        # Create empty seed_password file (Docker Secrets needs it)
        if local_dir:
            dest = Path(local_dir)
            (dest / "seed_password").touch(mode=0o600)
        elif ssh_host:
            subprocess.run(
                [
                    "ssh",
                    ssh_host,
                    f"touch {remote_dir}/seed_password && chmod 600 {remote_dir}/seed_password",
                ],
                capture_output=True,
            )

    click.echo()
    click.echo(click.style("  Done!", bold=True))
    if mode == 1:
        click.echo("  Start your node with:")
        click.echo(
            click.style(
                "    DINA_SEED_PASSWORD=<passphrase> docker compose up -d", fg="cyan"
            )
        )
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
        data = client.session_start(name)
        if json_mode:
            print_result_with_trace(data, json_mode, client.req_id)
        else:
            session_id = data.get("session_id") or data.get("id") or "?"
            label = name or "default"
            click.echo(f"  Session: {session_id} ({label}) active")
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
        data = client.session_end(session_id)
        if json_mode:
            print_result_with_trace(data, json_mode, client.req_id)
        else:
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
        data = client.session_list()
        sessions = data.get("sessions", [])
        if json_mode:
            print_result_with_trace(sessions, json_mode, client.req_id)
        elif not sessions:
            click.echo("  No active sessions.")
        else:
            click.echo(f"  {'ID':<16} {'Name':<20} {'Status':<10} {'Grants'}")
            for s in sessions:
                grants = (
                    ", ".join(g.get("persona_id", "?") for g in s.get("grants", []))
                    or "none"
                )
                click.echo(
                    f"  {s.get('session_id', s.get('id', '?')):<16} {s.get('name', '?'):<20} "
                    f"{s.get('status', '?'):<10} {grants}"
                )
    except DinaClientError as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)


# ── service (WS2 provider-service discovery) ──────────────────────────────


@cli.group()
def service() -> None:
    """Send and track queries against provider services on PeerLens.

    Schema-driven: the provider publishes a JSON Schema for each
    capability on AppView; this CLI validates and forwards the schema
    hash so version drift surfaces as a clean error rather than a
    silent contract break.
    """


@service.command("query")
@click.argument("to_did")
@click.argument("capability")
@click.argument("params_json")
@click.option(
    "--schema-hash",
    "schema_hash",
    default="",
    help="Provider's canonical schema_hash for this capability (from AppView).",
)
@click.option(
    "--ttl",
    default=60,
    type=int,
    help="Max seconds to wait for a response (1..600).",
)
@click.option(
    "--service-name",
    default="",
    help="Human-readable service name for logs/notifications.",
)
@click.option(
    "--origin-channel",
    default="",
    help="Optional channel tag (e.g. 'cli:session-42') for targeted reply routing.",
)
@click.option(
    "--session",
    required=True,
    help="Live Dina session ID (from `dina session start`).",
)
@click.option(
    "--request-id",
    required=True,
    help="Stable idempotency key; reuse it while polling/retrying this approval.",
)
@click.option(
    "--service-uri", default="", help="Selected listing URI returned by discovery."
)
@click.option(
    "--grant-id", default="", help="Grant ID for an approved/private service."
)
@click.pass_context
def service_query(
    ctx: click.Context,
    to_did: str,
    capability: str,
    params_json: str,
    schema_hash: str,
    ttl: int,
    service_name: str,
    origin_channel: str,
    session: str,
    request_id: str,
    service_uri: str,
    grant_id: str,
) -> None:
    """Send a schema-driven service query to a provider DID.

    PARAMS_JSON must be a JSON object matching the provider's published
    params schema for this capability. Example:

        dina service query \\
          did:plc:busdriver eta_query '{"route_id":"42"}' \\
          --schema-hash c48434... --ttl 120

    Returns {"task_id": "...", "query_id": "..."}; the response arrives
    asynchronously. Poll with ``dina service status <task_id>``.
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]

    try:
        params = json.loads(params_json) if params_json else {}
    except json.JSONDecodeError as e:
        print_error_with_trace(
            f"Invalid params_json: {e}",
            json_mode,
            client.req_id,
        )
        ctx.exit(2)
        return
    if not isinstance(params, dict):
        print_error_with_trace(
            'params_json must be a JSON object (e.g. \'{"route_id":"42"}\')',
            json_mode,
            client.req_id,
        )
        ctx.exit(2)
        return

    try:
        result = client.send_service_query(
            to_did=to_did,
            capability=capability,
            params=params,
            session=session,
            request_id=request_id,
            service_name=service_name,
            ttl_seconds=ttl,
            schema_hash=schema_hash,
            service_uri=service_uri,
            grant_id=grant_id,
            origin_channel=origin_channel,
        )
        if json_mode:
            print_result_with_trace(result, json_mode, client.req_id)
        else:
            click.echo(
                f"  Service action: {result.get('status', '?')} "
                f"task_id={result.get('task_id', '?')}"
            )
            click.echo(
                f"  Poll approval: dina action-status service_invoke {request_id} "
                f"--session {session}"
            )
    except DinaClientError as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)


@service.command("status")
@click.argument("task_id")
@click.option(
    "--session",
    required=True,
    help="The same live Dina session used to create the query.",
)
@click.pass_context
def service_status(ctx: click.Context, task_id: str, session: str) -> None:
    """Fetch the terminal state of a previously-sent service query.

    Returns the full workflow_task JSON. When the status is ``completed``
    or ``failed``, the response details live in the task's events. When
    still ``running``, the requester is waiting for the provider.
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        task = client.service_query_status(task_id=task_id, session=session)
        if json_mode:
            print_result_with_trace(task, json_mode, client.req_id)
        else:
            click.echo(
                f"  task_id: {task.get('id', '?')} "
                f"status: {task.get('status', '?')} "
                f"corr: {task.get('correlation_id', '?')}"
            )
            if task.get("status") in ("completed", "failed"):
                click.echo(f"  result: {task.get('result_summary', '')[:200]}")
    except DinaClientError as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)


# ── Talk + delegation (owner-approved facade actions) ─────────────────────


@cli.command()
@click.argument("contact")
@click.argument("text")
@click.option(
    "--session",
    required=True,
    help="Live Dina session ID (from `dina session start`).",
)
@click.option(
    "--request-id",
    required=True,
    help="Stable idempotency key; reuse it for retries and status polls.",
)
@click.option(
    "--in-reply-to",
    default="",
    help="Optional stable D2D message ID this message replies to.",
)
@click.pass_context
def talk(
    ctx: click.Context,
    contact: str,
    text: str,
    session: str,
    request_id: str,
    in_reply_to: str,
) -> None:
    """Ask Dina to send one exact message to a known contact.

    The first call normally requests owner approval. Do not generate a new
    REQUEST_ID when retrying: poll with ``dina action-status talk`` using the
    same request and session.
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        result = client.talk(
            contact=contact,
            text=text,
            session=session,
            request_id=request_id,
            in_reply_to=in_reply_to,
        )
        if json_mode:
            print_result_with_trace(result, json_mode, client.req_id)
            return
        status_value = result.get("status", "unknown")
        click.echo(f"  status: {status_value}")
        if status_value == "pending_approval":
            click.echo("  Waiting for owner approval.")
            click.echo(
                f"  Poll: dina action-status talk {request_id} --session {session}"
            )
        elif status_value == "completed":
            click.echo(
                f"  delivery: {result.get('delivery_status', 'accepted by transport')}"
            )
    except (DinaClientError, ValueError) as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)


@cli.command()
@click.argument("runner")
@click.argument("description")
@click.argument("input_json")
@click.option(
    "--session",
    required=True,
    help="Live Dina session ID (from `dina session start`).",
)
@click.option(
    "--request-id",
    required=True,
    help="Stable idempotency key; reuse it for retries and status polls.",
)
@click.pass_context
def delegate(
    ctx: click.Context,
    runner: str,
    description: str,
    input_json: str,
    session: str,
    request_id: str,
) -> None:
    """Ask Dina to queue one bounded task for an external agent runner.

    INPUT_JSON must be a JSON object. The task is created only after the owner
    approves the exact runner and description.
    """
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        input_data = json.loads(input_json)
    except json.JSONDecodeError as exc:
        print_error_with_trace(
            f"Invalid input_json: {exc}",
            json_mode,
            client.req_id,
        )
        ctx.exit(2)
        return
    if not isinstance(input_data, dict):
        print_error_with_trace(
            "input_json must be a JSON object",
            json_mode,
            client.req_id,
        )
        ctx.exit(2)
        return

    try:
        result = client.delegate(
            runner=runner,
            description=description,
            input_data=input_data,
            session=session,
            request_id=request_id,
        )
        if json_mode:
            print_result_with_trace(result, json_mode, client.req_id)
            return
        status_value = result.get("status", "unknown")
        click.echo(f"  status: {status_value}")
        if status_value == "pending_approval":
            click.echo("  Waiting for owner approval.")
            click.echo(
                f"  Poll: dina action-status delegate {request_id} "
                f"--session {session}"
            )
        elif status_value == "completed":
            click.echo(
                f"  task: {result.get('delegation_task_id', '?')} "
                f"({result.get('delegation_status', result.get('delegation_submit_status', 'queued'))})"
            )
    except (DinaClientError, ValueError) as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)


@cli.command("action-status")
@click.argument("action", type=click.Choice(["talk", "delegate"]))
@click.argument("request_id")
@click.option(
    "--session",
    required=True,
    help="The same live Dina session used to submit the action.",
)
@click.pass_context
def action_status(
    ctx: click.Context,
    action: str,
    request_id: str,
    session: str,
) -> None:
    """Poll and, after approval, idempotently continue Talk or delegation."""
    client = _make_client(ctx)
    json_mode = ctx.obj["json"]
    try:
        result = client.action_status(
            action=action,
            request_id=request_id,
            session=session,
        )
        if json_mode:
            print_result_with_trace(result, json_mode, client.req_id)
            return
        click.echo(f"  status: {result.get('status', 'unknown')}")
        if result.get("status") == "completed":
            if action == "talk":
                click.echo(
                    f"  delivery: "
                    f"{result.get('delivery_status', 'accepted by transport')}"
                )
            else:
                click.echo(
                    f"  task: {result.get('delegation_task_id', '?')} "
                    f"({result.get('delegation_status', result.get('delegation_submit_status', 'queued'))})"
                )
    except (DinaClientError, ValueError) as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)


# ── task (OpenClaw delegation) ──────────────────────────────────────────


@cli.command()
@click.argument("description")
@click.option("--dry-run", is_flag=True, help="Validate intent without executing")
@click.option(
    "--timeout",
    default=300,
    type=int,
    help="Approval poll timeout in seconds (30–1800, default 300)",
)
@click.pass_context
def task(ctx: click.Context, description: str, dry_run: bool, timeout: int) -> None:
    """Delegate an autonomous task to an agent runner.

    Dina validates the task-level intent once (research -> moderate, requires
    approval). After approval, the configured runner executes autonomously and calls back
    to Dina (ask, validate, remember) at its own discretion.

    Requires a configured runner (OpenClaw, Hermes, etc.) and agent role.
    """
    _load_cfg(ctx)
    config = ctx.obj["config"]
    json_mode = ctx.obj["json"]

    if config.role != "agent":
        raise click.UsageError(
            "dina task requires agent role. Re-pair with: dina configure --role agent"
        )

    from .agent_runner import build_task_prompt, RunnerResult
    from .runner_registry import get_runner as _get_runner

    client = _make_client(ctx)
    session_name = f"task-{uuid.uuid4().hex[:8]}"
    session_id = ""

    try:
        # 1. Start scoped session.
        opened = client.session_start(session_name)
        session_id = str(opened.get("session_id") or opened.get("id") or "")
        if session_id == "":
            raise DinaClientError("Core returned no session_id")
        if not json_mode:
            click.echo(f"  Session: {session_id}")

        # 2. Validate the delegation intent.
        decision = client.process_event(
            {
                "type": "agent_intent",
                "action": "research",
                "target": description[:200],
            },
            session=session_id,
        )

        action = decision.get("action", "")

        if action == "deny":
            msg = decision.get("reason", "blocked")
            if json_mode:
                print_result_with_trace(
                    {"status": "denied", "reason": msg}, json_mode, client.req_id
                )
            else:
                print_error_with_trace(f"Task denied: {msg}", json_mode, client.req_id)
            return

        if dry_run:
            status = (
                "requires_approval" if decision.get("requires_approval") else "approved"
            )
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
                click.echo("  Approve in the Dina app → Activity → Needs action.")

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
                        print_result_with_trace(
                            {"status": s, "reason": reason}, json_mode, client.req_id
                        )
                    else:
                        print_error_with_trace(
                            f"Task {s}: {reason}", json_mode, client.req_id
                        )
                    return
            else:
                print_error_with_trace(
                    f"Approval timeout ({timeout}s). Retry later.",
                    json_mode,
                    client.req_id,
                )
                return

        # 3. Execute via runner abstraction.
        runner_name = (
            getattr(config, "agent_runner", "")
            or os.environ.get("DINA_AGENT_RUNNER", "")
            or "openclaw"
        )
        if not json_mode:
            click.echo(f"  Delegating to {runner_name}: {description}")

        try:
            runner = _get_runner(runner_name, config=config)
            runner.validate_config()
        except RuntimeError as exc:
            print_error_with_trace(f"Runner error: {exc}", json_mode, client.req_id)
            return

        task_dict = {
            "id": f"interactive-{uuid.uuid4().hex[:8]}",
            "description": description,
        }
        prompt = build_task_prompt(task_dict, session_id, runner_name)
        runner_result = runner.execute(task_dict, prompt, session_id)

        if runner_result.state == "failed":
            print_error_with_trace(
                f"Runner failed: {runner_result.error}", json_mode, client.req_id
            )
            return

        if runner_result.state == "running":
            # Fire-and-forget runners (OpenClaw) — task continues in background.
            if not json_mode:
                click.echo(
                    f"  Task submitted (run_id={runner_result.run_id or 'none'})"
                )
                click.echo(f"  Check status via: dina task-status")
            # For fire-and-forget, we don't store a result yet — it comes via callback.
            result = {"summary": "Task submitted to runner", "status": "running"}
        else:
            # Inline runners (Hermes) — result is already available.
            result = {
                "summary": runner_result.summary or description[:200],
                "data": runner_result.metadata,
            }

        # 4. Store final summary via staging (auto-caveated for agent-role CLI).
        summary = result.get("summary", description[:200])
        client.staging_ingest(
            {
                "source": runner_name,
                "source_id": f"task-{uuid.uuid4().hex[:12]}",
                "type": "note",
                "summary": f"Task result: {summary}",
                "body": json.dumps(result.get("data", result), indent=2)[:50000],
                "metadata": json.dumps({"task": description, "session": session_id}),
            },
            session=session_id,
        )

        # 5. Display.
        print_result_with_trace(result, json_mode, client.req_id)

    except DinaClientError as exc:
        print_error_with_trace(str(exc), json_mode, client.req_id)
        ctx.exit(1)
    finally:
        try:
            if session_id:
                client.session_end(session_id)
        except Exception:
            pass


# ── Coding-agent gate hook (Claude Code / Codex PreToolUse) ───────────────

# Fail-closed self-deadline: resolve Core-slowness to a DENY inside this window,
# which is shorter than the host hook timeout (Plugin Developer Surface §10 /
# NEW-27). The supervisor `bin/dina-gate` is the outer backstop for spawn/crash
# failures — see the plugin's hooks/hooks.json.
_GATE_DEADLINE_S = 10


def _gate_block(reason: str) -> None:
    """Fail-closed BLOCK. Exit 2 is the ONLY PreToolUse outcome that stops a
    tool call; stderr becomes the reason Claude Code shows. Never returns."""
    click.echo(reason, err=True)
    sys.exit(2)


def _gate_ask(reason: str) -> None:
    """ASK — exit 0 + the PreToolUse JSON decision so the developer approves or
    denies locally. Used only for MODERATE actions. Never returns."""
    click.echo(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "ask",
                    "permissionDecisionReason": reason,
                }
            }
        )
    )
    sys.exit(0)


def _gate_allow(reason: str) -> None:
    """Explicitly authorize a Claude Code call after Dina redeemed a durable
    owner-approved permit. A silent exit 0 still lets Claude's own permission
    layer deny the call after Core has consumed the single-use permit."""
    click.echo(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "permissionDecisionReason": reason,
                }
            }
        )
    )
    sys.exit(0)


@cli.command("gate-hook")
@click.option(
    "--host",
    type=click.Choice(["claude-code", "codex"], case_sensitive=False),
    default="claude-code",
    show_default=True,
)
def gate_hook(host: str) -> None:
    """Coding-agent gate for a Claude Code / Codex PreToolUse hook.

    Reads the tool call as JSON on stdin, forwards the RAW ``(tool_name,
    tool_input)`` to Core's ``/v1/agent/gate`` for classification, and enforces
    the decision:

    \b
      allow                       -> exit 0 (silent)
      owner-approved allow        -> explicit Claude `allow` decision
      deny / hard-blocked         -> exit 2 (stderr = reason)
      MODERATE approval_required  -> `ask` (JSON permissionDecision)
      HIGH approval_required      -> block pending Dina approval; retry after approval
      Core unreachable / timeout /
        malformed / not-configured-> exit 2 (fail-closed — NEVER a silent allow)

    Invoke it through the supervisor ``bin/dina-gate``, which also normalizes
    a crash/timeout/missing-binary to a block (only exit 2 blocks a PreToolUse
    call). Config-free of Click state on purpose so every failure path can fail
    closed.
    """
    # Self-deadline so a slow/hung Core resolves to a block inside the window.
    import signal

    have_alarm = hasattr(signal, "SIGALRM")
    if have_alarm:

        def _deadline(_signum: Any, _frame: Any) -> None:
            _gate_block("Dina gate timed out reaching Core — blocked (fail-closed)")

        signal.signal(signal.SIGALRM, _deadline)
        signal.alarm(_GATE_DEADLINE_S)
    # Keep the transport timeout under the self-deadline too.
    os.environ.setdefault("DINA_TIMEOUT", str(_GATE_DEADLINE_S - 2))

    # Read + parse the PreToolUse payload. Malformed/empty/no-tool_name = block.
    try:
        raw = sys.stdin.read()
    except Exception:  # noqa: BLE001 — any read failure is fail-closed
        _gate_block(
            "Dina gate could not read the tool-call payload — blocked (fail-closed)"
        )
    try:
        event = json.loads(raw) if raw.strip() else {}
    except Exception:  # noqa: BLE001
        _gate_block(
            "Dina gate could not parse the tool-call payload — blocked (fail-closed)"
        )
    if not isinstance(event, dict):
        _gate_block(
            "Dina gate got a non-object tool-call payload — blocked (fail-closed)"
        )

    tool_name = event.get("tool_name")
    if not isinstance(tool_name, str) or tool_name.strip() == "":
        _gate_block("Dina gate got no tool_name — blocked (fail-closed)")
    tool_input = event.get("tool_input")
    if not isinstance(tool_input, dict):
        _gate_block("Dina gate got a non-object tool_input — blocked (fail-closed)")
    cwd = event.get("cwd")
    cwd = cwd if isinstance(cwd, str) and cwd else None
    host_session_id = event.get("session_id")
    if not isinstance(host_session_id, str) or host_session_id.strip() == "":
        _gate_block("Dina gate got no host session_id — blocked (fail-closed)")

    # Ask Core. Claude's signed host-session id is resolved atomically to an
    # opaque DID-bound Core session by the gate route, avoiding an extra relay
    # round-trip on every tool call while preserving revoke-on-session-end.
    try:
        client = DinaClient(load_config())
        decision = client.gate(
            tool_name,
            tool_input,
            host_session=host_session_id,
            cwd=cwd,
            approval_surface="owner" if host == "codex" else "host",
        )
    except DinaClientError as exc:
        _gate_block(f"Dina gate could not reach Core ({exc}) — blocked (fail-closed)")
    except click.UsageError:
        _gate_block(
            "Dina is not configured (run: dina configure) — blocked (fail-closed)"
        )
    except Exception as exc:  # noqa: BLE001 — ANY failure fails closed
        _gate_block(f"Dina gate error ({type(exc).__name__}) — blocked (fail-closed)")

    if have_alarm:
        signal.alarm(0)  # reached a verdict — cancel the deadline

    outcome = decision.get("outcome") if isinstance(decision, dict) else None
    risk = (decision.get("risk") if isinstance(decision, dict) else "") or ""
    reason = (decision.get("reason") if isinstance(decision, dict) else "") or ""
    action = (decision.get("action") if isinstance(decision, dict) else "") or ""
    owner_approval_redeemed = (
        decision.get("owner_approval_redeemed")
        if isinstance(decision, dict)
        else False
    )

    if outcome == "allow":
        # Core sets this bit only after a durable owner-approval task wins its
        # single-use redemption CAS. Without an explicit Claude allow, Claude's
        # native classifier can deny the call after Dina has consumed that
        # permit, forcing a second owner approval for an action that never ran.
        # Do not emit this for ordinary SAFE/auto allows, and do not emit
        # Claude-specific output for Codex.
        if host == "claude-code" and owner_approval_redeemed is True:
            _gate_allow(
                reason
                or f"Dina owner approval was redeemed for {action or 'this action'}"
            )
        sys.exit(0)  # silent allow
    if outcome == "deny":
        _gate_block(reason or f"Dina blocked this action ({action})")
    if outcome == "approval_required":
        if risk == "MODERATE":
            if host == "codex":
                task_id = (
                    decision.get("task_id") if isinstance(decision, dict) else ""
                ) or ""
                if task_id:
                    _gate_block(
                        f"Dina approval required for {action or 'this action'} "
                        f"(task {task_id}). Approve it in Dina, then retry the tool call"
                    )
                _gate_block(
                    f"Dina approval is required for {action or 'this action'}, but "
                    "Codex cannot ask locally and no Dina approval task was created "
                    "— blocked (fail-closed)"
                )
            _gate_ask(
                reason or f"Dina flagged this action for your approval ({action})"
            )
        if risk == "HIGH":
            task_id = (
                decision.get("task_id") if isinstance(decision, dict) else ""
            ) or ""
            if task_id:
                _gate_block(
                    f"Dina approval required for {action or 'this action'} "
                    f"(task {task_id}). Approve it in Dina, then retry the tool call"
                )
            _gate_block(
                f"Dina approval is required for {action or 'this action'}, but no "
                "approval task could be created — blocked (fail-closed)"
            )
        _gate_block(
            f"Dina returned approval_required with an unrecognized risk "
            f"({risk!r}) — blocked (fail-closed)"
        )
    # Unknown result from a REACHABLE Core → never allow (§12.2).
    _gate_block(
        f"Dina returned an unrecognized decision ({outcome!r}) — blocked (fail-closed)"
    )


@cli.command("session-end-hook", hidden=True)
def session_end_hook() -> None:
    """Best-effort Claude SessionEnd bridge.

    Reads Claude's hook payload from stdin, finds this authenticated agent's
    Core session for that host session id, and ends it so session grants and
    outstanding gate authority are revoked immediately. Lease expiry remains
    the crash/forced-exit backstop.
    """
    try:
        raw = sys.stdin.read()
        event = json.loads(raw) if raw.strip() else {}
        if not isinstance(event, dict):
            raise ValueError("hook payload is not an object")
        host_session_id = event.get("session_id")
        if not isinstance(host_session_id, str) or host_session_id.strip() == "":
            raise ValueError("hook payload has no session_id")

        client = DinaClient(load_config())
        sessions = client.session_list().get("sessions", [])
        if not isinstance(sessions, list):
            raise ValueError("Core returned an invalid session list")
        for session in sessions:
            if not isinstance(session, dict) or session.get("name") != host_session_id:
                continue
            session_id = session.get("session_id")
            if isinstance(session_id, str) and session_id:
                client.session_end(session_id)
    except Exception as exc:  # noqa: BLE001 — SessionEnd must not trap the host
        click.echo(
            f"Dina could not end the agent session ({type(exc).__name__}); "
            "its lease will expire automatically.",
            err=True,
        )


# ── MCP Server ───────────────────────────────────────────────────────────


@cli.command("mcp-server")
@click.option(
    "--profile",
    type=click.Choice(["all", "coding", "brain", "connected"], case_sensitive=False),
    default="all",
    show_default=True,
    help="Limit the exposed MCP tools to a host contract.",
)
def mcp_server(profile: str) -> None:
    """Run Dina as an MCP server (stdio transport).

    \b
    For OpenClaw:
      mcp.servers.dina = { command: "dina", args: ["mcp-server"] }

    \b
    For Claude Code:
      claude mcp add dina -- dina mcp-server
    """
    from .mcp_server import run_server

    run_server(profile=profile.lower())


@cli.command("agent-daemon")
@click.option(
    "--poll-interval",
    default=15,
    type=int,
    help="Seconds between claim polls (default 15)",
)
@click.option(
    "--lease-duration",
    default=300,
    type=int,
    help="Lease duration in seconds (default 300)",
)
@click.option(
    "--runner",
    default="",
    type=str,
    help="Runner: openclaw, hermes, or auto (default from config/env)",
)
def agent_daemon(poll_interval: int, lease_duration: int, runner: str) -> None:
    """Run the persistent agent daemon.

    \b
    Polls Core for queued delegated tasks, executes via the configured runner
    (OpenClaw, Hermes, etc.), and reports results back. Runs until SIGINT/SIGTERM.

    \b
    Requires:
      - Paired device with role=agent (dina configure --role agent)
      - Runner-specific config (OpenClaw: DINA_OPENCLAW_URL; Hermes: hermes package)
    """
    from .agent_daemon import run_daemon

    run_daemon(
        poll_interval=poll_interval, lease_duration=lease_duration, runner_name=runner
    )


# `dina setup-agent` (MCP-era OpenClaw/Hermes registration) was retired:
# agents learn to call the dina CLI via `dina skill install` now, and
# runner selection lives on `dina agent-daemon --runner <name>` /
# DINA_AGENT_RUNNER / the `agent_runner` config key.
