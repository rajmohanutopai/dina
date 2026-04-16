"""Entry point: python -m demo.transit"""
from .server import mcp

mcp.run(transport="stdio")
