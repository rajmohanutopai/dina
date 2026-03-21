"""Dina installer core — structured, testable install pipeline.

Production path: install.sh collects prompts → builds config JSON →
runs this module inside Docker → reads result.

Test path: tests construct InstallerConfig directly → call run_install() →
assert on InstallerResult fields.

Same code, same logic, same output. Only the I/O adapter differs.
"""

from __future__ import annotations

from scripts.installer.models import (
    IdentityChoice,
    InstallerConfig,
    InstallerResult,
    StartupMode,
)
from scripts.installer.pipeline import run_install

__all__ = [
    "IdentityChoice",
    "InstallerConfig",
    "InstallerResult",
    "StartupMode",
    "run_install",
]
