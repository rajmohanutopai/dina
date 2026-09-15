/**
 * How a plugin's answer reaches the owner (§15.6, §11).
 *
 * The render is Core's because it is policy: §15.13 says the client contract
 * carries no policy of its own, and a safe-rendering rule copied into the
 * phone and the web is a rule that eventually differs between them. So these
 * pin the render itself — what survives untrusted mode, what never does, and
 * when there is honestly nothing to draw.
 */

import { buildPluginResultCard } from '../../src/plugins/result_card';

import type { CardBlock } from '@dina/protocol';

const CARD = {
  version: 1,
  blocks: [
    { kind: 'title', text: 'E-way bill', icon: 'document' },
    { kind: 'stat', value: '{eway_bill_no}', caption: 'bill number' },
    { kind: 'keyValue', label: 'Valid until', value: '{valid_until}' },
  ],
};

function task(over: { card?: unknown; result?: string | null; status?: string } = {}) {
  const payload = {
    type: 'plugin_invocation',
    install_id: 'pli_in',
    capability_id: 'com.dinakernel.country.in.eway-bill',
    params: {},
    context: [],
    manifest_cid: 'bafy-cid',
    approved_scope_hash: 'a'.repeat(64),
    schema_snapshot: null,
    ...('card' in over ? { card_snapshot: over.card } : { card_snapshot: CARD }),
    config_revision: 1,
    execution_id: 'plgx_1',
    idempotency_key: 'key-1',
    action_class: 'write',
    effects_idempotency: 'supported',
  };
  return {
    status: over.status ?? 'completed',
    payload: JSON.stringify(payload),
    result:
      over.result !== undefined
        ? over.result
        : JSON.stringify({ eway_bill_no: 'EWB-9912', valid_until: '2026-09-18' }),
  };
}

function kinds(blocks: readonly CardBlock[]): string[] {
  return blocks.map((b) => b.kind);
}

describe('the template renders the answer', () => {
  it('fills the pinned template from the validated result', () => {
    const card = buildPluginResultCard(task());
    expect(card).not.toBeNull();
    expect(kinds(card?.blocks ?? [])).toEqual(['title', 'stat', 'keyValue']);
    expect(card?.blocks[1]).toEqual({ kind: 'stat', value: 'EWB-9912', caption: 'bill number' });
    expect(card?.blocks[2]).toEqual({ kind: 'keyValue', label: 'Valid until', value: '2026-09-18' });
  });

  it('a field the runner left out drops its block, never an empty row', () => {
    const card = buildPluginResultCard(task({ result: JSON.stringify({ eway_bill_no: 'EWB-9912' }) }));
    expect(kinds(card?.blocks ?? [])).toEqual(['title', 'stat']);
  });

  it('renders the template PINNED on the task, not whatever the install carries now', () => {
    // The point of `card_snapshot`: the owner approved an answer arriving in
    // this shape, and an update that rewrites the card must not re-frame an
    // answer already in flight.
    const card = buildPluginResultCard(
      task({
        card: { version: 1, blocks: [{ kind: 'body', text: 'the shape approved at the time' }] },
      }),
    );
    expect(card?.blocks).toEqual([{ kind: 'body', text: 'the shape approved at the time' }]);
  });
});

describe('untrusted mode, and no outbound exit', () => {
  it('drops a badge — trust chrome is Dina’s, and a plugin cannot mint it', () => {
    const card = buildPluginResultCard(
      task({
        card: {
          version: 1,
          blocks: [
            { kind: 'badge', text: 'Verified by the GST department', tone: 'positive' },
            { kind: 'stat', value: '{eway_bill_no}' },
          ],
        },
      }),
    );
    expect(kinds(card?.blocks ?? [])).toEqual(['stat']);
  });

  it('drops a link and a media block — a plugin answer has no outbound exit (§11)', () => {
    const card = buildPluginResultCard(
      task({
        card: {
          version: 1,
          blocks: [
            { kind: 'title', text: 'E-way bill' },
            { kind: 'link', label: 'Download the bill', url: 'https://example.test/bill', action: 'open_url' },
            { kind: 'media', url: 'https://example.test/bill.png', alt: 'the bill' },
          ],
        },
      }),
    );
    expect(kinds(card?.blocks ?? [])).toEqual(['title']);
    expect(JSON.stringify(card)).not.toContain('example.test');
  });

  it('drops a block kind this node does not know, rather than guessing at it', () => {
    const card = buildPluginResultCard(
      task({
        card: {
          version: 1,
          blocks: [
            { kind: 'title', text: 'E-way bill' },
            { kind: 'future_widget', text: 'from a newer publisher' },
          ],
        },
      }),
    );
    expect(kinds(card?.blocks ?? [])).toEqual(['title']);
  });

  it('drops the card’s FRAME — a source line and a freshness stamp are Dina’s, not a publisher’s', () => {
    const card = buildPluginResultCard(
      task({
        card: {
          version: 1,
          sourceLabel: 'Official GST record',
          generatedAt: '2026-09-15T10:42:00Z',
          expiresAt: '2026-12-01T00:00:00Z',
          ttlSeconds: 3600,
          blocks: [{ kind: 'stat', value: '{eway_bill_no}' }],
        },
      }),
    );
    expect(card).toEqual({ version: 1, blocks: [{ kind: 'stat', value: 'EWB-9912' }] });
    expect(JSON.stringify(card)).not.toContain('Official GST record');
  });

  it('a result cannot smuggle layout: its values fill slots and change nothing else', () => {
    const card = buildPluginResultCard(
      task({
        result: JSON.stringify({
          eway_bill_no: 'EWB-9912',
          valid_until: '2026-09-18',
          // A runner inventing its own blocks is simply a field nothing names.
          blocks: [{ kind: 'badge', text: 'Trusted' }],
          version: 2,
        }),
      }),
    );
    expect(kinds(card?.blocks ?? [])).toEqual(['title', 'stat', 'keyValue']);
    expect(card?.version).toBe(1);
  });
});

describe('when there is nothing to draw', () => {
  it('a capability with no template answers on the label: value floor', () => {
    expect(buildPluginResultCard(task({ card: undefined }))).toBeNull();
  });

  it('a task that has not completed has no answer yet', () => {
    expect(buildPluginResultCard(task({ status: 'pending_approval' }))).toBeNull();
    expect(buildPluginResultCard(task({ status: 'outcome_unknown' }))).toBeNull();
  });

  it('an unreadable or non-object result renders nothing rather than a card of empty labels', () => {
    expect(buildPluginResultCard(task({ result: 'not json' }))).toBeNull();
    expect(buildPluginResultCard(task({ result: null }))).toBeNull();
    expect(buildPluginResultCard(task({ result: '"settled"' }))).toBeNull();
    expect(buildPluginResultCard(task({ result: '[1,2]' }))).toBeNull();
  });

  it('a template whose every block fails validation is null, not an empty card', () => {
    const card = buildPluginResultCard(
      task({ card: { version: 1, blocks: [{ kind: 'keyValue', label: 'Valid until', value: '{missing}' }] } }),
    );
    expect(card).toBeNull();
  });

  it('an unparseable envelope renders nothing', () => {
    expect(buildPluginResultCard({ status: 'completed', payload: 'not json', result: '{}' })).toBeNull();
  });
});
