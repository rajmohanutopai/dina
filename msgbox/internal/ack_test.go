package internal

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Delete-on-ack: a client that declares the "ack" feature at auth keeps each
// message in the relay until it acknowledges it. These run the real
// HandleWebSocket (real handshake, real read pump) so the feature travels the
// path a phone uses.

type ackServer struct {
	url string
	buf *Buffer
	h   *Handler
}

func startAckServer(t *testing.T) *ackServer {
	t.Helper()
	buf := newTestBuffer(t)
	h := NewHandler(NewHub(buf))
	srv := httptest.NewServer(http.HandlerFunc(h.HandleWebSocket))
	t.Cleanup(func() {
		srv.Close()
		buf.Close()
	})
	return &ackServer{url: "ws" + strings.TrimPrefix(srv.URL, "http"), buf: buf, h: h}
}

type ackClient struct {
	did  string
	pub  ed25519.PublicKey
	priv ed25519.PrivateKey
}

func newAckClient(t *testing.T) ackClient {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return ackClient{did: deriveDIDKey(pub), pub: pub, priv: priv}
}

// connect runs the handshake declaring `features` and returns the socket and
// the features the relay granted in auth_success.
func (c ackClient) connect(t *testing.T, s *ackServer, features ...string) (*websocket.Conn, []string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, s.url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { ws.Close(websocket.StatusNormalClosure, "") })
	_, chalBytes, err := ws.Read(ctx)
	if err != nil {
		t.Fatalf("read challenge: %v", err)
	}
	var chal AuthChallenge
	if err := json.Unmarshal(chalBytes, &chal); err != nil {
		t.Fatalf("parse challenge: %v", err)
	}
	sig := ed25519.Sign(c.priv, []byte(fmt.Sprintf("AUTH_RELAY\n%s\n%d", chal.Nonce, chal.TS)))
	resp, _ := json.Marshal(AuthResponse{
		Type: AuthResponseType, DID: c.did,
		Sig: hex.EncodeToString(sig), Pub: hex.EncodeToString(c.pub),
		Features: features,
	})
	if err := ws.Write(ctx, websocket.MessageText, resp); err != nil {
		t.Fatalf("write response: %v", err)
	}
	_, okBytes, err := ws.Read(ctx)
	if err != nil {
		t.Fatalf("read auth_success: %v", err)
	}
	var ok struct {
		Type     string   `json:"type"`
		Features []string `json:"features"`
	}
	if err := json.Unmarshal(okBytes, &ok); err != nil || ok.Type != AuthSuccessType {
		t.Fatalf("auth_success: %s (%v)", okBytes, err)
	}
	if ok.Features == nil {
		t.Fatalf("auth_success carries no features list: %s", okBytes)
	}
	return ws, ok.Features
}

func sendEnv(t *testing.T, ws *websocket.Conn, env map[string]any) {
	t.Helper()
	data, _ := json.Marshal(env)
	sendBinary(t, ws, data)
}

func request(from, to, id string) map[string]any {
	return map[string]any{
		"type": "rpc", "id": id, "from_did": from, "to_did": to,
		"direction": "request", "ciphertext": "sealed",
	}
}

func ackOf(env envelope) map[string]any {
	return map[string]any{"type": "ack", "id": env.ID, "from_did": env.FromDID}
}

// readEnvelope waits for the next binary frame; ok is false on timeout.
func readEnvelope(t *testing.T, ws *websocket.Conn, timeout time.Duration) (envelope, bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	for {
		typ, data, err := ws.Read(ctx)
		if err != nil {
			return envelope{}, false
		}
		if typ != websocket.MessageBinary {
			continue
		}
		var env envelope
		if err := json.Unmarshal(data, &env); err != nil {
			t.Fatalf("frame is not an envelope: %s", data)
		}
		return env, true
	}
}

func TestAck_AuthSuccessGrantsOnlyKnownFeatures(t *testing.T) {
	s := startAckServer(t)
	_, granted := newAckClient(t).connect(t, s, "ack", "telepathy")
	if len(granted) != 1 || granted[0] != FeatureAck {
		t.Errorf("granted = %v, want [ack]", granted)
	}
	_, none := newAckClient(t).connect(t, s)
	if len(none) != 0 {
		t.Errorf("a client asking for nothing was granted %v", none)
	}
}

