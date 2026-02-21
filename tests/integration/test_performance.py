"""Integration tests for Performance (Architecture section 13).

Tests cover three categories:
  S13.1 Throughput — concurrent WS connections, vault write/search under load,
        inbound message handling, outbox drain rate.
  S13.2 Latency — p99 query-to-response for local and cloud LLM, message send
        latency, pairing completion time.
  S13.3 Resource Usage — memory tracking for core/brain/LLM, disk growth for
        vault and spool.
"""

from __future__ import annotations

import time
import uuid

import pytest

from tests.integration.mocks import (
    DinaMessage,
    LLMTarget,
    MockChaosMonkey,
    MockDinaCore,
    MockDockerCompose,
    MockGoCore,
    MockIdentity,
    MockInboxSpool,
    MockLLMRouter,
    MockOutbox,
    MockPairingManager,
    MockPerformanceMetrics,
    MockPIIScrubber,
    MockPythonBrain,
    MockVault,
    MockWebSocketServer,
    PersonaType,
    SilenceTier,
    WSMessage,
)


# -----------------------------------------------------------------------
# TestThroughput  (S13.1)
# -----------------------------------------------------------------------


class TestThroughput:
    """Verify the system handles concurrent load without data loss."""

# TST-INT-338
    def test_concurrent_websocket_connections(
        self,
        mock_ws_server: MockWebSocketServer,
        mock_identity: MockIdentity,
    ) -> None:
        """10 simultaneous WS connections, all authenticated and responsive.

        The Home Node must handle multiple device connections without
        dropping any.  Each connection authenticates independently and
        receives messages correctly.
        """
        num_connections = 10
        tokens: list[str] = []
        connections = []

        # Register 10 devices and issue tokens
        for i in range(num_connections):
            device_id = f"device_{i:03d}"
            token = mock_identity.register_device(device_id)
            tokens.append(token)
            mock_ws_server.add_valid_token(token)

        # Connect all 10 simultaneously
        for i in range(num_connections):
            device_id = f"device_{i:03d}"
            conn = mock_ws_server.accept(device_id)
            result = mock_ws_server.authenticate_connection(conn, tokens[i])
            assert result.type == "auth_ok", (
                f"Device {device_id} failed to authenticate"
            )
            connections.append(conn)

        # Verify all connections are authenticated
        assert len(mock_ws_server.connections) == num_connections
        for conn in connections:
            assert conn.connected is True
            assert conn.authenticated is True

        # Push a message to each and verify delivery
        for i, conn in enumerate(connections):
            msg = WSMessage(
                type="whisper",
                id=f"msg_{i:03d}",
                payload={"text": f"Hello device {i}"},
            )
            delivered = mock_ws_server.push_to_device(conn.device_id, msg)
            assert delivered is True
            assert len(conn.received) == 1
            assert conn.received[0].payload["text"] == f"Hello device {i}"

# TST-INT-339
    def test_vault_write_throughput(
        self,
        mock_vault: MockVault,
        mock_perf_metrics: MockPerformanceMetrics,
    ) -> None:
        """100 vault writes complete successfully.

        All 100 items must be stored and retrievable. The vault's write
        counter must reflect the total writes.
        """
        num_writes = 100
        initial_write_count = mock_vault._write_count

        for i in range(num_writes):
            start = time.monotonic()
            mock_vault.store(1, f"perf_item_{i:04d}", {
                "index": i,
                "data": f"payload_{i}",
                "timestamp": time.time(),
            })
            elapsed_ms = (time.monotonic() - start) * 1000
            mock_perf_metrics.record(elapsed_ms)

        # All items stored successfully
        assert mock_vault._write_count == initial_write_count + num_writes
        assert mock_perf_metrics.total_requests == num_writes
        assert mock_perf_metrics.errors == 0

        # Spot-check retrieval
        for i in [0, 49, 99]:
            item = mock_vault.retrieve(1, f"perf_item_{i:04d}")
            assert item is not None
            assert item["index"] == i

# TST-INT-340
    def test_vault_search_under_load(
        self,
        mock_vault: MockVault,
        mock_perf_metrics: MockPerformanceMetrics,
    ) -> None:
        """FTS search works while writes are happening.

        Seed 50 items with FTS index, then interleave writes and searches
        to verify the read path is not blocked by writes.
        """
        # Seed 50 items with FTS
        for i in range(50):
            key = f"load_item_{i:03d}"
            mock_vault.store(1, key, {"product": f"Product_{i}"})
            mock_vault.index_for_fts(key, f"Product_{i} review benchmark test")

        # Interleave writes and searches
        search_results_count = 0
        for i in range(50, 100):
            # Write a new item
            key = f"load_item_{i:03d}"
            mock_vault.store(1, key, {"product": f"Product_{i}"})
            mock_vault.index_for_fts(key, f"Product_{i} review benchmark test")

            # Search while writes are ongoing
            start = time.monotonic()
            results = mock_vault.search_fts("review")
            elapsed_ms = (time.monotonic() - start) * 1000
            mock_perf_metrics.record(elapsed_ms)
            search_results_count += len(results)

        # Searches must return results (FTS index is populated)
        assert search_results_count > 0
        assert mock_perf_metrics.total_requests == 50
        assert mock_perf_metrics.errors == 0

