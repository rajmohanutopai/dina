/**
 * Composer mode definitions + user-bubble chip resolver
 * (docs/COMPOSER_MODES_DESIGN.md).
 *
 * Pins the INV-3 display contract that the live Maestro flow exercises but no
 * jest test covered before: a sent user bubble shows CLEAN content + a mode
 * chip, never a leaked slash prefix. resolveUserChip is the pure logic lifted
 * out of ChatScreen so it can be asserted without rendering the screen.
 */

import { ACTIONS, resolveUserChip } from '../../src/components/composer_modes';

describe('ACTIONS — composer mode table', () => {
  it('keys are unique', () => {
    const keys = ACTIONS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every prefix is a slash command with a trailing space', () => {
    for (const a of ACTIONS) {
      expect(a.prefix).toMatch(/^\/[a-z]+ $/);
      expect(a.prefix).toBe(`/${a.key} `);
    }
  });

  it('includes the explicit external lanes Services + Reviews', () => {
    const byKey = Object.fromEntries(ACTIONS.map((a) => [a.key, a]));
    expect(byKey.services?.prefix).toBe('/services ');
    expect(byKey.reviews?.prefix).toBe('/reviews ');
    // Reviews surfaces the user-facing "Ranked Reviews" name (never "PeerLens").
    expect(byKey.reviews?.description).toMatch(/Ranked Reviews/);
    expect(JSON.stringify(ACTIONS)).not.toMatch(/PeerLens/i);
  });

  it('Talk is NOT a text mode (it is a navigation chip, handled separately)', () => {
    expect(ACTIONS.map((a) => a.key)).not.toContain('talk');
  });
});

describe('resolveUserChip — metadata.mode (new messages)', () => {
  it.each([
    ['ask', 'Ask'],
    ['remember', 'Remember'],
    ['task', 'Task'],
    ['services', 'Services'],
    ['reviews', 'Reviews'],
  ])('mode=%s → %s chip, content untouched', (mode, label) => {
    const { chipLabel, displayContent } = resolveUserChip('price of kebab nearby', mode);
    expect(chipLabel).toBe(label);
    expect(displayContent).toBe('price of kebab nearby');
  });

  it('metadata.mode wins even when content coincidentally starts with a prefix', () => {
    // Clean content is authoritative; we must NOT double-strip.
    const { chipLabel, displayContent } = resolveUserChip('/ask literally my question', 'services');
    expect(chipLabel).toBe('Services');
    expect(displayContent).toBe('/ask literally my question');
  });

  it('an unknown mode falls through to the prefix/none path (no crash)', () => {
    const { chipLabel, displayContent } = resolveUserChip('hello there', 'bogus-mode');
    expect(chipLabel).toBeNull();
    expect(displayContent).toBe('hello there');
  });
});

describe('resolveUserChip — legacy prefix fallback (older persisted messages)', () => {
  it('strips a known slash prefix and labels the chip', () => {
    const { chipLabel, displayContent } = resolveUserChip('/reviews is the Sony XM5 good?', undefined);
    expect(chipLabel).toBe('Reviews');
    expect(displayContent).toBe('is the Sony XM5 good?');
  });

  it('non-string mode (undefined / number) uses the prefix path', () => {
    expect(resolveUserChip('/services kebab', undefined).chipLabel).toBe('Services');
    expect(resolveUserChip('/services kebab', 42).displayContent).toBe('kebab');
  });
});

describe('resolveUserChip — plain text (no chip)', () => {
  it('returns no chip and verbatim content for a non-command, no-mode message', () => {
    const { chipLabel, displayContent } = resolveUserChip('just a normal message', undefined);
    expect(chipLabel).toBeNull();
    expect(displayContent).toBe('just a normal message');
  });
});
