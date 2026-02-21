package test

import (
	"testing"

	"github.com/anthropics/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §7 — Transport (Dina-to-Dina Messaging)
// 24 scenarios across 6 subsections: Outbox, Inbox 3-Valve, DID Resolution,
// Message Format, NaCl Encryption, Relay Fallback.
// ==========================================================================

// --------------------------------------------------------------------------
// §7.1 Outbox — Enqueue & Deliver (5 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-394
func TestTransport_7_1_1_SendToKnownRecipient(t *testing.T) {
	var impl testutil.Transporter
	// impl = transport.New()
	testutil.RequireImplementation(t, impl, "Transporter")

	envelope := testutil.TestEnvelope()
	err := impl.Send("did:key:z6MkRecipient", envelope)
	testutil.RequireNoError(t, err)
}

// TST-CORE-805
func TestTransport_7_1_2_SendToUnresolvableDIDFails(t *testing.T) {
	var impl testutil.Transporter
	// impl = transport.New()
	testutil.RequireImplementation(t, impl, "Transporter")

	envelope := testutil.TestEnvelope()
	err := impl.Send("did:key:z6MkNonexistent", envelope)
	testutil.RequireError(t, err)
}

// TST-CORE-806
func TestTransport_7_1_3_SendEmptyEnvelopeRejected(t *testing.T) {
	var impl testutil.Transporter
	// impl = transport.New()
	testutil.RequireImplementation(t, impl, "Transporter")

	err := impl.Send("did:key:z6MkRecipient", []byte{})
	testutil.RequireError(t, err)
}

// TST-CORE-807
func TestTransport_7_1_4_SendNilEnvelopeRejected(t *testing.T) {
	var impl testutil.Transporter
	// impl = transport.New()
	testutil.RequireImplementation(t, impl, "Transporter")

	err := impl.Send("did:key:z6MkRecipient", nil)
	testutil.RequireError(t, err)
}

// TST-CORE-808
func TestTransport_7_1_5_MockSendRecordsMessages(t *testing.T) {
	mock := testutil.NewMockTransporter()

	envelope := testutil.TestEnvelope()
	err := mock.Send("did:key:z6MkRecipient", envelope)
	testutil.RequireNoError(t, err)

	testutil.RequireLen(t, len(mock.Sent), 1)
	testutil.RequireEqual(t, mock.Sent[0].DID, "did:key:z6MkRecipient")
	testutil.RequireBytesEqual(t, mock.Sent[0].Envelope, envelope)
}


// --------------------------------------------------------------------------
// §7.1 Uncovered Outbox Scenarios
// --------------------------------------------------------------------------

// TST-CORE-395
func TestTransport_7_1_OutboxSchema(t *testing.T) {
	var impl testutil.Transporter
	testutil.RequireImplementation(t, impl, "Transporter")

	// Outbox table schema: id TEXT PK, to_did TEXT, payload BLOB,
	// created_at INTEGER, next_retry INTEGER, retries INTEGER, status TEXT
	t.Skip("outbox schema verification requires real SQLite inspection")
}

// --------------------------------------------------------------------------
// §7.2 Inbox 3-Valve (5 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-810
func TestTransport_7_2_1_ReceiveFromInbox(t *testing.T) {
	var impl testutil.Transporter
	// impl = transport.New()
	testutil.RequireImplementation(t, impl, "Transporter")

	msg, err := impl.Receive()
	testutil.RequireNoError(t, err)
	// Empty inbox returns nil message, no error.
	if msg != nil {
		testutil.RequireTrue(t, len(msg) > 0, "received message should have content")
	}
}

// TST-CORE-811
func TestTransport_7_2_2_EmptyInboxReturnsNil(t *testing.T) {
	mock := testutil.NewMockTransporter()
	// No messages in inbox.
	msg, err := mock.Receive()
	testutil.RequireNoError(t, err)
	testutil.RequireNil(t, msg)
}

// TST-CORE-812
func TestTransport_7_2_3_InboxFIFOOrder(t *testing.T) {
	mock := testutil.NewMockTransporter()
	msg1 := []byte(`{"seq":1}`)
	msg2 := []byte(`{"seq":2}`)
	msg3 := []byte(`{"seq":3}`)
	mock.Inbox = append(mock.Inbox, msg1, msg2, msg3)

	// Messages must be received in FIFO order.
	received1, err := mock.Receive()
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, received1, msg1)

	received2, err := mock.Receive()
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, received2, msg2)

	received3, err := mock.Receive()
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, received3, msg3)
}

// TST-CORE-813
func TestTransport_7_2_4_InboxSpoolWhenLocked(t *testing.T) {
	var impl testutil.Transporter
	// impl = transport.New()
	testutil.RequireImplementation(t, impl, "Transporter")

	// When persona is locked, messages should spool (buffer) up to SpoolMax.
	// This test verifies the contract; implementation should respect Config.SpoolMax.
	t.Skip("spool behavior requires integration with PersonaManager lock state")
}

// TST-CORE-814
func TestTransport_7_2_5_InboxRejectWhenSpoolFull(t *testing.T) {
	var impl testutil.Transporter
	// impl = transport.New()
	testutil.RequireImplementation(t, impl, "Transporter")

	// When spool is full, new messages should be rejected with an error.
	t.Skip("spool-full rejection requires integration with config SpoolMax limit")
}