func TestAck_DeliveredMessageStaysUntilAcked(t *testing.T) {
	s := startAckServer(t)
	phone, cli := newAckClient(t), newAckClient(t)
	phoneWS, _ := phone.connect(t, s, FeatureAck)
	cliWS, _ := cli.connect(t, s)

	sendEnv(t, cliWS, request(cli.did, phone.did, "req-1"))
	got, ok := readEnvelope(t, phoneWS, 2*time.Second)
	if !ok || got.ID != "req-1" {
		t.Fatalf("phone got %+v (ok=%v), want req-1", got, ok)
	}
	// Written, not yet acked: the relay still holds it.
	time.Sleep(50 * time.Millisecond)
	if n := s.buf.TotalCount(); n != 1 {
		t.Fatalf("buffer after delivery = %d, want 1 (held until ack)", n)
	}

	sendEnv(t, phoneWS, ackOf(got))
	if !waitFor(t, 2*time.Second, func() bool { return s.buf.TotalCount() == 0 }) {
		t.Fatalf("buffer after ack = %d, want 0", s.buf.TotalCount())
	}
	// A repeated ack is harmless.
	sendEnv(t, phoneWS, ackOf(got))
}

func TestAck_UnackedMessageIsSentAgainOnReconnect(t *testing.T) {
	s := startAckServer(t)
	phone, cli := newAckClient(t), newAckClient(t)
	cliWS, _ := cli.connect(t, s)

	first, _ := phone.connect(t, s, FeatureAck)
	sendEnv(t, cliWS, request(cli.did, phone.did, "req-lost"))
	if got, ok := readEnvelope(t, first, 2*time.Second); !ok || got.ID != "req-lost" {
		t.Fatalf("first connection got %+v (ok=%v)", got, ok)
	}
	// The app is suspended before it can handle (and ack) the message.
	first.Close(websocket.StatusGoingAway, "suspended")

	second, _ := phone.connect(t, s, FeatureAck)
	again, ok := readEnvelope(t, second, 2*time.Second)
	if !ok || again.ID != "req-lost" || again.FromDID != cli.did {
		t.Fatalf("reconnect got %+v (ok=%v), want req-lost again", again, ok)
	}
	if n := s.buf.TotalCount(); n != 1 {
		t.Fatalf("buffer after redelivery = %d, want 1", n)
	}
	sendEnv(t, second, ackOf(again))
	if !waitFor(t, 2*time.Second, func() bool { return s.buf.TotalCount() == 0 }) {
		t.Fatalf("buffer after ack = %d, want 0", s.buf.TotalCount())
	}
}

func TestAck_OnlyTheRecipientCanAck(t *testing.T) {
	s := startAckServer(t)
	phone, cli := newAckClient(t), newAckClient(t)
	phoneWS, _ := phone.connect(t, s, FeatureAck)
	cliWS, _ := cli.connect(t, s, FeatureAck)

	sendEnv(t, cliWS, request(cli.did, phone.did, "req-mine"))
	got, ok := readEnvelope(t, phoneWS, 2*time.Second)
	if !ok {
		t.Fatal("phone got nothing")
	}
	// The sender (or anyone else) naming the same key acks nothing.
	sendEnv(t, cliWS, ackOf(got))
	time.Sleep(100 * time.Millisecond)
	if n := s.buf.TotalCount(); n != 1 {
		t.Fatalf("a non-recipient's ack removed the message: buffer = %d", n)
	}
	// An ack missing its sender names no key and is dropped.
	sendEnv(t, phoneWS, map[string]any{"type": "ack", "id": got.ID})
	time.Sleep(50 * time.Millisecond)
	if n := s.buf.TotalCount(); n != 1 {
		t.Fatalf("an ack without from_did removed the message: buffer = %d", n)
	}
}

