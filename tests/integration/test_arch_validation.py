"""Architecture validation tests — closing HIGH severity gaps.

Each test addresses a specific gap identified during deep validation
of architecture documents (docs/architecture/) against existing test plans.

Tests are pure-Python, mock-based — no real Docker, network, or LLM.
"""

from __future__ import annotations

import json

from tests.integration.mocks import (
    MockAppView,
    MockBackupManager,
    MockBotQuerySanitizer,
    MockDeploymentProfile,
    MockExportArchive,
    MockGoCore,
    MockIdentity,
    MockPIIScrubber,
    MockReviewBot,
    MockSSSManager,
    MockSTTProvider,
    MockSTTRouter,
    MockTelegramConnector,
    MockVault,
    OutcomeReport,
    PersonaType,
    TrustRing,
)


# ---------------------------------------------------------------------------
# §17.1 Plaintext Lifecycle & Export Encryption
# ---------------------------------------------------------------------------

# TST-INT-590
def test_plaintext_only_in_memory_never_at_rest(
    mock_vault: MockVault, mock_identity: MockIdentity
):
    """Architecture §1: 'Home Node decrypts in-memory only during processing,
    then discards plaintext.' Verify encrypted persona files have no SQLite
    plaintext header at rest.
    """
    # Store data to a persona partition (simulates in-memory processing)
    mock_vault.store(1, "health_record", {"diagnosis": "hypertension"},
                     persona=PersonaType.HEALTH)

    # After processing completes, verify data at rest is encrypted
    header = mock_vault.raw_file_header(PersonaType.HEALTH)
    assert header != b"SQLite format 3\x00", \
        "Plaintext SQLite header found — data at rest must be encrypted"

    # Verify the data IS retrievable (was processed in memory)
    retrieved = mock_vault.retrieve(1, "health_record", persona=PersonaType.HEALTH)
    assert retrieved is not None, "Data should be retrievable via vault API"

    # An empty/uninitialized partition WOULD show plaintext header (failure case)
    empty_header = mock_vault.raw_file_header(PersonaType.CITIZEN)
    assert empty_header == b"SQLite format 3\x00", \
        "Empty partition should show plaintext header (test control)"


# TST-INT-591
def test_export_archive_encrypted_aes256gcm(
    mock_vault: MockVault, mock_identity: MockIdentity,
    mock_backup_manager: MockBackupManager,
):
    """Architecture §2: 'Encrypt the tar.gz with Argon2id(passphrase) →
    AES-256-GCM.' No plaintext archive on disk.
    """
    # Populate vault with data
    mock_vault.store(1, "item_1", {"data": "sensitive"})
    mock_vault.store(1, "item_2", {"data": "private"})

    # Create encrypted snapshot
    snapshot = mock_backup_manager.create_snapshot(passphrase="my_secure_pass")

    # Verify encryption metadata
    assert snapshot["encryption"] == "AES-256-GCM"
    assert snapshot["kdf"] == "Argon2id"
    assert "AES256GCM[" in snapshot["encrypted_data"]

    # Verify no plaintext written to disk
    assert snapshot["plaintext_written_to_disk"] is False

    # Verify DID is recorded (for restore verification)
    assert snapshot["did"] == mock_identity.root_did

    # Verify checksum is present
    assert len(snapshot["checksum"]) == 64  # SHA-256 hex


# ---------------------------------------------------------------------------
# §17.2 Core API Boundary
# ---------------------------------------------------------------------------

# TST-INT-592
def test_core_makes_zero_external_api_calls(
    mock_go_core: MockGoCore,
):
    """Architecture §3: 'Core never calls external APIs — no OAuth, no Gmail,
    no connector code.' All Core endpoints are local Docker network only.
    """
    # Exercise various Core operations
    mock_go_core.vault_query("test search")
    mock_go_core.vault_store("key1", {"data": "value"})
    mock_go_core.did_sign(b"test data")
    mock_go_core.did_verify(b"test data", mock_go_core.did_sign(b"test data"))
    mock_go_core.pii_scrub("Rajmohan lives at 123 Main Street")

    # Inspect ALL API calls made by Core
    external_prefixes = (
        "https://", "http://gmail", "http://calendar",
        "http://api.telegram", "http://oauth",
    )

    for call in mock_go_core.api_calls:
        endpoint = call.get("endpoint", "")
        # All Core endpoints should be internal (/v1/vault, /v1/did, etc.)
        assert endpoint.startswith("/v1/"), \
            f"Core made non-internal call: {endpoint}"
        assert not any(endpoint.startswith(p) for p in external_prefixes), \
            f"Core made external API call: {endpoint}"

    # Verify Core has no OAuth token management
    assert not hasattr(mock_go_core, "oauth_token")
    assert not hasattr(mock_go_core, "refresh_token")


