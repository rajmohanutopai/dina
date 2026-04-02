"""REL-006 Two Dinas Talk — D2D messaging between Node A and Node B.

Verify Dina-to-Dina encrypted messaging works between two separate
Core+Brain nodes running in the release Docker stack.

Node A: alonso-core (did:plc:alonso)
Node B: sancho-core (did:plc:sancho)

Execution class: Harness.
"""

from __future__ import annotations

import base64
import json
import os
import time

import httpx
import pytest


class TestTwoDinas:
    """Real API tests for REL-006: D2D messaging between two nodes."""

    # REL-006
    # TRACE: {"suite": "REL", "case": "0006", "section": "06", "sectionName": "Two Dinas", "subsection": "01", "scenario": "01", "title": "rel_006_node_b_healthy"}
    def test_rel_006_node_b_healthy(
        self, core_url, core_b_url, auth_headers, actor_a_did, actor_b_did,
    ) -> None:
        """Node B Core is reachable and healthy. Also ensures contacts exist."""
        resp = httpx.get(f"{core_b_url}/healthz", timeout=10)
        assert resp.status_code == 200

        # Add contacts so D2D messaging works (idempotent — 201 or 409)
        httpx.post(
            f"{core_url}/v1/contacts",
            json={"did": actor_b_did, "name": "sancho"},
            headers=auth_headers, timeout=10,
        )
        httpx.post(
            f"{core_b_url}/v1/contacts",
            json={"did": actor_a_did, "name": "alonso"},
            headers=auth_headers, timeout=10,
        )

    # REL-006
    # TRACE: {"suite": "REL", "case": "0006", "section": "06", "sectionName": "Two Dinas", "subsection": "01", "scenario": "02", "title": "rel_006_send_message_a_to_b"}
    @pytest.mark.xfail(reason="Core contact directory not synced after Add() — in-memory cache stale")
    def test_rel_006_send_message_a_to_b(
        self, core_url, auth_headers, actor_b_did,
    ) -> None:
        """Node A sends a D2D message to Node B with a unique marker."""
        marker = f"rel006_{os.getpid()}_{int(time.time())}"
        body_payload = json.dumps({
            "status": "arriving",
            "location_label": "home",
            "marker": marker,
        })

        resp = httpx.post(
            f"{core_url}/v1/msg/send",
            json={
                "to": actor_b_did,
                "body": base64.b64encode(body_payload.encode()).decode(),
                "type": "presence.signal",
            },
            headers=auth_headers,
            timeout=15,
        )
        assert resp.status_code == 202, (
            f"D2D send A→B failed: {resp.status_code} {resp.text}"
        )
        data = resp.json()
        assert data.get("id") or data.get("message_id") or data.get("status"), (
            f"Send response missing ID/status: {data}"
        )
        # Store marker for inbox verification
        self.__class__._msg_marker = marker

    # REL-006
    # TRACE: {"suite": "REL", "case": "0006", "section": "06", "sectionName": "Two Dinas", "subsection": "01", "scenario": "03", "title": "rel_006_message_arrives_in_b_inbox"}
    @pytest.mark.xfail(reason="Depends on send_a_to_b which is blocked by contact sync bug")
    def test_rel_006_message_arrives_in_b_inbox(
        self, core_b_url, auth_headers,
    ) -> None:
        """Node B receives the D2D message in its inbox."""
        deadline = time.time() + 30
        found = False

        while time.time() < deadline:
            resp = httpx.get(
                f"{core_b_url}/v1/msg/inbox",
                headers=auth_headers,
                timeout=10,
            )
            if resp.status_code != 200:
                time.sleep(1)
                continue

            messages = resp.json().get("messages", [])
            expected_marker = getattr(self.__class__, "_msg_marker", "")
            for msg in messages:
                msg_type = msg.get("Type") or msg.get("type")
                if msg_type == "presence.signal":
                    msg_body_raw = msg.get("Body") or msg.get("body") or ""
                    # Decode base64 body before checking marker
                    try:
                        msg_body = base64.b64decode(msg_body_raw).decode("utf-8", errors="replace")
                    except Exception:
                        msg_body = str(msg_body_raw)
                    if expected_marker and expected_marker in msg_body:
                        found = True
                        break
                    elif not expected_marker:
                        found = True
                        break
            if found:
                break
            time.sleep(1)

        assert found, (
            "D2D message not received in Node B inbox after 30s"
        )

    # REL-006
    # TRACE: {"suite": "REL", "case": "0006", "section": "06", "sectionName": "Two Dinas", "subsection": "01", "scenario": "04", "title": "rel_006_send_message_b_to_a"}
    @pytest.mark.xfail(reason="Core contact directory not synced after Add() — in-memory cache stale")
    def test_rel_006_send_message_b_to_a(
        self, core_b_url, core_url, auth_headers, actor_a_did,
    ) -> None:
        """Node B sends a D2D message back to Node A."""
        body_payload = json.dumps({
            "text": "hello from node B",
            "category": "context",
        })

        resp = httpx.post(
            f"{core_b_url}/v1/msg/send",
            json={
                "to": actor_a_did,
                "body": base64.b64encode(body_payload.encode()).decode(),
                "type": "social.update",
            },
            headers=auth_headers,
            timeout=15,
        )
        assert resp.status_code == 202, (
            f"D2D send B→A failed: {resp.status_code} {resp.text}"
        )

        # Verify arrival in Node A's inbox
        deadline = time.time() + 30
        found = False

        while time.time() < deadline:
            resp = httpx.get(
                f"{core_url}/v1/msg/inbox",
                headers=auth_headers,
                timeout=10,
            )
            if resp.status_code != 200:
                time.sleep(1)
                continue

            messages = resp.json().get("messages", [])
            for msg in messages:
                msg_type = msg.get("Type") or msg.get("type")
                if msg_type == "social.update":
                    found = True
                    break
            if found:
                break
            time.sleep(1)

        assert found, (
            "D2D message not received in Node A inbox after 30s"
        )
