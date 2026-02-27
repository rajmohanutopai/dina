"""MCP client adapter over stdio transport — implements MCPClient protocol.

Manages child processes for MCP servers and communicates via JSON-RPC
messages over stdin/stdout.

Third-party imports:  structlog.
"""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass, field
from typing import Any

import structlog

from ..domain.errors import MCPError

logger = structlog.get_logger(__name__)

_TIMEOUT_S = 30.0
_REQUEST_ID_COUNTER = 0

_SAFE_ENV_KEYS = frozenset({
    "PATH", "HOME", "LANG", "LC_ALL", "TERM", "USER",
    "SHELL", "TMPDIR", "XDG_RUNTIME_DIR",
})


def _next_id() -> int:
    """Generate a monotonically-increasing JSON-RPC request id."""
    global _REQUEST_ID_COUNTER
    _REQUEST_ID_COUNTER += 1
    return _REQUEST_ID_COUNTER


@dataclass
class _StdioSession:
    """Tracks state for a single MCP server subprocess."""

    process: asyncio.subprocess.Process
    command: str
    args: list[str] = field(default_factory=list)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class MCPStdioClient:
    """Implements MCPClient via stdio transport to MCP servers.

    Each MCP server is launched as a child process.  Communication
    uses JSON-RPC 2.0 messages over stdin (requests) and stdout
    (responses).

    Session lifecycle:
    - ``list_tools`` or ``call_tool`` lazily starts the server process.
    - ``disconnect`` terminates the process and cleans up.
    - 30-second timeout per call; raises ``MCPError`` on timeout.
    """

    def __init__(
        self,
        server_commands: dict[str, list[str]] | None = None,
    ) -> None:
        """Initialize the stdio MCP client.

        Parameters:
            server_commands: Maps server names to their launch commands.
                             Example: ``{"gmail": ["npx", "gmail-mcp-server"]}``.
        """
        self._server_commands: dict[str, list[str]] = server_commands or {}
        self._sessions: dict[str, _StdioSession] = {}

    # -- Session management --------------------------------------------------

    async def _get_session(self, server: str) -> _StdioSession:
        """Get or create a stdio session for the named server."""
        if server in self._sessions:
            session = self._sessions[server]
            # Check if process is still alive
            if session.process.returncode is None:
                return session
            # Process died — clean up and recreate
            logger.warning("mcp_stdio_process_died", server=server)
            del self._sessions[server]

        cmd = self._server_commands.get(server)
        if not cmd:
            raise MCPError(
                f"No command configured for MCP server '{server}'. "
                f"Add it to server_commands."
            )

        try:
            safe_env = {k: v for k, v in os.environ.items() if k in _SAFE_ENV_KEYS}
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=safe_env,
            )
        except FileNotFoundError as exc:
            raise MCPError(
                f"MCP server command not found: {cmd[0]}"
            ) from exc
        except OSError as exc:
            raise MCPError(
                f"Failed to start MCP server '{server}': {exc}"
            ) from exc

        session = _StdioSession(
            process=process,
            command=cmd[0],
            args=cmd[1:],
        )
        self._sessions[server] = session

        logger.info(
            "mcp_stdio_session_started",
            server=server,
            pid=process.pid,
        )
        return session

    async def _send_request(
        self, server: str, method: str, params: dict[str, Any] | None = None
    ) -> Any:
        """Send a JSON-RPC 2.0 request and read the response."""
        session = await self._get_session(server)

        if session.process.stdin is None or session.process.stdout is None:
            raise MCPError(
                f"MCP server '{server}' has no stdin/stdout pipes"
            )

        req_id = _next_id()
        request = {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": method,
        }
        if params is not None:
            request["params"] = params

        # Serialize write+read under a per-session lock to prevent
        # concurrent coroutines from interleaving requests/responses.
        async with session.lock:
            # Write request
            payload = json.dumps(request) + "\n"
            session.process.stdin.write(payload.encode())
            await session.process.stdin.drain()

            # Read response with timeout
            try:
                raw_line = await asyncio.wait_for(
                    session.process.stdout.readline(),
                    timeout=_TIMEOUT_S,
                )
            except asyncio.TimeoutError:
                raise MCPError(
                    f"MCP server '{server}' timed out after {_TIMEOUT_S}s "
                    f"(method={method})"
                )

            if not raw_line:
                # Process may have exited
                stderr_data = b""
                if session.process.stderr:
                    try:
                        stderr_data = await asyncio.wait_for(
                            session.process.stderr.read(4096),
                            timeout=2.0,
                        )
                    except asyncio.TimeoutError:
                        pass
                # MEDIUM-14: Log metadata only — never raw stderr content
                stderr_text = stderr_data.decode(errors='replace').strip()
                logger.debug(
                    "mcp.stderr_captured",
                    server=server,
                    stderr_len=len(stderr_text),
                    exit_code=session.process.returncode,
                )
                raise MCPError(
                    f"MCP server '{server}' closed stdout unexpectedly. "
                    f"Exit code: {session.process.returncode}"
                )

        try:
            response = json.loads(raw_line)
        except json.JSONDecodeError as exc:
            raise MCPError(
                f"MCP server '{server}' returned invalid JSON: "
                f"{raw_line[:200]!r}"
            ) from exc

        # Verify response ID matches request ID.
        resp_id = response.get("id")
        if resp_id != req_id:
            raise MCPError(
                f"MCP server '{server}' response id mismatch: "
                f"expected {req_id}, got {resp_id}"
            )

        # Check for JSON-RPC error
        if "error" in response:
            err = response["error"]
            code = err.get("code", -1)
            message = err.get("message", "Unknown error")
            raise MCPError(
                f"MCP server '{server}' error (code={code}): {message}"
            )

        return response.get("result")

    # -- MCPClient protocol --------------------------------------------------

    async def call_tool(self, server: str, tool: str, args: dict) -> dict:
        """Invoke a named tool on an MCP server.

        Parameters:
            server: Identifier of the MCP server.
            tool:   Name of the tool to invoke.
            args:   JSON-serialisable arguments.

        Returns:
            Structured result dict from the tool execution.

        Raises:
            MCPError: On connection failure, timeout, or protocol error.
        """
        logger.info(
            "mcp_stdio_call_tool",
            server=server,
            tool=tool,
        )
        result = await self._send_request(
            server,
            "tools/call",
            {"name": tool, "arguments": args},
        )
        return result if isinstance(result, dict) else {"result": result}

    async def list_tools(self, server: str) -> list[dict]:
        """Discover available tools on an MCP server.

        Returns a list of tool descriptors with ``name``, ``description``,
        and ``parameters`` keys.

        Raises:
            MCPError: On connection failure, timeout, or protocol error.
        """
        logger.info("mcp_stdio_list_tools", server=server)
        result = await self._send_request(server, "tools/list")

        if isinstance(result, dict):
            return result.get("tools", [])
        if isinstance(result, list):
            return result
        return []

    async def disconnect(self, server: str) -> None:
        """Terminate the MCP server process and clean up.

        Sends SIGTERM and waits briefly for graceful shutdown.
        Falls back to SIGKILL if the process does not exit.

        No-op if the server is not connected.
        """
        session = self._sessions.pop(server, None)
        if session is None:
            return

        pid = session.process.pid
        logger.info("mcp_stdio_disconnect", server=server, pid=pid)

        try:
            session.process.terminate()
            await asyncio.wait_for(session.process.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            logger.warning(
                "mcp_stdio_force_kill",
                server=server,
                pid=pid,
            )
            session.process.kill()
            await session.process.wait()

    async def disconnect_all(self) -> None:
        """Disconnect from all connected MCP servers."""
        servers = list(self._sessions.keys())
        for server in servers:
            await self.disconnect(server)
