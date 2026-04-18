"""Entry point: ``python -m demo.appointment``.

Starts the FastMCP server over stdio so OpenClaw can spawn it as a
subprocess (same pattern as demo/transit).
"""
from .server import mcp

mcp.run(transport="stdio")
