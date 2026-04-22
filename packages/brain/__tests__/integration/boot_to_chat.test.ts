/**
 * Capstone: Boot-to-Chat Integration Test
 *
 * The ultimate integration test — exercises the entire system from
 * cold start to chat response:
 *
 *   1. Onboard (generate mnemonic → wrap seed)
 *   2. Unlock (unwrap seed → derive keys → open personas)
 *   3. Store vault items
 *   4. Ingest via staging pipeline (dedup → classify → enrich → resolve)
 *   5. Chat reasoning (vault search → context → answer)
 *   6. Guardian classification (silence tier)
 *   7. Health check (all systems green)
 *
 * This test proves the entire Dina mobile architecture works end-to-end.
 */

import { runOnboarding } from '../../../core/src/onboarding/portable';
import { fullUnlock } from '../../../core/src/lifecycle/unlock';
import { deserializeWrappedSeed } from '../../../core/src/storage/seed_file';
import {
  createPersona,
  listPersonas,
  isPersonaOpen,
  resetPersonaState,
} from '../../../core/src/persona/service';
import { storeItem, queryVault, clearVaults } from '../../../core/src/vault/crud';
import { ingest, claim, resolve, resetStagingState } from '../../../core/src/staging/service';
import { classifyItem, enrichItem } from '../../src/staging/processor';
import { reason, resetReasoningLLM } from '../../src/pipeline/chat_reasoning';
import {
  classifyPriority,
  resetDNDState,
  resetEscalationState,
  resetUserOverrides,
  resetQuietHoursState,
  resetBatchingState,
} from '../../src/guardian/silence';
import { runHealthCheck } from '../../../core/src/diagnostics/health';
import { resetAuditState, auditCount } from '../../../core/src/audit/service';
import { resetRotationState, getCurrentGeneration } from '../../../core/src/identity/rotation';
import { resetLifecycleState, areSecretsZeroed } from '../../../core/src/lifecycle/sleep_wake';
import { resetReminderState } from '../../../core/src/reminders/service';
import { setAccessiblePersonas } from '../../src/vault_context/assembly';
import { makeEvent, TEST_PASSPHRASE, resetFactoryCounters } from '@dina/test-harness';

describe('Boot-to-Chat Integration (Capstone)', () => {
  beforeEach(() => {
    resetPersonaState();
    clearVaults();
    resetStagingState();
    resetAuditState();
    resetRotationState();
    resetLifecycleState();
    resetReminderState();
    resetReasoningLLM();
    resetFactoryCounters();
    resetDNDState();
    resetEscalationState();
    resetUserOverrides();
    resetQuietHoursState();
    resetBatchingState();
  });

  it('full lifecycle: onboard → unlock → store → ingest → reason → respond', async () => {
    // ========== PHASE 1: ONBOARD ==========
    const onboarding = await runOnboarding(TEST_PASSPHRASE);
    expect(onboarding.mnemonic).toHaveLength(24);
    expect(onboarding.did).toMatch(/^did:key:z6Mk/);
    expect(onboarding.wrapped.length).toBeGreaterThan(32);

    // ========== PHASE 2: UNLOCK ==========
    const wrappedSeed = deserializeWrappedSeed(onboarding.wrapped);
    const unlock = await fullUnlock({
      passphrase: TEST_PASSPHRASE,
      wrappedSeed,
      personas: [
        { name: 'general', tier: 'default' },
        { name: 'work', tier: 'standard' },
        { name: 'health', tier: 'sensitive' },
      ],
    });

    expect(unlock.did).toBe(onboarding.did); // same DID
    expect(unlock.personasOpened).toContain('general');
    expect(unlock.personasOpened).toContain('work');
    expect(unlock.personasOpened).not.toContain('health'); // sensitive = closed
    expect(isPersonaOpen('general')).toBe(true);
    expect(getCurrentGeneration()).toBe(0);
    expect(areSecretsZeroed()).toBe(false);

    // ========== PHASE 3: STORE VAULT ITEMS ==========
    storeItem('general', {
      summary: 'Alice likes dark roast coffee and craft beer',
      body: 'From conversation at the conference',
      type: 'relationship_note',
    });
    storeItem('general', {
      summary: 'Meeting with Bob next Thursday about project',
      body: 'Discuss Q4 roadmap and budget',
      type: 'email',
    });
    storeItem('work', {
      summary: 'Quarterly budget review presentation',
      body: 'Slides ready for the board meeting',
      type: 'note',
    });

    // Verify vault search works
    const aliceResults = queryVault('general', { mode: 'fts5', text: 'Alice coffee', limit: 10 });
    expect(aliceResults.length).toBeGreaterThan(0);

    // ========== PHASE 4: STAGING PIPELINE ==========
    const { id: stagingId } = ingest({
      source: 'gmail',
      source_id: 'email-from-alice',
      data: {
        summary: 'Alice: Birthday party next month',
        body: 'Hi! My birthday is coming up, would love to see you there.',
        sender: 'alice@example.com',
        type: 'email',
      },
    });

    const claimed = claim(10);
    expect(claimed).toHaveLength(1);

    // Classify
    const classification = await classifyItem(claimed[0].data as Record<string, unknown>);
    expect(classification.persona).toBeTruthy();

    // Enrich
    const enriched = await enrichItem(claimed[0].data as Record<string, unknown>);
    expect(enriched.content_l0).toBeTruthy();
    expect(enriched.enrichment_status).toBe('l0_complete');

    // Resolve to vault
    resolve(stagingId, 'general', true);

    // ========== PHASE 5: CHAT REASONING ==========
    setAccessiblePersonas(['general', 'work']);
    const chatResult = await reason({
      query: 'Alice coffee',
      persona: 'general',
      provider: 'none', // no LLM — context-only answer
    });

    expect(chatResult.answer).toBeTruthy();
    expect(chatResult.answer.length).toBeGreaterThan(10);
    expect(chatResult.sources.length).toBeGreaterThan(0);
    expect(chatResult.persona).toBe('general');

    // ========== PHASE 6: GUARDIAN CLASSIFICATION ==========
    const priority = await classifyPriority(
      makeEvent({
        source: 'bank',
        subject: 'Security Alert: unusual login',
      }),
    );
    expect(priority.tier).toBe(1); // fiduciary

    const engagement = await classifyPriority(
      makeEvent({
        type: 'notification',
        subject: 'New RSS article',
      }),
    );
    expect(engagement.tier).toBe(3); // engagement

    // ========== PHASE 7: HEALTH CHECK ==========
    const health = runHealthCheck();
    expect(health.overall).not.toBe('fail');
    expect(health.checks.length).toBeGreaterThanOrEqual(6);
    const vaultCheck = health.checks.find((c) => c.name === 'vault_access');
    expect(vaultCheck!.status).toBe('pass');

    // ========== VERIFY: SYSTEM STATE ==========
    expect(listPersonas()).toHaveLength(3);
    expect(isPersonaOpen('general')).toBe(true);
    expect(isPersonaOpen('health')).toBe(false);
  }, 60_000); // 60s timeout for Argon2id
});