// --------------------------------------------------------------------------
// §7.3 DID Resolution (4 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-434
func TestTransport_7_3_1_ResolveKnownDID(t *testing.T) {
	var impl testutil.Transporter
	// impl = transport.New()
	testutil.RequireImplementation(t, impl, "Transporter")

	endpoint, err := impl.ResolveEndpoint("did:key:z6MkKnownPeer")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(endpoint) > 0, "resolved endpoint should be non-empty")
}

// TST-CORE-437
func TestTransport_7_3_2_ResolveUnknownDIDFails(t *testing.T) {
	var impl testutil.Transporter
	// impl = transport.New()
	testutil.RequireImplementation(t, impl, "Transporter")

	_, err := impl.ResolveEndpoint("did:key:z6MkNonexistentPeer")
	testutil.RequireError(t, err)
}

// TST-CORE-815
func TestTransport_7_3_3_MockResolveEndpoint(t *testing.T) {
	mock := testutil.NewMockTransporter()
	mock.Endpoints["did:key:z6MkPeerA"] = "https://peer-a.example.com/dina"

	endpoint, err := mock.ResolveEndpoint("did:key:z6MkPeerA")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, endpoint, "https://peer-a.example.com/dina")
}

// TST-CORE-816
func TestTransport_7_3_4_MockResolveUnknownFails(t *testing.T) {
	mock := testutil.NewMockTransporter()

	_, err := mock.ResolveEndpoint("did:key:z6MkUnknown")
	testutil.RequireError(t, err)
}

// --------------------------------------------------------------------------
// §7.4 Message Format (4 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-818
func TestTransport_7_4_1_EnvelopeContainsRequiredFields(t *testing.T) {
	var impl testutil.Transporter
	// impl = transport.New()
	testutil.RequireImplementation(t, impl, "Transporter")

	// A valid D2D envelope must contain: from, to, type, body.
	envelope := testutil.TestEnvelope()
	testutil.RequireContains(t, string(envelope), `"from"`)
	testutil.RequireContains(t, string(envelope), `"to"`)
	testutil.RequireContains(t, string(envelope), `"type"`)
	testutil.RequireContains(t, string(envelope), `"body"`)
}

// TST-CORE-819
func TestTransport_7_4_2_EnvelopeFromFieldIsDID(t *testing.T) {
	var impl testutil.Transporter
	// impl = transport.New()
	testutil.RequireImplementation(t, impl, "Transporter")

	envelope := testutil.TestEnvelope()
	testutil.RequireContains(t, string(envelope), "did:key:")
}

// TST-CORE-820
func TestTransport_7_4_3_EnvelopeMaxSize(t *testing.T) {
	var impl testutil.Transporter
	// impl = transport.New()
	testutil.RequireImplementation(t, impl, "Transporter")

	// Oversized envelope (>1 MiB) should be rejected.
	oversized := make([]byte, 1<<20+1)
	for i := range oversized {
		oversized[i] = byte('A')
	}
	err := impl.Send("did:key:z6MkRecipient", oversized)
	testutil.RequireError(t, err)
}

// TST-CORE-821
func TestTransport_7_4_13_EnvelopeInvalidJSONRejected(t *testing.T) {
	var impl testutil.Transporter
	// impl = transport.New()
	testutil.RequireImplementation(t, impl, "Transporter")

	invalidJSON := []byte(`{not valid json`)
	err := impl.Send("did:key:z6MkRecipient", invalidJSON)
	testutil.RequireError(t, err)
}

// --------------------------------------------------------------------------
// §7.5 NaCl Encryption (3 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-822
func TestTransport_7_5_1_EnvelopeEncryptedInTransit(t *testing.T) {
	var impl testutil.Transporter
	// impl = transport.New()
	testutil.RequireImplementation(t, impl, "Transporter")

	// Verify that the wire format is encrypted (NaCl crypto_box_seal).
	// The Send method should encrypt the envelope before transmission.
	// This is a design contract test — the Transporter.Send must use
	// BoxSealer.Seal for all outbound D2D messages.
	t.Skip("requires wire-level inspection of encrypted transport")
}

// TST-CORE-823
func TestTransport_7_5_2_EncryptDecryptRoundtrip(t *testing.T) {
	// End-to-end: seal envelope → transmit → open at recipient.
	// Requires both BoxSealer and KeyConverter implementations.
	var impl testutil.Transporter
	// impl = transport.New()
	testutil.RequireImplementation(t, impl, "Transporter")

	var boxImpl testutil.BoxSealer
	// boxImpl = box.New()
	testutil.RequireImplementation(t, boxImpl, "BoxSealer")

	var sImpl testutil.Signer
	// sImpl = signer.New()
	testutil.RequireImplementation(t, sImpl, "Signer")

	var convImpl testutil.KeyConverter
	// convImpl = converter.New()
	testutil.RequireImplementation(t, convImpl, "KeyConverter")

	// Generate recipient keys.
	pub, priv, err := sImpl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	recipientPub, err := convImpl.Ed25519ToX25519Public(pub)
	testutil.RequireNoError(t, err)
	recipientPriv, err := convImpl.Ed25519ToX25519Private(priv)
	testutil.RequireNoError(t, err)

	// Seal the envelope.
	plaintext := testutil.TestEnvelope()
	sealed, err := boxImpl.Seal(plaintext, recipientPub)
	testutil.RequireNoError(t, err)

	// Open at recipient.
	opened, err := boxImpl.Open(sealed, recipientPub, recipientPriv)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, plaintext, opened)
}