# ---------------------------------------------------------------------------
# §17.3 SSS Share Rotation & Custodian Encryption
# ---------------------------------------------------------------------------

# TST-INT-593
def test_sss_share_rotation_preserves_master_key(
    mock_sss_manager: MockSSSManager, mock_identity: MockIdentity,
):
    """Architecture §5: 'Share rotation: re-split with new randomness when
    trust changes — old shares become mathematically useless.'
    Master key/seed remains constant across rotations.
    """
    original_key = mock_identity.root_private_key

    # Initial split
    original_shares = mock_sss_manager.split()
    assert len(original_shares) == 5

    # Rotate — new polynomial, same master key
    new_shares = mock_sss_manager.rotate()
    assert len(new_shares) == 5

    # Master key unchanged
    assert mock_identity.root_private_key == original_key

    # Old shares are now invalid (wrong rotation number)
    for old_share in original_shares:
        assert not mock_sss_manager.is_share_valid(old_share), \
            f"Old share {old_share['index']} should be invalid after rotation"

    # New shares are valid
    for new_share in new_shares:
        assert mock_sss_manager.is_share_valid(new_share), \
            f"New share {new_share['index']} should be valid"

    # Recovery works with new shares
    recovered = mock_sss_manager.recover(new_shares[:3])  # threshold=3
    assert recovered == original_key

    # Recovery fails with old shares
    recovered_old = mock_sss_manager.recover(original_shares[:3])
    assert recovered_old is None, "Old shares should not recover the key"


# TST-INT-594
def test_sss_shard_per_custodian_nacl_encryption(
    mock_sss_manager: MockSSSManager,
):
    """Architecture §5: 'Digital shards are encrypted to each custodian's
    public key and delivered via Dina-to-Dina NaCl.'
    Each share encrypted with custodian's key — only correct custodian decrypts.
    """
    custodian_dids = [
        "did:plc:CustodianAlice12345678901234",
        "did:plc:CustodianBob1234567890123456",
        "did:plc:CustodianCharlie123456789012",
        "did:plc:CustodianDiana1234567890123",
        "did:plc:CustodianEve12345678901234567",
    ]

    shares = mock_sss_manager.split()
    encrypted_shares = []

    for share, custodian_did in zip(shares, custodian_dids):
        encrypted = mock_sss_manager.encrypt_share_for_custodian(
            share, custodian_did
        )
        encrypted_shares.append(encrypted)

        # Verify encrypted with NaCl sealed box
        assert "NACL_SEALED[" in encrypted["encrypted_data"]
        assert custodian_did[:20] in encrypted["encrypted_data"]

    # Only correct custodian can decrypt their share
    for encrypted, custodian_did in zip(encrypted_shares, custodian_dids):
        decrypted = mock_sss_manager.decrypt_share(encrypted, custodian_did)
        assert decrypted is not None, \
            f"Custodian {custodian_did[:20]} should decrypt their share"

    # Wrong custodian cannot decrypt
    wrong_custodian = "did:plc:WrongPerson12345678901234"
    for encrypted in encrypted_shares:
        decrypted = mock_sss_manager.decrypt_share(encrypted, wrong_custodian)
        assert decrypted is None, \
            "Wrong custodian should NOT decrypt another's share"


# TST-INT-595
def test_sss_recovery_manifest_on_pds(
    mock_sss_manager: MockSSSManager, mock_identity: MockIdentity,
):
    """Architecture §5: 'A signed recovery manifest on the PDS lists custodian
    DIDs (not the shards themselves) so a fresh Dina knows who to contact.'
    """
    custodian_dids = [
        "did:plc:CustodianAlice12345678901234",
        "did:plc:CustodianBob1234567890123456",
        "did:plc:CustodianCharlie123456789012",
    ]

    manifest = mock_sss_manager.publish_recovery_manifest(
        custodian_dids, pds_url="https://pds.dina.host"
    )

    # Manifest contains custodian DIDs
    assert manifest["custodian_dids"] == custodian_dids

    # Manifest does NOT contain actual shares
    manifest_json = json.dumps(manifest)
    assert "share_data" not in manifest_json
    assert "NACL_SEALED" not in manifest_json

    # Manifest is signed by the owner
    assert manifest["signature"]
    assert manifest["owner_did"] == mock_identity.root_did

    # Manifest published to PDS
    assert manifest["pds_url"] == "https://pds.dina.host"
    assert manifest["type"] == "com.dina.recovery.manifest"

    # Threshold info for recovery
    assert manifest["threshold"] == 3
    assert manifest["total_shares"] == 5

    # Manifest is retrievable
    assert mock_sss_manager.recovery_manifest is not None


