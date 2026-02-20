"""Shared request/response types for the brain API."""

from pydantic import BaseModel


class ProcessEvent(BaseModel):
    event: str
    payload: dict = {}