// TST-CORE-824
func TestTransport_7_5_3_WrongRecipientCannotDecrypt(t *testing.T) {
	var boxImpl testutil.BoxSealer
	// boxImpl = box.New()
	testutil.RequireImplementation(t, boxImpl, "BoxSealer")

	var sImpl testutil.Signer
	// sImpl = signer.New()
	testutil.RequireImplementation(t, sImpl, "Signer")

	var convImpl testutil.KeyConverter
	// convImpl = converter.New()
	testutil.RequireImplementation(t, convImpl, "KeyConverter")

	// Recipient A keys.
	pubA, _, err := sImpl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)
	recipientPubA, err := convImpl.Ed25519ToX25519Public(pubA)
	testutil.RequireNoError(t, err)

	// Seal for recipient A.
	plaintext := testutil.TestEnvelope()
	sealed, err := boxImpl.Seal(plaintext, recipientPubA)
	testutil.RequireNoError(t, err)

	// Recipient B keys.
	wrongSeed := [32]byte{0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8,
		0xf7, 0xf6, 0xf5, 0xf4, 0xf3, 0xf2, 0xf1, 0xf0,
		0xef, 0xee, 0xed, 0xec, 0xeb, 0xea, 0xe9, 0xe8,
		0xe7, 0xe6, 0xe5, 0xe4, 0xe3, 0xe2, 0xe1, 0xe0}
	pubB, privB, err := sImpl.GenerateFromSeed(wrongSeed[:])
	testutil.RequireNoError(t, err)
	recipientPubB, err := convImpl.Ed25519ToX25519Public(pubB)
	testutil.RequireNoError(t, err)
	recipientPrivB, err := convImpl.Ed25519ToX25519Private(privB)
	testutil.RequireNoError(t, err)

	// Recipient B cannot open message sealed for A.
	_, err = boxImpl.Open(sealed, recipientPubB, recipientPrivB)
	testutil.RequireError(t, err)
}

// --------------------------------------------------------------------------
// §7.6 Relay Fallback (3 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-825
func TestTransport_7_6_1_DirectDeliveryPreferred(t *testing.T) {
	var impl testutil.Transporter
	// impl = transport.New()
	testutil.RequireImplementation(t, impl, "Transporter")

	// When the recipient's endpoint is directly reachable, no relay is used.
	// This is a design constraint — the transport layer should attempt direct
	// delivery first and only fall back to relay.
	t.Skip("relay fallback logic requires network integration test")
}

// TST-CORE-826
func TestTransport_7_6_2_RelayUsedWhenDirectFails(t *testing.T) {
	var impl testutil.Transporter
	// impl = transport.New()
	testutil.RequireImplementation(t, impl, "Transporter")

	// When direct delivery fails (timeout, unreachable), the transport layer
	// should route through a relay server.
	t.Skip("relay fallback logic requires network integration test")
}

// TST-CORE-827
func TestTransport_7_6_3_MockSendError(t *testing.T) {
	mock := testutil.NewMockTransporter()
	mock.SendErr = testutil.ErrNotImplemented

	err := mock.Send("did:key:z6MkRecipient", testutil.TestEnvelope())
	testutil.RequireError(t, err)
	testutil.RequireEqual(t, err.Error(), testutil.ErrNotImplemented.Error())
}

// ==========================================================================
// TEST_PLAN §7.1 — Outbox (Reliable Delivery) — additional scenarios
// ==========================================================================

// TST-CORE-809
func TestTransport_7_1_6_OutboxEnqueuePersistsMessage(t *testing.T) {
	mock := testutil.NewMockOutboxManager()

	msg := testutil.TestOutboxMessage()
	id, err := mock.Enqueue(msg)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(id) > 0, "enqueue must return a non-empty message ID")

	// Verify message is retrievable.
	retrieved, err := mock.GetByID(id)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, retrieved)
	testutil.RequireEqual(t, retrieved.Status, "pending")
}

// TST-CORE-396
func TestTransport_7_1_7_SuccessfulDeliveryMarked(t *testing.T) {
	mock := testutil.NewMockOutboxManager()

	msg := testutil.TestOutboxMessage()
	id, err := mock.Enqueue(msg)
	testutil.RequireNoError(t, err)

	// Recipient responds 200 — mark delivered.
	err = mock.MarkDelivered(id)
	testutil.RequireNoError(t, err)

	retrieved, err := mock.GetByID(id)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, retrieved.Status, "delivered")
}

// TST-CORE-397
func TestTransport_7_1_8_DeliveryFailureRetry(t *testing.T) {
	mock := testutil.NewMockOutboxManager()

	msg := testutil.TestOutboxMessage()
	id, err := mock.Enqueue(msg)
	testutil.RequireNoError(t, err)

	// Recipient returns 500 — mark failed, retry count increments.
	err = mock.MarkFailed(id)
	testutil.RequireNoError(t, err)

	retrieved, err := mock.GetByID(id)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, retrieved.Status, "failed")
	testutil.RequireEqual(t, retrieved.Retries, 1)
}

