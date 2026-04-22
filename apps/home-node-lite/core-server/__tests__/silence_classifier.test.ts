/**
 * silence_classifier tests.
 */

import {
  DEFAULT_FIDUCIARY_KEYWORDS,
  DEFAULT_FIDUCIARY_WINDOW_SEC,
  DEFAULT_URGENCY_KEYWORDS,
  classifySilence,
  type SilenceClassifyInput,
} from '../src/brain/silence_classifier';

function input(overrides: Partial<SilenceClassifyInput> = {}): SilenceClassifyInput {
  return { nowSec: 1_000_000, ...overrides };
}

describe('classifySilence — rule order', () => {
  it('explicit priority wins over everything', () => {
    const r = classifySilence(
      input({
        text: 'Emergency!!',
        deadlineSec: 1_000_100,
        solicited: true,
        ring: 1,
        explicitPriority: 'engagement',
      }),
    );
    expect(r.priority).toBe('engagement');
    expect(r.reason).toBe('explicit_priority');
  });

  it('fiduciary keyword → fiduciary', () => {
    const r = classifySilence(input({ text: 'CALL 911 NOW' }));
    expect(r.priority).toBe('fiduciary');
    expect(r.reason).toBe('fiduciary_keyword');
  });

  it('deadline within window → fiduciary', () => {
    const r = classifySilence(
      input({
        nowSec: 1_000_000,
        deadlineSec: 1_000_000 + 60 * 60, // 1h away
      }),
    );
    expect(r.priority).toBe('fiduciary');
    expect(r.reason).toBe('deadline_within_window');
    const t = r.triggers[0] as { kind: 'deadline'; secondsUntil: number };
    expect(t.secondsUntil).toBe(3600);
  });

  it('deadline past now → not fiduciary', () => {
    const r = classifySilence(
      input({ nowSec: 1_000_000, deadlineSec: 999_000 }),
    );
    expect(r.priority).toBe('engagement');
  });

  it('deadline outside window → not fiduciary', () => {
    const r = classifySilence(
      input({
        nowSec: 1_000_000,
        deadlineSec: 1_000_000 + DEFAULT_FIDUCIARY_WINDOW_SEC + 60,
      }),
    );
    expect(r.priority).toBe('engagement');
  });

  it('health + urgency keyword → fiduciary', () => {
    const r = classifySilence(
      input({
        text: 'urgent checkup for the patient',
        healthSignal: true,
      }),
    );
    expect(r.priority).toBe('fiduciary');
    expect(r.reason).toBe('health_and_urgency');
  });

  it('health alone (no urgency) → engagement', () => {
    const r = classifySilence(input({ healthSignal: true, text: 'checkup' }));
    expect(r.priority).toBe('engagement');
  });

  it('solicited flag → solicited', () => {
    const r = classifySilence(input({ solicited: true }));
    expect(r.priority).toBe('solicited');
    expect(r.reason).toBe('solicited_flag');
  });

  it('ring-1 sender without solicited flag → solicited', () => {
    const r = classifySilence(input({ ring: 1 }));
    expect(r.priority).toBe('solicited');
    expect(r.reason).toBe('ring_1_sender');
  });

  it('ring-2 sender without other signals → engagement', () => {
    const r = classifySilence(input({ ring: 2 }));
    expect(r.priority).toBe('engagement');
  });

  it('ring-3 sender never escalates above engagement without other signals', () => {
    const r = classifySilence(input({ ring: 3 }));
    expect(r.priority).toBe('engagement');
  });

  it('default → engagement', () => {
    const r = classifySilence(input());
    expect(r.priority).toBe('engagement');
    expect(r.reason).toBe('default_engagement');
    expect(r.triggers).toEqual([]);
  });
});

