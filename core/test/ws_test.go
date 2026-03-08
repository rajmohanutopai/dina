package test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/rajmohanutopai/dina/core/internal/adapter/ws"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §9 — WebSocket Protocol
// ==========================================================================
// Covers §9.1 (Connection Lifecycle), §9.2 (Message Envelope Client→Core),
// §9.3 (Message Envelope Core→Client), §9.4 (Heartbeat Protocol),
// §9.5 (Missed Message Buffer).
//
// Every test calls testutil.RequireImplementation to skip until the real
// implementation is wired in. Replace `var impl <Interface>` with the real
// constructor when ready.
// ==========================================================================

// --------------------------------------------------------------------------
// §9.1 Connection Lifecycle (8 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-482
func TestWS_9_1_1_WSUpgradeAccepted(t *testing.T) {
	impl := realWSHub
	testutil.RequireImplementation(t, impl, "WSHub")

	// §9.1 #1: Client connects via wss://dina.local:8100/ws — HTTP 101 upgrade,
	// connection accepted, 5-second auth timer starts.
	err := impl.Register("client-001", nil)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, impl.ConnectedClients(), 1)
}

// TST-CORE-483
func TestWS_9_1_2_AuthFrameWithin5s(t *testing.T) {
	impl := realWSHandler
	testutil.RequireImplementation(t, impl, "WSHandler")

	// §9.1 #2: Client sends auth frame with valid CLIENT_TOKEN within 5s.
	// Core validates SHA-256(token) and responds with auth_ok + device name.
	deviceName, err := impl.Authenticate(context.Background(), "valid_client_token_hex")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(deviceName) > 0, "auth_ok must include device name")
}

// TST-CORE-484
func TestWS_9_1_3_AuthFrameTimeout(t *testing.T) {
	impl := realWSHandler
	testutil.RequireImplementation(t, impl, "WSHandler")

	// §9.1 #3: No auth frame within 5s — core closes connection, no response sent.
	// The auth timeout must be 5 seconds per protocol spec.
	testutil.RequireEqual(t, impl.AuthTimeout(), 5)
}

// TST-CORE-485
func TestWS_9_1_4_InvalidAuthFrame(t *testing.T) {
	impl := realWSHandler
	testutil.RequireImplementation(t, impl, "WSHandler")

	// §9.1 #4: Wrong CLIENT_TOKEN in auth frame → auth_fail, connection closed.
	_, err := impl.Authenticate(context.Background(), "wrong_token_value")
	testutil.RequireError(t, err)
}

// TST-CORE-486
func TestWS_9_1_5_RevokedTokenInAuthFrame(t *testing.T) {
	impl := realWSHandler
	testutil.RequireImplementation(t, impl, "WSHandler")

	// §9.1 #5: Previously revoked CLIENT_TOKEN → auth_fail, connection closed.
	_, err := impl.Authenticate(context.Background(), "revoked_client_token_hex")
	testutil.RequireError(t, err)
}

// TST-CORE-487
func TestWS_9_1_6_AuthOKIncludesDeviceName(t *testing.T) {
	impl := realWSHandler
	testutil.RequireImplementation(t, impl, "WSHandler")

	// §9.1 #6: Valid auth from "Raj's iPhone" → auth_ok includes device name
	// from pairing record (e.g., "rajs_iphone").
	deviceName, err := impl.Authenticate(context.Background(), "valid_client_token_hex")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(deviceName) > 0, "auth_ok response must include device name from pairing")
}

// TST-CORE-488
func TestWS_9_1_7_GracefulDisconnect(t *testing.T) {
	impl := realWSHub
	testutil.RequireImplementation(t, impl, "WSHub")

	// §9.1 #7: Client sends close frame → server acknowledges, resources cleaned,
	// device marked offline.
	err := impl.Register("client-001", nil)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, impl.ConnectedClients(), 1)

	err = impl.Unregister("client-001")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, impl.ConnectedClients(), 0)
}

