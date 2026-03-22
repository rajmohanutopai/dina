"""Formatted output helpers for the CLI."""

from __future__ import annotations

import json

import click


def print_result(data: dict | list, json_mode: bool) -> None:
    """Print *data* to stdout.

    In *json_mode* the output is pretty-printed JSON.  Otherwise dicts
    are rendered as ``key: value`` pairs and lists as numbered items.
    """
    if json_mode:
        click.echo(json.dumps(data, indent=2))
        return

    if isinstance(data, dict):
        for key, value in data.items():
            click.echo(f"{key}: {value}")
    else:
        for i, item in enumerate(data, 1):
            click.echo(f"{i}. {item}")


def print_error(message: str, json_mode: bool) -> None:
    """Print an error to stderr.

    In *json_mode* the error is emitted as a JSON object.
    """
    if json_mode:
        click.echo(json.dumps({"error": message}), err=True)
    else:
        click.echo(f"Error: {message}", err=True)


def print_result_with_trace(data: dict | list, json_mode: bool, req_id: str = "") -> None:
    """Print result with req_id injected into the output.

    JSON mode: adds ``req_id`` to dict responses.
    Text mode: appends ``req_id: ...`` on the last line.
    """
    if req_id and isinstance(req_id, str) and isinstance(data, dict):
        data = {**data, "req_id": req_id}
    print_result(data, json_mode)
    # Always show req_id on stderr (text + JSON list responses)
    if req_id and isinstance(req_id, str):
        click.echo(f"  req_id: {req_id}", err=True)


def print_error_with_trace(message: str, json_mode: bool, req_id: str = "") -> None:
    """Print an error with optional request trace ID for debugging.

    Appends the req_id to the message so the user can look up the
    full trace via ``dina-admin trace <req_id>``.
    """
    if req_id:
        message = f"{message} (req_id: {req_id})"
    print_error(message, json_mode)
