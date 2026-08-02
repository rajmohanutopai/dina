#!/usr/bin/env python3
"""Deterministic validation helpers for the coding-plugin release mirror."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse


PLUGIN_MANIFESTS = (
    Path("cli/claude-plugin/dina/.claude-plugin/plugin.json"),
    Path("cli/codex-plugin/plugins/dina/.codex-plugin/plugin.json"),
)
SEMVER_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
NATIVE_TARGETS = (
    ("darwin", "x64"),
    ("darwin", "arm64"),
    ("linux", "x64"),
    ("linux", "arm64"),
    ("win32", "x64"),
)


class GuardError(ValueError):
    """A release invariant was not satisfied."""


def _load_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise GuardError(f"cannot read valid JSON from {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise GuardError(f"{path} must contain a JSON object")
    return value


def _parse_semver(value: object, *, field: str) -> tuple[int, int, int]:
    if not isinstance(value, str):
        raise GuardError(f"{field} must be a semantic version string")
    match = SEMVER_RE.fullmatch(value)
    if match is None:
        raise GuardError(f"{field} must use stable X.Y.Z form, got {value!r}")
    return tuple(int(part) for part in match.groups())


def plugin_version(root: Path) -> str:
    versions: list[str] = []
    for relative in PLUGIN_MANIFESTS:
        manifest = _load_json(root / relative)
        if manifest.get("name") != "dina":
            raise GuardError(f"{relative} must describe the dina plugin")
        version = manifest.get("version")
        _parse_semver(version, field=f"{relative}: version")
        assert isinstance(version, str)
        versions.append(version)
    if len(set(versions)) != 1:
        raise GuardError(
            "Claude and Codex plugin versions must move together: "
            + ", ".join(versions)
        )
    return versions[0]


def require_version_advance(current_root: Path, staged_root: Path) -> str:
    current = plugin_version(current_root)
    staged = plugin_version(staged_root)
    if _parse_semver(staged, field="staged plugin version") <= _parse_semver(
        current, field="current plugin version"
    ):
        raise GuardError(
            f"plugin payload changed but version did not advance ({current} -> {staged})"
        )
    return staged


def verify_wheel(payload: dict, *, filename: str, sha256: str) -> None:
    urls = payload.get("urls")
    if not isinstance(urls, list):
        raise GuardError("PyPI response has no urls array")
    for artifact in urls:
        if not isinstance(artifact, dict):
            continue
        digests = artifact.get("digests")
        if (
            artifact.get("filename") == filename
            and artifact.get("packagetype") == "bdist_wheel"
            and artifact.get("yanked") is not True
            and isinstance(digests, dict)
            and digests.get("sha256") == sha256
        ):
            return
    raise GuardError(
        f"PyPI does not serve the exact non-yanked wheel {filename} with sha256 {sha256}"
    )


def required_native_assets(version: str) -> set[str]:
    _parse_semver(version, field="native release version")
    assets: set[str] = set()
    for platform, arch in NATIVE_TARGETS:
        archive = f"dina-home-node-lite-{platform}-{arch}.tar.gz"
        assets.update((archive, f"{archive}.sha256", f"{archive}.sigstore.json"))
    return assets


def verify_native_release(payload: dict, *, version: str) -> None:
    expected_tag = f"home-node-lite-v{version}"
    if payload.get("tag_name") != expected_tag:
        raise GuardError(
            f"GitHub returned tag {payload.get('tag_name')!r}, expected {expected_tag!r}"
        )
    if payload.get("draft") is True or payload.get("prerelease") is True:
        raise GuardError(f"{expected_tag} must be a published, non-prerelease release")
    raw_assets = payload.get("assets")
    if not isinstance(raw_assets, list):
        raise GuardError(f"{expected_tag} has no assets array")
    actual = {
        asset.get("name")
        for asset in raw_assets
        if isinstance(asset, dict) and isinstance(asset.get("name"), str)
    }
    missing = sorted(required_native_assets(version) - actual)
    if missing:
        raise GuardError(
            f"{expected_tag} is incomplete; missing assets: {', '.join(missing)}"
        )


def verify_claude_install(payload: object, *, version: str) -> None:
    if not isinstance(payload, list):
        raise GuardError("Claude plugin list must be a JSON array")
    matches = [
        plugin
        for plugin in payload
        if isinstance(plugin, dict) and plugin.get("id") == "dina@dina"
    ]
    if len(matches) != 1:
        raise GuardError(
            "Claude smoke install did not produce exactly one dina@dina plugin"
        )
    plugin = matches[0]
    if plugin.get("version") != version or plugin.get("enabled") is not True:
        raise GuardError(
            f"Claude smoke install is not enabled at expected version {version}"
        )
    if not isinstance(plugin.get("installPath"), str):
        raise GuardError("Claude smoke install has no installation path")


def verify_codex_install(payload: object, *, version: str) -> None:
    if not isinstance(payload, dict):
        raise GuardError("Codex plugin install result must be a JSON object")
    if payload.get("pluginId") != "dina@dina" or payload.get("version") != version:
        raise GuardError(f"Codex smoke install did not install dina@dina at {version}")
    if not isinstance(payload.get("installedPath"), str):
        raise GuardError("Codex smoke install has no installation path")


def verify_ci_run(payload: object, *, source_commit: str) -> None:
    if not isinstance(payload, list) or not payload:
        raise GuardError("no plugin CI run exists for the public source commit")
    latest = payload[0]
    if not isinstance(latest, dict) or latest.get("headSha") != source_commit:
        raise GuardError("latest plugin CI run does not match the public source commit")
    if latest.get("status") != "completed" or latest.get("conclusion") != "success":
        raise GuardError(
            "plugin CI for the public source commit has not completed successfully"
        )


def remote_slug(remote: str) -> str:
    value = remote.strip()
    if not value:
        raise GuardError("git remote cannot be empty")
    if "://" in value:
        path = urlparse(value).path
    elif re.match(r"^[^/]+@[^:]+:", value):
        path = value.split(":", 1)[1]
    else:
        path = value
    parts = [part for part in path.strip("/").split("/") if part]
    if not parts:
        raise GuardError(f"cannot identify repository from remote {remote!r}")
    parts[-1] = re.sub(r"\.git$", "", parts[-1])
    if len(parts) < 2:
        raise GuardError(f"remote must include owner and repository: {remote!r}")
    return "/".join(parts[-2:])


def validate_remote(remote: str, *, expected_slug: str) -> None:
    actual = remote_slug(remote)
    if actual != expected_slug:
        raise GuardError(
            f"refusing remote {remote!r}: expected repository {expected_slug}, got {actual}"
        )


def _resolve_stage_path(root: Path, relative: str, *, field: str) -> Path:
    target = (root / relative).resolve()
    resolved_root = root.resolve()
    if target != resolved_root and resolved_root not in target.parents:
        raise GuardError(f"{field} escapes the staged marketplace: {relative!r}")
    if not target.is_dir():
        raise GuardError(
            f"{field} does not resolve to a plugin directory: {relative!r}"
        )
    return target


def validate_stage(root: Path) -> str:
    root = root.resolve()
    if not root.is_dir():
        raise GuardError(f"staged root does not exist: {root}")
    symlinks = sorted(
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_symlink()
    )
    if symlinks:
        raise GuardError(f"release mirror cannot contain symlinks: {', '.join(symlinks)}")

    claude = _load_json(root / ".claude-plugin/marketplace.json")
    claude_plugins = claude.get("plugins")
    if not isinstance(claude_plugins, list) or len(claude_plugins) != 1:
        raise GuardError("Claude marketplace must contain exactly one plugin")
    claude_entry = claude_plugins[0]
    if not isinstance(claude_entry, dict) or claude_entry.get("name") != "dina":
        raise GuardError("Claude marketplace entry must be named dina")
    claude_source = claude_entry.get("source")
    if not isinstance(claude_source, str):
        raise GuardError("Claude marketplace source must be a local path")
    expected_claude = (root / "cli/claude-plugin/dina").resolve()
    if _resolve_stage_path(root, claude_source, field="Claude source") != expected_claude:
        raise GuardError("Claude marketplace points outside the canonical plugin directory")

    codex = _load_json(root / ".agents/plugins/marketplace.json")
    codex_plugins = codex.get("plugins")
    if not isinstance(codex_plugins, list) or len(codex_plugins) != 1:
        raise GuardError("Codex marketplace must contain exactly one plugin")
    codex_entry = codex_plugins[0]
    if not isinstance(codex_entry, dict) or codex_entry.get("name") != "dina":
        raise GuardError("Codex marketplace entry must be named dina")
    codex_source = codex_entry.get("source")
    if not isinstance(codex_source, dict) or codex_source.get("source") != "local":
        raise GuardError("Codex marketplace source must be a local path")
    codex_path = codex_source.get("path")
    if not isinstance(codex_path, str):
        raise GuardError("Codex marketplace path is missing")
    expected_codex = (root / "cli/codex-plugin/plugins/dina").resolve()
    if _resolve_stage_path(root, codex_path, field="Codex source") != expected_codex:
        raise GuardError("Codex marketplace points outside the canonical plugin directory")

    return plugin_version(root)


def payload_digest(root: Path) -> str:
    """Hash customer-visible files, including executable bits, but not provenance."""

    root = root.resolve()
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
        relative = path.relative_to(root)
        if ".git" in relative.parts or relative == Path(".source"):
            continue
        if path.is_symlink():
            raise GuardError(f"payload cannot contain symlink {relative.as_posix()}")
        if not path.is_file():
            continue
        executable = 1 if path.stat().st_mode & 0o111 else 0
        digest.update(relative.as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(executable).encode("ascii"))
        digest.update(b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
        digest.update(b"\0")
    return digest.hexdigest()


def _stdin_json() -> object:
    try:
        value = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        raise GuardError(f"invalid JSON input: {exc}") from exc
    return value


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    wheel = subparsers.add_parser("verify-wheel")
    wheel.add_argument("--filename", required=True)
    wheel.add_argument("--sha256", required=True)

    native = subparsers.add_parser("verify-native-release")
    native.add_argument("--version", required=True)

    claude_install = subparsers.add_parser("verify-claude-install")
    claude_install.add_argument("--version", required=True)

    codex_install = subparsers.add_parser("verify-codex-install")
    codex_install.add_argument("--version", required=True)

    ci_run = subparsers.add_parser("verify-ci-run")
    ci_run.add_argument("--source-commit", required=True)

    remote = subparsers.add_parser("validate-remote")
    remote.add_argument("--remote", required=True)
    remote.add_argument("--expected-slug", required=True)

    stage = subparsers.add_parser("validate-stage")
    stage.add_argument("--root", type=Path, required=True)

    version = subparsers.add_parser("plugin-version")
    version.add_argument("--root", type=Path, required=True)

    advance = subparsers.add_parser("require-version-advance")
    advance.add_argument("--current-root", type=Path, required=True)
    advance.add_argument("--staged-root", type=Path, required=True)

    payload = subparsers.add_parser("payload-digest")
    payload.add_argument("--root", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "verify-wheel":
            payload = _stdin_json()
            if not isinstance(payload, dict):
                raise GuardError("PyPI response must be a JSON object")
            verify_wheel(payload, filename=args.filename, sha256=args.sha256)
        elif args.command == "verify-native-release":
            payload = _stdin_json()
            if not isinstance(payload, dict):
                raise GuardError("GitHub release response must be a JSON object")
            verify_native_release(payload, version=args.version)
        elif args.command == "verify-claude-install":
            verify_claude_install(_stdin_json(), version=args.version)
        elif args.command == "verify-codex-install":
            verify_codex_install(_stdin_json(), version=args.version)
        elif args.command == "verify-ci-run":
            verify_ci_run(_stdin_json(), source_commit=args.source_commit)
        elif args.command == "validate-remote":
            validate_remote(args.remote, expected_slug=args.expected_slug)
        elif args.command == "validate-stage":
            print(validate_stage(args.root))
        elif args.command == "plugin-version":
            print(plugin_version(args.root))
        elif args.command == "require-version-advance":
            print(require_version_advance(args.current_root, args.staged_root))
        elif args.command == "payload-digest":
            print(payload_digest(args.root))
        else:  # pragma: no cover
            raise AssertionError(args.command)
    except GuardError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
