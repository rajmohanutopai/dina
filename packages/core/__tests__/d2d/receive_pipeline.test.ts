/**
 * T6.8–6.12 — Full D2D receive pipeline: unseal → verify → trust → scenario → stage.
 *
 * Source: ARCHITECTURE.md Tasks 6.8–6.12
 */

import { TEST_ED25519_SEED } from '@dina/test-harness';

import { resetAuditState, queryAudit } from '../../src/audit/service';
import { getPublicKey } from '../../src/crypto/ed25519';
import { sealMessage, type DinaMessage } from '../../src/d2d/envelope';
import { addContact, setScenarioDeny, clearGatesState } from '../../src/d2d/gates';
import { resetQuarantineState, quarantineSize } from '../../src/d2d/quarantine';
import { receiveD2D } from '../../src/d2d/receive_pipeline';
import { resetStagingState } from '../../src/staging/service';
import { clearReplayCache } from '../../src/transport/adversarial';

const senderPriv = TEST_ED25519_SEED;
const senderPub = getPublicKey(senderPriv);
const recipientPriv = new Uint8Array(32).fill(0x42);
const recipientPub = getPublicKey(recipientPriv);

function buildSealed(overrides?: Partial<DinaMessage>) {
  const msg: DinaMessage = {
    id: 'msg-001',
    type: 'social.update',
    from: 'did:plc:sender',
    to: 'did:plc:recipient',
    created_time: Date.now(),
    body: '{"text":"hello"}',
    ...overrides,
  };
  return sealMessage(msg, senderPriv, recipientPub);
}

