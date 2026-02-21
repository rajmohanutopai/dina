"""Admin UI FastAPI sub-application.

Serves Jinja2 templates for the dashboard. Proxied through dina-core
at /admin/* with CLIENT_TOKEN authentication.
"""

from fastapi import APIRouter

admin_router = APIRouter(prefix="/admin")