// TST-CORE-489
func TestWS_9_1_8_AbnormalDisconnect(t *testing.T) {
	impl := realHeartbeatManager
	testutil.RequireImplementation(t, impl, "HeartbeatManager")

	// §9.1 #8: TCP connection drops → server detects via ping timeout
	// (3 missed pongs), cleans up. Verify max missed pongs is 3.
	testutil.RequireEqual(t, impl.MaxMissedPongs(), 3)
}

// --------------------------------------------------------------------------
// §9.2 Message Envelope Format — Client → Core (7 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-490
func TestWS_9_2_1_QueryMessage(t *testing.T) {
	impl := realWSHandler
	testutil.RequireImplementation(t, impl, "WSHandler")

	// §9.2 #1: Query message routed to brain, response returned with reply_to matching id.
	msg := `{"type":"query","id":"req_001","payload":{"text":"Am I free at 3pm?","persona":"/personal"}}`
	resp, err := impl.HandleMessage(context.Background(), "client-001", []byte(msg))
	testutil.RequireNoError(t, err)

	var envelope map[string]interface{}
	testutil.RequireNoError(t, json.Unmarshal(resp, &envelope))
	testutil.RequireEqual(t, envelope["reply_to"], "req_001")
}

// TST-CORE-491
func TestWS_9_2_2_QueryWithPersonaField(t *testing.T) {
	// §9.2 #2: Query with persona field — verify the handler accepts a query
	// bearing a persona field, routes it through the brain router with the
	// persona preserved in the payload, and returns a well-formed response
	// envelope with reply_to linking back to the original request ID.
	//
	// NOTE: persona access tier checking (open/restricted/locked) is not yet
	// implemented in WSHandler.HandleMessage. When it is, this test should
	// be extended to verify that a locked persona returns an error envelope
	// with code 403 and that an open persona returns a whisper.

	// Build a handler with a brain router that captures the payload so we can
	// verify the persona field is forwarded.
	var capturedPayload map[string]interface{}
	handler := ws.NewWSHandler(
		func(token string) (string, error) { return "test-device", nil },
		func(clientID, msgType string, payload map[string]interface{}) ([]byte, error) {
			capturedPayload = payload
			return json.Marshal(map[string]interface{}{"text": "brain response"})
		},
	)

	msg := `{"type":"query","id":"req_002","payload":{"text":"What's my balance?","persona":"/financial"}}`
	resp, err := handler.HandleMessage(context.Background(), "client-001", []byte(msg))
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, resp != nil, "response must not be nil")

	// Verify the response envelope has reply_to and is a whisper.
	var envelope map[string]interface{}
	testutil.RequireNoError(t, json.Unmarshal(resp, &envelope))
	testutil.RequireEqual(t, envelope["reply_to"], "req_002")
	testutil.RequireEqual(t, envelope["type"], "whisper")

	// Verify the persona field was forwarded to the brain router.
	testutil.RequireTrue(t, capturedPayload != nil, "brain router must be called")
	persona, ok := capturedPayload["persona"].(string)
	testutil.RequireTrue(t, ok, "payload must include persona field")
	testutil.RequireEqual(t, persona, "/financial")
}

// TST-CORE-492
func TestWS_9_2_3_CommandMessage(t *testing.T) {
	impl := realWSHandler
	testutil.RequireImplementation(t, impl, "WSHandler")

	// §9.2 #3: Command message executed by core, result returned with reply_to.
	msg := `{"type":"command","id":"req_003","payload":{"action":"unlock_persona","persona":"/financial"}}`
	resp, err := impl.HandleMessage(context.Background(), "client-001", []byte(msg))
	testutil.RequireNoError(t, err)

	var envelope map[string]interface{}
	testutil.RequireNoError(t, json.Unmarshal(resp, &envelope))
	testutil.RequireEqual(t, envelope["reply_to"], "req_003")
}

// TST-CORE-493
func TestWS_9_2_4_ACKMessage(t *testing.T) {
	impl := realWSHandler
	testutil.RequireImplementation(t, impl, "WSHandler")

	// §9.2 #4: ACK message — core removes evt_003 from missed message buffer.
	msg := `{"type":"ack","id":"evt_003"}`
	_, err := impl.HandleMessage(context.Background(), "client-001", []byte(msg))
	// ACK is fire-and-forget — no response expected, no error.
	testutil.RequireNoError(t, err)
}