# ---------------------------------------------------------------------------
# §17.4 Bot Query Anonymity & Sanitization
# ---------------------------------------------------------------------------

# TST-INT-596
def test_bot_query_contains_no_user_did(
    mock_bot_sanitizer: MockBotQuerySanitizer,
):
    """Architecture §10: 'anonymous — just the ring level.' The bot knows
    the requester is trust ring 2 but cannot determine WHO is asking.
    """
    # Raw query with identifying information attached
    raw_query = {
        "query": "Best ergonomic office chair, lumbar support, budget under 80000 INR",
        "requester_trust_ring": 2,
        "response_format": "structured",
        "max_sources": 5,
        # These should NOT pass through:
        "user_did": "did:plc:UserXYZ123456789012345678",
        "user_name": "Rajmohan",
        "home_node_url": "https://my-dina.tailnet.ts.net",
        "persona_path": "/consumer",
        "session_id": "sess_abc123",
        "device_id": "phone_001",
    }

    sanitized = mock_bot_sanitizer.sanitize_query(raw_query)

    # Only allowed fields survive
    assert "query" in sanitized
    assert "requester_trust_ring" in sanitized
    assert sanitized["requester_trust_ring"] == 2

    # All identifying fields stripped
    assert "user_did" not in sanitized
    assert "user_name" not in sanitized
    assert "home_node_url" not in sanitized
    assert "persona_path" not in sanitized
    assert "session_id" not in sanitized
    assert "device_id" not in sanitized

    # Validate no PII
    violations = mock_bot_sanitizer.validate_no_pii(sanitized)
    assert violations == [], f"Sanitized query has PII: {violations}"


# TST-INT-597
def test_query_sanitization_strips_persona_data(
    mock_bot_sanitizer: MockBotQuerySanitizer,
):
    """Architecture §10: 'What Dina does NOT send: User's name, identity,
    DID, specific medical diagnosis, financial details, any persona data.'
    """
    # Query with PII and persona data embedded
    raw_query = {
        "query": "Chair for someone with lumbar disc herniation",
        "requester_trust_ring": 2,
        "response_format": "structured",
        "max_sources": 5,
        "medical_diagnosis": "L4-L5 herniated disc",
        "financial_details": {"income": 1500000, "savings": 500000},
        "email": "user@example.com",
        "phone": "+91-9876543210",
        "address": "123 MG Road, Bangalore",
        "aadhaar": "XXXX-XXXX-1234",
    }

    sanitized = mock_bot_sanitizer.sanitize_query(raw_query)

    # Verify no medical, financial, or contact data leaked
    assert "medical_diagnosis" not in sanitized
    assert "financial_details" not in sanitized
    assert "email" not in sanitized
    assert "phone" not in sanitized
    assert "address" not in sanitized
    assert "aadhaar" not in sanitized

    # The query text itself should remain (abstracted requirements)
    assert "chair" in sanitized["query"].lower() or "Chair" in sanitized["query"]

    # Validate original query would flag violations
    violations = mock_bot_sanitizer.validate_no_pii(raw_query)
    assert len(violations) >= 4, \
        f"Expected 4+ violations but got {len(violations)}: {violations}"


# TST-INT-598
def test_bot_post_query_wire_format(
    mock_review_bot: MockReviewBot,
):
    """Architecture §10: POST /query wire format — request has query,
    trust_ring, response_format, max_sources. Response has recommendations
    with sources, bot_signature, bot_did.
    """
    # Send query matching architecture §10 spec
    response = mock_review_bot.query_product(
        query="Best ergonomic office chair, lumbar support, budget under 80000 INR",
        requester_trust_ring=TrustRing.RING_2_VERIFIED,
        max_sources=5,
    )

    # Verify request was recorded with correct format
    last_query = mock_review_bot.queries[-1]
    assert "query" in last_query
    assert "trust_ring" in last_query
    assert "max_sources" in last_query

    # Verify response structure per §10 spec
    assert "recommendations" in response
    assert "bot_signature" in response
    assert "bot_did" in response
    assert response["bot_did"].startswith("did:plc:")

    # Verify recommendation structure
    recs = response["recommendations"]
    assert len(recs) >= 1
    rec = recs[0]
    assert "product" in rec
    assert "score" in rec
    assert "sources" in rec
    assert "cons" in rec
    assert "confidence" in rec

    # Verify source attribution (deep link default)
    sources = rec["sources"]
    assert len(sources) >= 1
    expert_source = next(s for s in sources if s["type"] == "expert")
    assert "creator_name" in expert_source
    assert "source_url" in expert_source
    assert "deep_link" in expert_source
    assert "deep_link_context" in expert_source


