"""dina skill — renderers, managed-block idempotency, installer, drift gate."""

from pathlib import Path

from click.testing import CliRunner

from dina_cli.main import cli
from dina_cli.skill import (
    BEGIN_MARKER,
    END_MARKER,
    TARGETS,
    detect_targets,
    install_target,
    render_claude_code,
    render_managed_block,
    render_openclaw,
    skill_body_full,
    skill_body_thin,
    target_by_key,
    upsert_managed_block,
)

REPO_ROOT = Path(__file__).resolve().parents[2]


# ── content invariants ──────────────────────────────────────────────────


def test_full_body_carries_the_load_bearing_rules():
    body = skill_body_full()
    # The pending-approval contract is the most important sentence in the
    # skill — losing it in a refactor must fail a test.
    assert "MUST NOT execute" in body
    assert "pending_approval" in body
    assert "dina scrub" in body
    assert "setup code" in body.lower()
    # Drift markers that were FIXED must never come back.
    assert "Telegram" not in body
    assert "DINA_CORE_URL" not in body
    assert "DINA_OPENCLAW_URL" not in body


def test_thin_body_is_thin_and_self_sufficient():
    thin = skill_body_thin()
    assert len(thin) < len(skill_body_full()) / 4
    assert "pending_approval" in thin
    assert "dina --help" in thin  # progressive disclosure
    assert "dina validate" in thin


def test_platform_renders_wrap_the_same_canonical_body():
    assert render_claude_code().endswith(skill_body_full())
    assert render_openclaw().endswith(skill_body_full())
    assert render_claude_code().startswith("---\nname: dina\n")
    assert "openclaw:" in render_openclaw()
    assert "package: dina-agent" in render_openclaw()


def test_docker_rig_copy_matches_canonical_render():
    """docker/openclaw/skills/SKILL.md is a build artifact of
    render_openclaw() — regenerate it when this fails:

        python3 -c "import sys; sys.path.insert(0,'src'); \\
          from dina_cli.skill import render_openclaw; \\
          open('../docker/openclaw/skills/SKILL.md','w').write(render_openclaw())"
    """
    docker_copy = REPO_ROOT / "docker" / "openclaw" / "skills" / "SKILL.md"
    assert docker_copy.read_text(encoding="utf-8") == render_openclaw()


# ── managed block ───────────────────────────────────────────────────────


def test_upsert_into_empty_and_fresh_files():
    block = render_managed_block()
    assert upsert_managed_block("", block) == block
    out = upsert_managed_block("# My agents file\n\nlocal notes\n", block)
    assert out.startswith("# My agents file")
    assert "local notes" in out
    assert out.count(BEGIN_MARKER) == 1


def test_upsert_is_idempotent_and_preserves_surroundings():
    block = render_managed_block()
    original = "# Top\n\nuser content above\n\n" + block + "\nuser content below\n"
    # Re-upserting an identical block changes nothing.
    assert upsert_managed_block(original, block) == original
    # Upserting a NEW block replaces only the marked region.
    new_block = f"{BEGIN_MARKER}\n\nNEW CONTENT\n\n{END_MARKER}\n"
    out = upsert_managed_block(original, new_block)
    assert "NEW CONTENT" in out
    assert "user content above" in out
    assert "user content below" in out
    assert out.count(BEGIN_MARKER) == 1
    assert skill_body_thin().strip()[:40] not in out


# ── installer ───────────────────────────────────────────────────────────


def test_detect_targets(tmp_path):
    assert detect_targets(tmp_path) == []
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".codex").mkdir()
    keys = [t.key for t in detect_targets(tmp_path)]
    assert keys == ["claude-code", "codex"]


def test_install_file_and_block_targets(tmp_path):
    (tmp_path / ".claude").mkdir()
    claude = target_by_key("claude-code")
    r1 = install_target(claude, tmp_path)
    assert r1.action == "created"
    assert r1.path == tmp_path / ".claude" / "skills" / "dina" / "SKILL.md"
    assert r1.path.read_text(encoding="utf-8") == render_claude_code()
    # Second install: unchanged.
    assert install_target(claude, tmp_path).action == "unchanged"

    (tmp_path / ".codex").mkdir()
    (tmp_path / ".codex" / "AGENTS.md").write_text("# mine\n", encoding="utf-8")
    codex = target_by_key("codex")
    r2 = install_target(codex, tmp_path)
    assert r2.action == "updated"
    content = r2.path.read_text(encoding="utf-8")
    assert content.startswith("# mine")
    assert BEGIN_MARKER in content
    assert install_target(codex, tmp_path).action == "unchanged"


def test_install_dry_run_writes_nothing(tmp_path):
    (tmp_path / ".gemini").mkdir()
    gemini = target_by_key("gemini")
    r = install_target(gemini, tmp_path, dry_run=True)
    assert r.action == "dry-run"
    assert not r.path.exists()


# ── CLI surface ─────────────────────────────────────────────────────────


