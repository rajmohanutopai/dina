/**
 * Onboarding state machine — the shared mandatory `ai_provider` step and the
 * progress-total bumps it introduced (create 6→7, recover 4→5, external 5→6).
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
  const back: Step = { kind: 'create_mnemonic_verify', draft };
  const ai: Step = {
    kind: 'ai_provider',
    next,
    back,
    location: { current: 6, total: 7, label: 'Connect AI' },
  };

  it('locateStep returns the carried location', () => {
    expect(locateStep(ai)).toEqual({ current: 6, total: 7, label: 'Connect AI' });
  });

  it('previousStep returns the carried back step', () => {
    expect(previousStep(ai)).toEqual(back);
  });

  it('create flow totals bumped to 7 with provisioning last', () => {
    expect(locateStep({ kind: 'create_name', draft })?.total).toBe(7);
    expect(locateStep({ kind: 'create_mnemonic_verify', draft })).toMatchObject({
      current: 5,
      total: 7,
    });
    expect(locateStep({ kind: 'provisioning_create', draft })).toMatchObject({
      current: 7,
      total: 7,
    });
  });

  it('recover flow totals bumped to 5', () => {
    expect(locateStep({ kind: 'recover_mnemonic', draft: {} })?.total).toBe(5);
    expect(locateStep({ kind: 'provisioning_recover', draft: {} as never })).toMatchObject({
      current: 5,
      total: 5,
    });
  });

  it('external flow totals bumped to 6', () => {
    expect(locateStep({ kind: 'external_identity', draft: {} })?.total).toBe(6);
    expect(locateStep({ kind: 'provisioning_external', draft: {} as never })).toMatchObject({
      current: 6,
      total: 6,
    });
  });
});