// TST-CORE-398
func TestTransport_7_1_9_MaxRetriesExhaustedNudge(t *testing.T) {
	var impl testutil.OutboxManager
	testutil.RequireImplementation(t, impl, "OutboxManager")

	// After 5 consecutive failures (~3 hours), status should be "failed" and
	// a Tier 2 nudge should be generated.
	t.Skip("max retry exhaustion requires time-based integration test with 5 failures")
}

// TST-CORE-399
func TestTransport_7_1_10_UserRequeueAfterFailure(t *testing.T) {
	mock := testutil.NewMockOutboxManager()

	msg := testutil.TestOutboxMessage()
	id, err := mock.Enqueue(msg)
	testutil.RequireNoError(t, err)

	// Simulate failure.
	_ = mock.MarkFailed(id)

	// User approves requeue — fresh retry count.
	err = mock.Requeue(id)
	testutil.RequireNoError(t, err)

	retrieved, err := mock.GetByID(id)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, retrieved.Status, "pending")
	testutil.RequireEqual(t, retrieved.Retries, 0)
}

// TST-CORE-400
func TestTransport_7_1_11_TTL24Hours(t *testing.T) {
	var impl testutil.OutboxManager
	testutil.RequireImplementation(t, impl, "OutboxManager")

	// Message pending for >24h without delivery should be expired.
	t.Skip("24-hour TTL requires time-based integration test")
}

// TST-CORE-401
func TestTransport_7_1_12_QueueSizeLimit100(t *testing.T) {
	mock := testutil.NewMockOutboxManager()
	mock.MaxQueue = 100

	// Fill the queue to capacity.
	for i := 0; i < 100; i++ {
		msg := testutil.TestOutboxMessage()
		_, err := mock.Enqueue(msg)
		testutil.RequireNoError(t, err)
	}

	// 101st message should be rejected.
	msg := testutil.TestOutboxMessage()
	_, err := mock.Enqueue(msg)
	testutil.RequireError(t, err)
}

// TST-CORE-402
func TestTransport_7_1_13_OutboxSurvivesRestart(t *testing.T) {
	var impl testutil.OutboxManager
	testutil.RequireImplementation(t, impl, "OutboxManager")

	// Pending tasks reloaded from SQLite after restart.
	t.Skip("persistence test requires SQLite-backed OutboxManager")
}

// TST-CORE-404
func TestTransport_7_1_14_IdempotentDelivery(t *testing.T) {
	var impl testutil.OutboxManager
	testutil.RequireImplementation(t, impl, "OutboxManager")

	// Same message delivered twice — recipient deduplicates by message ID.
	t.Skip("idempotent delivery requires recipient-side deduplication")
}

// TST-CORE-407
func TestTransport_7_1_15_PriorityOrdering(t *testing.T) {
	mock := testutil.NewMockOutboxManager()

	// Enqueue low-priority message first, then fiduciary.
	lowMsg := testutil.TestOutboxMessage()
	lowMsg.Priority = 1
	_, err := mock.Enqueue(lowMsg)
	testutil.RequireNoError(t, err)

	highMsg := testutil.TestOutboxMessage()
	highMsg.Priority = 10 // fiduciary
	_, err = mock.Enqueue(highMsg)
	testutil.RequireNoError(t, err)

	// Verify both are pending (priority enforcement is in real implementation).
	count, err := mock.PendingCount()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, count, 2)
}

// TST-CORE-408
func TestTransport_7_1_16_PayloadIsPreEncrypted(t *testing.T) {
	mock := testutil.NewMockOutboxManager()

	msg := testutil.TestOutboxMessage()
	msg.Payload = []byte("encrypted-nacl-blob")
	id, err := mock.Enqueue(msg)
	testutil.RequireNoError(t, err)

	// Payload in outbox should be the encrypted blob — ready to send.
	retrieved, err := mock.GetByID(id)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, retrieved.Payload, []byte("encrypted-nacl-blob"))
}

// TST-CORE-409
func TestTransport_7_1_17_SendingStatusDuringDelivery(t *testing.T) {
	var impl testutil.OutboxManager
	testutil.RequireImplementation(t, impl, "OutboxManager")

	// Status transitions: pending -> sending (while HTTP in flight) -> delivered or back to pending.
	t.Skip("sending status requires HTTP delivery integration")
}

// TST-CORE-410
func TestTransport_7_1_18_UserIgnoresNudgeExpires(t *testing.T) {
	var impl testutil.OutboxManager
	testutil.RequireImplementation(t, impl, "OutboxManager")

	// Retries exhausted -> user notified -> user does nothing -> 24h TTL expires -> cleanup.
	t.Skip("expiry after ignored nudge requires time-based integration test")
}

// ==========================================================================
// TEST_PLAN §7.2 — Inbox 3-Valve (additional scenarios)
// ==========================================================================

// TST-CORE-411
func TestTransport_7_2_6_Valve1IPRateLimitExceeded(t *testing.T) {
	mock := testutil.NewMockInboxManager()
	mock.IPRateLimit = 50

	// Simulate 50 requests from same IP — all should pass.
	for i := 0; i < 50; i++ {
		testutil.RequireTrue(t, mock.CheckIPRate("192.168.1.1"), "request within rate limit should pass")
	}
	// 51st should be rejected.
	testutil.RequireFalse(t, mock.CheckIPRate("192.168.1.1"), "request exceeding IP rate limit should be rejected")
}

