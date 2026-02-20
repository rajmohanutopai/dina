"""Connector scheduler — manages periodic sync cycles.

Dispatches sync tasks to the task queue in dina-core.
Connectors run as MCP child agents (Gmail, Calendar, etc.).
"""