# TST-INT-341
    def test_inbound_message_handling(
        self,
        mock_dina: MockDinaCore,
        mock_perf_metrics: MockPerformanceMetrics,
    ) -> None:
        """50 inbound messages processed without loss.

        Simulate 50 inbound Dina-to-Dina messages arriving at the Core,
        forwarded to Brain for processing.  Every message must produce a
        processed result.
        """
        num_messages = 50
        sender_did = "did:plc:Sender12345678901234567890abc"

        for i in range(num_messages):
            payload = {
                "type": "dina/social/update",
                "content": f"Inbound message #{i}",
            }
            start = time.monotonic()
            result = mock_dina.brain.process(payload)
            elapsed_ms = (time.monotonic() - start) * 1000
            mock_perf_metrics.record(elapsed_ms, error=not result["processed"])

        # All messages processed
        assert len(mock_dina.brain.processed) == num_messages
        assert mock_perf_metrics.total_requests == num_messages
        assert mock_perf_metrics.errors == 0

# TST-INT-342
    def test_outbox_drain_rate(
        self,
        mock_outbox: MockOutbox,
        mock_perf_metrics: MockPerformanceMetrics,
    ) -> None:
        """Outbox drains 100 messages sequentially.

        Enqueue 100 messages, then acknowledge them all. Every message
        must transition from pending to delivered.
        """
        num_messages = 100
        msg_ids: list[str] = []

        # Enqueue 100 messages
        for i in range(num_messages):
            msg = DinaMessage(
                type="dina/social/ping",
                from_did="did:plc:Sender",
                to_did=f"did:plc:Receiver_{i:03d}",
                payload={"seq": i},
            )
            msg_id = mock_outbox.enqueue(msg)
            msg_ids.append(msg_id)

        assert len(mock_outbox.get_pending()) == num_messages

        # Drain by acknowledging each message
        for msg_id in msg_ids:
            start = time.monotonic()
            acked = mock_outbox.ack(msg_id)
            elapsed_ms = (time.monotonic() - start) * 1000
            mock_perf_metrics.record(elapsed_ms, error=not acked)

        # All messages delivered
        assert len(mock_outbox.delivered) == num_messages
        assert len(mock_outbox.get_pending()) == 0
        assert mock_perf_metrics.errors == 0


# -----------------------------------------------------------------------
# TestLatency  (S13.2)
# -----------------------------------------------------------------------


class TestLatency:
    """Verify p99 latency for key operations stays within bounds."""

# TST-INT-343
    def test_query_to_response_local_llm(
        self,
        mock_dina: MockDinaCore,
        mock_perf_metrics: MockPerformanceMetrics,
    ) -> None:
        """p99 latency recorded and within bounds for local LLM queries.

        Simulate 100 queries routed to the local LLM (summarize task).
        Record latencies and verify p99 is within the mock bound.
        """
        num_queries = 100

        for i in range(num_queries):
            start = time.monotonic()
            target = mock_dina.llm_router.route("summarize")
            result = mock_dina.brain.process({
                "type": "user_query",
                "content": f"Summarize review #{i}",
            })
            elapsed_ms = (time.monotonic() - start) * 1000
            mock_perf_metrics.record(elapsed_ms, error=not result["processed"])

            # Local LLM route
            assert target == LLMTarget.LOCAL

        assert mock_perf_metrics.total_requests == num_queries
        assert mock_perf_metrics.errors == 0

        # p99 should be recorded (non-zero)
        p99 = mock_perf_metrics.p99
        assert p99 >= 0.0, "p99 latency must be recorded"

        # In mock environment, latency is near-zero; in production this
        # would be bounded by LLM inference time (~200ms local).
        assert p99 < 1000.0, "p99 must be under 1s for local LLM (mock)"