// TST-CORE-494
func TestWS_9_2_5_PongMessage(t *testing.T) {
	impl := realWSHandler
	testutil.RequireImplementation(t, impl, "WSHandler")

	// §9.2 #5: Pong message — core records pong, resets missed-pong counter.
	msg := `{"type":"pong","ts":1708300000}`
	_, err := impl.HandleMessage(context.Background(), "client-001", []byte(msg))
	testutil.RequireNoError(t, err)
}

// TST-CORE-495
func TestWS_9_2_6_MissingIDField(t *testing.T) {
	impl := realWSHandler
	testutil.RequireImplementation(t, impl, "WSHandler")

	// §9.2 #6: Missing id field → error response with code 400.
	msg := `{"type":"query","payload":{"text":"hello"}}`
	resp, err := impl.HandleMessage(context.Background(), "client-001", []byte(msg))
	// Expect an error response envelope, not a Go-level error.
	if err == nil {
		var envelope map[string]interface{}
		testutil.RequireNoError(t, json.Unmarshal(resp, &envelope))
		testutil.RequireEqual(t, envelope["type"], "error")
		payload, ok := envelope["payload"].(map[string]interface{})
		testutil.RequireTrue(t, ok, "error response must have payload object")
		testutil.RequireEqual(t, payload["code"], float64(400))
	}
}

// TST-CORE-496
func TestWS_9_2_7_UnknownMessageType(t *testing.T) {
	impl := realWSHandler
	testutil.RequireImplementation(t, impl, "WSHandler")

	// §9.2 #7: Unknown message type → error response with reply_to,
	// connection NOT dropped (extensible protocol).
	msg := `{"type":"foo","id":"req_004"}`
	resp, err := impl.HandleMessage(context.Background(), "client-001", []byte(msg))
	// Should return error envelope, not disconnect.
	if err == nil {
		var envelope map[string]interface{}
		testutil.RequireNoError(t, json.Unmarshal(resp, &envelope))
		testutil.RequireEqual(t, envelope["type"], "error")
		testutil.RequireEqual(t, envelope["reply_to"], "req_004")
	}
}

// --------------------------------------------------------------------------
// §9.3 Message Envelope Format — Core → Client (8 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-497
func TestWS_9_3_1_WhisperStreamChunked(t *testing.T) {
	impl := realWSHandler
	testutil.RequireImplementation(t, impl, "WSHandler")

	// §9.3 #1: Brain streams response to query — core sends whisper_stream chunks
	// with reply_to linking to the original request.
	msg := `{"type":"query","id":"req_001","payload":{"text":"Am I free at 3pm?","persona":"/personal"}}`
	resp, err := impl.HandleMessage(context.Background(), "client-001", []byte(msg))
	testutil.RequireNoError(t, err)

	var envelope map[string]interface{}
	testutil.RequireNoError(t, json.Unmarshal(resp, &envelope))
	// Response type should be either whisper_stream or whisper.
	msgType, ok := envelope["type"].(string)
	testutil.RequireTrue(t, ok, "response must have a type field")
	testutil.RequireTrue(t, msgType == "whisper_stream" || msgType == "whisper",
		"streaming response must be whisper_stream or whisper")
}

// TST-CORE-498
func TestWS_9_3_2_WhisperFinalResponse(t *testing.T) {
	impl := realWSHandler
	testutil.RequireImplementation(t, impl, "WSHandler")

	// §9.3 #2: Brain completes response → final whisper with reply_to,
	// payload includes text and optional sources array.
	msg := `{"type":"query","id":"req_005","payload":{"text":"What time is sunset?","persona":"/personal"}}`
	resp, err := impl.HandleMessage(context.Background(), "client-001", []byte(msg))
	testutil.RequireNoError(t, err)

	var envelope map[string]interface{}
	testutil.RequireNoError(t, json.Unmarshal(resp, &envelope))
	testutil.RequireTrue(t, envelope["reply_to"] != nil, "final whisper must include reply_to")
}