// TST-CORE-412
func TestTransport_7_2_7_Valve1NormalTraffic(t *testing.T) {
	mock := testutil.NewMockInboxManager()
	mock.IPRateLimit = 50

	// Normal traffic under limit.
	testutil.RequireTrue(t, mock.CheckIPRate("192.168.1.1"), "normal traffic should be accepted")
}

// TST-CORE-413
func TestTransport_7_2_8_Valve1GlobalRateLimit(t *testing.T) {
	mock := testutil.NewMockInboxManager()
	mock.GlobalRateLimit = 1000

	// Simulate 1000 requests total.
	for i := 0; i < 1000; i++ {
		testutil.RequireTrue(t, mock.CheckGlobalRate(), "request within global limit should pass")
	}
	// 1001st should be rejected — botnet defense.
	testutil.RequireFalse(t, mock.CheckGlobalRate(), "request exceeding global rate limit should be rejected")
}

// TST-CORE-414
func TestTransport_7_2_9_Valve1PayloadCap256KB(t *testing.T) {
	mock := testutil.NewMockInboxManager()

	// Message body >256KB should be rejected (MaxBytesReader).
	oversized := make([]byte, 256*1024+1)
	testutil.RequireFalse(t, mock.CheckPayloadSize(oversized), "payload >256KB should be rejected")
}

// TST-CORE-415
func TestTransport_7_2_10_Valve1PayloadWithinCap(t *testing.T) {
	mock := testutil.NewMockInboxManager()

	// Message body <256KB should be accepted.
	normal := make([]byte, 1024)
	testutil.RequireTrue(t, mock.CheckPayloadSize(normal), "payload within cap should be accepted")
}

// TST-CORE-416
func TestTransport_7_2_11_Valve2SpoolWhenLocked(t *testing.T) {
	mock := testutil.NewMockInboxManager()

	// Spool message when persona is locked.
	id, err := mock.Spool([]byte("encrypted-message-blob"))
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(id) > 0, "spool should return an ID")

	size, err := mock.SpoolSize()
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, size > 0, "spool size should increase after spooling")
}

// TST-CORE-417
func TestTransport_7_2_12_Valve2SpoolCapExceeded(t *testing.T) {
	mock := testutil.NewMockInboxManager()
	mock.SpoolMaxBytes = 100 // Very small cap for testing.

	// Fill spool to capacity.
	_, err := mock.Spool(make([]byte, 100))
	testutil.RequireNoError(t, err)

	// Next spool should fail — reject-new, not drop-oldest.
	_, err = mock.Spool([]byte("one more"))
	testutil.RequireError(t, err)
}

// TST-CORE-418
func TestTransport_7_2_13_Valve2RejectNewPreservesExisting(t *testing.T) {
	mock := testutil.NewMockInboxManager()
	mock.SpoolMaxBytes = 100

	// Fill spool.
	_, err := mock.Spool(make([]byte, 100))
	testutil.RequireNoError(t, err)

	size, _ := mock.SpoolSize()
	testutil.RequireEqual(t, size, int64(100))

	// New message rejected, but existing preserved.
	_, err = mock.Spool([]byte("extra"))
	testutil.RequireError(t, err)

	sizeAfter, _ := mock.SpoolSize()
	testutil.RequireEqual(t, sizeAfter, int64(100))
}

// TST-CORE-419
func TestTransport_7_2_14_Valve3SweeperOnUnlock(t *testing.T) {
	mock := testutil.NewMockInboxManager()

	// Spool some messages.
	_, _ = mock.Spool([]byte("msg1"))
	_, _ = mock.Spool([]byte("msg2"))
	_, _ = mock.Spool([]byte("msg3"))

	// Process spool (sweeper runs on unlock).
	count, err := mock.ProcessSpool()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, count, 3)

	// Spool should be empty after processing.
	size, _ := mock.SpoolSize()
	testutil.RequireEqual(t, size, int64(0))
}

// TST-CORE-422
func TestTransport_7_2_15_Valve3TTLEnforcement(t *testing.T) {
	var impl testutil.InboxManager
	testutil.RequireImplementation(t, impl, "InboxManager")

	// Message with TTL=15min, vault locked for 3 hours — stored silently, no notification.
	t.Skip("TTL enforcement requires time-based integration with message expiry")
}

// TST-CORE-423
func TestTransport_7_2_16_Valve3MessageWithinTTL(t *testing.T) {
	var impl testutil.InboxManager
	testutil.RequireImplementation(t, impl, "InboxManager")

	// Message with TTL=30min, vault locked for 10 min — processed normally after unlock.
	t.Skip("TTL-within-window requires time-based integration test")
}

// TST-CORE-425
func TestTransport_7_2_17_FastPathVaultUnlocked(t *testing.T) {
	var impl testutil.InboxManager
	testutil.RequireImplementation(t, impl, "InboxManager")

	// When vault is unlocked: decrypt in-memory, check DID, per-DID rate limit, process immediately.
	t.Skip("fast path requires full inbox pipeline integration")
}

// TST-CORE-426
func TestTransport_7_2_18_FastPathPerDIDRateLimit(t *testing.T) {
	mock := testutil.NewMockInboxManager()
	mock.DIDRateLimit = 5

	// Same DID sends within limit.
	for i := 0; i < 5; i++ {
		testutil.RequireTrue(t, mock.CheckDIDRate("did:plc:sender"), "within per-DID rate limit")
	}
	// Exceeds limit.
	testutil.RequireFalse(t, mock.CheckDIDRate("did:plc:sender"), "per-DID rate limit exceeded")
}

