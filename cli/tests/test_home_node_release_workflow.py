from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "home-node-lite-release.yml"


def test_native_release_matrix_and_publish_gates() -> None:
    source = WORKFLOW.read_text(encoding="utf-8")
    workflow = yaml.safe_load(source)
    jobs = workflow["jobs"]

    targets = {
        (entry["platform"], entry["arch"])
        for entry in jobs["build"]["strategy"]["matrix"]["include"]
    }
    assert targets == {
        ("darwin", "x64"),
        ("darwin", "arm64"),
        ("linux", "x64"),
        ("linux", "arm64"),
        ("win32", "x64"),
    }
    runners = {
        (entry["platform"], entry["arch"]): entry["runner"]
        for entry in jobs["build"]["strategy"]["matrix"]["include"]
    }
    assert runners[("darwin", "x64")] == "macos-15-intel"
    assert runners[("darwin", "arm64")] == "macos-15"
    assert runners[("win32", "x64")] == "windows-2022"
    assert jobs["build"]["needs"] == "validate"
    assert set(jobs["publish"]["needs"]) == {"validate", "build"}
    assert "tag_version" in source
    assert "cli/pyproject.toml" in source
    assert "does not match CLI version" in source
    assert "component_version.sh check cli --head" in source


def test_native_builder_supports_downloaded_and_debian_node_licenses() -> None:
    source = (REPO_ROOT / "scripts" / "release" / "build_home_node_native.py").read_text(
        encoding="utf-8"
    )

    assert 'node.parent / "LICENSE"' in source
    assert 'Path("/usr/share/doc/nodejs/copyright")' in source
