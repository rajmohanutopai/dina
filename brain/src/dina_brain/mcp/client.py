"""MCP client — issues tasks to child agents and collects results.

Child agents are external processes (containers, services). They receive
task messages via MCP and return structured results. They never access
Dina's vault, keys, or personas directly.
"""
