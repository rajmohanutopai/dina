"""Port interface for MCP (Model Context Protocol) agent delegation.

Matches Brain TEST_PLAN SS6 (MCP Client) and the contract in
``brain/tests/contracts.py::MCPClient``.

Implementations live in ``src/adapter/``.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class MCPClient(Protocol):
    """Async interface for calling tools on remote MCP servers.

    Dina uses MCP to delegate specialist tasks (email fetch, calendar
    read, legal review, image analysis) to external agents while
    maintaining the Thin Agent principle: raw vault data never leaves
    the Home Node — only questions are sent.

    Implementations must enforce a 30-second timeout per ``call_tool``
    invocation and raise ``MCPError`` on failure.
    """

    async def call_tool(self, server: str, tool: str, args: dict) -> dict:
        """Invoke a named tool on an MCP server.

        Parameters:
            server: Identifier or URL of the MCP server.
            tool:   Name of the tool to invoke (e.g. ``"gmail_fetch"``).
            args:   JSON-serialisable arguments for the tool.

        Returns:
            Structured result dict from the tool execution.

        Raises:
            MCPError: On connection failure, timeout, or protocol error.
        """
        ...

    async def list_tools(self, server: str) -> list[dict]:
        """Discover available tools on an MCP server.

        Returns a list of tool descriptors, each containing at least
        ``name``, ``description``, and ``parameters`` keys.
        """
        ...

    async def disconnect(self, server: str) -> None:
        """Cleanly disconnect from an MCP server.

        Called after task completion or when blacklisting a compromised
        agent (SS6.2.10).
        """
        ...
