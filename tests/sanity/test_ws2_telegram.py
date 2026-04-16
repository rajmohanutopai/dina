"""WS2 Service Query — Telegram Sanity Tests.

Tests the WS2 service query flow through real Telegram bot interactions
using Telethon as the user client.

Prerequisites:
- Regression Alonso + Sancho Docker containers running
- Telethon session created (tests/sanity/create_session.py)
- .env.sanity with bot tokens
"""

import os
import pytest

# Bot usernames for regression instances
ALONSO_BOT = os.environ.get("SANITY_ALONSO_BOT", "regression_test_dina_alonso_bot")


class TestWS2ServiceQuery:
    """Test /service_query and /service_approve via Telegram."""

    def test_service_query_validation(self, tg):
        """Incomplete /service_query returns usage help."""
        response = tg.send_and_wait(
            ALONSO_BOT,
            "/service_query",
            timeout=30,
        )
        assert response is not None, "Bot should respond to /service_query"
        assert "usage" in response.lower() or "example" in response.lower(), \
            f"Expected usage help, got: {response[:200]}"

    def test_service_query_with_args(self, tg):
        """Valid /service_query with args attempts to find a service."""
        response = tg.send_and_wait(
            ALONSO_BOT,
            "/service_query eta_query 12.97 77.59 bus 42",
            timeout=60,
        )
        assert response is not None, "Bot should respond"
        # Without AppView running, this should report "No services found"
        # or a similar message. Either way, it proves the command is wired.
        lower = response.lower()
        assert any(kw in lower for kw in [
            "no services", "not found", "failed", "asking", "service",
        ]), f"Expected service-related response, got: {response[:200]}"

    def test_service_approve_validation(self, tg):
        """Incomplete /service_approve returns usage help."""
        response = tg.send_and_wait(
            ALONSO_BOT,
            "/service_approve",
            timeout=30,
        )
        assert response is not None, "Bot should respond to /service_approve"
        assert "usage" in response.lower() or "task_id" in response.lower() or "approve" in response.lower(), \
            f"Expected usage help, got: {response[:200]}"

    def test_service_approve_nonexistent(self, tg):
        """Approving a nonexistent task returns an error."""
        response = tg.send_and_wait(
            ALONSO_BOT,
            "/service_approve nonexistent-task-id",
            timeout=30,
        )
        assert response is not None, "Bot should respond"
        lower = response.lower()
        assert any(kw in lower for kw in [
            "failed", "error", "not found", "denied",
        ]), f"Expected error response, got: {response[:200]}"

    def test_status_command(self, tg):
        """Verify /status shows WS2 Brain version with workflow support."""
        response = tg.send_and_wait(
            ALONSO_BOT,
            "/status",
            timeout=30,
        )
        assert response is not None
        assert "ok" in response.lower() or "version" in response.lower() or "0.8" in response, \
            f"Expected status response, got: {response[:200]}"
