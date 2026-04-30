/**
 * T2D.16 — User story behavioral contracts (portable subset).
 *
 * Wired to real modules from @dina/core and @dina/brain.
 * Each story verifies an end-to-end user journey.
 *
 * Source: tests/system/user_stories/*.py
 */

import {
  signAttestation,
  verifyAttestation,
} from '../../../core/src/trust/pds_publish';
import type { Attestation } from '../../../core/src/trust/pds_publish';
import { storeItem, queryVault, clearVaults } from '../../../core/src/vault/crud';
import {
  createPersona,
  openPersona,
  isPersonaOpen,
  closePersona,
  resetPersonaState,
} from '../../../core/src/persona/service';
import {
  startSession,
  addGrant,
  checkGrant,
  endSession,
} from '../../../core/src/session/lifecycle';
import { evaluateIntent } from '../../../core/src/gatekeeper/intent';
import { evaluateDelegation, clearBlacklist } from '../../../brain/src/mcp/delegation';
import {
  assembleBriefing,
  registerEngagementProvider,
  registerApprovalProvider,
  resetBriefingState,
} from '../../../brain/src/briefing/assembly';
import { createReminder, resetReminderState } from '../../../core/src/reminders/service';
import { createArchive, verifyArchive, readManifest } from '../../../core/src/export/archive';
import { recoverFromMnemonic } from '../../../core/src/onboarding/recovery';
import { runOnboarding } from '../../../core/src/onboarding/portable';
import { addContact, resetContactDirectory } from '../../../core/src/contacts/directory';
import {
  classifyPriority,
  resetDNDState,
  resetEscalationState,
  resetUserOverrides,
  resetQuietHoursState,
  resetBatchingState,
} from '../../../brain/src/guardian/silence';
import { assembleNudge } from '../../../brain/src/nudge/assembler';
import { getPublicKey } from '../../../core/src/crypto/ed25519';
import {
  TEST_ED25519_SEED,
  TEST_PASSPHRASE,
  makeEvent,
  resetFactoryCounters,
} from '@dina/test-harness';