describe('classifySilence — keyword detection', () => {
  it('fiduciary keyword detected via keywords array', () => {
    const r = classifySilence(input({ keywords: ['emergency', 'todo'] }));
    expect(r.priority).toBe('fiduciary');
  });

  it('keywords array is lowercased before matching', () => {
    const r = classifySilence(input({ keywords: ['EMERGENCY'] }));
    expect(r.priority).toBe('fiduciary');
  });

  it('text scan finds fiduciary keyword as substring', () => {
    const r = classifySilence(
      input({ text: 'Hello there is a SECURITY ALERT on your account' }),
    );
    expect(r.priority).toBe('fiduciary');
  });

  it('case-insensitive text scan', () => {
    const r = classifySilence(input({ text: 'Final Notice from bank' }));
    expect(r.priority).toBe('fiduciary');
  });

  it('text without trigger words → engagement', () => {
    const r = classifySilence(input({ text: 'hello there, how are you' }));
    expect(r.priority).toBe('engagement');
  });

  it('urgency keyword alone (no health) → engagement', () => {
    const r = classifySilence(input({ text: 'urgent reply needed' }));
    expect(r.priority).toBe('engagement');
  });

  it('caller-supplied fiduciaryKeywords override defaults', () => {
    const r = classifySilence(
      input({ text: 'custom-trigger here' }),
      { fiduciaryKeywords: ['custom-trigger'] },
    );
    expect(r.priority).toBe('fiduciary');
  });

  it('caller-supplied urgencyKeywords tracked for health escalation', () => {
    const r = classifySilence(
      input({ text: 'stat blood draw', healthSignal: true }),
      { urgencyKeywords: ['stat'] },
    );
    expect(r.priority).toBe('fiduciary');
    expect(r.reason).toBe('health_and_urgency');
  });
});

describe('classifySilence — window option', () => {
  it('custom fiduciaryWindowSec tightens the deadline rule', () => {
    const r = classifySilence(
      input({
        nowSec: 1000,
        deadlineSec: 1000 + 1800, // 30min
      }),
      { fiduciaryWindowSec: 900 }, // 15min window
    );
    expect(r.priority).toBe('engagement');
  });
});

describe('classifySilence — input validation (graceful)', () => {
  it('null input → engagement default', () => {
    const r = classifySilence(null as unknown as SilenceClassifyInput);
    expect(r.priority).toBe('engagement');
  });

  it('non-finite nowSec → engagement default', () => {
    const r = classifySilence(input({ nowSec: Number.NaN }));
    expect(r.priority).toBe('engagement');
  });

  it('invalid ring → engagement default', () => {
    const r = classifySilence(
      input({ ring: 4 as unknown as 1 | 2 | 3 }),
    );
    expect(r.priority).toBe('engagement');
  });
});

describe('classifySilence — combined signals', () => {
  it('fiduciary keyword + solicited flag → fiduciary (keyword wins)', () => {
    const r = classifySilence(
      input({ text: 'emergency', solicited: true }),
    );
    expect(r.priority).toBe('fiduciary');
  });

  it('solicited flag + ring-2 → solicited (flag wins over ring)', () => {
    const r = classifySilence(input({ solicited: true, ring: 2 }));
    expect(r.priority).toBe('solicited');
    expect(r.reason).toBe('solicited_flag');
  });

  it('deadline + solicited → fiduciary (deadline wins)', () => {
    const r = classifySilence(
      input({
        nowSec: 1000,
        deadlineSec: 2000,
        solicited: true,
      }),
    );
    expect(r.priority).toBe('fiduciary');
  });
});

describe('DEFAULT constants', () => {
  it('DEFAULT_FIDUCIARY_WINDOW_SEC is 6 hours', () => {
    expect(DEFAULT_FIDUCIARY_WINDOW_SEC).toBe(6 * 60 * 60);
  });

  it('fiduciary keywords contain "emergency" + "call 911"', () => {
    expect(DEFAULT_FIDUCIARY_KEYWORDS).toContain('emergency');
    expect(DEFAULT_FIDUCIARY_KEYWORDS).toContain('call 911');
  });

  it('urgency keywords contain "urgent" + "asap"', () => {
    expect(DEFAULT_URGENCY_KEYWORDS).toContain('urgent');
    expect(DEFAULT_URGENCY_KEYWORDS).toContain('asap');
  });
});
