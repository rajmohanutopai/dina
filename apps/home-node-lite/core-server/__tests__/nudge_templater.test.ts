/**
 * nudge_templater tests.
 */

import type { DeepLinkPayload } from '../src/brain/deep_link_builder';
import {
  DEFAULT_MAX_CHARS,
  NudgeTemplateError,
  renderNudge,
  type NudgeInput,
} from '../src/brain/nudge_templater';

function input(overrides: Partial<NudgeInput> = {}): NudgeInput {
  return {
    priority: 'engagement',
    topic: 'Quarterly review',
    action: 'review the slides',
    ...overrides,
  };
}

describe('renderNudge — input validation', () => {
  it.each([
    ['null input', null],
    ['bogus priority', { ...input(), priority: 'bogus' as NudgeInput['priority'] }],
    ['empty topic', { ...input(), topic: '' }],
    ['whitespace topic', { ...input(), topic: '   ' }],
    ['empty action', { ...input(), action: '' }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() =>
      renderNudge(bad as NudgeInput),
    ).toThrow(NudgeTemplateError);
  });
});

describe('renderNudge — priority glyphs', () => {
  it('fiduciary uses 🚨', () => {
    expect(renderNudge(input({ priority: 'fiduciary' }))).toMatch(/^🚨 /);
  });

  it('solicited uses 🔔', () => {
    expect(renderNudge(input({ priority: 'solicited' }))).toMatch(/^🔔 /);
  });

  it('engagement uses ·', () => {
    expect(renderNudge(input({ priority: 'engagement' }))).toMatch(/^· /);
  });

  it('glyphOverrides swaps glyph', () => {
    const out = renderNudge(
      input({ priority: 'fiduciary' }),
      { glyphOverrides: { fiduciary: '⚡' } },
    );
    expect(out.startsWith('⚡ ')).toBe(true);
  });

  it('empty glyph produces text-only output', () => {
    const out = renderNudge(
      input({ priority: 'engagement' }),
      { glyphOverrides: { engagement: '' } },
    );
    expect(out.startsWith('·')).toBe(false);
    expect(out.startsWith('Quarterly')).toBe(true);
  });
});

describe('renderNudge — subject rendering', () => {
  it('self subject → "you"', () => {
    const out = renderNudge(input({ subject: { kind: 'self' } }));
    expect(out).toContain('you: Quarterly review');
  });

  it('contact subject → contact name', () => {
    const out = renderNudge(input({ subject: { kind: 'contact', name: 'Alice' } }));
    expect(out).toContain('Alice: Quarterly review');
  });

  it('group subject uses default label "your family"', () => {
    const out = renderNudge(input({ subject: { kind: 'group' } }));
    expect(out).toContain('your family: Quarterly review');
  });

  it('group subject with explicit label', () => {
    const out = renderNudge(
      input({ subject: { kind: 'group', label: 'the team' } }),
    );
    expect(out).toContain('the team: Quarterly review');
  });

  it('group label override via opts', () => {
    const out = renderNudge(
      input({ subject: { kind: 'group' } }),
      { groupLabel: 'household' },
    );
    expect(out).toContain('household: Quarterly review');
  });

  it('unknown subject → omitted (no "subject: topic" prefix)', () => {
    const out = renderNudge(input({ subject: { kind: 'unknown' } }));
    expect(out).not.toContain(': Quarterly review');
    expect(out).toContain('Quarterly review');
  });

  it('no subject at all → omitted', () => {
    const out = renderNudge(input());
    expect(out).not.toContain(': ');
    expect(out).toContain('Quarterly review');
  });

  it('empty contact name falls back to no subject', () => {
    const out = renderNudge(input({ subject: { kind: 'contact', name: '   ' } }));
    expect(out).not.toContain(': Quarterly review');
  });
});

describe('renderNudge — topic + action + context', () => {
  it('core pattern: "<topic> — <action>"', () => {
    const out = renderNudge(input());
    expect(out).toContain('Quarterly review — review the slides');
  });

  it('context appended after action', () => {
    const out = renderNudge(input({ context: 'before Friday' }));
    expect(out).toContain('review the slides before Friday');
  });

  it('context trimmed', () => {
    const out = renderNudge(input({ context: '  before noon  ' }));
    expect(out).toContain('review the slides before noon');
    expect(out).not.toContain('  before noon');
  });

  it('topic + action trimmed', () => {
    const out = renderNudge(
      input({ topic: '  trimme topic  ', action: '  click  ' }),
    );
    expect(out).toContain('trimme topic — click');
  });
});

describe('renderNudge — deep-link attribution', () => {
  const payload: DeepLinkPayload = {
    url: 'https://www.example.com/article',
    host: 'www.example.com',
    anchor: 'example.com',
    author: 'Alice Jones',
    publisher: 'Dina Times',
    publishedAtIso: '2026-04-22T00:00:00.000Z',
    publishedAtSec: 1_745_000_000,
    excerpt: null,
    ref: null,
  };

  it('attribution appended in parens by default (no URL)', () => {
    const out = renderNudge(input({ deepLink: payload }));
    expect(out).toContain('(Alice Jones, Dina Times, 2026-04-22)');
    expect(out).not.toContain('https://');
  });

  it('includeLinkUrl=true adds the URL', () => {
    const out = renderNudge(input({ deepLink: payload }), { includeLinkUrl: true });
    expect(out).toContain('https://www.example.com/article');
  });

  it('attribution without author uses publisher + date', () => {
    const noAuthor: DeepLinkPayload = { ...payload, author: null };
    const out = renderNudge(input({ deepLink: noAuthor }));
    expect(out).toContain('(Dina Times, 2026-04-22)');
  });

  it('attribution without date uses just publisher', () => {
    const noDate: DeepLinkPayload = {
      ...payload,
      author: null,
      publishedAtIso: null,
      publishedAtSec: null,
    };
    const out = renderNudge(input({ deepLink: noDate }));
    expect(out).toContain('(Dina Times)');
  });
});

describe('renderNudge — length cap', () => {
  it('truncates with ellipsis when over cap', () => {
    const out = renderNudge(
      input({ topic: 'x'.repeat(500) }),
      { maxChars: 50 },
    );
    expect(out.length).toBe(50);
    expect(out.endsWith('…')).toBe(true);
  });

  it('under cap → no truncation', () => {
    const out = renderNudge(input(), { maxChars: 1000 });
    expect(out.endsWith('…')).toBe(false);
  });

  it('DEFAULT_MAX_CHARS is 280', () => {
    expect(DEFAULT_MAX_CHARS).toBe(280);
  });
});

describe('renderNudge — integration', () => {
  it('full nudge: fiduciary + contact + topic + action + context + deepLink', () => {
    const link: DeepLinkPayload = {
      url: 'https://dr.example/appt',
      host: 'dr.example',
      anchor: 'dr.example',
      author: null,
      publisher: 'dr.example',
      publishedAtIso: null,
      publishedAtSec: null,
      excerpt: null,
      ref: null,
    };
    const out = renderNudge(
      input({
        priority: 'fiduciary',
        subject: { kind: 'contact', name: 'Dr. Smith' },
        topic: 'Appointment at 3pm',
        action: 'confirm or reschedule',
        context: 'today',
        deepLink: link,
      }),
    );
    expect(out).toBe(
      '🚨 Dr. Smith: Appointment at 3pm — confirm or reschedule today (dr.example)',
    );
  });

  it('plain engagement nudge with no extras', () => {
    const out = renderNudge(input());
    expect(out).toBe('· Quarterly review — review the slides');
  });
});
