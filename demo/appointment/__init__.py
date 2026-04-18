"""Demo appointment-status MCP server.

Small, deterministic service that stands in for a dentist / doctor /
mechanic etc. who runs their own Dina node and publishes an
``appointment_status`` capability.

Used by the Working Memory scenario tests (docs/WORKING_MEMORY_DESIGN.md,
scenario 7 "is my dentist appointment still confirmed?") — Dr Carl's
OpenClaw runs this tool. Alonso asks the question → classifier routes
vault+provider_services → query_service hits Dr Carl → this tool
returns a structured status.
"""