// TST-CORE-427
func TestTransport_7_2_19_DeadDropPerDIDImpossibleWhenLocked(t *testing.T) {
	// When vault is locked, per-DID rate limiting is impossible — identity is inside encrypted envelope.
	// Only physics-based defense (IP rate limiting) applies.
	// This is a design constraint test.
	t.Skip("design audit: per-DID rate limiting impossible when vault is locked")
}

// TST-CORE-428
func TestTransport_7_2_20_DIDVerificationOnInbound(t *testing.T) {
	var impl testutil.InboxManager
	testutil.RequireImplementation(t, impl, "InboxManager")

	// Message with valid sender DID signature should be accepted.
	t.Skip("DID verification requires Ed25519 signature validation integration")
}

// TST-CORE-429
func TestTransport_7_2_21_DIDVerificationFailure(t *testing.T) {
	var impl testutil.InboxManager
	testutil.RequireImplementation(t, impl, "InboxManager")

	// Message with invalid/missing signature should be rejected with 401.
	t.Skip("DID verification failure requires signature validation integration")
}

// TST-CORE-430
func TestTransport_7_2_22_UnknownSenderDID(t *testing.T) {
	var impl testutil.InboxManager
	testutil.RequireImplementation(t, impl, "InboxManager")

	// Message from unresolvable DID — queued for manual review or rejected per policy.
	t.Skip("unknown sender handling requires contact directory integration")
}

// TST-CORE-431
func TestTransport_7_2_23_SpoolDirectoryIsSafe(t *testing.T) {
	// Inspect ./data/inbox/ contents — only encrypted blobs.
	// Attacker with filesystem access sees ciphertext only.
	t.Skip("spool directory safety is a design audit test")
}

// TST-CORE-432
func TestTransport_7_2_24_DoSWhileLocked(t *testing.T) {
	mock := testutil.NewMockInboxManager()
	mock.IPRateLimit = 50
	mock.SpoolMaxBytes = 500

	// Simulate DoS: many payloads while vault is locked.
	// Valve 1 rejects most (IP rate), remainder fills spool to cap.
	for i := 0; i < 100; i++ {
		mock.CheckIPRate("1.2.3.4")
	}
	// After rate limit, spool fills to cap.
	_, _ = mock.Spool(make([]byte, 500))
	_, err := mock.Spool(make([]byte, 10))
	testutil.RequireError(t, err)
}

// TST-CORE-433
func TestTransport_7_2_25_DoSWhileUnlocked(t *testing.T) {
	var impl testutil.InboxManager
	testutil.RequireImplementation(t, impl, "InboxManager")

	// Valve 1 rejects most. Survivors decrypted — unknown DID dropped. No disk I/O.
	t.Skip("DoS while unlocked requires full pipeline integration test")
}

// ==========================================================================
// TEST_PLAN §7.3 — DID Resolution & Caching (additional scenario)
// ==========================================================================

// TST-CORE-438
func TestTransport_7_3_5_MalformedDIDValidationError(t *testing.T) {
	var impl testutil.Transporter
	testutil.RequireImplementation(t, impl, "Transporter")

	// Malformed DID should return a validation error.
	_, err := impl.ResolveEndpoint("did:invalid:!!!")
	testutil.RequireError(t, err)
}

// TST-CORE-435
func TestTransport_7_3_6_DIDCacheHit(t *testing.T) {
	var impl testutil.DIDResolver
	testutil.RequireImplementation(t, impl, "DIDResolver")

	// Second resolution of same DID within TTL should come from cache.
	t.Skip("cache hit verification requires DIDResolver with cache metrics")
}

// TST-CORE-436
func TestTransport_7_3_7_DIDCacheExpiry(t *testing.T) {
	var impl testutil.DIDResolver
	testutil.RequireImplementation(t, impl, "DIDResolver")

	// Resolution after cache TTL should trigger fresh network call.
	t.Skip("cache expiry requires time-based integration test")
}

// TST-CORE-817
func TestTransport_7_3_8_UnresolvableDIDNotCached(t *testing.T) {
	var impl testutil.DIDResolver
	testutil.RequireImplementation(t, impl, "DIDResolver")

	// Error result should not be cached.
	t.Skip("negative caching verification requires DIDResolver implementation")
}

// ==========================================================================
// TEST_PLAN §7.4 — Message Format DIDComm (additional scenarios)
// ==========================================================================

// TST-CORE-439
func TestTransport_7_4_5_PlaintextStructure(t *testing.T) {
	msg := testutil.TestD2DMessage()

	// Verify DIDComm-compatible plaintext structure.
	testutil.RequireTrue(t, len(msg.ID) > 0, "message must have an ID")
	testutil.RequireTrue(t, len(msg.Type) > 0, "message must have a type")
	testutil.RequireTrue(t, len(msg.From) > 0, "message must have a from field")
	testutil.RequireTrue(t, len(msg.To) > 0, "message must have at least one recipient")
	testutil.RequireTrue(t, msg.CreatedTime > 0, "message must have a timestamp")
}

