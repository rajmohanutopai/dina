from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.release.plugin_publish_guard import (
    GuardError,
    payload_digest,
    plugin_version,
    remote_slug,
    require_version_advance,
    required_native_assets,
    validate_remote,
    validate_stage,
    verify_ci_run,
    verify_claude_install,
    verify_codex_install,
    verify_native_release,
    verify_wheel,
)


def _write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def _stage(root: Path, version: str = "1.2.3") -> Path:
    claude = root / "cli/claude-plugin/dina"
    codex = root / "cli/codex-plugin/plugins/dina"
    _write_json(
        root / ".claude-plugin/marketplace.json",
        {"plugins": [{"name": "dina", "source": "./cli/claude-plugin/dina"}]},
    )
    _write_json(
        root / ".agents/plugins/marketplace.json",
        {
            "plugins": [
                {
                    "name": "dina",
                    "source": {
                        "source": "local",
                        "path": "./cli/codex-plugin/plugins/dina",
                    },
                }
            ]
        },
    )
    _write_json(
        claude / ".claude-plugin/plugin.json", {"name": "dina", "version": version}
    )
    _write_json(
        codex / ".codex-plugin/plugin.json", {"name": "dina", "version": version}
    )
    return root


def test_verify_wheel_requires_exact_filename_hash_type_and_yank_state() -> None:
    artifact = {
        "filename": "dina_agent-0.20.2-py3-none-any.whl",
        "packagetype": "bdist_wheel",
        "yanked": False,
        "digests": {"sha256": "a" * 64},
    }
    verify_wheel(
        {"urls": [artifact]}, filename=artifact["filename"], sha256="a" * 64
    )

    for field, value in (
        ("filename", "other.whl"),
        ("packagetype", "sdist"),
        ("yanked", True),
        ("digests", {"sha256": "b" * 64}),
    ):
        changed = {**artifact, field: value}
        with pytest.raises(GuardError):
            verify_wheel(
                {"urls": [changed]},
                filename=artifact["filename"],
                sha256="a" * 64,
            )


def test_verify_native_release_requires_every_signed_supported_asset() -> None:
    assets = sorted(required_native_assets("0.20.2"))
    payload = {
        "tag_name": "home-node-lite-v0.20.2",
        "draft": False,
        "prerelease": False,
        "assets": [{"name": name} for name in assets],
    }
    verify_native_release(payload, version="0.20.2")

    payload["assets"] = payload["assets"][:-1]
    with pytest.raises(GuardError, match="missing assets"):
        verify_native_release(payload, version="0.20.2")


def test_host_install_results_must_match_plugin_and_version() -> None:
    verify_claude_install(
        [
            {
                "id": "dina@dina",
                "version": "0.3.0",
                "enabled": True,
                "installPath": "/tmp/claude/dina",
            }
        ],
        version="0.3.0",
    )
    verify_codex_install(
        {
            "pluginId": "dina@dina",
            "version": "0.3.0",
            "installedPath": "/tmp/codex/dina",
        },
        version="0.3.0",
    )

    with pytest.raises(GuardError):
        verify_claude_install([], version="0.3.0")
    with pytest.raises(GuardError):
        verify_codex_install(
            {
                "pluginId": "dina@dina",
                "version": "0.2.0",
                "installedPath": "/tmp/codex/dina",
            },
            version="0.3.0",
        )


def test_ci_run_must_be_green_for_the_exact_public_commit() -> None:
    source_commit = "a" * 40
    verify_ci_run(
        [
            {
                "headSha": source_commit,
                "status": "completed",
                "conclusion": "success",
            }
        ],
        source_commit=source_commit,
    )

    for payload in (
        [],
        [{"headSha": "b" * 40, "status": "completed", "conclusion": "success"}],
        [{"headSha": source_commit, "status": "in_progress", "conclusion": None}],
        [{"headSha": source_commit, "status": "completed", "conclusion": "failure"}],
    ):
        with pytest.raises(GuardError):
            verify_ci_run(payload, source_commit=source_commit)


@pytest.mark.parametrize("field", ["draft", "prerelease"])
def test_verify_native_release_rejects_nonfinal_releases(field: str) -> None:
    payload = {
        "tag_name": "home-node-lite-v1.0.0",
        "draft": False,
        "prerelease": False,
        "assets": [{"name": name} for name in required_native_assets("1.0.0")],
    }
    payload[field] = True
    with pytest.raises(GuardError, match="non-prerelease"):
        verify_native_release(payload, version="1.0.0")


@pytest.mark.parametrize(
    ("remote", "slug"),
    [
        (
            "git@github.com:rajmohanutopai/dina-plugins.git",
            "rajmohanutopai/dina-plugins",
        ),
        ("https://github.com/rajmohanutopai/dina.git", "rajmohanutopai/dina"),
        ("/tmp/rajmohanutopai/dina-plugins.git", "rajmohanutopai/dina-plugins"),
    ],
)
def test_remote_slug_handles_supported_git_url_forms(remote: str, slug: str) -> None:
    assert remote_slug(remote) == slug


def test_validate_remote_rejects_a_different_repository() -> None:
    with pytest.raises(GuardError, match="refusing remote"):
        validate_remote(
            "git@github.com:rajmohanutopai/dina.git",
            expected_slug="rajmohanutopai/dina-plugins",
        )


def test_validate_stage_checks_both_marketplaces_and_shared_version(
    tmp_path: Path,
) -> None:
    assert validate_stage(_stage(tmp_path)) == "1.2.3"

    _write_json(
        tmp_path / "cli/codex-plugin/plugins/dina/.codex-plugin/plugin.json",
        {"name": "dina", "version": "1.2.4"},
    )
    with pytest.raises(GuardError, match="must move together"):
        plugin_version(tmp_path)


def test_validate_stage_rejects_escaping_marketplace_path(tmp_path: Path) -> None:
    stage = _stage(tmp_path / "stage")
    outside = tmp_path / "outside"
    outside.mkdir()
    _write_json(
        stage / ".claude-plugin/marketplace.json",
        {"plugins": [{"name": "dina", "source": "../../outside"}]},
    )
    with pytest.raises(GuardError, match="escapes"):
        validate_stage(stage)


def test_require_version_advance_rejects_reused_or_lower_version(
    tmp_path: Path,
) -> None:
    current = _stage(tmp_path / "current", "1.2.3")
    assert require_version_advance(current, _stage(tmp_path / "new", "1.2.4")) == (
        "1.2.4"
    )
    for version in ("1.2.3", "1.2.2"):
        with pytest.raises(GuardError, match="did not advance"):
            require_version_advance(current, _stage(tmp_path / version, version))


def test_payload_digest_ignores_provenance_but_tracks_content_and_mode(
    tmp_path: Path,
) -> None:
    payload = tmp_path / "payload"
    payload.mkdir()
    file = payload / "run"
    file.write_text("one", encoding="utf-8")
    before = payload_digest(payload)

    (payload / ".source").write_text("commit=changed", encoding="utf-8")
    assert payload_digest(payload) == before

    file.chmod(0o755)
    executable = payload_digest(payload)
    assert executable != before

    file.write_text("two", encoding="utf-8")
    assert payload_digest(payload) != executable
