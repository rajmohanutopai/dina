"""MCP client adapter over HTTP transport — implements MCPClient protocol.

Communicates with MCP servers via HTTP REST endpoints instead of
stdio.  Suited for MCP servers running as standalone HTTP services.

Third-party imports:  httpx, structlog.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

import httpx
import structlog

from ..domain.errors import MCPError

# BA2: Tool name whitelist pattern — defense-in-depth against path injection.
_TOOL_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+$")

logger = structlog.get_logger(__name__)

_TIMEOUT_S = 30.0


class MCPHTTPClient:
    """Implements MCPClient via HTTP transport.

    Each MCP server is identified by name and mapped to a base URL.
    Tool invocations are POSTed and tool listings are fetched via GET.

    Unlike the stdio client, there is no persistent process — each
    request is a stateless HTTP call.

    Parameters:
        base_urls: Maps server names to HTTP base URLs.
                   Example: ``{"gmail": "http://gmail-mcp:8300"}``.
    """

    def __init__(
        self,
        base_urls: dict[str, str] | None = None,
    ) -> None:
        self._base_urls: dict[str, str] = base_urls or {}
        self._client: httpx.AsyncClient | None = None

    # -- Lifecycle -----------------------------------------------------------

    def _ensure_client(self) -> httpx.AsyncClient:
        """Lazily create the underlying httpx client."""
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(_TIMEOUT_S),
            )
        return self._client

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    def _get_base_url(self, server: str) -> str:
        """Resolve a server name to its base URL."""
        url = self._base_urls.get(server)
        if not url:
            raise MCPError(
                f"No base URL configured for MCP server '{server}'. "
                f"Add it to base_urls."
            )
        return url.rstrip("/")

    # -- MCPClient protocol --------------------------------------------------

    async def call_tool(self, server: str, tool: str, args: dict) -> dict:
        """POST /tools/{tool} — invoke a named tool on an MCP server.

        Parameters:
            server: Identifier of the MCP server.
            tool:   Name of the tool to invoke.
            args:   JSON-serialisable arguments.

        Returns:
            Structured result dict from the tool execution.

        Raises:
            MCPError: On connection failure, timeout, or HTTP error.
        """
        client = self._ensure_client()
        base_url = self._get_base_url(server)

        # BA2: Validate tool name before URL path interpolation.
        if not _TOOL_NAME_RE.match(tool):
            raise MCPError(f"invalid tool name: {tool!r}")

        logger.info(
            "mcp_http_call_tool",
            server=server,
            tool=tool,
        )

        try:
            resp = await asyncio.wait_for(
                client.post(
                    f"{base_url}/tools/{tool}",
                    json=args,
                ),
                timeout=_TIMEOUT_S,
            )
            resp.raise_for_status()
            data = resp.json()
            return data if isinstance(data, dict) else {"result": data}

        except asyncio.TimeoutError:
            raise MCPError(
                f"MCP HTTP call to '{server}/{tool}' timed out "
                f"after {_TIMEOUT_S}s"
            )
        except httpx.ConnectError as exc:
            raise MCPError(
                f"MCP server '{server}' unreachable at {base_url}: {exc}"
            ) from exc
        except httpx.HTTPStatusError as exc:
            raise MCPError(
                f"MCP server '{server}' returned HTTP "
                f"{exc.response.status_code} for tool '{tool}': "
                f"{exc.response.text[:500]}"
            ) from exc
        except MCPError:
            raise
        except Exception as exc:
            raise MCPError(
                f"MCP HTTP call_tool error (server={server}, tool={tool}): "
                f"{exc}"
            ) from exc

    async def list_tools(self, server: str) -> list[dict]:
        """GET /tools — discover available tools on an MCP server.

        Returns a list of tool descriptors, each containing at least
        ``name``, ``description``, and ``parameters`` keys.

        Raises:
            MCPError: On connection failure, timeout, or HTTP error.
        """
        client = self._ensure_client()
        base_url = self._get_base_url(server)

        logger.info("mcp_http_list_tools", server=server)

        try:
            resp = await asyncio.wait_for(
                client.get(f"{base_url}/tools"),
                timeout=_TIMEOUT_S,
            )
            resp.raise_for_status()
            data = resp.json()

            if isinstance(data, dict):
                return data.get("tools", [])
            if isinstance(data, list):
                return data
            return []

        except asyncio.TimeoutError:
            raise MCPError(
                f"MCP HTTP list_tools for '{server}' timed out "
                f"after {_TIMEOUT_S}s"
            )
        except httpx.ConnectError as exc:
            raise MCPError(
                f"MCP server '{server}' unreachable at {base_url}: {exc}"
            ) from exc
        except httpx.HTTPStatusError as exc:
            raise MCPError(
                f"MCP server '{server}' returned HTTP "
                f"{exc.response.status_code} for list_tools: "
                f"{exc.response.text[:500]}"
            ) from exc
        except MCPError:
            raise
        except Exception as exc:
            raise MCPError(
                f"MCP HTTP list_tools error (server={server}): {exc}"
            ) from exc

    async def disconnect(self, server: str) -> None:
        """No-op for HTTP transport.

        HTTP connections are stateless, so there is no persistent
        session to tear down.  This method exists to satisfy the
        MCPClient protocol interface.
        """
        logger.debug("mcp_http_disconnect_noop", server=server)