def test_cli_skill_show_variants():
    runner = CliRunner()
    full = runner.invoke(cli, ["skill", "show"])
    assert full.exit_code == 0
    assert "MUST NOT execute" in full.output

    thin = runner.invoke(cli, ["skill", "show", "--thin"])
    assert thin.exit_code == 0
    assert len(thin.output) < len(full.output)

    openclaw = runner.invoke(cli, ["skill", "show", "--target", "openclaw"])
    assert openclaw.exit_code == 0
    assert openclaw.output == render_openclaw()

    codex = runner.invoke(cli, ["skill", "show", "--target", "codex"])
    assert codex.exit_code == 0
    assert codex.output.startswith(BEGIN_MARKER)


def test_cli_skill_install_explicit_target(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    runner = CliRunner()
    result = runner.invoke(cli, ["skill", "install", "--target", "claude-code"])
    assert result.exit_code == 0, result.output
    written = tmp_path / ".claude" / "skills" / "dina" / "SKILL.md"
    assert written.is_file()
    assert str(written) in result.output  # transparency: path printed


def test_cli_skill_install_detection_and_dry_run(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    (tmp_path / ".codex").mkdir()
    runner = CliRunner()
    result = runner.invoke(cli, ["skill", "install", "--dry-run"])
    assert result.exit_code == 0, result.output
    assert "Codex CLI" in result.output
    assert "would write" in result.output
    assert not (tmp_path / ".codex" / "AGENTS.md").exists()


def test_cli_skill_install_nothing_detected(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    runner = CliRunner()
    result = runner.invoke(cli, ["skill", "install"])
    assert result.exit_code == 0
    assert "No agent platforms detected" in result.output
    assert "dina skill show" in result.output


def test_all_targets_have_distinct_paths():
    paths = [t.rel_path for t in TARGETS]
    assert len(paths) == len(set(paths))


# ── dina init (one-command quickstart) ──────────────────────────────────


def test_init_skips_pairing_when_already_paired(tmp_path, monkeypatch):
    from unittest.mock import MagicMock, patch

    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    ident = MagicMock()
    ident.exists = True
    ident.did.return_value = "did:key:zAlready"
    with patch(
        "dina_cli.config._load_saved",
        return_value={
            "device_id": "dev-paired",
            "msgbox_url": "wss://relay.example/ws",
            "core_url": "http://localhost:8100",
        },
    ), patch("dina_cli.signing.CLIIdentity", return_value=ident):
        runner = CliRunner()
        result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0, result.output
    assert "already paired" in result.output
    assert "did:key:zAlready" in result.output
    # Step 2 still runs (no platforms in the sandbox home).
    assert "No agent platforms detected" in result.output


def test_init_runs_configure_then_skill(tmp_path, monkeypatch):
    """Fresh host: init drives configure with the --setup-code (no
    connection prompts) and then the skill installer."""
    import base64 as _b64
    import json as _json
    from unittest.mock import MagicMock, patch

    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    (tmp_path / ".claude").mkdir()

    payload = {
        "v": 1,
        "msgbox_url": "wss://relay.example.com/ws",
        "homenode_did": "did:plc:home",
        "device_name": "openclaw-agent",
        "code": "ABCD2EFG",
    }
    setup_str = "dina1:" + _b64.urlsafe_b64encode(
        _json.dumps(payload, separators=(",", ":")).encode()
    ).decode().rstrip("=")

    ident = MagicMock()
    ident.exists = False
    with patch("dina_cli.config._load_saved", return_value={}), \
         patch("dina_cli.signing.CLIIdentity", return_value=ident), \
         patch("dina_cli.main._load_saved", return_value={}), \
         patch("dina_cli.main._configure_signature") as mock_sig, \
         patch("dina_cli.main.save_config") as mock_save:
        mock_save.return_value = tmp_path / "config.json"
        runner = CliRunner()
        # Prompts: config_location → test connection? → install for Claude Code?
        result = runner.invoke(
            cli, ["init", "--setup-code", setup_str], input="\nn\ny\n", env={},
        )
    assert result.exit_code == 0, result.output
    assert "Step 1 — Pair" in result.output
    assert "Setup code accepted" in result.output
    assert mock_sig.call_args.kwargs["pairing_code"] == "ABCD2EFG"
    assert mock_sig.call_args.args[2] == "agent"  # init defaults to role=agent
    assert "Step 2 — Teach" in result.output
    assert (tmp_path / ".claude" / "skills" / "dina" / "SKILL.md").is_file()


def test_init_skip_skill(tmp_path, monkeypatch):
    from unittest.mock import MagicMock, patch

    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    ident = MagicMock()
    ident.exists = True
    ident.did.return_value = "did:key:zX"
    with patch(
        "dina_cli.config._load_saved",
        return_value={"device_id": "dev-paired", "msgbox_url": "wss://r/ws"},
    ), \
         patch("dina_cli.signing.CLIIdentity", return_value=ident):
        runner = CliRunner()
        result = runner.invoke(cli, ["init", "--skip-skill"])
    assert result.exit_code == 0
    assert "skipped (--skip-skill)" in result.output


def test_setup_agent_command_is_retired():
    runner = CliRunner()
    result = runner.invoke(cli, ["setup-agent", "openclaw"])
    assert result.exit_code != 0  # unknown command
