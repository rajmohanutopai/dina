"""Hermes runner — inline task execution via Hermes Python library.

Runs a fresh Hermes AIAgent per task inside the daemon process.
MCP servers are configured via a temporary YAML config file per task.

Install: pip install git+https://github.com/NousResearch/hermes-agent.git
Import: from run_agent import AIAgent
API: agent.chat(message) → str, agent.run_conversation(message) → dict
Docs: https://hermes-agent.nousresearch.com/docs/guides/python-library/
"""

from __future__ import annotations

import json
import os
import tempfile
from typing import Any

import yaml

from .agent_runner import AgentRunner, RunnerResult


class HermesRunner:
    """AgentRunner implementation for Hermes (library mode).

    Uses Hermes Python library to run tasks inline. Each task creates
    a fresh AIAgent with a temporary YAML config for the Dina MCP server.
    """

    runner_name = "hermes"

    def __init__(self, config: Any = None) -> None:
        self._model = os.environ.get("DINA_HERMES_MODEL", "google/gemini-2.5-flash")
        self._max_iterations = int(os.environ.get("DINA_HERMES_MAX_STEPS", "50"))
        # Hermes uses OpenRouter natively. OPENROUTER_API_KEY is the standard env var.
        # api_key/base_url overrides are available for direct provider access.
        self._api_key = os.environ.get("DINA_HERMES_API_KEY", "")
        self._base_url = os.environ.get("DINA_HERMES_BASE_URL", "")
        self._hermes_available: bool | None = None

    def validate_config(self) -> None:
        """Check that Hermes library is importable."""
        try:
            from run_agent import AIAgent  # noqa: F401
            self._hermes_available = True
        except ImportError:
            self._hermes_available = False
            raise RuntimeError(
                "Hermes runner: 'from run_agent import AIAgent' failed. "
                "Install: pip install git+https://github.com/NousResearch/hermes-agent.git"
            )

    def health(self) -> dict[str, Any]:
        if self._hermes_available is None:
            try:
                self.validate_config()
            except RuntimeError:
                pass
        return {
            "status": "ok" if self._hermes_available else "unavailable",
            "runner": "hermes",
            "mode": "library",
        }

    def execute(self, task: dict, prompt: str, session_name: str) -> RunnerResult:
        """Execute task inline using Hermes Python library.

        Creates a fresh AIAgent per task with a temporary YAML config
        that declares the Dina MCP server. Returns terminal result.
        """
        task_id = task.get("id", "")

        try:
            from run_agent import AIAgent
        except ImportError:
            return RunnerResult(
                state="failed",
                error="Hermes not installed. pip install git+https://github.com/NousResearch/hermes-agent.git",
            )

        # Write a temporary Hermes YAML config with Dina MCP server.
        mcp_config = {
            "mcp_servers": {
                "dina": {
                    "command": "dina",
                    "args": ["mcp-server"],
                    "env": {
                        "DINA_CONFIG_DIR": os.environ.get("DINA_CONFIG_DIR", ""),
                    },
                },
            },
        }

        config_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".yaml", prefix="hermes-dina-",
                delete=False,
            ) as f:
                yaml.dump(mcp_config, f)
                config_path = f.name

            # Set HERMES_CONFIG to point to our temp config.
            old_config = os.environ.get("HERMES_CONFIG", "")
            os.environ["HERMES_CONFIG"] = config_path

            try:
                agent_kwargs: dict[str, Any] = {
                    "model": self._model,
                    "quiet_mode": True,
                    "max_iterations": self._max_iterations,
                }
                # Optional overrides for direct provider access (non-OpenRouter).
                if self._api_key:
                    agent_kwargs["api_key"] = self._api_key
                if self._base_url:
                    agent_kwargs["base_url"] = self._base_url

                agent = AIAgent(**agent_kwargs)

                # Use chat() for simple string result.
                output = agent.chat(prompt)

                return RunnerResult(
                    state="completed",
                    summary=str(output)[:2000],
                    run_id=f"hermes-{task_id}",
                )

            finally:
                # Restore original config.
                if old_config:
                    os.environ["HERMES_CONFIG"] = old_config
                else:
                    os.environ.pop("HERMES_CONFIG", None)

        except Exception as e:
            return RunnerResult(
                state="failed",
                error=f"Hermes execution error: {e}",
            )
        finally:
            if config_path:
                try:
                    os.unlink(config_path)
                except Exception:
                    pass

    def reconcile(self, task: dict) -> RunnerResult | None:
        """Hermes library mode is inline — no reconciliation needed."""
        return None

    def cancel(self, task: dict) -> None:
        """Hermes library mode — cancellation not supported yet."""
        pass

    @property
    def supports_reconciliation(self) -> bool:
        return False
