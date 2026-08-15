/**
 * §9.12 — held evidence is bound to a MESSAGE FAMILY, not to a byte sequence.
 *
 * WHAT THIS REPLACED. The check walked the entire signed body as a JSON tree
 * and returned true if the expected digest appeared as ANY string at ANY
 * depth. So a genuine, correctly-signed, entirely unrelated supplier response
 * that merely MENTIONED the digest — echoed a parameter, quoted it in a card,
 * carried it as a query id — satisfied the check and could be replayed as
 * re-adoption evidence for an order that supplier never acknowledged.
 *
 * `never_received` is the one answer that authorizes resubmitting an order, so
 * every lie that gets through is a duplicate order: goods shipped twice, money
 * owed twice.
 *
 * The verifier now asks four questions the old one did not:
 *   1. is this a VALID `service.response` body at all?
 *   2. did it SUCCEED? (an `unavailable` answer commits to nothing)
 *   3. is the digest inside `result` — the part that IS the supplier's answer?
 *   4. (in `verifyHeldRecord`) is the envelope type `service.response`?
 *
 * The fixture that fed this was itself invalid — `status: 'ok'`, no
 * `ttl_seconds` — which is how a body no D2D pipeline would accept was being
 * used to prove the verifier worked.
 */

import { heldResponseCommitsTo } from '../../src/commerce/lifecycle_engine';

const DIGEST = 'ab'.repeat(32);

/**
 * A conformant `service.response` body carrying `result`.
 *
 * `result` is part of `overrides` rather than a defaulted parameter: passing
 * `undefined` explicitly to a defaulted parameter selects the DEFAULT, so an
 * "omit the result" case silently built a body that still had one — and
 * reported the verifier as broken when the fixture was.
 */
function body(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    capability: 'com.dinakernel.commerce.order_status',
    query_id: 'q-1',
    status: 'success',
    ttl_seconds: 300,
    result: { status_digest: DIGEST },
    ...overrides,
  });
}

describe('held evidence binds to a service.response result', () => {
  it('accepts the digest inside the result', () => {
    expect(heldResponseCommitsTo(body(), DIGEST)).toBe(true);
  });

  it('accepts the record nested under its own key', () => {
    // `{result: {acknowledgement: {acknowledgement_digest}}}` — the record
    // stating its own identity, one level down.
    expect(
      heldResponseCommitsTo(
        body({ result: { acknowledgement: { acknowledgement_digest: DIGEST } } }),
        DIGEST,
      ),
    ).toBe(true);
  });

  /**
   * THE DIGEST HAS TO BE THE RECORD'S OWN IDENTITY, not a string in its result.
   *
   * Narrowing from "anywhere in the body" to "anywhere in `result`" was not a
   * binding either. A genuine, correctly-signed response from an UNRELATED
   * capability satisfied it whenever the digest appeared somewhere inside —
   * echoed as a parameter, listed among digests already seen, carried in a
   * free-text field. §9.12 asks whether this response IS the record being
   * presented; these are all cases where it demonstrably is not.
   */
  it('REFUSES the digest under a field that is not a record identity', () => {
    for (const result of [
      { echoed_id: DIGEST },
      { seen: [DIGEST] },
      { note: `we processed ${DIGEST}` },
      { nested: { deeper: { digest: DIGEST } } },
      // The right shape at the wrong depth: two levels down is not "the
      // record nested under its own key".
      { wrapper: { acknowledgement: { acknowledgement_digest: DIGEST } } },
      // The right value under the wrong field name on the record itself.
      { digest: DIGEST },
      { order_digest: DIGEST },
    ]) {
      expect(heldResponseCommitsTo(body({ result }), DIGEST)).toBe(false);
    }
  });

  it('accepts a status receipt by its own status_digest', () => {
    expect(heldResponseCommitsTo(body({ result: { status_digest: DIGEST } }), DIGEST)).toBe(true);
    expect(
      heldResponseCommitsTo(body({ result: { status: { status_digest: DIGEST } } }), DIGEST),
    ).toBe(true);
  });

  it('refuses an array result, which can carry no identity', () => {
    expect(heldResponseCommitsTo(body({ result: [{ status_digest: DIGEST }] }), DIGEST)).toBe(
      false,
    );
  });

  it('REFUSES a digest that appears outside the result', () => {
    // THE CENTRAL CASE. Everything about this response is genuine and signed;
    // the digest is simply not part of what the supplier answered. The old
    // tree-walk accepted it.
    expect(heldResponseCommitsTo(body({ query_id: DIGEST, result: { state: 'accepted' } }), DIGEST)).toBe(
      false,
    );
  });

  it('REFUSES a digest hidden in a card rather than the result', () => {
    // `card` is publisher-shaped, opaque display data. A buyer that can get a
    // supplier to render arbitrary text could otherwise mint evidence.
    expect(
      heldResponseCommitsTo(
        body({ card: { title: DIGEST }, result: { state: 'accepted' } }),
        DIGEST,
      ),
      ).toBe(false);
  });

  it('refuses an unsuccessful response even when the result names the digest', () => {
    // "I could not answer" is not a commitment. Both non-success statuses.
    expect(heldResponseCommitsTo(body({ status: 'unavailable' }), DIGEST)).toBe(false);
    expect(heldResponseCommitsTo(body({ status: 'error' }), DIGEST)).toBe(false);
  });

  it('refuses a body that is not a valid service.response', () => {
    // The exact fixture shape that used to be accepted: a status outside the
    // closed set, and no ttl.
    const invalid = JSON.stringify({
      capability: 'com.dinakernel.commerce.order_status',
      query_id: 'q-1',
      status: 'ok',
      result: { status_digest: DIGEST },
    });
    expect(heldResponseCommitsTo(invalid, DIGEST)).toBe(false);
  });

  it('refuses a response with no result at all', () => {
    // `JSON.stringify` drops an undefined value, so this body has no `result`.
    expect(heldResponseCommitsTo(body({ result: undefined }), DIGEST)).toBe(false);
    expect(heldResponseCommitsTo(body({ result: 'a string result' }), DIGEST)).toBe(false);
    expect(heldResponseCommitsTo(body({ result: null }), DIGEST)).toBe(false);
  });

  it('refuses an unparseable body rather than throwing', () => {
    // A throw out of the reconcile path would leave the order neither
    // re-adopted nor refused.
    expect(heldResponseCommitsTo('{not json', DIGEST)).toBe(false);
    expect(heldResponseCommitsTo('', DIGEST)).toBe(false);
  });

  it('refuses a DIFFERENT digest in a perfectly valid response', () => {
    // The baseline: the mechanism still distinguishes records.
    expect(heldResponseCommitsTo(body(), 'cd'.repeat(32))).toBe(false);
  });
});