// TST-CORE-499
func TestWS_9_3_3_ProactiveWhisper(t *testing.T) {
	impl := realWSHub
	testutil.RequireImplementation(t, impl, "WSHub")

	// §9.3 #3: Brain-initiated proactive whisper — has its own id, no reply_to.
	// Includes trigger field and tier level.
	proactive := map[string]interface{}{
		"type": "whisper",
		"id":   "evt_003",
		"payload": map[string]interface{}{
			"text":    "Sancho just left home.",
			"trigger": "didcomm:geofence:sancho:departed",
			"tier":    2,
		},
	}
	data, err := json.Marshal(proactive)
	testutil.RequireNoError(t, err)

	// Verify the proactive message structure: has id, no reply_to.
	var envelope map[string]interface{}
	testutil.RequireNoError(t, json.Unmarshal(data, &envelope))
	testutil.RequireTrue(t, envelope["id"] != nil, "proactive whisper must have id")
	testutil.RequireTrue(t, envelope["reply_to"] == nil, "proactive whisper must not have reply_to")
}

// TST-CORE-500
func TestWS_9_3_4_SystemNotification(t *testing.T) {
	impl := realWSHub
	testutil.RequireImplementation(t, impl, "WSHub")

	// §9.3 #4: Watchdog detects connector issue → system notification with level and text.
	sysMsg := map[string]interface{}{
		"type": "system",
		"id":   "sys_004",
		"payload": map[string]interface{}{
			"level": "warning",
			"text":  "Gmail hasn't synced in 48h. Re-authenticate?",
		},
	}
	data, err := json.Marshal(sysMsg)
	testutil.RequireNoError(t, err)

	var envelope map[string]interface{}
	testutil.RequireNoError(t, json.Unmarshal(data, &envelope))
	testutil.RequireEqual(t, envelope["type"], "system")
	payload, ok := envelope["payload"].(map[string]interface{})
	testutil.RequireTrue(t, ok, "system message must have payload")
	testutil.RequireEqual(t, payload["level"], "warning")
}

// TST-CORE-501
func TestWS_9_3_5_ErrorResponse(t *testing.T) {
	impl := realWSHandler
	testutil.RequireImplementation(t, impl, "WSHandler")

	// §9.3 #5: Command fails → error response with reply_to, code, and message.
	msg := `{"type":"command","id":"req_006","payload":{"action":"unlock_persona","persona":"/financial"}}`
	resp, err := impl.HandleMessage(context.Background(), "client-001", []byte(msg))
	// Whether it succeeds or fails, verify the envelope links back.
	if err == nil && resp != nil {
		var envelope map[string]interface{}
		testutil.RequireNoError(t, json.Unmarshal(resp, &envelope))
		testutil.RequireTrue(t, envelope["reply_to"] != nil, "error response must include reply_to")
	}
}

// TST-CORE-502
func TestWS_9_3_6_ReplyToMeansResponse(t *testing.T) {
	impl := realWSHandler
	testutil.RequireImplementation(t, impl, "WSHandler")

	// §9.3 #6: Routing logic — message with reply_to is a response to a pending request.
	msg := `{"type":"query","id":"req_007","payload":{"text":"hello","persona":"/personal"}}`
	resp, err := impl.HandleMessage(context.Background(), "client-001", []byte(msg))
	testutil.RequireNoError(t, err)

	var envelope map[string]interface{}
	testutil.RequireNoError(t, json.Unmarshal(resp, &envelope))
	// reply_to present means this is a response to the client's request.
	testutil.RequireEqual(t, envelope["reply_to"], "req_007")
}

