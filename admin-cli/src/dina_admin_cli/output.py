"""Formatted output helpers for the admin CLI."""

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