func TestAck_ClientWithoutTheFeatureKeepsDeleteOnWrite(t *testing.T) {
	s := startAckServer(t)
	node, cli := newAckClient(t), newAckClient(t)
	nodeWS, _ := node.connect(t, s)
	cliWS, _ := cli.connect(t, s)

	sendEnv(t, cliWS, request(cli.did, node.did, "req-old"))
	if _, ok := readEnvelope(t, nodeWS, 2*time.Second); !ok {
		t.Fatal("node got nothing")
	}
	time.Sleep(50 * time.Millisecond)
	if n := s.buf.TotalCount(); n != 0 {
		t.Fatalf("buffer = %d, want 0 (delete-on-write for a client without ack)", n)
	}
}

func TestAck_CancelOfAMessageNeverSentDeletesItQuietly(t *testing.T) {
	s := startAckServer(t)
	phone, cli := newAckClient(t), newAckClient(t)
	cliWS, _ := cli.connect(t, s)

	// Phone offline: the request waits in the buffer, then is cancelled.
	sendEnv(t, cliWS, request(cli.did, phone.did, "req-gone"))
	if !waitFor(t, 2*time.Second, func() bool { return s.buf.TotalCount() == 1 }) {
		t.Fatal("request was not buffered")
	}
	sendEnv(t, cliWS, map[string]any{
		"type": "cancel", "cancel_of": "req-gone", "from_did": cli.did, "to_did": phone.did,
	})
	if !waitFor(t, 2*time.Second, func() bool { return s.buf.TotalCount() == 0 }) {
		t.Fatalf("buffer after cancel = %d, want 0", s.buf.TotalCount())
	}
	phoneWS, _ := phone.connect(t, s, FeatureAck)
	if env, ok := readEnvelope(t, phoneWS, 300*time.Millisecond); ok {
		t.Fatalf("phone got %+v; a cancelled, never-sent request should vanish", env)
	}
}

func TestAck_CancelOfAMessageAlreadySentReachesTheRecipient(t *testing.T) {
	s := startAckServer(t)
	phone, cli := newAckClient(t), newAckClient(t)
	phoneWS, _ := phone.connect(t, s, FeatureAck)
	cliWS, _ := cli.connect(t, s)

	sendEnv(t, cliWS, request(cli.did, phone.did, "req-busy"))
	if got, ok := readEnvelope(t, phoneWS, 2*time.Second); !ok || got.ID != "req-busy" {
		t.Fatalf("phone got %+v (ok=%v)", got, ok)
	}
	// The phone may be working on it, so the cancel must reach it — the CLI
	// sends cancels without an id of their own.
	sendEnv(t, cliWS, map[string]any{
		"type": "cancel", "cancel_of": "req-busy", "from_did": cli.did, "to_did": phone.did,
	})
	cancelEnv, ok := readEnvelope(t, phoneWS, 2*time.Second)
	if !ok || cancelEnv.Type != "cancel" || cancelEnv.CancelOf != "req-busy" {
		t.Fatalf("phone got %+v (ok=%v), want the cancel", cancelEnv, ok)
	}
	if cancelEnv.ID == "" || cancelEnv.FromDID != cli.did {
		t.Fatalf("relayed cancel %+v cannot be acked: needs an id and from_did", cancelEnv)
	}
	// The request's copy went with the cancel; the cancel waits for its ack.
	if n := s.buf.TotalCount(); n != 1 {
		t.Fatalf("buffer after relayed cancel = %d, want 1 (the cancel)", n)
	}
	sendEnv(t, phoneWS, ackOf(cancelEnv))
	if !waitFor(t, 2*time.Second, func() bool { return s.buf.TotalCount() == 0 }) {
		t.Fatalf("buffer after acking the cancel = %d, want 0", s.buf.TotalCount())
	}
}