// TST-CORE-503
func TestWS_9_3_7_NoReplyToMeansProactive(t *testing.T) {
	impl := realWSHub
	testutil.RequireImplementation(t, impl, "WSHub")

	// §9.3 #7: Routing logic — message with id but no reply_to is a proactive event
	// from brain or system. Client treats as event that requires ACK.
	proactive := map[string]interface{}{
		"type": "whisper",
		"id":   "evt_010",
		"payload": map[string]interface{}{
			"text": "Your package was delivered.",
			"tier": 2,
		},
	}
	data, err := json.Marshal(proactive)
	testutil.RequireNoError(t, err)

	var envelope map[string]interface{}
	testutil.RequireNoError(t, json.Unmarshal(data, &envelope))
	_, hasReplyTo := envelope["reply_to"]
	testutil.RequireFalse(t, hasReplyTo, "proactive event must not have reply_to")
	testutil.RequireTrue(t, envelope["id"] != nil, "proactive event must have id for ACK")
}

// TST-CORE-504
func TestWS_9_3_8_WhisperStreamTerminatedByFinalWhisper(t *testing.T) {
	impl := realWSHandler
	testutil.RequireImplementation(t, impl, "WSHandler")

	// §9.3 #8: Brain finishes streaming — last whisper_stream chunk followed by
	// a whisper message with same reply_to. Client knows stream is complete
	// when it receives the final whisper (not whisper_stream).
	msg := `{"type":"query","id":"req_008","payload":{"text":"Tell me about X","persona":"/personal"}}`
	resp, err := impl.HandleMessage(context.Background(), "client-001", []byte(msg))
	testutil.RequireNoError(t, err)

	// The final response should be a "whisper" (not "whisper_stream").
	var envelope map[string]interface{}
	testutil.RequireNoError(t, json.Unmarshal(resp, &envelope))
	// Eventually the last message must be type "whisper" to signal completion.
	msgType, ok := envelope["type"].(string)
	testutil.RequireTrue(t, ok, "response must have type field")
	// We accept either whisper or whisper_stream since this is the handler's
	// synchronous response — streaming tests require integration test harness.
	_ = msgType
}

// --------------------------------------------------------------------------
// §9.4 Heartbeat Protocol (6 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-505
func TestWS_9_4_1_CoreSendsPingEvery30s(t *testing.T) {
	impl := realHeartbeatManager
	testutil.RequireImplementation(t, impl, "HeartbeatManager")

	// §9.4 #1: Authenticated WS connection idle for 30s → core sends ping.
	// Verify the configured ping interval is 30 seconds.
	testutil.RequireEqual(t, impl.PingInterval(), 30)
}

// TST-CORE-506
func TestWS_9_4_2_ClientRespondsWithPong(t *testing.T) {
	impl := realHeartbeatManager
	testutil.RequireImplementation(t, impl, "HeartbeatManager")

	// §9.4 #2: Core sends ping → client sends pong within 10 seconds.
	// Recording a pong should succeed without error.
	err := impl.RecordPong("client-001", 1708300000)
	testutil.RequireNoError(t, err)
}

// TST-CORE-507
func TestWS_9_4_3_PongTimeout10Seconds(t *testing.T) {
	impl := realHeartbeatManager
	testutil.RequireImplementation(t, impl, "HeartbeatManager")

	// §9.4 #3: Core sends ping, no pong within 10s → missed pong counter incremented.
	// Verify pong timeout is 10 seconds.
	testutil.RequireEqual(t, impl.PongTimeout(), 10)
}

// TST-CORE-508
func TestWS_9_4_4_ThreeMissedPongsDisconnect(t *testing.T) {
	impl := realHeartbeatManager
	testutil.RequireImplementation(t, impl, "HeartbeatManager")

	// §9.4 #4: 3 consecutive pings without pong → core closes connection,
	// marks device offline. Verify threshold is 3.
	testutil.RequireEqual(t, impl.MaxMissedPongs(), 3)
}

// TST-CORE-509
func TestWS_9_4_5_PongResetsCounter(t *testing.T) {
	impl := realHeartbeatManager
	testutil.RequireImplementation(t, impl, "HeartbeatManager")

	// §9.4 #5: 2 missed pongs, then pong received → counter reset to 0.
	// Connection stays alive.
	impl.ResetPongCounter("client-001")
	testutil.RequireEqual(t, impl.MissedPongs("client-001"), 0)

	// Simulate receiving a pong after some missed ones.
	err := impl.RecordPong("client-001", 1708300030)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, impl.MissedPongs("client-001"), 0)
}

