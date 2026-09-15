/**
 * The plugin card TEMPLATE (§15.6): the manifest owns the layout, the result
 * owns the values, and the seam between them is a slot.
 *
 * The rules that matter are the ones about what a slot is NOT: not a
 * fragment, not an expression, not a path into a nested object. Each of those
 * would be a small language, and a small language inside a signed manifest is
 * a large attack surface.
 */

import { cardTemplateSlot, cardTemplateSlots, fillCardTemplate } from '../../src/plugins/card_template';

describe('what counts as a slot', () => {
  it('a whole string of one identifier in braces', () => {
    expect(cardTemplateSlot('{eway_bill_no}')).toBe('eway_bill_no');
    expect(cardTemplateSlot('{status}')).toBe('status');
    expect(cardTemplateSlot('{_private}')).toBe('_private');
  });

  it('a FRAGMENT is literal text, not a slot', () => {
    // Partial interpolation truncates the sentence around an over-long value
    // and re-enters substitution on a value carrying its own braces. The block
    // vocabulary separates label from value, so nothing needs fragments.
    expect(cardTemplateSlot('Bill {eway_bill_no}')).toBeNull();
    expect(cardTemplateSlot('{a} and {b}')).toBeNull();
    expect(cardTemplateSlot('{eway_bill_no} ')).toBeNull();
  });

  it('a path, an expression, or an empty name is not a slot', () => {
    expect(cardTemplateSlot('{amount.currency}')).toBeNull();
    expect(cardTemplateSlot('{a || b}')).toBeNull();
    expect(cardTemplateSlot('{}')).toBeNull();
    expect(cardTemplateSlot('{9lives}')).toBeNull();
    expect(cardTemplateSlot(`{${'x'.repeat(80)}}`)).toBeNull();
  });

  it('a non-string is never a slot', () => {
    for (const value of [7, true, null, undefined, {}, ['{a}']]) {
      expect(cardTemplateSlot(value)).toBeNull();
    }
  });
});

describe('the slots a template names', () => {
  it('finds them at any depth, deduplicated, in first-seen order', () => {
    const template = {
      version: 1,
      blocks: [
        { kind: 'title', text: 'E-way bill' },
        { kind: 'stat', value: '{eway_bill_no}' },
        { kind: 'list', rows: [{ text: '{valid_until}', sub: '{eway_bill_no}' }] },
      ],
    };
    expect(cardTemplateSlots(template)).toEqual(['eway_bill_no', 'valid_until']);
  });

  it('a template with no slots names none', () => {
    expect(cardTemplateSlots({ version: 1, blocks: [{ kind: 'body', text: 'nothing here' }] })).toEqual([]);
  });
});

describe('filling a template', () => {
  const template = {
    version: 1,
    blocks: [
      { kind: 'title', text: 'Payment status' },
      { kind: 'stat', value: '{status}' },
      { kind: 'keyValue', label: 'Settled at', value: '{settled_at}' },
      { kind: 'keyValue', label: 'Attempts', value: '{attempts}' },
      { kind: 'keyValue', label: 'Confirmed', value: '{confirmed}' },
      { kind: 'keyValue', label: 'Jurisdictions', value: '{jurisdictions}' },
      { kind: 'keyValue', label: 'Breakdown', value: '{breakdown}' },
    ],
  };

  it('puts the result’s values in, leaving the publisher’s words alone', () => {
    const filled = fillCardTemplate(template, {
      status: 'settled',
      settled_at: '2026-09-15T10:00:00Z',
      attempts: 3,
      confirmed: true,
      jurisdictions: ['CA', 'San Francisco'],
      breakdown: { state: 1, city: 2 },
    }) as { blocks: (Record<string, unknown> | undefined)[] };
    expect(filled.blocks[0]?.text).toBe('Payment status');
    expect(filled.blocks[1]?.value).toBe('settled');
    expect(filled.blocks[2]?.value).toBe('2026-09-15T10:00:00Z');
    // A number reads as its decimal form, a boolean in words, a list by count.
    expect(filled.blocks[3]?.value).toBe('3');
    expect(filled.blocks[4]?.value).toBe('yes');
    expect(filled.blocks[5]?.value).toBe('2 items');
    // An object has no honest one-line rendering, so its block loses its value
    // and the CardSpec validator drops the block.
    expect(filled.blocks[6]?.value).toBeNull();
  });

  it('an absent field becomes null rather than the word "undefined"', () => {
    const filled = fillCardTemplate(template, { status: 'pending' }) as {
      blocks: Record<string, unknown>[];
    };
    expect(filled.blocks[1]?.value).toBe('pending');
    expect(filled.blocks[2]?.value).toBeNull();
  });

  it('a result field carrying its OWN braces is a value, never another substitution', () => {
    const filled = fillCardTemplate(template, { status: '{settled_at}', settled_at: 'secret' }) as {
      blocks: Record<string, unknown>[];
    };
    expect(filled.blocks[1]?.value).toBe('{settled_at}');
  });

  it('never mutates the template — the pinned bytes are reused across renders', () => {
    const before = JSON.stringify(template);
    fillCardTemplate(template, { status: 'settled' });
    expect(JSON.stringify(template)).toBe(before);
  });

  it('a result that is not an object fills nothing rather than throwing', () => {
    for (const result of [null, 7, 'settled', ['settled']]) {
      const filled = fillCardTemplate(template, result) as { blocks: (Record<string, unknown> | undefined)[] };
      expect(filled.blocks[1]?.value).toBeNull();
    }
  });
});