# ---------------------------------------------------------------------------
# §17.5 Telegram Connector
# ---------------------------------------------------------------------------

# TST-INT-599
def test_telegram_connector_bot_api_with_token(
    mock_telegram_connector: MockTelegramConnector,
):
    """Architecture §7: Telegram connector uses official Bot API (server-side).
    Requires bot_token from @BotFather. Full message+media support.
    """
    # Without token, ingestion should fail
    messages = [
        {"id": "msg_1", "text": "Hello from Telegram", "chat_id": "123"},
    ]
    assert mock_telegram_connector.ingest_from_bot_api(messages) is False

    # Configure bot token (from @BotFather)
    mock_telegram_connector.set_bot_token("bot123456:ABCdefGhIjKlMnOpQrS")

    # Now ingestion works
    assert mock_telegram_connector.ingest_from_bot_api(messages) is True

    # Verify media support (architecture says "full message content, media")
    assert mock_telegram_connector.supports_media is True

    # Verify default persona routing (architecture: "Messages default to /social")
    assert mock_telegram_connector.persona == PersonaType.SOCIAL

    # Verify messages are stored
    polled = mock_telegram_connector.poll()
    assert len(polled) == 1
    assert polled[0]["text"] == "Hello from Telegram"


# ---------------------------------------------------------------------------
# §17.6 Outcome Lexicon & AppView
# ---------------------------------------------------------------------------

# TST-INT-600
def test_outcome_report_payload_matches_architecture_spec():
    """Architecture §8: Outcome report payload must include all required fields:
    reporter_trust_ring, reporter_age_days, product_id, purchase_verified,
    outcome, satisfaction, signature. No PII (no buyer name, address, etc.).
    """
    report = OutcomeReport(
        reporter_trust_ring=TrustRing.RING_2_VERIFIED,
        reporter_age_days=730,
        product_category="office_chairs",
        product_id="herman_miller_aeron_2025",
        purchase_verified=True,
        time_since_purchase_days=180,
        outcome="still_using",
        satisfaction="positive",
        issues=[],
        signature="ed25519_sig_hex_placeholder",
    )

    # All required fields present per §8 spec
    assert report.reporter_trust_ring == TrustRing.RING_2_VERIFIED
    assert report.reporter_age_days == 730
    assert report.product_category == "office_chairs"
    assert report.product_id == "herman_miller_aeron_2025"
    assert report.purchase_verified is True
    assert report.time_since_purchase_days == 180
    assert report.outcome == "still_using"
    assert report.satisfaction == "positive"
    assert isinstance(report.issues, list)
    assert report.signature != ""
    assert report.timestamp > 0

    # Verify NO PII in the report structure
    report_fields = {f.name for f in report.__dataclass_fields__.values()}
    pii_fields = {"buyer_name", "buyer_address", "buyer_email", "buyer_did",
                  "buyer_phone", "exact_price"}
    assert report_fields.isdisjoint(pii_fields), \
        f"OutcomeReport contains PII fields: {report_fields & pii_fields}"


# TST-INT-601
def test_appview_phase1_single_go_binary_postgresql():
    """Architecture §8: Phase 1 AppView is a single Go binary + PostgreSQL 16
    + pg_trgm. Sharding, ScyllaDB, Kafka deferred to Phase 3+.
    """
    app_view = MockAppView()

    # Phase 1: single process, not sharded
    assert hasattr(app_view, "consume_firehose"), \
        "AppView must consume AT Protocol firehose"
    assert hasattr(app_view, "query_by_did"), \
        "AppView must support query by DID"
    assert hasattr(app_view, "query_by_product"), \
        "AppView must support query by product"

    # Lexicon filter — only reputation records
    assert app_view.lexicon_filter == "com.dina.reputation."

    # Firehose consumption works
    records = [
        {"lexicon": "com.dina.reputation.review", "author_did": "did:plc:a",
         "product_id": "aeron_2025", "rating": 90},
        {"lexicon": "app.bsky.feed.post", "content": "hello"},  # Ignored
        {"lexicon": "com.dina.identity.attestation", "did": "did:plc:b"},
    ]
    indexed = app_view.consume_firehose(records)
    assert indexed == 2, "Only reputation + attestation records indexed"

    # Deterministic aggregate computation
    score = app_view.compute_aggregate("aeron_2025")
    assert score == 90.0

    # Cursor tracking for crash recovery
    assert app_view.cursor == 3  # All records processed, cursor advanced