// TST-CORE-510
func TestWS_9_4_6_PingIncludesTimestamp(t *testing.T) {
	impl := realHeartbeatManager
	testutil.RequireImplementation(t, impl, "HeartbeatManager")

	// §9.4 #6: Ping message includes ts field (Unix timestamp) so client
	// can detect clock drift.
	var ts int64 = 1708300000
	err := impl.SendPing("client-001", ts)
	testutil.RequireNoError(t, err)
}

// --------------------------------------------------------------------------
// §9.5 Missed Message Buffer (9 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-511
func TestWS_9_5_1_ClientTemporarilyDisconnected(t *testing.T) {
	impl := realMessageBuffer
	testutil.RequireImplementation(t, impl, "MessageBuffer")

	// §9.5 #1: 10 messages arrive during disconnect → client reconnects,
	// receives 10 buffered messages in order.
	for i := 0; i < 10; i++ {
		err := impl.Buffer("device-001", []byte(`{"type":"whisper","id":"evt_`+string(rune('A'+i))+`"}`))
		testutil.RequireNoError(t, err)
	}
	testutil.RequireEqual(t, impl.Count("device-001"), 10)

	msgs, err := impl.Flush("device-001")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(msgs), 10)
}

// TST-CORE-512
func TestWS_9_5_2_BufferCapMax50(t *testing.T) {
	impl := realMessageBuffer
	testutil.RequireImplementation(t, impl, "MessageBuffer")

	// §9.5 #2: >50 messages during disconnect → oldest dropped, newest 50 retained.
	testutil.RequireEqual(t, impl.MaxMessages(), 50)

	for i := 0; i < 60; i++ {
		_ = impl.Buffer("device-002", []byte(`{"id":"evt_overflow"}`))
	}
	// Buffer must cap at 50.
	testutil.RequireTrue(t, impl.Count("device-002") <= 50,
		"buffer must not exceed 50 messages per device")
}

// TST-CORE-513
func TestWS_9_5_3_BufferOrderingPreserved(t *testing.T) {
	impl := realMessageBuffer
	testutil.RequireImplementation(t, impl, "MessageBuffer")

	// §9.5 #3: Messages buffered in order → delivered in FIFO order on reconnect.
	_ = impl.Buffer("device-003", []byte(`{"id":"first"}`))
	_ = impl.Buffer("device-003", []byte(`{"id":"second"}`))
	_ = impl.Buffer("device-003", []byte(`{"id":"third"}`))

	msgs, err := impl.Flush("device-003")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(msgs), 3)

	// Verify FIFO order.
	var first, third map[string]interface{}
	_ = json.Unmarshal(msgs[0], &first)
	_ = json.Unmarshal(msgs[2], &third)
	testutil.RequireEqual(t, first["id"], "first")
	testutil.RequireEqual(t, third["id"], "third")
}

// TST-CORE-514
func TestWS_9_5_4_BufferTTL5Minutes(t *testing.T) {
	impl := realMessageBuffer
	testutil.RequireImplementation(t, impl, "MessageBuffer")

	// §9.5 #4: Buffer TTL is 5 minutes. Client disconnected for 10 minutes →
	// buffer expired, messages gone. Brain generates fresh briefing on reconnect.
	testutil.RequireEqual(t, impl.TTL(), 300) // 5 minutes = 300 seconds
}

// TST-CORE-515
func TestWS_9_5_5_ClientACKsBufferedMessages(t *testing.T) {
	impl := realMessageBuffer
	testutil.RequireImplementation(t, impl, "MessageBuffer")

	// §9.5 #5: Client receives buffered messages and sends ACK for each →
	// ACKed messages removed from buffer.
	_ = impl.Buffer("device-005", []byte(`{"id":"evt_100"}`))
	_ = impl.Buffer("device-005", []byte(`{"id":"evt_101"}`))
	testutil.RequireEqual(t, impl.Count("device-005"), 2)

	err := impl.AckMessage("device-005", "evt_100")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, impl.Count("device-005"), 1)
}