describe('D2D Receive Pipeline', () => {
  beforeEach(() => {
    clearGatesState();
    resetStagingState();
    resetAuditState();
    resetQuarantineState();
    clearReplayCache();
  });

  describe('full pipeline success', () => {
    it('unseals → verifies → stages trusted message', () => {
      addContact('did:plc:sender');
      const payload = buildSealed();
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.action).toBe('staged');
      expect(result.signatureValid).toBe(true);
      expect(result.messageId).toBe('msg-001');
      expect(result.messageType).toBe('social.update');
      expect(result.senderDID).toBe('did:plc:sender');
      expect(result.stagingId).toMatch(/^stg-/);
    });

    it('forwards sender created_time as senderCreatedTime (MT-19-I2)', () => {
      // The receive pipeline must surface the sender's wire timestamp
      // alongside the staged body so chat-side fan-out can render
      // multiple replayed messages chronologically. Without this,
      // every inbound got Date.now() at receive-time and a back-to-
      // back replay-on-reconnect rendered out of order.
      addContact('did:plc:sender');
      const sentAt = 1_700_000_123_456;
      const payload = buildSealed({ created_time: sentAt });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.action).toBe('staged');
      expect(result.senderCreatedTime).toBe(sentAt);
    });

    it('omits senderCreatedTime on dropped messages (no body to render)', () => {
      // Quarantined / dropped paths must not leak a sender timestamp
      // — there's no body to associate it with on a UI surface, and
      // surfacing it would invite consumers to render the message.
      const payload = buildSealed();
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'blocked');
      expect(result.action).toBe('dropped');
      expect(result.senderCreatedTime).toBeUndefined();
    });

    it('audit logs the receive', () => {
      addContact('did:plc:sender');
      receiveD2D(buildSealed(), recipientPub, recipientPriv, [senderPub], 'trusted');
      const audits = queryAudit({ action: 'd2d_recv_staged' });
      expect(audits.length).toBeGreaterThan(0);
    });
  });

  describe('unseal failure', () => {
    it('wrong recipient key → dropped', () => {
      const payload = buildSealed();
      const wrongPriv = new Uint8Array(32).fill(0x99);
      const wrongPub = getPublicKey(wrongPriv);
      const result = receiveD2D(payload, wrongPub, wrongPriv, [senderPub], 'trusted');
      expect(result.action).toBe('dropped');
      expect(result.signatureValid).toBe(false);
      expect(result.reason).toContain('Unseal failed');
    });
  });

  describe('signature verification', () => {
    it('valid signature passes', () => {
      addContact('did:plc:sender');
      const result = receiveD2D(buildSealed(), recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.signatureValid).toBe(true);
    });

    it('wrong verification keys → dropped', () => {
      const wrongKey = getPublicKey(new Uint8Array(32).fill(0x77));
      const result = receiveD2D(buildSealed(), recipientPub, recipientPriv, [wrongKey], 'trusted');
      expect(result.action).toBe('dropped');
      expect(result.signatureValid).toBe(false);
      expect(result.reason).toContain('Signature');
    });

    it('bad signature audit-logged', () => {
      const wrongKey = getPublicKey(new Uint8Array(32).fill(0x77));
      receiveD2D(buildSealed(), recipientPub, recipientPriv, [wrongKey], 'trusted');
      expect(queryAudit({ action: 'd2d_recv_bad_sig' }).length).toBeGreaterThan(0);
    });
  });

  describe('sender binding (transport authenticity)', () => {
    // A valid signature only proves the holder of senderVerificationKeys
    // signed the bytes; it does NOT prove the sealed inner `from` matches the
    // DID the transport authenticated. When the caller supplies
    // authenticatedFromDID, the inner `from` must equal it — otherwise an
    // attacker who signs with their OWN key can spoof a trusted peer's DID in
    // `from` and inherit that peer's trust + vault attribution.
    it('inner from matching the authenticated DID → proceeds (staged)', () => {
      addContact('did:plc:sender');
      const result = receiveD2D(
        buildSealed(),
        recipientPub,
        recipientPriv,
        [senderPub],
        'trusted',
        {
          authenticatedFromDID: 'did:plc:sender',
        },
      );
      expect(result.action).toBe('staged');
      expect(result.signatureValid).toBe(true);
    });

    it('inner from spoofing a different DID → dropped (not staged) despite valid signature', () => {
      // Exploit shape: attacker signs with their own key (senderPriv → senderPub,
      // which the transport authenticated as did:plc:attacker), but seals
      // from: did:plc:victim to inherit the victim's trust/attribution.
      addContact('did:plc:victim');
      const forged = buildSealed({ from: 'did:plc:victim' });
      const result = receiveD2D(forged, recipientPub, recipientPriv, [senderPub], 'trusted', {
        authenticatedFromDID: 'did:plc:attacker',
      });
      expect(result.action).toBe('dropped');
      expect(result.signatureValid).toBe(true);
      expect(result.reason).toContain('authenticated transport DID');
      expect(quarantineSize()).toBe(0);
      expect(queryAudit({ action: 'd2d_recv_sender_mismatch' }).length).toBe(1);
    });

    it('omitted authenticatedFromDID → no binding enforced (pure-pipeline callers)', () => {
      addContact('did:plc:sender');
      const result = receiveD2D(buildSealed(), recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.action).toBe('staged');
    });
  });

  describe('trust evaluation', () => {
    it('blocked sender → dropped', () => {
      const result = receiveD2D(buildSealed(), recipientPub, recipientPriv, [senderPub], 'blocked');
      expect(result.action).toBe('dropped');
    });

    it('unknown trust_level → quarantined (not a verified contact)', () => {
      // Fix: Codex #15 — 'unknown' trust means "not a verified contact" → quarantine.
      // Only explicit positive trust levels (verified, trusted, contact_ring1, etc.) proceed.
      addContact('did:plc:sender');
      const result = receiveD2D(buildSealed(), recipientPub, recipientPriv, [senderPub], 'unknown');
      expect(result.action).toBe('quarantined');
    });

    it('verified contact → accepted (staged)', () => {
      addContact('did:plc:sender');
      const result = receiveD2D(
        buildSealed(),
        recipientPub,
        recipientPriv,
        [senderPub],
        'verified',
      );
      expect(result.action).toBe('staged');
    });

    it('non-contact (empty trust) → quarantined', () => {
      // Sender NOT in contact directory → quarantine. Pass empty string for trust.
      const result = receiveD2D(
        buildSealed({ id: 'msg-non-contact' }),
        recipientPub,
        recipientPriv,
        [senderPub],
        '',
      );
      expect(result.action).toBe('quarantined');
      expect(result.quarantineId).toBeTruthy();
      expect(quarantineSize()).toBe(1);
    });
  });

  describe('scenario policy', () => {
    it('denied message type → dropped', () => {
      addContact('did:plc:sender');
      setScenarioDeny('did:plc:sender', ['social.update']);
      const result = receiveD2D(buildSealed(), recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.action).toBe('dropped');
      expect(result.reason).toContain('Scenario policy');
    });

    it('safety.alert always passes scenario check', () => {
      addContact('did:plc:sender');
      setScenarioDeny('did:plc:sender', ['safety.alert']);
      const payload = buildSealed({ type: 'safety.alert' });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.action).toBe('staged'); // safety.alert cannot be blocked
    });

    it('scenario denial audit-logged', () => {
      addContact('did:plc:sender');
      setScenarioDeny('did:plc:sender', ['social.update']);
      receiveD2D(buildSealed(), recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(queryAudit({ action: 'd2d_recv_scenario_denied' }).length).toBeGreaterThan(0);
    });
  });

  describe('ephemeral messages', () => {
    it('presence.signal → ephemeral (not staged)', () => {
      addContact('did:plc:sender');
      const payload = buildSealed({ type: 'presence.signal' });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.action).toBe('ephemeral');
    });
  });

  describe('replay detection (SEC-HIGH-08)', () => {
    it('accepts first message, drops second with same ID', () => {
      addContact('did:plc:sender');
      const payload1 = buildSealed({ id: 'msg-replay-test' });

      // First delivery — accepted
      const result1 = receiveD2D(payload1, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result1.action).toBe('staged');

      // Second delivery of same message — rejected as replay
      const payload2 = buildSealed({ id: 'msg-replay-test' });
      const result2 = receiveD2D(payload2, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result2.action).toBe('dropped');
      expect(result2.reason).toContain('Replayed');
    });

    it('accepts different message IDs from same sender', () => {
      addContact('did:plc:sender');
      const p1 = buildSealed({ id: 'msg-a' });
      const p2 = buildSealed({ id: 'msg-b' });

      expect(receiveD2D(p1, recipientPub, recipientPriv, [senderPub], 'trusted').action).toBe(
        'staged',
      );
      expect(receiveD2D(p2, recipientPub, recipientPriv, [senderPub], 'trusted').action).toBe(
        'staged',
      );
    });

    it('accepts same message ID from different senders', () => {
      addContact('did:plc:sender');
      addContact('did:plc:other');
      const p1 = buildSealed({ id: 'msg-shared-id', from: 'did:plc:sender' });
      const p2 = buildSealed({ id: 'msg-shared-id', from: 'did:plc:other' });

      expect(receiveD2D(p1, recipientPub, recipientPriv, [senderPub], 'trusted').action).toBe(
        'staged',
      );
      // Different sender → different replay key → accepted (not a replay)
      expect(receiveD2D(p2, recipientPub, recipientPriv, [senderPub], 'trusted').action).toBe(
        'staged',
      );
    });

    it('audit logs replay detections', () => {
      addContact('did:plc:sender');
      const payload = buildSealed({ id: 'msg-audit-replay' });

      receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');
      receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');

      const logs = queryAudit({ action: 'd2d_recv_replay' });
      expect(logs.length).toBeGreaterThan(0);
    });
  });

  describe('V1 type enforcement', () => {
    it('drops non-V1 message types with audit', () => {
      addContact('did:plc:sender');
      const payload = buildSealed({ id: 'msg-v1-reject', type: 'dina/query' });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');

      expect(result.action).toBe('dropped');
      expect(result.reason).toContain('Non-V1');
      expect(result.signatureValid).toBe(true); // sig was valid, type was not

      const logs = queryAudit({ action: 'd2d_recv_type_rejected' });
      expect(logs.length).toBeGreaterThan(0);
    });

    it('accepts valid V1 types', () => {
      addContact('did:plc:sender');
      const payload = buildSealed({ id: 'msg-v1-accept', type: 'social.update' });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.action).toBe('staged');
    });
  });

  describe('body size validation', () => {
    it('accepts normal-sized bodies', () => {
      addContact('did:plc:sender');
      const payload = buildSealed({
        id: 'msg-body-ok',
        body: 'x'.repeat(1000),
      });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.action).toBe('staged');
    });

    it('drops bodies exceeding 256 KB', () => {
      addContact('did:plc:sender');
      // 256 KB + 1 byte
      const payload = buildSealed({
        id: 'msg-body-oversized',
        body: 'x'.repeat(256 * 1024 + 1),
      });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.action).toBe('dropped');
      expect(result.reason).toContain('exceeds maximum size');
      expect(result.signatureValid).toBe(true);
    });

    it('audit logs oversized body rejections', () => {
      addContact('did:plc:sender');
      const payload = buildSealed({
        id: 'msg-body-audit',
        body: 'x'.repeat(256 * 1024 + 1),
      });
      receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');

      const logs = queryAudit({ action: 'd2d_recv_body_oversized' });
      expect(logs.length).toBeGreaterThan(0);
    });
  });

  describe('stagedBody — UI fan-out hook', () => {
    it('exposes the verified body on staged actions', () => {
      addContact('did:plc:sender');
      const payload = buildSealed({
        id: 'msg-staged-body',
        body: '{"text":"hello peer"}',
      });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.action).toBe('staged');
      expect(result.stagedBody).toBe('{"text":"hello peer"}');
    });

    it('exposes the body on ephemeral actions (e.g. presence.signal)', () => {
      const payload = buildSealed({
        id: 'msg-presence',
        type: 'presence.signal',
        body: '{"online":true}',
      });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted');
      expect(result.action).toBe('ephemeral');
      expect(result.stagedBody).toBe('{"online":true}');
    });

    it('omits the body on quarantined messages (unknown sender, no contact)', () => {
      const payload = buildSealed({
        id: 'msg-quarantine',
        body: '{"text":"from a stranger"}',
      });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'unknown');
      expect(result.action).toBe('quarantined');
      expect(result.stagedBody).toBeUndefined();
    });

    it('omits the body on dropped messages (blocked sender)', () => {
      addContact('did:plc:sender');
      const payload = buildSealed({
        id: 'msg-blocked',
        body: '{"text":"should not leak"}',
      });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'blocked');
      expect(result.action).toBe('dropped');
      expect(result.stagedBody).toBeUndefined();
    });
  });

  describe('service.query ingress — recipient & service_uri binds (P1)', () => {
    // SECURITY: the trusted recipient is the TRANSPORT-authenticated delivery
    // DID (MsgBox env.to_did, threaded in as `authenticatedToDID`), NOT the
    // sender-signed inner `message.to`. `buildSealed` seals to OUR box keys
    // (`recipientPub`) regardless of the inner `to` field — so an attacker can
    // deliver an envelope to US while naming a different inner `to`/service_uri
    // (the confused-deputy attack). These tests pin that the bind authority is
    // `authenticatedToDID`, never the inner body.
    const RECIPIENT = 'did:plc:recipient';
    const ATTACKER = 'did:plc:attacker';

    function svcQuery(
      opts: { serviceUri?: string; innerTo?: string | string[]; id?: string } = {},
    ) {
      const body: Record<string, unknown> = {
        query_id: 'q-1',
        capability: 'eta_query',
        params: { route: '42' },
        ttl_seconds: 60,
      };
      if (opts.serviceUri !== undefined) body.service_uri = opts.serviceUri;
      // `DinaMessage.to` is typed `string` here, but the wire field is a
      // recipient LIST and the receive pipeline defends with `Array.isArray`.
      // We deliberately seal an array `to` in one case to exercise that runtime
      // branch, so build the overrides untyped and cast once.
      const overrides: Record<string, unknown> = {
        id: opts.id ?? 'msg-svc-uri',
        type: 'service.query',
        body: JSON.stringify(body),
      };
      if (opts.innerTo !== undefined) overrides.to = opts.innerTo;
      return buildSealed(overrides as unknown as Partial<DinaMessage>);
    }

    it('bypasses a service.query whose service_uri authority == authenticated recipient DID', () => {
      const payload = svcQuery({
        serviceUri: `at://${RECIPIENT}/com.dinakernel.service.profile/store-2`,
        innerTo: RECIPIENT,
        id: 'msg-svc-ok',
      });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted', {
        isCapabilityConfigured: () => true,
        authenticatedToDID: RECIPIENT,
      });
      expect(result.action).toBe('bypassed');
    });

    it('drops a service.query whose service_uri authority != authenticated recipient DID (cross-DID)', () => {
      // Inner `to` matches us (passes the inner-recipient check), but the chosen
      // listing belongs to a different provider → `service_uri_mismatch` drop.
      const payload = svcQuery({
        serviceUri: `at://${ATTACKER}/com.dinakernel.service.profile/store-9`,
        innerTo: RECIPIENT,
        id: 'msg-svc-crossdid',
      });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted', {
        isCapabilityConfigured: () => true,
        authenticatedToDID: RECIPIENT,
      });
      expect(result.action).toBe('dropped');
      // Drop is audited (decision layer never falls back to the contact gate).
      expect(queryAudit({ action: 'd2d_recv_service_denied' }).length).toBeGreaterThan(0);
    });

    it('drops the confused-deputy service.query: inner to + service_uri both attacker, delivered to us', () => {
      // The attack: an attacker delivers an envelope to US (the relay
      // authenticated env.to_did = RECIPIENT → authenticatedToDID) but sets the
      // sender-signed inner `to` AND `service_uri` to their OWN DID. If the bind
      // trusted the inner `to` this would pass. It MUST drop, because the
      // authority is the transport-authenticated delivery DID.
      const payload = svcQuery({
        serviceUri: `at://${ATTACKER}/com.dinakernel.service.profile/store-evil`,
        innerTo: ATTACKER,
        id: 'msg-svc-deputy',
      });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted', {
        isCapabilityConfigured: () => true,
        authenticatedToDID: RECIPIENT,
      });
      expect(result.action).toBe('dropped');
    });

    it('drops a service.query whose inner recipient is not the authenticated delivery DID', () => {
      // Inner `to` names a different DID than the envelope was delivered to —
      // even with no service_uri at all → `inner_to_mismatch` drop.
      const payload = svcQuery({ innerTo: ATTACKER, id: 'msg-svc-innerto' });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted', {
        isCapabilityConfigured: () => true,
        authenticatedToDID: RECIPIENT,
      });
      expect(result.action).toBe('dropped');
    });

    it('drops a service.query addressed to multiple inner recipients', () => {
      // service.query is 1:1; a fan-out inner `to` (even one that includes us)
      // is rejected — exactly one recipient must equal the authenticated DID.
      const payload = svcQuery({ innerTo: [RECIPIENT, ATTACKER], id: 'msg-svc-multi' });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted', {
        isCapabilityConfigured: () => true,
        authenticatedToDID: RECIPIENT,
      });
      expect(result.action).toBe('dropped');
    });

    it('drops a service.query with a structurally-malformed service_uri', () => {
      const payload = svcQuery({
        serviceUri: 'not-an-at-uri',
        innerTo: RECIPIENT,
        id: 'msg-svc-malformed',
      });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted', {
        isCapabilityConfigured: () => true,
        authenticatedToDID: RECIPIENT,
      });
      expect(result.action).toBe('dropped');
    });

    it('bypasses a service.query with no service_uri (single-listing provider)', () => {
      const payload = svcQuery({ innerTo: RECIPIENT, id: 'msg-svc-nouri' });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted', {
        isCapabilityConfigured: () => true,
        authenticatedToDID: RECIPIENT,
      });
      expect(result.action).toBe('bypassed');
    });

    it('skips the recipient/service_uri binds when authenticatedToDID is omitted (back-compat)', () => {
      // Pure-pipeline callers with no transport envelope don't know the
      // authenticated delivery DID, so the binds are skipped (mirrors
      // `authenticatedFromDID`). A cross-DID service_uri then bypasses — which
      // is ONLY safe because the sole real caller (`msgbox_handlers`) ALWAYS
      // supplies `env.to_did`.
      const payload = svcQuery({
        serviceUri: `at://${ATTACKER}/com.dinakernel.service.profile/store-x`,
        innerTo: ATTACKER,
        id: 'msg-svc-nobind',
      });
      const result = receiveD2D(payload, recipientPub, recipientPriv, [senderPub], 'trusted', {
        isCapabilityConfigured: () => true,
      });
      expect(result.action).toBe('bypassed');
    });
  });
});
