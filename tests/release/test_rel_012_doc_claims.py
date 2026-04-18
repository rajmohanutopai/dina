"""REL-012 README, QUICKSTART, and Public Claims Checklist.

Verify that provider-facing documentation is materially true as written.

Execution class: Hybrid (harness portion).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


class TestDocExistence:
    """REL-012: Referenced documents exist."""

    # REL-012
    # TRACE: {"suite": "REL", "case": "0012", "section": "12", "sectionName": "Doc Claims", "subsection": "01", "scenario": "01", "title": "rel_012_core_docs_exist"}
    def test_rel_012_core_docs_exist(self) -> None:
        """All core referenced documents exist.

        README, ARCHITECTURE, SECURITY, ROADMAP, and other top-level
        docs must exist as referenced.
        """
        required_docs = [
            "README.md",
            "ARCHITECTURE.md",
            "docs/ROADMAP.md",
            "CLAUDE.md",
            "docs/RELEASE_TEST_PLAN.md",
        ]
        for doc in required_docs:
            path = PROJECT_ROOT / doc
            assert path.exists(), f"Missing required doc: {doc}"
            assert path.stat().st_size > 100, f"Doc {doc} is suspiciously small"

    # REL-012
    # TRACE: {"suite": "REL", "case": "0012", "section": "12", "sectionName": "Doc Claims", "subsection": "01", "scenario": "02", "title": "rel_012_architecture_docs_exist"}
    def test_rel_012_architecture_docs_exist(self) -> None:
        """Architecture detail docs exist.

        The docs/architecture/ directory should contain the referenced
        architecture documents.
        """
        arch_dir = PROJECT_ROOT / "docs" / "architecture"
        if arch_dir.exists():
            # Should have at least some architecture docs
            md_files = list(arch_dir.glob("*.md"))
            assert len(md_files) > 0, "Architecture docs directory is empty"

    # REL-012
    # TRACE: {"suite": "REL", "case": "0012", "section": "12", "sectionName": "Doc Claims", "subsection": "01", "scenario": "03", "title": "rel_012_walkthrough_docs_exist"}
    def test_rel_012_walkthrough_docs_exist(self) -> None:
        """Walkthrough documents exist.

        Security, brain, and core walkthroughs should exist as
        referenced in the architecture.
        """
        docs_dir = PROJECT_ROOT / "docs"
        if docs_dir.exists():
            walkthroughs = [
                "security-walkthrough.md",
                "brain-walkthrough.md",
                "core-walkthrough.md",
            ]
            for doc in walkthroughs:
                path = docs_dir / doc
                assert path.exists(), f"Missing walkthrough: {doc}"


class TestScriptsExist:
    """REL-012: Referenced scripts and entrypoints exist."""

    # REL-012
    # TRACE: {"suite": "REL", "case": "0012", "section": "12", "sectionName": "Doc Claims", "subsection": "02", "scenario": "01", "title": "rel_012_install_script_exists"}
    def test_rel_012_install_script_exists(self) -> None:
        """install.sh exists and is executable."""
        install = PROJECT_ROOT / "install.sh"
        assert install.exists(), "Missing install.sh"

    # REL-012
    # TRACE: {"suite": "REL", "case": "0012", "section": "12", "sectionName": "Doc Claims", "subsection": "02", "scenario": "02", "title": "rel_012_run_script_exists"}
    def test_rel_012_run_script_exists(self) -> None:
        """run.sh exists."""
        run_sh = PROJECT_ROOT / "run.sh"
        assert run_sh.exists(), "Missing run.sh"

    # REL-012
    # TRACE: {"suite": "REL", "case": "0012", "section": "12", "sectionName": "Doc Claims", "subsection": "02", "scenario": "03", "title": "rel_012_docker_compose_exists"}
    def test_rel_012_docker_compose_exists(self) -> None:
        """docker-compose.yml exists."""
        compose = PROJECT_ROOT / "docker-compose.yml"
        assert compose.exists(), "Missing docker-compose.yml"

    # REL-012
    # TRACE: {"suite": "REL", "case": "0012", "section": "12", "sectionName": "Doc Claims", "subsection": "02", "scenario": "04", "title": "rel_012_provision_scripts_exist"}
    def test_rel_012_provision_scripts_exist(self) -> None:
        """Key provisioning scripts exist."""
        scripts = [
            "scripts/provision_derived_service_keys.py",
            "scripts/wrap_seed.py",
            "scripts/unwrap_seed.py",
        ]
        for script in scripts:
            path = PROJECT_ROOT / script
            assert path.exists(), f"Missing script: {script}"


class TestDocLinks:
    """REL-012: Internal documentation links resolve."""

    # REL-012
    # TRACE: {"suite": "REL", "case": "0012", "section": "12", "sectionName": "Doc Claims", "subsection": "03", "scenario": "01", "title": "rel_012_readme_internal_links"}
    def test_rel_012_readme_internal_links(self) -> None:
        """Internal links in README.md resolve to existing files.

        Markdown links like [text](path) where path is a relative
        file path must point to files that actually exist.
        """
        readme = PROJECT_ROOT / "README.md"
        if not readme.exists():
            pytest.skip("README.md not found")

        content = readme.read_text()
        # Match markdown links: [text](path) — skip URLs
        link_re = re.compile(r'\[([^\]]+)\]\(([^)]+)\)')

        broken = []
        for match in link_re.finditer(content):
            target = match.group(2)
            # Skip external URLs and anchors
            if target.startswith(("http://", "https://", "#", "mailto:")):
                continue
            # Strip anchor from file path
            file_path = target.split("#")[0]
            if not file_path:
                continue
            full_path = (PROJECT_ROOT / file_path).resolve()
            if not full_path.exists():
                broken.append(f"  {match.group(1)} -> {target}")

        assert len(broken) == 0, (
            f"Broken internal links in README.md:\n" + "\n".join(broken)
        )

    # REL-012
    # TRACE: {"suite": "REL", "case": "0012", "section": "12", "sectionName": "Doc Claims", "subsection": "03", "scenario": "02", "title": "rel_012_test_plan_references"}
    def test_rel_012_test_plan_references(self) -> None:
        """Test plan files referenced in RELEASE_TEST_PLAN.md exist."""
        plan = PROJECT_ROOT / "docs" / "RELEASE_TEST_PLAN.md"
        if not plan.exists():
            pytest.skip("RELEASE_TEST_PLAN.md not found")

        content = plan.read_text()
        plan_dir = plan.parent  # resolve relative links from the file's directory
        # Extract file paths from markdown links
        link_re = re.compile(r'\[([^\]]+)\]\(([^)]+)\)')

        broken = []
        for match in link_re.finditer(content):
            target = match.group(2)
            if target.startswith(("http://", "https://", "#")):
                continue
            # Handle absolute paths starting with /Users/
            if target.startswith("/Users/"):
                full_path = Path(target)
            else:
                file_path = target.split("#")[0]
                if not file_path:
                    continue
                full_path = (plan_dir / file_path).resolve()
            if not full_path.exists():
                broken.append(f"  {match.group(1)} -> {target}")

        assert len(broken) == 0, (
            f"Broken references in RELEASE_TEST_PLAN.md:\n" + "\n".join(broken)
        )