func TestAck_ForwardedD2DCanBeAcked(t *testing.T) {
	s := startAckServer(t)
	phone, sender := newAckClient(t), newAckClient(t)
	phoneWS, _ := phone.connect(t, s, FeatureAck)

	// /forward mints the message id itself; the delivered envelope must carry
	// it, and the sender, so the phone can name the message in its ack.
	rec := forwardRequest(t, http.HandlerFunc(s.h.HandleForward),
		sender.did, phone.did, sender.pub, sender.priv, []byte(`{"c":"sealed"}`))
	if rec.Code != http.StatusOK && rec.Code != http.StatusAccepted {
		t.Fatalf("forward status = %d (%s)", rec.Code, rec.Body.String())
	}
	got, ok := readEnvelope(t, phoneWS, 2*time.Second)
	if !ok || got.Type != "d2d" || got.ID == "" || got.FromDID != sender.did {
		t.Fatalf("phone got %+v (ok=%v)", got, ok)
	}
	if n := s.buf.TotalCount(); n != 1 {
		t.Fatalf("buffer after delivery = %d, want 1", n)
	}
	sendEnv(t, phoneWS, ackOf(got))
	if !waitFor(t, 2*time.Second, func() bool { return s.buf.TotalCount() == 0 }) {
		t.Fatalf("buffer after ack = %d, want 0", s.buf.TotalCount())
	}
}

func TestAck_AFullBufferRefusesTheDeliveryRatherThanWritingAnUnkeptCopy(t *testing.T) {
	s := startAckServer(t)
	phone, cli := newAckClient(t), newAckClient(t)
	phoneWS, _ := phone.connect(t, s, FeatureAck)
	// The phone holds its per-recipient maximum, all written and unacked.
	for i := 0; i < MaxMessagesPerDID; i++ {
		if err := s.buf.Add(phone.did, fmt.Sprintf("x:%d", i), []byte(`{}`)); err != nil {
			t.Fatalf("prefill %d: %v", i, err)
		}
	}
	status, err := s.h.Hub.Deliver(phone.did, cli.did+":one-too-many", []byte(`{"type":"rpc","id":"one-too-many"}`))
	if err == nil {
		t.Fatalf("Deliver = %q, want an error: no copy could be kept", status)
	}
	if env, ok := readEnvelope(t, phoneWS, 300*time.Millisecond); ok {
		t.Fatalf("phone was sent %+v without a kept copy", env)
	}
}

// Everything done for one recipient waits for its lock, so a cancel cannot
// slip between a drain's read and its write, nor a delivery between a
// connection's replacement and its drain.
func TestHub_EverythingForOneRecipientWaitsItsTurn(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)
	const phone = "did:plc:onerecipient1"
	if err := buf.Add(phone, "did:key:zcli:req", []byte(`{}`), WithSender("did:key:zcli")); err != nil {
		t.Fatal(err)
	}

	serverWS, closeWS := newTestWSPair(t)
	defer closeWS()

	unlock := hub.lockRecipient(phone) // a drain or delivery in progress
	done := make(chan string, 4)
	go func() {
		hub.Cancel(phone, "did:key:zcli:req", func(string, func(string, []byte, ...AddOption)) {})
		done <- "cancel"
	}()
	go func() { hub.Ack(phone, "did:key:zcli:other"); done <- "ack" }()
	go func() { _, _ = hub.Deliver(phone, "did:key:zcli:new", []byte(`{}`)); done <- "deliver" }()
	go func() {
		hub.Register(&MsgBoxConn{WS: serverWS, DID: phone, Ctx: context.Background(), Cancel: func() {}})
		done <- "register"
	}()

	select {
	case who := <-done:
		t.Fatalf("%s ran while the recipient's lock was held", who)
	case <-time.After(150 * time.Millisecond):
	}
	if buf.TotalCount() != 1 {
		t.Fatalf("the buffered request changed while the lock was held")
	}
	unlock()
	for i := 0; i < 4; i++ {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("a waiter never ran after the lock was released")
		}
	}
}

// A recipient whose lock is held (a slow socket mid-drain) delays only
// itself: delivery to anyone else goes straight through.
func TestHub_OneSlowRecipientDoesNotHoldUpAnother(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)
	unlock := hub.lockRecipient("did:plc:slowrecipient1")
	defer unlock()
	done := make(chan struct{})
	go func() {
		for i := 0; i < 50; i++ {
			other := fmt.Sprintf("did:plc:otherrecipient%d", i)
			if _, err := hub.Deliver(other, "did:key:zs:m", []byte(`{}`)); err != nil {
				t.Errorf("deliver to %s: %v", other, err)
			}
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("delivery to other recipients waited on one recipient's lock")
	}
}