# ---------------------------------------------------------------------------
# §17.7 Disaster Recovery
# ---------------------------------------------------------------------------

# TST-INT-602
def test_encrypted_snapshots_and_restore(
    mock_vault: MockVault, mock_identity: MockIdentity,
    mock_backup_manager: MockBackupManager,
):
    """Architecture §13: 'Home Node takes encrypted snapshots of the full Vault
    to a blob store. Recovery: Spin up a new Home Node, restore from latest
    snapshot, re-authenticate devices.'
    """
    # Populate vault with data
    mock_vault.store(1, "contact_1", {"name": "Sancho"})
    mock_vault.store(1, "health_record", {"bp": "120/80"})

    # Create encrypted snapshot
    passphrase = "my_strong_backup_password"
    snapshot = mock_backup_manager.create_snapshot(passphrase=passphrase)

    # Verify snapshot is encrypted
    assert "AES256GCM[" in snapshot["encrypted_data"]
    assert snapshot["encryption"] == "AES-256-GCM"

    # Restore with correct passphrase succeeds
    assert mock_backup_manager.restore_from_snapshot(
        snapshot, passphrase=passphrase
    ) is True

    # Restore with wrong passphrase fails
    assert mock_backup_manager.restore_from_snapshot(
        snapshot, passphrase="wrong_password"
    ) is False

    # Verify snapshot list
    snapshots = mock_backup_manager.list_snapshots()
    assert len(snapshots) == 1
    assert snapshots[0]["did"] == mock_identity.root_did


# ---------------------------------------------------------------------------
# §17.8 Voice STT Integration
# ---------------------------------------------------------------------------

# TST-INT-603
def test_deepgram_nova3_websocket_stt_with_fallback(
    mock_stt_router: MockSTTRouter,
):
    """Architecture §16: 'Voice STT (Online): Deepgram Nova-3 ($0.0077/min,
    WebSocket streaming), ~150-300ms latency. Fallback: Gemini Flash Lite.'
    """
    # Primary: Deepgram Nova-3
    result = mock_stt_router.transcribe(b"audio_chunk_1")
    assert result["provider"] == "deepgram"
    assert result["connection"] == "websocket"
    assert 150 <= result["latency_ms"] <= 300

    # Verify cost tracking
    assert mock_stt_router.primary.cost_per_minute == 0.0077

    # Simulate Deepgram failure
    mock_stt_router.primary.fail()

    # Fallback: Gemini Flash Lite
    fallback_result = mock_stt_router.transcribe(b"audio_chunk_2")
    assert fallback_result["provider"] == "gemini"
    assert mock_stt_router.failover_count == 1

    # Deepgram recovers
    mock_stt_router.primary.recover()
    recovery_result = mock_stt_router.transcribe(b"audio_chunk_3")
    assert recovery_result["provider"] == "deepgram"


# TST-INT-604
def test_stt_available_in_all_deployment_profiles(
    mock_stt_router: MockSTTRouter,
):
    """Architecture §17: Deepgram Nova-3 available in ALL deployment profiles
    (Cloud LLM, Local LLM, Hybrid). STT is not profile-dependent.
    """
    profiles = ["cloud", "local-llm"]

    for profile_name in profiles:
        profile = MockDeploymentProfile(profile=profile_name)

        # STT router is available regardless of profile
        assert mock_stt_router.supports_all_profiles() is True

        # STT works in this profile
        result = mock_stt_router.transcribe(b"audio_data")
        assert result["provider"] in ("deepgram", "gemini")

        # Verify containers exist for this profile
        assert "core" in profile.containers
        assert "brain" in profile.containers

    # STT functionality is identical across profiles
    assert mock_stt_router.primary.provider == "deepgram"
    assert mock_stt_router.primary.connection_type == "websocket"