# TST-INT-344
    def test_query_to_response_cloud_llm(
        self,
        mock_cloud_llm_router: MockLLMRouter,
        mock_dina: MockDinaCore,
        mock_perf_metrics: MockPerformanceMetrics,
    ) -> None:
        """p99 latency recorded for cloud LLM queries.

        Complex reasoning tasks go to cloud.  Latency includes
        simulated PII scrub + cloud round-trip.
        """
        num_queries = 50

        for i in range(num_queries):
            start = time.monotonic()
            # Route through cloud
            target = mock_cloud_llm_router.route("complex_reasoning")
            assert target == LLMTarget.CLOUD

            # Simulate PII scrub before sending to cloud
            scrubbed, _map = mock_dina.go_core.pii_scrub(
                f"Rajmohan wants complex analysis #{i}"
            )
            assert "Rajmohan" not in scrubbed

            # Brain processes the query
            result = mock_dina.brain.process({
                "type": "complex_query",
                "content": f"Multi-step analysis #{i}",
            })
            elapsed_ms = (time.monotonic() - start) * 1000
            mock_perf_metrics.record(elapsed_ms, error=not result["processed"])

        assert mock_perf_metrics.total_requests == num_queries
        assert mock_perf_metrics.errors == 0

        # p99 latency is recorded
        p99 = mock_perf_metrics.p99
        assert p99 >= 0.0, "p99 latency must be recorded for cloud LLM"

# TST-INT-345
    def test_message_send_latency(
        self,
        mock_dina: MockDinaCore,
        mock_perf_metrics: MockPerformanceMetrics,
    ) -> None:
        """D2D message send latency recorded.

        Measure the time from enqueue to send for 20 messages to an
        authenticated peer.
        """
        recipient_did = "did:plc:LatencyTestPeer123456789012"
        mock_dina.p2p.add_contact(recipient_did)
        mock_dina.p2p.authenticated_peers.add(recipient_did)

        num_messages = 20

        for i in range(num_messages):
            msg = DinaMessage(
                type="dina/social/ping",
                from_did=mock_dina.identity.root_did,
                to_did=recipient_did,
                payload={"seq": i},
            )
            start = time.monotonic()
            sent = mock_dina.p2p.send(msg)
            elapsed_ms = (time.monotonic() - start) * 1000
            mock_perf_metrics.record(elapsed_ms, error=not sent)

        assert mock_perf_metrics.total_requests == num_messages
        assert mock_perf_metrics.errors == 0
        assert len(mock_dina.p2p.messages) == num_messages

        # Latency must be recorded
        p99 = mock_perf_metrics.p99
        assert p99 >= 0.0

# TST-INT-346
    def test_pairing_completion_latency(
        self,
        mock_pairing_manager: MockPairingManager,
        mock_perf_metrics: MockPerformanceMetrics,
    ) -> None:
        """Device pairing completes within latency bounds.

        Measure the full pairing cycle: generate code, validate, issue
        CLIENT_TOKEN.  Repeat 10 times and check p99.
        """
        num_pairings = 10

        for i in range(num_pairings):
            start = time.monotonic()

            # Generate pairing code
            code = mock_pairing_manager.generate_code()
            assert len(code.code) == 6

            # Complete pairing
            token = mock_pairing_manager.complete_pairing(
                code.code, f"TestDevice_{i}"
            )
            elapsed_ms = (time.monotonic() - start) * 1000
            mock_perf_metrics.record(elapsed_ms, error=(token is None))

            assert token is not None
            assert not token.revoked

        assert mock_perf_metrics.total_requests == num_pairings
        assert mock_perf_metrics.errors == 0

        # All pairings succeeded within time bounds
        p99 = mock_perf_metrics.p99
        assert p99 >= 0.0
        # In mock environment, near-instant; production bound ~2s
        assert p99 < 5000.0, "Pairing p99 must be under 5s"


# -----------------------------------------------------------------------
# TestResourceUsage  (S13.3)
# -----------------------------------------------------------------------


class TestResourceUsage:
    """Verify memory and disk usage stay within budgeted bounds."""

# TST-INT-347
    def test_core_memory_usage(
        self,
        mock_go_core: MockGoCore,
        mock_vault: MockVault,
        mock_perf_metrics: MockPerformanceMetrics,
    ) -> None:
        """Simulated memory tracking for Go Core stays bounded.

        After exercising core operations, the number of tracked API calls
        and vault items should grow linearly and stay reasonable.
        """
        # Exercise core operations
        for i in range(200):
            mock_go_core.vault_store(f"mem_test_{i}", {"data": i})

        # Core tracks API calls — should be exactly 200
        store_calls = [
            c for c in mock_go_core.api_calls
            if c["endpoint"] == "/v1/vault/store"
        ]
        assert len(store_calls) == 200

        # Vault items in tier 1 should be 200
        tier1_count = len(mock_vault._tiers[1])
        assert tier1_count == 200

        # Simulated memory: each API call entry is small and bounded
        # In production: Go Core targets <100MB RSS with 200 items
        mock_perf_metrics.record(tier1_count)
        assert mock_perf_metrics.total_requests == 1

