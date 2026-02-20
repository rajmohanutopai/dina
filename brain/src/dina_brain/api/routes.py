"""API routes for dina-brain.

POST /v1/process — core notifies brain of events (vault_unlocked, new_message).
POST /v1/classify — silence classification for incoming items.
POST /v1/nudge — assemble and return a nudge for the user.
"""

from fastapi import APIRouter

router = APIRouter(prefix="/v1")
