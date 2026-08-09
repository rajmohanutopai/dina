/**
 * WS-2.8 — receipt authentication evidence (§9.12, §16.2).
 *
 * The receipt store is content-addressed, so the record body is self-proving.
 * What it could not show is HOW this node came to hold the document — signed
 * here, or received from a counterparty over an authenticated envelope. That
 * is what a dispute turns on: "we agree this is the document" is rarely the
 * argument, "you sent it to me, here is the envelope" is.
 *
 * The column existed since CMC-1 and every caller wrote `'{}'`, and `put` was
 * first-writer-wins, so the later observation — the one carrying real
 * authentication — was thrown away.
 */

import {
  mergeEvidence,
  readEvidence,
  receivedFrom,
  signedHere,
} from '../../src/commerce/receipt_evidence';
import { InMemoryCommerceReceiptRepository } from '../../src/commerce/receipts';

const NOW = 1_700_000_000_000;
const DIGEST = 'a'.repeat(64);
const BUYER = 'did:plc:retailer';

describe('reading stored evidence', () => {
  it('reads back what was written', () => {
    expect(readEvidence(signedHere(NOW))).toEqual({
      observations: [{ kind: 'signed_here', observedAt: NOW }],
    });
  });

  /**
   * A receipt whose evidence column was corrupted must not become a receipt
   * nobody can write to: the record body is the thing under dispute, and
   * losing access to it because a metadata field went bad is the worse
   * failure. The corrupt value is DROPPED, not merged — merging it would give
   * anyone who could write that column a way to inject observations.
   */
  it.each(['', 'not json', 'null', '[]', '{}', '{"observations":"nope"}'])(
    'reads %p as empty rather than throwing',
    (json) => {
      expect(readEvidence(json)).toEqual({ observations: [] });
    },
  );

  it('drops an observation with an unknown kind', () => {
    const json = JSON.stringify({
      observations: [
        { kind: 'invented', observedAt: NOW },
        { kind: 'signed_here', observedAt: NOW },
      ],
    });
    expect(readEvidence(json).observations).toHaveLength(1);
  });

  it('drops an observation with no readable timestamp', () => {
    const json = JSON.stringify({ observations: [{ kind: 'received', observedAt: 'today' }] });
    expect(readEvidence(json).observations).toEqual([]);
  });
});

describe('merging', () => {
  it('adds a later observation to an earlier one', () => {
    // The sequence the whole item exists for: a node records a document it
    // built, then receives the same digest back carrying real authentication.
    const stored = signedHere(NOW);
    const merged = mergeEvidence(
      stored,
      readEvidence(receivedFrom({ fromDid: BUYER, observedAt: NOW + 10, envelopeId: 'env-1' }))
        .observations,
    );
    expect(readEvidence(merged).observations.map((o) => o.kind)).toEqual([
      'signed_here',
      'received',
    ]);
  });

  it('does not grow on a retried delivery of the SAME envelope', () => {
    const first = receivedFrom({ fromDid: BUYER, observedAt: NOW, envelopeId: 'env-1' });
    const merged = mergeEvidence(first, readEvidence(first).observations);
    expect(readEvidence(merged).observations).toHaveLength(1);
  });

  it('treats a retry at a DIFFERENT millisecond as the same fact', () => {
    // `observedAt` is deliberately absent from the identity. Including the
    // clock would make every retry a new observation and turn the evidence
    // list into a delivery log.
    const first = receivedFrom({ fromDid: BUYER, observedAt: NOW, envelopeId: 'env-1' });
    const retry = receivedFrom({ fromDid: BUYER, observedAt: NOW + 5_000, envelopeId: 'env-1' });
    const merged = mergeEvidence(first, readEvidence(retry).observations);
    expect(readEvidence(merged).observations).toHaveLength(1);
    // And the FIRST sighting keeps its timestamp: when it first arrived is
    // the fact worth holding.
    expect(readEvidence(merged).observations[0]?.observedAt).toBe(NOW);
  });

  it('keeps TWO deliveries under different keys, because that is itself evidence', () => {
    const first = receivedFrom({ fromDid: BUYER, observedAt: NOW, keyId: 'key-1' });
    const second = receivedFrom({ fromDid: BUYER, observedAt: NOW, keyId: 'key-2' });
    const merged = mergeEvidence(first, readEvidence(second).observations);
    expect(readEvidence(merged).observations).toHaveLength(2);
  });

  it('does not merge a corrupt stored value into the result', () => {
    const merged = mergeEvidence('{"observations":[{"kind":"forged"}]}', [
      { kind: 'signed_here', observedAt: NOW },
    ]);
    expect(readEvidence(merged).observations).toEqual([{ kind: 'signed_here', observedAt: NOW }]);
  });
});

describe('the repository write: two fields, two rules', () => {
  function receipt(evidenceJson: string, recordJson = '{"v":1}') {
    return {
      recordDigest: DIGEST,
      domain: 'order' as const,
      buyerDid: BUYER,
      quoteId: 'q-1',
      purchaseOrderId: 'po-1',
      recordJson,
      evidenceJson,
      createdAt: NOW,
    };
  }

  it('accumulates evidence across two writes of the same digest', () => {
    const repo = new InMemoryCommerceReceiptRepository();
    repo.put(receipt(signedHere(NOW)));
    repo.put(receipt(receivedFrom({ fromDid: BUYER, observedAt: NOW + 10, envelopeId: 'env-1' })));
    const stored = repo.get(DIGEST);
    expect(readEvidence(stored?.evidenceJson ?? '').observations.map((o) => o.kind)).toEqual([
      'signed_here',
      'received',
    ]);
  });

  /**
   * The body must stay first-writer-wins. The digest addresses those bytes, so
   * a second writer proposing different bytes under the same digest is a
   * collision or an attack — the first writer holds.
   */
  it('does NOT let a second writer replace the record body', () => {
    const repo = new InMemoryCommerceReceiptRepository();
    repo.put(receipt(signedHere(NOW), '{"v":1}'));
    repo.put(receipt(signedHere(NOW + 1), '{"v":"forged"}'));
    expect(repo.get(DIGEST)?.recordJson).toBe('{"v":1}');
  });

  it('reports FALSE on the second write, because no record was created', () => {
    // Callers use the return value to decide whether they stored the record.
    // An evidence merge must not read as a creation.
    const repo = new InMemoryCommerceReceiptRepository();
    expect(repo.put(receipt(signedHere(NOW)))).toBe(true);
    expect(repo.put(receipt(receivedFrom({ fromDid: BUYER, observedAt: NOW })))).toBe(false);
  });
});
