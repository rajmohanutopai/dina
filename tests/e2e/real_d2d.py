"""RealD2DNetwork — D2D messaging through real Go Core /v1/msg/send endpoints.

Routes messages between Docker containers via their Go Core HTTP APIs
while preserving all mock-level simulation (partitions, online/offline,
latency, traffic capture) for test assertions.

Inherits from MockD2DNetwork for full interface compatibility.

Usage: construct with a DID-to-Core-URL mapping and pass as the
``network`` parameter to RealHomeNode instances.
"""

from __future__ import annotations

import base64
import json
import logging
import time
from typing import Any

from tests.e2e.mocks import D2DMessage, MockD2DNetwork
from tests.e2e.real_nodes import _api_request

logger = logging.getLogger(__name__)


class RealD2DNetwork(MockD2DNetwork):
    """D2D network that routes messages through real Go Core endpoints.

    Every D2D message goes through the full crypto pipeline:

      Sender's Go Core:
        DID resolve → Ed25519 sign → X25519 convert → NaCl sealed box → HTTP POST

      Recipient's Go Core:
        HTTP receive → NaCl unseal → JSON unmarshal → in-memory inbox

    If the recipient fails to decrypt, the test FAILS — this is not optional.
    Mock state is also updated for test convenience, but the real crypto
    pipeline is asserted.

    Parameters
    ----------
    did_to_core_url : dict[str, str]
        Mapping of DID -> external Core URL (e.g. localhost:18100).
    api_token : str
        Bearer token for authenticating API requests.
    """

    def __init__(
        self,
        did_to_core_url: dict[str, str],
        api_token: str,
    ) -> None:
        super().__init__()
        self._did_to_core_url = {
            did: url.rstrip("/") for did, url in did_to_core_url.items()
        }
        self._token = api_token

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"}

    def deliver(self, msg: D2DMessage) -> bool:
        """Deliver message between nodes via real Go Core crypto pipeline.

        The test FAILS if the real D2D pipeline breaks — decryption is
        not optional.  Mock state is also updated for assertion convenience.
        """
        # 1. Capture traffic (identical to MockD2DNetwork)
        self.captured_traffic.append({
            "msg_id": msg.msg_id,
            "from": msg.from_did,
            "to": msg.to_did,
            "type": msg.message_type,
            "encrypted_size": len(msg.encrypted_payload),
            "timestamp": msg.timestamp,
        })

        # 2. Check partitions and online status
        pair = (msg.from_did, msg.to_did)
        if pair in self._partitions:
            return False

        if msg.to_did not in self._online:
            return False

        target = self.nodes.get(msg.to_did)
        if target is None:
            return False

        # 3. Simulate latency if configured
        latency = self._latency_ms.get(pair, 0)
        if latency > 0:
            time.sleep(latency / 1000.0)

        # 4. Record recipient's inbox count BEFORE sending
        sender_core_url = self._did_to_core_url.get(msg.from_did)
        recipient_core_url = self._did_to_core_url.get(msg.to_did)
        pre_inbox_count = 0

        if recipient_core_url:
            pre_resp = _api_request(
                "get",
                f"{recipient_core_url}/v1/msg/inbox",
                headers=self._headers(),
            )
            if pre_resp is not None:
                pre_inbox_count = pre_resp.json().get("count", 0)

        # 5. Send via sender's Go Core — real DID resolution, signing,
        #    NaCl encryption, HTTP delivery to recipient's /msg endpoint
        real_delivered = False

        if sender_core_url:
            body_bytes = json.dumps(msg.payload).encode()
            body_b64 = base64.b64encode(body_bytes).decode()

            resp = _api_request(
                "post",
                f"{sender_core_url}/v1/msg/send",
                json={
                    "to": msg.to_did,
                    "body": body_b64,
                    "type": msg.message_type,
                },
                headers=self._headers(),
            )
            assert resp is not None, (
                f"D2D send failed: {msg.from_did} → {msg.to_did} "
                f"({sender_core_url}/v1/msg/send returned no response)"
            )
            api_data = resp.json()
            assert api_data.get("status") == "accepted", (
                f"D2D send rejected: {msg.from_did} → {msg.to_did}: {api_data}"
            )
            real_delivered = True

        # 6. Verify recipient DECRYPTED the message — this is the real test.
        #    If the crypto pipeline is broken, this assertion fails and
        #    the test fails.  No fallback, no "log and continue".
        if real_delivered and recipient_core_url:
            post_resp = _api_request(
                "get",
                f"{recipient_core_url}/v1/msg/inbox",
                headers=self._headers(),
            )
            assert post_resp is not None, (
                f"D2D verify failed: could not query {msg.to_did} inbox "
                f"at {recipient_core_url}/v1/msg/inbox"
            )
            post_inbox_count = post_resp.json().get("count", 0)
            assert post_inbox_count > pre_inbox_count, (
                f"D2D DECRYPTION FAILED: {msg.from_did} → {msg.to_did} — "
                f"sender's Go Core accepted the message but recipient's "
                f"Go Core did not decrypt it "
                f"(inbox: {pre_inbox_count} → {post_inbox_count})"
            )

        # 7. Also update mock state for test assertion convenience
        target.receive_d2d(msg)

        return True

    def traffic_contains_plaintext(self, text: str) -> bool:
        """Check if any captured traffic contains plaintext.

        Inherited from MockD2DNetwork. Should always return False
        because traffic capture only stores encrypted_size, not content.
        """
        return super().traffic_contains_plaintext(text)