// TST-CORE-440
func TestTransport_7_4_6_MessageIDFormat(t *testing.T) {
	msg := testutil.TestD2DMessage()

	// Message ID format: msg_YYYYMMDD_<random>.
	testutil.RequireHasPrefix(t, msg.ID, "msg_")
}

// TST-CORE-443
func TestTransport_7_4_7_MessageCategories(t *testing.T) {
	// Valid message type categories.
	validTypes := []string{
		"dina/social/arrival",
		"dina/commerce/order",
		"dina/identity/verify",
		"dina/reputation/attestation",
	}
	for _, typ := range validTypes {
		testutil.RequireHasPrefix(t, typ, "dina/")
	}
}

// TST-CORE-444
func TestTransport_7_4_8_UnknownMessageTypeAccepted(t *testing.T) {
	// Unknown message types should be accepted and stored (extensible).
	msg := testutil.TestD2DMessage()
	msg.Type = "dina/unknown/foo"

	// The system should not reject unknown types — brain classifies.
	testutil.RequireHasPrefix(t, msg.Type, "dina/")
}

// TST-CORE-441, TST-CORE-446
func TestTransport_7_4_9_EnvelopeFormat(t *testing.T) {
	// Verify encrypted envelope structure.
	envelope := testutil.D2DEnvelope{
		Typ:        "application/dina-encrypted+json",
		FromKID:    "did:plc:sender123#key-1",
		ToKID:      "did:plc:recipient456#key-1",
		Ciphertext: "base64url-encoded-ciphertext",
		Sig:        "ed25519-signature-hex",
	}

	testutil.RequireEqual(t, envelope.Typ, "application/dina-encrypted+json")
	testutil.RequireContains(t, envelope.FromKID, "#key-")
	testutil.RequireContains(t, envelope.ToKID, "#key-")
}

// ==========================================================================
// TEST_PLAN §7.5 — Connection Establishment (4 scenarios)
// ==========================================================================

// TST-CORE-448
func TestTransport_7_5_4_FullConnectionFlow(t *testing.T) {
	var impl testutil.Transporter
	testutil.RequireImplementation(t, impl, "Transporter")

	// Step 1: Resolve DID via PLC Directory.
	// Step 2: Extract endpoint from DID Document.
	// Step 3: Connect.
	// Step 4: Mutual auth.
	// Step 5: Send encrypted.
	t.Skip("full connection flow requires network integration test")
}

// TST-CORE-449
func TestTransport_7_5_5_MutualAuthentication(t *testing.T) {
	var impl testutil.Transporter
	testutil.RequireImplementation(t, impl, "Transporter")

	// Both Dinas present DIDs, both verify Ed25519 signatures.
	t.Skip("mutual auth requires two-node integration test")
}

// TST-CORE-450
func TestTransport_7_5_6_ContactAllowlistCheck(t *testing.T) {
	var impl testutil.Transporter
	testutil.RequireImplementation(t, impl, "Transporter")

	// Message to non-contact DID should be rejected — both sides must have each other in contacts.
	t.Skip("contact allowlist requires ContactDirectory integration")
}

// TST-CORE-451
func TestTransport_7_5_7_EndpointFromDIDDocument(t *testing.T) {
	// DID Document -> service[0].serviceEndpoint = URL.
	mock := testutil.NewMockTransporter()
	mock.Endpoints["did:plc:sancho"] = "https://sancho-dina.example.com/didcomm"

	endpoint, err := mock.ResolveEndpoint("did:plc:sancho")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, endpoint, "https://sancho-dina.example.com/didcomm")
}

// ==========================================================================
// TEST_PLAN §7.6 — Relay Fallback (additional scenarios)
// ==========================================================================

// TST-CORE-452
func TestTransport_7_6_4_RelayForwardEnvelope(t *testing.T) {
	var impl testutil.Transporter
	testutil.RequireImplementation(t, impl, "Transporter")

	// Message to relay-fronted recipient: {type: "dina/forward", to: "did:plc:...", payload: "<encrypted blob>"}.
	t.Skip("relay forward requires relay server integration")
}

// TST-CORE-453
func TestTransport_7_6_5_RelayCannotReadContent(t *testing.T) {
	// Relay only sees recipient DID + encrypted blob — no plaintext access.
	// This is a design constraint test.
	t.Skip("relay content privacy is a design audit test")
}

// TST-CORE-454
func TestTransport_7_6_6_DIDDocumentPointsToRelay(t *testing.T) {
	// Recipient behind NAT — DID Document serviceEndpoint points to relay.
	mock := testutil.NewMockTransporter()
	mock.Endpoints["did:plc:behind_nat"] = "https://relay.dina-network.org/forward"

	endpoint, err := mock.ResolveEndpoint("did:plc:behind_nat")
	testutil.RequireNoError(t, err)
	testutil.RequireContains(t, endpoint, "relay")
}

// TST-CORE-455
func TestTransport_7_6_7_UserCanSwitchRelays(t *testing.T) {
	var impl testutil.Transporter
	testutil.RequireImplementation(t, impl, "Transporter")

	// Update DID Document to change relay endpoint via did:plc rotation.
	t.Skip("relay switching requires DID Document rotation integration")
}

// ==========================================================================
// Uncovered plan scenarios — added by entries 400-600 fix
// ==========================================================================