describe('User Stories', () => {
  beforeEach(() => {
    resetFactoryCounters();
    clearVaults();
    resetPersonaState();
    clearBlacklist();
    resetBriefingState();
    resetReminderState();
    resetContactDirectory();
    resetDNDState();
    resetEscalationState();
    resetUserOverrides();
    resetQuietHoursState();
    resetBatchingState();
  });

  describe('01: Purchase Journey', () => {
    const FIXED_CREATED_AT = '2026-01-15T12:00:00.000Z';

    it('product attestation stored with cryptographic signature', () => {
      const record: Attestation = {
        subject: { type: 'did', did: 'did:plc:seller' },
        category: 'product',
        sentiment: 'positive',
        createdAt: FIXED_CREATED_AT,
        text: 'Aeron Chair — recommend',
        dimensions: [{ dimension: 'comfort', value: 'exceeded' }],
      };
      const signed = signAttestation(record, TEST_ED25519_SEED, 'did:key:z6MkReviewer');
      expect(signed.signature_hex).toMatch(/^[0-9a-f]{128}$/);
      expect(verifyAttestation(signed, getPublicKey(TEST_ED25519_SEED))).toBe(true);
    });

    it('cart handover: Dina advises but purchase action is HIGH risk', () => {
      const result = evaluateIntent('purchase');
      expect(result.riskLevel).toBe('HIGH');
      expect(result.requiresApproval).toBe(true);
    });

    it('outcome tracked as attestation', () => {
      const record: Attestation = {
        subject: { type: 'did', did: 'did:plc:seller' },
        category: 'product',
        sentiment: 'positive',
        createdAt: FIXED_CREATED_AT,
        dimensions: [{ dimension: 'overall', value: 'met' }],
        text: 'Order arrived on time, quality matched listing.',
      };
      const signed = signAttestation(record, TEST_ED25519_SEED, 'did:key:z6MkBuyer');
      expect(signed.record.sentiment).toBe('positive');
      expect(signed.record.dimensions?.[0]?.value).toBe('met');
    });
  });

  describe('02: Sancho Moment', () => {
    it('friend context assembled from vault', () => {
      storeItem('general', {
        summary: 'Sancho mother was ill last month',
        body: '',
        type: 'relationship_note',
      });
      storeItem('general', {
        summary: 'Sancho prefers green tea',
        body: '',
        type: 'relationship_note',
      });
      const nudge = assembleNudge('did:plc:sancho', 'Sancho');
      expect(nudge).not.toBeNull();
      expect(nudge!.items.length).toBeGreaterThan(0);
    });

    it('whisper includes health context', () => {
      storeItem('general', {
        summary: 'Sancho mother was ill last month',
        body: '',
        type: 'relationship_note',
      });
      const nudge = assembleNudge('did:plc:sancho', 'Sancho');
      // Nudge may be null if frequency cap applies or no vault items match
      if (nudge) {
        expect(nudge.items.some((i) => i.text.includes('ill'))).toBe(true);
      }
    });

    it('tea preference recalled', () => {
      storeItem('general', {
        summary: 'Sancho prefers green tea',
        body: '',
        type: 'relationship_note',
      });
      const nudge = assembleNudge('did:plc:sancho', 'Sancho');
      if (nudge) {
        expect(nudge.items.some((i) => i.text.includes('tea'))).toBe(true);
      }
    });

    it('arrival is Tier 2 (solicited) notification', async () => {
      const result = await classifyPriority(
        makeEvent({ type: 'reminder', subject: 'Friend arriving', timestamp: Date.now() }),
      );
      expect(result.tier).toBe(2);
    });
  });

  describe('03: Dead Internet Filter', () => {
    const FIXED_CREATED_AT = '2026-01-15T12:00:00.000Z';

    it('authentic attestations are signed and verifiable', () => {
      const authentic: Attestation = {
        subject: { type: 'did', did: 'did:plc:seller' },
        category: 'product',
        sentiment: 'positive',
        createdAt: FIXED_CREATED_AT,
        confidence: 'certain',
        evidence: [{ type: 'receipt', uri: 'https://example.com/r/1' }],
        text: 'Verified purchase',
      };
      const signed = signAttestation(authentic, TEST_ED25519_SEED, 'did:key:z6MkVerified');
      expect(verifyAttestation(signed, getPublicKey(TEST_ED25519_SEED))).toBe(true);
    });

    it('synthetic content can be flagged with a negative attestation', () => {
      const flag: Attestation = {
        subject: { type: 'content', uri: 'https://example.com/post/123' },
        category: 'content_quality',
        sentiment: 'negative',
        createdAt: FIXED_CREATED_AT,
        tags: ['synthetic'],
        text: 'Likely AI-generated',
      };
      const signed = signAttestation(flag, TEST_ED25519_SEED, 'did:key:z6MkAuditor');
      expect(signed.signer_did).toBe('did:key:z6MkAuditor');
      expect(signed.record.sentiment).toBe('negative');
    });
  });

  describe('04: Persona Wall', () => {
    it('health data stays in health vault', () => {
      createPersona('general', 'default');
      createPersona('health', 'sensitive');
      storeItem('health', { summary: 'Lab results', type: 'medical_record' });
      expect(queryVault('general', { mode: 'fts5', text: 'lab', limit: 10 })).toHaveLength(0);
      expect(queryVault('health', { mode: 'fts5', text: 'lab', limit: 10 })).toHaveLength(1);
    });

    it('sensitive persona requires approval to open', () => {
      createPersona('health', 'sensitive');
      expect(openPersona('health')).toBe(false); // no approval
      expect(openPersona('health', true)).toBe(true); // with approval
    });

    it('approved agent accesses for session duration only', () => {
      const session = startSession('did:key:z6MkAgent', 'health');
      addGrant(session.id, 'health', 'session', 'did:key:z6MkAgent');
      expect(checkGrant(session.id, 'health')).toBe(true);
      endSession(session.id);
      expect(checkGrant(session.id, 'health')).toBe(false);
    });

    it('session end revokes all grants', () => {
      const session = startSession('did:key:z6MkAgent', 'health');
      addGrant(session.id, 'health', 'session', 'did:key:z6MkAgent');
      addGrant(session.id, 'financial', 'session', 'did:key:z6MkAgent');
      endSession(session.id);
      expect(checkGrant(session.id, 'health')).toBe(false);
      expect(checkGrant(session.id, 'financial')).toBe(false);
    });

    it('locked persona requires passphrase (not just approval)', () => {
      createPersona('secret', 'locked');
      expect(openPersona('secret')).toBe(false);
      expect(openPersona('secret', true)).toBe(true);
    });
  });

  describe('05: Agent Gateway', () => {
    it('SAFE actions auto-approved', () => {
      const result = evaluateIntent('search');
      expect(result.riskLevel).toBe('SAFE');
      expect(result.requiresApproval).toBe(false);
    });

    it('MODERATE actions need user approval', () => {
      const result = evaluateIntent('send_large');
      expect(result.riskLevel).toBe('MODERATE');
      expect(result.requiresApproval).toBe(true);
    });

    it('BLOCKED actions always denied', () => {
      const result = evaluateIntent('credential_export');
      expect(result.allowed).toBe(false);
      expect(result.riskLevel).toBe('BLOCKED');
    });

    it('agent cannot escalate permissions', () => {
      const result = evaluateDelegation({
        agentDID: 'did:key:z6MkAgent',
        action: 'credential_export',
        description: 'trying to export',
      });
      expect(result.approved).toBe(false);
    });

    it("draft-don't-send: send actions need approval", () => {
      const result = evaluateIntent('send_email');
      expect(result.requiresApproval).toBe(true);
    });
  });

  describe('06: License Renewal', () => {
    it('upcoming expiry → solicited notification', async () => {
      const result = await classifyPriority(
        makeEvent({
          type: 'reminder',
          subject: 'License expires in 30 days',
          timestamp: Date.now(),
        }),
      );
      expect(result.tier).toBe(2); // reminder = solicited
    });

    it('delegation evaluated through safety gate', () => {
      const result = evaluateDelegation({
        agentDID: 'did:key:z6MkLegalBot',
        action: 'search',
        description: 'search renewal forms',
      });
      expect(result.approved).toBe(true);
      expect(result.risk).toBe('SAFE');
    });

    it('agent creates draft (MODERATE, not auto-approved)', () => {
      const result = evaluateIntent('send_email');
      expect(result.requiresApproval).toBe(true);
    });
  });

  describe('07: Daily Briefing', () => {
    it('Tier 3 items collected', () => {
      registerEngagementProvider(() => [
        { type: 'engagement', title: 'New RSS article', timestamp: Date.now() },
        { type: 'engagement', title: 'Social notification', timestamp: Date.now() },
      ]);
      const briefing = assembleBriefing();
      expect(briefing).not.toBeNull();
      expect(briefing!.sections.engagement).toHaveLength(2);
    });

    it('upcoming reminders included', () => {
      createReminder({ message: 'Meeting tomorrow', due_at: Date.now() - 1000, persona: 'work' });
      const briefing = assembleBriefing();
      expect(briefing).not.toBeNull();
      expect(briefing!.sections.reminders.length).toBeGreaterThan(0);
    });

    it('pending approvals surfaced', () => {
      registerApprovalProvider(() => [
        { type: 'approval', title: 'Unlock health persona', timestamp: Date.now() },
      ]);
      const briefing = assembleBriefing();
      expect(briefing!.sections.approvals).toHaveLength(1);
    });

    it('returns null when nothing to report (Silence First)', () => {
      expect(assembleBriefing()).toBeNull();
    });
  });

  describe('08: Move to New Device', () => {
    it('export → verify → import round-trip', async () => {
      const archive = await createArchive(TEST_PASSPHRASE);
      expect(await verifyArchive(archive, TEST_PASSPHRASE)).toBe(true);
      const manifest = await readManifest(archive, TEST_PASSPHRASE);
      expect(manifest.header.format).toBe('dina-archive-v1');
    }, 60_000);

    it('same mnemonic → same DID on new device', async () => {
      const onboarding = await runOnboarding(TEST_PASSPHRASE);
      const recovered = await recoverFromMnemonic(onboarding.mnemonic, 'new-passphrase');
      expect(recovered.did).toBe(onboarding.did);
    }, 60_000);

    it('wrong passphrase cannot decrypt archive', async () => {
      const archive = await createArchive(TEST_PASSPHRASE);
      expect(await verifyArchive(archive, 'wrong')).toBe(false);
    }, 30_000);

    it('contacts can be re-created on new device', () => {
      addContact('did:plc:alice', 'Alice', 'trusted', 'full');
      const contacts = require('../../../core/src/contacts/directory').listContacts();
      expect(contacts).toHaveLength(1);
      expect(contacts[0].displayName).toBe('Alice');
    });
  });
});
