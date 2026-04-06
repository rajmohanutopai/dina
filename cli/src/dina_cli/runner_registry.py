"""Runner registry — resolves runner name to implementation.

Supports: openclaw, hermes, auto (default from config).
"""

from __future__ import annotations

from typing import Any

from .agent_runner import AgentRunner


_REGISTRY: dict[str, type] = {}


def register_runner(name: str, cls: type) -> None:
    """Register a runner class by name."""
    _REGISTRY[name] = cls


def get_runner(name: str, config: object = None) -> AgentRunner:
    """Get a runner instance by name. Raises if unknown.

    Passes config to the runner constructor if it accepts it.
    """
    if name not in _REGISTRY:
        available = ", ".join(sorted(_REGISTRY.keys())) or "none"
        raise RuntimeError(f"Unknown runner '{name}'. Available: {available}")
    cls = _REGISTRY[name]
    try:
        return cls(config=config)
    except TypeError:
        return cls()


def list_runners() -> list[str]:
    """List registered runner names."""
    return sorted(_REGISTRY.keys())


# Auto-register built-in runners on import.
def _auto_register() -> None:
    try:
        from .openclaw_runner import OpenClawRunner
        register_runner("openclaw", OpenClawRunner)
    except ImportError:
        pass

    # HermesRunner is always registerable — it handles missing hermes library
    # gracefully at validate_config() and execute() time.
    from .hermes_runner import HermesRunner
    register_runner("hermes", HermesRunner)


_auto_register()