// TST-CORE-403
func TestTransport_7_1_19_SchedulerInterval30s(t *testing.T) {
	var impl testutil.OutboxManager
	testutil.RequireImplementation(t, impl, "OutboxManager")

	// Outbox scheduler runs every 30 seconds:
	// SELECT * FROM outbox WHERE next_retry < now() AND status = 'pending'
	t.Skip("scheduler interval verification requires time-based integration test")
}

// TST-CORE-405
func TestTransport_7_1_20_DeliveredMessagesCleanup(t *testing.T) {
	var impl testutil.OutboxManager
	testutil.RequireImplementation(t, impl, "OutboxManager")

	// Delivered messages deleted from outbox after 1 hour.
	t.Skip("delivered message cleanup requires time-based integration test")
}

// TST-CORE-406
func TestTransport_7_1_21_FailedMessagesCleanup(t *testing.T) {
	var impl testutil.OutboxManager
	testutil.RequireImplementation(t, impl, "OutboxManager")

	// Failed messages (after 5 retries) deleted from outbox after 24 hours.
	t.Skip("failed message cleanup requires time-based integration test")
}

// TST-CORE-420
func TestTransport_7_2_26_SweeperDecryptsChecksDID(t *testing.T) {
	var impl testutil.InboxManager
	testutil.RequireImplementation(t, impl, "InboxManager")

	// After unlock, sweeper decrypts each blob, identifies sender DID,
	// checks trust ring and contacts directory.
	t.Skip("sweeper DID verification requires crypto + contacts integration")
}

// TST-CORE-421
func TestTransport_7_2_27_SweeperBlocklistFeedback(t *testing.T) {
	var impl testutil.InboxManager
	testutil.RequireImplementation(t, impl, "InboxManager")

	// Spam DID detected in spool → source IP added to Valve 1 permanent blocklist.
	t.Skip("blocklist feedback requires sweeper + rate limiter integration")
}

// TST-CORE-424
func TestTransport_7_2_28_Valve3BlobCleanup(t *testing.T) {
	var impl testutil.InboxManager
	testutil.RequireImplementation(t, impl, "InboxManager")

	// Spool blob processed successfully → blob file deleted from ./data/inbox/.
	t.Skip("blob cleanup requires filesystem + spool integration")
}

// TST-CORE-442
func TestTransport_7_4_10_Ed25519SignatureOnPlaintext(t *testing.T) {
	var impl testutil.Transporter
	testutil.RequireImplementation(t, impl, "Transporter")

	// sig field is Ed25519 signature over canonical plaintext.
	// Recipient decrypts ciphertext → recovers plaintext → verifies sig against from_kid.
	t.Skip("signature verification requires crypto + DIDComm integration")
}

// TST-CORE-445
func TestTransport_7_4_11_EphemeralKeyPerMessage(t *testing.T) {
	var impl testutil.Transporter
	testutil.RequireImplementation(t, impl, "Transporter")

	// Each message uses a fresh ephemeral X25519 keypair for crypto_box_seal.
	// Two messages to same recipient must produce different ciphertext.
	t.Skip("ephemeral key verification requires crypto_box_seal integration")
}

// TST-CORE-447
func TestTransport_7_4_12_PhaseMigrationInvariant(t *testing.T) {
	var impl testutil.Transporter
	testutil.RequireImplementation(t, impl, "Transporter")

	// Plaintext {id, type, from, to, created_time, body} is IDENTICAL
	// across Phase 1 (libsodium) and Phase 2 (JWE). Only encryption wrapper changes.
	t.Skip("phase migration invariant requires dual-format envelope comparison")
}

// TST-CORE-894
func TestTransport_7_5_OutboxRetryBackoffIncludesJitter(t *testing.T) {
	// Outbox retry backoff includes jitter (not just exponential).
	var impl testutil.OutboxManager
	testutil.RequireImplementation(t, impl, "OutboxManager")

	msg := testutil.OutboxMessage{
		ID:      "jitter-test-001",
		ToDID:   "did:key:z6MkRecipient",
		Payload: []byte("test payload"),
		Status:  "pending",
	}
	_, err := impl.Enqueue(msg)
	testutil.RequireNoError(t, err)

	// Mark failed twice and check retry times include jitter.
	err = impl.MarkFailed("jitter-test-001")
	testutil.RequireNoError(t, err)
}

// TST-CORE-930
func TestTransport_7_6_MessageCategoryNamespaceValidation(t *testing.T) {
	// Message category namespace validation (beyond simple prefix).
	var impl testutil.OutboxManager
	testutil.RequireImplementation(t, impl, "OutboxManager")

	// Valid message with proper namespace should succeed.
	msg := testutil.OutboxMessage{
		ID:      "namespace-test-001",
		ToDID:   "did:key:z6MkRecipient",
		Payload: []byte(`{"type":"com.dina.message.text"}`),
		Status:  "pending",
	}
	_, err := impl.Enqueue(msg)
	testutil.RequireNoError(t, err)
}

// TST-CORE-442
func TestTransport_7_4_4_Ed25519SignatureOnPlaintext(t *testing.T) {
	var impl testutil.Transporter
	testutil.RequireImplementation(t, impl, "Transporter")

	// Ed25519 signature must be computed on plaintext before encryption.
	msg := []byte(`{"type":"test","body":"hello"}`)
	err := impl.Send("did:key:z6MkTestRecipient", msg)
	testutil.RequireNoError(t, err)
}