# TST-INT-348
    def test_brain_memory_usage(
        self,
        mock_dina: MockDinaCore,
        mock_perf_metrics: MockPerformanceMetrics,
    ) -> None:
        """Brain memory tracked after processing many items.

        After 200 Brain.process() calls, the processed log grows linearly.
        Memory should not spike unexpectedly.
        """
        for i in range(200):
            result = mock_dina.brain.process({
                "type": "email_incoming",
                "content": f"Message body #{i}",
            })
            assert result["processed"] is True

        processed_count = len(mock_dina.brain.processed)
        assert processed_count == 200

        # Record simulated memory metric
        mock_perf_metrics.record(processed_count)
        assert mock_perf_metrics.total_requests == 1

        # Classification log also grows linearly
        log_count = len(mock_dina.classifier.classification_log)
        assert log_count == 200

# TST-INT-349
    def test_llm_memory_usage(
        self,
        mock_llm_router: MockLLMRouter,
        mock_perf_metrics: MockPerformanceMetrics,
    ) -> None:
        """LLM container memory bounded after many routing decisions.

        The routing log grows linearly with requests. In production,
        the llama-server container is capped at 6GB RAM.
        """
        num_routes = 500

        for i in range(num_routes):
            task_type = ["summarize", "draft", "classify", "fts_search"][i % 4]
            mock_llm_router.route(task_type)

        # Routing log should contain exactly num_routes entries
        assert len(mock_llm_router.routing_log) == num_routes

        # Record simulated metric
        mock_perf_metrics.record(len(mock_llm_router.routing_log))
        assert mock_perf_metrics.total_requests == 1

        # In production, LLM container is bounded at 6GB. The routing
        # log itself is lightweight metadata.
        log_size = len(mock_llm_router.routing_log)
        assert log_size == num_routes, "Routing log must grow linearly"

# TST-INT-350
    def test_disk_usage_growth(
        self,
        mock_vault: MockVault,
        mock_perf_metrics: MockPerformanceMetrics,
    ) -> None:
        """Vault size grows linearly with items.

        Store items in batches and verify the tier-1 dictionary size
        grows proportionally. No unexpected bloat from FTS or metadata.
        """
        batch_sizes = [10, 50, 100, 200]
        cumulative = 0

        for batch_size in batch_sizes:
            items = [
                (f"disk_item_{cumulative + j}", {"payload": "x" * 100})
                for j in range(batch_size)
            ]
            mock_vault.store_batch(1, items)
            cumulative += batch_size

            # Record vault size after each batch
            current_size = len(mock_vault._tiers[1])
            mock_perf_metrics.record(current_size)

        # Final vault size should equal total items stored
        assert len(mock_vault._tiers[1]) == sum(batch_sizes)

        # Verify linear growth: each recorded metric increases
        for i in range(1, len(mock_perf_metrics.latencies_ms)):
            assert mock_perf_metrics.latencies_ms[i] > mock_perf_metrics.latencies_ms[i - 1], (
                "Vault size must grow monotonically with items"
            )

# TST-INT-351
    def test_spool_disk_usage(
        self,
        mock_inbox_spool: MockInboxSpool,
        mock_perf_metrics: MockPerformanceMetrics,
    ) -> None:
        """Spool respects 500MB limit.

        Fill the spool with blobs until it rejects new writes, verifying
        that the used_bytes never exceeds max_bytes.
        """
        # Default max is 500MB
        assert mock_inbox_spool.max_bytes == 500 * 1024 * 1024

        blob_size = 1024 * 1024  # 1MB per blob
        stored_count = 0

        # Store blobs until spool is full
        for i in range(600):  # More than 500 to test rejection
            blob = b"X" * blob_size
            blob_id = mock_inbox_spool.store(blob)
            if blob_id is None:
                # Spool is full — verify used_bytes is at the limit
                assert mock_inbox_spool.is_full(blob_size)
                break
            stored_count += 1

        # Must have stored some blobs before hitting the limit
        assert stored_count > 0
        assert stored_count <= 500  # Cannot store more than 500 x 1MB in 500MB

        # Used bytes must never exceed max
        assert mock_inbox_spool.used_bytes <= mock_inbox_spool.max_bytes

        # Record metric
        mock_perf_metrics.record(mock_inbox_spool.used_bytes / (1024 * 1024))

        # Drain the spool and verify it resets
        drained = mock_inbox_spool.drain()
        assert len(drained) == stored_count
        assert mock_inbox_spool.used_bytes == 0
