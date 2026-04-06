"""dina setup-agent — configure integration with an agent runner.

Assumes:
  - Device is already paired (dina configure --role agent)
  - Runner (OpenClaw/Hermes) is already installed

Does:
  1. Register dina mcp-server with the runner's config
  2. Store runner config in dina config
  3. Optionally start the agent daemon
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import click
import yaml


def setup_openclaw(
    openclaw_url: str = "",
    openclaw_token: str = "",
    hook_token: str = "",
    config_dir: str = "",
    start_daemon: bool = False,
) -> None:
    """Configure Dina integration with OpenClaw."""
    from .config import load_config, CONFIG_FILE

    cfg = load_config()
    dina_config_dir = config_dir or str(CONFIG_FILE.parent)

    # Resolve OpenClaw URL.
    url = openclaw_url or os.environ.get("DINA_OPENCLAW_URL", "") or getattr(cfg, "openclaw_url", "")
    if not url:
        click.echo("Error: OpenClaw URL required. Pass --url or set DINA_OPENCLAW_URL.", err=True)
        sys.exit(1)

    token = openclaw_token or os.environ.get("DINA_OPENCLAW_TOKEN", "") or getattr(cfg, "openclaw_token", "")
    h_token = hook_token or os.environ.get("DINA_OPENCLAW_HOOK_TOKEN", "") or getattr(cfg, "openclaw_hook_token", "")

    # 1. Register dina mcp-server with OpenClaw.
    # Find OpenClaw config — typically ~/.openclaw/openclaw.json
    oc_config_paths = [
        Path.home() / ".openclaw" / "openclaw.json",
        Path("/root/.openclaw/openclaw.json"),
    ]
    oc_config = None
    for p in oc_config_paths:
        if p.exists():
            oc_config = p
            break

    if oc_config:
        try:
            # OpenClaw uses JSON5-like config. We'll read, update, and write.
            text = oc_config.read_text()
            # Simple approach: check if dina MCP is already configured.
            if '"dina"' in text and '"mcp-server"' in text:
                click.echo(f"  MCP: dina already registered in {oc_config}")
            else:
                click.echo(f"  MCP: Cannot auto-register in {oc_config} (manual config needed)")
                click.echo(f"  Add to openclaw.json mcp.servers:")
                click.echo(f'    dina: {{ command: "dina", args: ["mcp-server"], env: {{ DINA_CONFIG_DIR: "{dina_config_dir}" }} }}')
        except Exception as e:
            click.echo(f"  MCP: Error reading {oc_config}: {e}", err=True)
    else:
        click.echo("  MCP: OpenClaw config not found. Add manually:")
        click.echo(f'    dina: {{ command: "dina", args: ["mcp-server"], env: {{ DINA_CONFIG_DIR: "{dina_config_dir}" }} }}')

    # 2. Store runner config.
    _save_runner_config("openclaw", {
        "openclaw_url": url,
        "openclaw_token": token,
        "openclaw_hook_token": h_token,
    })
    click.echo(f"  Config: agent_runner=openclaw, url={url}")

    # 3. Optionally start daemon.
    if start_daemon:
        _start_daemon("openclaw")


def setup_hermes(
    hermes_model: str = "",
    config_dir: str = "",
    start_daemon: bool = False,
) -> None:
    """Configure Dina integration with Hermes."""
    from .config import CONFIG_FILE

    dina_config_dir = config_dir or str(CONFIG_FILE.parent)
    model = hermes_model or os.environ.get("DINA_HERMES_MODEL", "google/gemini-2.5-flash")

    # 1. Register dina mcp-server with Hermes.
    hermes_config_paths = [
        Path.home() / ".hermes" / "config.yaml",
        Path("/root/.hermes/config.yaml"),
    ]
    hermes_config = None
    for p in hermes_config_paths:
        if p.exists():
            hermes_config = p
            break

    if hermes_config:
        try:
            data = yaml.safe_load(hermes_config.read_text()) or {}
            mcp = data.get("mcp_servers", {})

            if "dina" in mcp:
                click.echo(f"  MCP: dina already registered in {hermes_config}")
            else:
                mcp["dina"] = {
                    "command": "dina",
                    "args": ["mcp-server"],
                    "env": {"DINA_CONFIG_DIR": dina_config_dir},
                }
                data["mcp_servers"] = mcp

                # Write back — append to end to avoid clobbering comments.
                with open(hermes_config, "a") as f:
                    f.write("\n# Dina MCP server (added by dina setup-agent)\n")
                    f.write("mcp_servers:\n")
                    f.write("  dina:\n")
                    f.write(f'    command: "dina"\n')
                    f.write(f'    args: ["mcp-server"]\n')
                    f.write(f"    env:\n")
                    f.write(f'      DINA_CONFIG_DIR: "{dina_config_dir}"\n')
                click.echo(f"  MCP: dina registered in {hermes_config}")
        except Exception as e:
            click.echo(f"  MCP: Error updating {hermes_config}: {e}", err=True)
    else:
        click.echo("  MCP: Hermes config not found. Add manually to ~/.hermes/config.yaml:")
        click.echo(f"    mcp_servers:")
        click.echo(f"      dina:")
        click.echo(f'        command: "dina"')
        click.echo(f'        args: ["mcp-server"]')
        click.echo(f"        env:")
        click.echo(f'          DINA_CONFIG_DIR: "{dina_config_dir}"')

    # 2. Store runner config.
    _save_runner_config("hermes", {
        "hermes_model": model,
    })
    click.echo(f"  Config: agent_runner=hermes, model={model}")

    # 3. Optionally start daemon.
    if start_daemon:
        _start_daemon("hermes")


def _save_runner_config(runner_name: str, extra: dict) -> None:
    """Save runner selection + extras to dina config.json."""
    from .config import CONFIG_FILE

    config_file = CONFIG_FILE
    saved = {}
    if config_file.exists():
        try:
            saved = json.loads(config_file.read_text())
        except Exception:
            pass

    saved["agent_runner"] = runner_name
    saved.update(extra)

    config_file.parent.mkdir(parents=True, exist_ok=True)
    config_file.write_text(json.dumps(saved, indent=2))


def _start_daemon(runner_name: str) -> None:
    """Start the agent daemon in background."""
    click.echo(f"  Daemon: starting with --runner {runner_name}...")
    try:
        proc = subprocess.Popen(
            ["dina", "agent-daemon", "--runner", runner_name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        click.echo(f"  Daemon: started (PID {proc.pid})")
    except Exception as e:
        click.echo(f"  Daemon: failed to start: {e}", err=True)
