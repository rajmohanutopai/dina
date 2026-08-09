/**
 * §16.2/§9.11 — choosing what a restore fence stands on (ARCH-0c).
 *
 * A restored supplier fast-forwards to what the buyer can prove. Which
 * receipt it lands on decides the whole chain's future, so the choice has
 * to be one the chain can actually support.
 *
 * The old selection was `reduce` to the highest sequence plus two checks
 * against the local head. That admits two things it should not:
 *
 *   - a GAP. Present the head's successor and then a receipt six
 *     sequences later, and the supplier jumps past records nobody showed
 *     it. Every status names its predecessor precisely so the chain has
 *     no gaps; skipping one discards that at the moment it matters most.
 *   - a FORK IN THE EVIDENCE. Two authentic receipts at the same top
 *     sequence with different digests mean the supplier signed twice at
 *     one height. `reduce` kept whichever came first in the array, so the
 *     buyer chose the winner by ordering its own request.
 *
 * Both are refusals rather than repairs. Which branch is real is exactly
 * what a restored node lost and cannot re-derive.
 *
 * These drive the rule directly: signature verification is the caller's
 * job and is tested where it lives, so every record here is treated as
 * already proven authentic. What is under test is whether they line up.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { commerceRecordDigest, type CommerceOrderStatus, type Sha256Fn } from '@dina/commerce-protocol';

import { selectFencePredecessor } from '../../src/commerce/status_chain';

const hash: Sha256Fn = (data) => sha256(data);

/** A status record with a REAL digest — the selector compares digests. */
function status(args: {
  sequence: string;
  previous?: string;
  state?: string;
  salt?: string;
}): CommerceOrderStatus {
  const base = {
    protocol_version: '1.0',
    purchase_order_id: 'po-1',
    buyer_did: 'did:plc:buyer',
    supplier_did: 'did:plc:supplier',
    sequence: args.sequence,
    ...(args.previous === undefined ? {} : { previous_status_digest: args.previous }),
    state: args.state ?? 'preparing',
    supplier_epoch: '1',
    updated_at: '2026-08-08T10:00:00.000Z',
    // Distinguishes two records at one sequence without changing anything
    // the rule reads, which is the whole point of the fork case.
    ...(args.salt === undefined ? {} : { supplier_order_id: args.salt }),
    status_digest: '',
  } as unknown as Record<string, unknown>;
  const digest = commerceRecordDigest('status', base, hash);
  return { ...base, status_digest: digest } as unknown as CommerceOrderStatus;
}

const GENESIS = status({ sequence: '0', state: 'accepted' });
const HEAD = { headSequence: GENESIS.sequence, headDigest: GENESIS.status_digest };

describe('a contiguous chain from the head', () => {
  it('accepts one unbroken run and returns its tallest record', () => {
    const one = status({ sequence: '1', previous: GENESIS.status_digest });
    const two = status({ sequence: '2', previous: one.status_digest });
    const verdict = selectFencePredecessor(HEAD, [two, one]);
    expect(verdict.ok).toBe(true);
    // Order of presentation must not matter — the rule sorts.
    expect(verdict.ok && verdict.value.status_digest).toBe(two.status_digest);
  });

  it('accepts the head itself as the predecessor', () => {
    const verdict = selectFencePredecessor(HEAD, [GENESIS]);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.value.status_digest).toBe(GENESIS.status_digest);
  });

  it('accepts receipts BELOW the head without walking', () => {
    // Rollback is the caller's rule and is enforced there; deciding it here
    // too would put one rule in two places, where they can disagree.
    const above = { headSequence: '5', headDigest: 'f'.repeat(64) };
    const one = status({ sequence: '1', previous: GENESIS.status_digest });
    expect(selectFencePredecessor(above, [one]).ok).toBe(true);
  });
});

describe('a gap is refused', () => {
  it('refuses when a sequence between the head and the top is missing', () => {
    const one = status({ sequence: '1', previous: GENESIS.status_digest });
    const three = status({ sequence: '3', previous: 'a'.repeat(64) });
    const verdict = selectFencePredecessor(HEAD, [one, three]);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.refusal).toBe('evidence_not_contiguous');
    expect(!verdict.ok && verdict.detail).toMatch(/sequence 2/);
  });

  it('refuses a lone receipt that does not name the head', () => {
    // Rooting is by DIGEST, not by requiring the head record itself: a buyer
    // presenting only what is above our head is being economical. But the
    // lowest one it presents has to name our head.
    const orphan = status({ sequence: '1', previous: 'b'.repeat(64) });
    const verdict = selectFencePredecessor(HEAD, [orphan]);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.refusal).toBe('evidence_not_contiguous');
    expect(!verdict.ok && verdict.detail).toMatch(/does not name the record before it/);
  });

  it('refuses a run whose middle link points somewhere else', () => {
    // Present, in sequence, and still not a chain: sequence 2 names a record
    // that is not sequence 1.
    const one = status({ sequence: '1', previous: GENESIS.status_digest });
    const two = status({ sequence: '2', previous: 'c'.repeat(64) });
    const verdict = selectFencePredecessor(HEAD, [one, two]);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.refusal).toBe('evidence_not_contiguous');
  });

  it('refuses an empty set rather than choosing nothing', () => {
    const verdict = selectFencePredecessor(HEAD, []);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.refusal).toBe('evidence_not_contiguous');
  });
});

describe('a fork in the evidence is refused', () => {
  it('refuses two different records at the same top sequence', () => {
    const one = status({ sequence: '1', previous: GENESIS.status_digest });
    const rival = status({ sequence: '1', previous: GENESIS.status_digest, salt: 'CM-9' });
    expect(one.status_digest).not.toBe(rival.status_digest);
    const verdict = selectFencePredecessor(HEAD, [one, rival]);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.refusal).toBe('evidence_forks');
  });

  it('refuses a fork BURIED below a taller receipt', () => {
    // Checked across the whole set, not only the top, so a contradiction
    // cannot be hidden under a higher record.
    const one = status({ sequence: '1', previous: GENESIS.status_digest });
    const rival = status({ sequence: '1', previous: GENESIS.status_digest, salt: 'CM-9' });
    const two = status({ sequence: '2', previous: one.status_digest });
    const verdict = selectFencePredecessor(HEAD, [one, rival, two]);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.refusal).toBe('evidence_forks');
  });

  it('tolerates the SAME record presented twice', () => {
    // A duplicate is not a disagreement, and a buyer that repeats itself
    // should not be refused for it.
    const one = status({ sequence: '1', previous: GENESIS.status_digest });
    const verdict = selectFencePredecessor(HEAD, [one, { ...one }]);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.value.status_digest).toBe(one.status_digest);
  });
});
