/**
 * Onboarding state machine — the shared mandatory `ai_provider` step and the
 * progress totals.
 *
 * The recovery-phrase reveal/verify screens were removed from the create +
 * external paths (the phrase is generated silently and backed up later via the
 * deferred backup prompt — see services/backup_prompt). So the create flow is
 * 5 steps (name, handle, passphrase, AI, setting up) and external is 4
 * (identity, local vault, AI, connecting). The AI step now sits right after
 * the passphrase step, and its `back` target is the passphrase — never a
 * (now-skipped) mnemonic-confirm.
 */

import {
  locateStep,
  previousStep,
  type CreateDraft,
  type Step,
} from '../../src/onboarding/state';

const draft = {} as CreateDraft; // locateStep/previousStep switch on `kind` only.

describe('ai_provider onboarding step', () => {
  const next: Step = { kind: 'provisioning_create', draft };
  // Back from AI goes to the passphrase step now — the reveal/verify wall is gone.
  const back: Step = { kind: 'create_passphrase', draft };
  const ai: Step = {
    kind: 'ai_provider',
    next,
    back,
    location: { current: 4, total: 5, label: 'Connect AI' },
  };

  it('locateStep returns the carried location', () => {
    expect(locateStep(ai)).toEqual({ current: 4, total: 5, label: 'Connect AI' });
  });

  it('previousStep returns the carried back step (passphrase, not a phrase step)', () => {
    expect(previousStep(ai)).toEqual(back);
  });

  it('create flow is 5 steps with no phrase reveal/verify in the path', () => {
    expect(locateStep({ kind: 'create_name', draft })?.total).toBe(5);
    expect(locateStep({ kind: 'create_passphrase', draft })).toMatchObject({
      current: 3,
      total: 5,
    });
    expect(locateStep({ kind: 'provisioning_create', draft })).toMatchObject({
      current: 5,
      total: 5,
    });
  });

  it('recover flow totals are 5', () => {
    expect(locateStep({ kind: 'recover_mnemonic', draft: {} })?.total).toBe(5);
    expect(locateStep({ kind: 'provisioning_recover', draft: {} as never })).toMatchObject({
      current: 5,
      total: 5,
    });
  });

  it('external flow is 4 steps (phrase steps removed)', () => {
    expect(locateStep({ kind: 'external_identity', draft: {} })?.total).toBe(4);
    expect(locateStep({ kind: 'provisioning_external', draft: {} as never })).toMatchObject({
      current: 4,
      total: 4,
    });
  });
});