// A cancel that leaves out `to_did`, or names the wrong recipient, still
// waits on the lock of the recipient the message is buffered for.
func TestHub_CancelWaitsOnTheBufferedRecipientWhateverToDIDSays(t *testing.T) {
	for _, toDID := range []string{"", "did:plc:somebodyelse1"} {
		buf := newTestBuffer(t)
		hub := NewHub(buf)
		const phone = "did:plc:realrecipient1"
		if err := buf.Add(phone, "did:key:zcli:req", []byte(`{}`), WithSender("did:key:zcli")); err != nil {
			t.Fatal(err)
		}
		unlock := hub.lockRecipient(phone) // the phone's drain is mid-way
		done := make(chan bool, 1)
		go func() {
			done <- hub.Cancel(toDID, "did:key:zcli:req", func(string, func(string, []byte, ...AddOption)) {})
		}()
		select {
		case <-done:
			t.Fatalf("to_did=%q: the cancel ran while the recipient's drain held its lock", toDID)
		case <-time.After(150 * time.Millisecond):
		}
		unlock()
		select {
		case relayed := <-done:
			if relayed {
				t.Fatalf("to_did=%q: a never-delivered message should be withdrawn, not relayed", toDID)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("to_did=%q: the cancel never ran", toDID)
		}
		if buf.TotalCount() != 0 {
			t.Fatalf("to_did=%q: the buffered request was not withdrawn", toDID)
		}
		buf.Close()
	}
}

// A row older than the TTL is never drained, even before the background
// sweep has run (a relay just restarted with old rows).
func TestHub_DrainSkipsRowsPastTheTTL(t *testing.T) {
	s := startAckServer(t)
	phone, cli := newAckClient(t), newAckClient(t)
	if err := s.buf.Add(phone.did, cli.did+":ancient", []byte(`{"type":"rpc","id":"ancient"}`), WithSender(cli.did)); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-MessageTTL - time.Hour).Unix()
	if _, err := s.buf.db.Exec("UPDATE messages SET stored_at = ? WHERE id = ?", old, cli.did+":ancient"); err != nil {
		t.Fatal(err)
	}
	ws, _ := phone.connect(t, s, FeatureAck)
	if env, ok := readEnvelope(t, ws, 300*time.Millisecond); ok {
		t.Fatalf("an over-age row was drained: %+v", env)
	}
	if n := s.buf.TotalCount(); n != 0 {
		t.Fatalf("the over-age row was kept: buffer = %d", n)
	}
}

// A cancel for a request the recipient already has, sent with the wrong
// to_did, still reaches the recipient — addressed to it, so it is not
// dropped as misdirected.
func TestAck_CancelWithAWrongToDIDReachesTheRealRecipientAddressedToIt(t *testing.T) {
	s := startAckServer(t)
	phone, cli := newAckClient(t), newAckClient(t)
	phoneWS, _ := phone.connect(t, s, FeatureAck)
	cliWS, _ := cli.connect(t, s)

	sendEnv(t, cliWS, request(cli.did, phone.did, "req-held"))
	if got, ok := readEnvelope(t, phoneWS, 2*time.Second); !ok || got.ID != "req-held" {
		t.Fatalf("phone got %+v (ok=%v)", got, ok)
	}
	sendEnv(t, cliWS, map[string]any{
		"type": "cancel", "cancel_of": "req-held", "from_did": cli.did, "to_did": "did:plc:somebodyelse1",
	})
	c, ok := readEnvelope(t, phoneWS, 2*time.Second)
	if !ok || c.Type != "cancel" || c.CancelOf != "req-held" {
		t.Fatalf("phone got %+v (ok=%v), want the cancel", c, ok)
	}
	if c.ToDID != phone.did {
		t.Fatalf("relayed cancel addressed to %q, want the phone %q", c.ToDID, phone.did)
	}
}