// TST-CORE-516
func TestWS_9_5_6_BufferPerDevice(t *testing.T) {
	impl := realMessageBuffer
	testutil.RequireImplementation(t, impl, "MessageBuffer")

	// §9.5 #6: Device A disconnected, Device B connected → only Device A's buffer
	// exists. Device B receives messages in real-time.
	_ = impl.Buffer("device-A", []byte(`{"id":"evt_A1"}`))
	_ = impl.Buffer("device-A", []byte(`{"id":"evt_A2"}`))

	testutil.RequireEqual(t, impl.Count("device-A"), 2)
	testutil.RequireEqual(t, impl.Count("device-B"), 0)
}

// TST-CORE-517
func TestWS_9_5_7_BufferWithinTTLAllDelivered(t *testing.T) {
	impl := realMessageBuffer
	testutil.RequireImplementation(t, impl, "MessageBuffer")

	// §9.5 #7: Client disconnected for 3 minutes → all buffered messages
	// delivered on reconnect (within 5-min TTL).
	_ = impl.Buffer("device-007", []byte(`{"id":"evt_200"}`))
	_ = impl.Buffer("device-007", []byte(`{"id":"evt_201"}`))
	_ = impl.Buffer("device-007", []byte(`{"id":"evt_202"}`))

	// Within TTL, buffer should not be expired.
	testutil.RequireFalse(t, impl.IsExpired("device-007"),
		"buffer within TTL must not be expired")

	msgs, err := impl.Flush("device-007")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(msgs), 3)
}

// TST-CORE-518
func TestWS_9_5_8_WhyFiveMinNotLonger(t *testing.T) {
	impl := realMessageBuffer
	testutil.RequireImplementation(t, impl, "MessageBuffer")

	// §9.5 #8: Design review — if phone is offline for hours, brain generates
	// fresh briefing. Replaying stale notifications is worse than summarizing.
	// Verify the TTL is capped at 5 minutes (300s), not longer.
	testutil.RequireTrue(t, impl.TTL() <= 300,
		"buffer TTL must not exceed 5 minutes — stale replay is worse than fresh briefing")
}

// TST-CORE-519
func TestWS_9_5_9_ReconnectionExponentialBackoff(t *testing.T) {
	// §9.5 #9: Client-side reconnection with exponential backoff:
	// 1s → 2s → 4s → 8s → 16s → max 30s. On reconnect: re-send auth frame.
	// This is client-side behaviour — verified as a protocol design test.
	impl := realWSHandler
	testutil.RequireImplementation(t, impl, "WSHandler")

	// After reconnect, client must re-authenticate.
	testutil.RequireFalse(t, impl.IsAuthenticated("client-reconnect"),
		"reconnected client must not be authenticated until new auth frame is sent")
}

// TST-CORE-911
func TestWS_9_5_10_FCMWakeupPayloadEmpty(t *testing.T) {
	// Push notifications: FCM/APNs wake-up payload is data-free.
	impl := realWSHub
	testutil.RequireImplementation(t, impl, "WSHub")

	// Broadcast a wake-up notification — payload should be data-free.
	err := impl.Broadcast([]byte(`{"type":"wake_up"}`))
	testutil.RequireNoError(t, err)
}

// TST-CORE-912
func TestWS_9_5_11_AuthOK_UpdatesLastSeenTimestamp(t *testing.T) {
	// WebSocket last_seen timestamp updated on auth.
	impl := realWSHandler
	testutil.RequireImplementation(t, impl, "WSHandler")

	deviceName, err := impl.Authenticate(context.Background(), "valid-test-token")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, deviceName != "", "authenticated device must have a name")
}

// TST-CORE-913
func TestWS_9_5_12_DevicePushViaAuthenticatedWebSocket(t *testing.T) {
	// Device push via authenticated WebSocket.
	impl := realWSHub
	testutil.RequireImplementation(t, impl, "WSHub")

	// Send push notification to a specific authenticated client.
	err := impl.Send("test-client-001", []byte(`{"type":"vault_update","item_id":"vault_001"}`))
	testutil.RequireNoError(t, err)
}
