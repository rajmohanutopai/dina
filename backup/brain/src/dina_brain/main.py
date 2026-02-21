"""FastAPI application entry point for dina-brain.

Mounts the API router and admin UI. Connects to dina-core on startup.
"""

from fastapi import FastAPI

app = FastAPI(title="dina-brain", version="0.5.0")


@app.get("/v1/health")
async def health():
    return {"status": "ok"}
