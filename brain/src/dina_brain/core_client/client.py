"""Typed async HTTP client for dina-core's API.

Authenticates with BRAIN_TOKEN. Provides methods for vault CRUD,
contact lookup, PII scrubbing, and sending messages.
"""

import httpx
