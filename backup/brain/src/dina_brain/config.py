"""Configuration for dina-brain.

Loads from environment variables: BRAIN_TOKEN, CORE_URL, LLM provider settings.
"""

import os

CORE_URL = os.getenv("CORE_URL", "http://core:8300")
BRAIN_TOKEN = os.getenv("BRAIN_TOKEN", "")
