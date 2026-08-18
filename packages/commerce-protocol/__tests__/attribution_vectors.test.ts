/**
 * §6.4 dual-read migration vectors (TRADE_FIRST_STRATEGY).
 *
 * PINNED HEX, frozen on purpose: the v1 digests must never move (a
 * stored pre-staff receipt is re-verified against them for ever), and
 * the v2 digests pin the attributed domain so an implementation cannot
 * silently reuse the v1 domain with an extra field. Any change that
 * shifts one of these constants is a wire break, not a refactor.
 */

import { createHash } from 'node:crypto';

import {
  catalogContentReceiptDigest,
  validateVouchReceipt,
  vouchReceiptDigest,
  type Sha256Fn,
  type VouchReceipt,
} from '../src/index';

const hash: Sha256Fn = (data) => new Uint8Array(createHash('sha256').update(data).digest());

const VOUCH_V1: VouchReceipt = {
  draft_id: 'draft-vec-1',
  ceremony: 1,
  extraction_digest: 'a'.repeat(64),
  lines: [
    {
      line_id: 'l1',
      generation: 1,
      quantity: { value: '10', unit_code: 'each' },
      resolved_product: { scheme: 'gtin', value: '09506000134352' },
      supplier_did: 'did:plc:vectorsupplier00000000000',
    },
  ],
  requirements: [{ key: 'delivery_note', omitted: false, value: 'gate 4', generation: 1 }],
};
const VOUCH_V2: VouchReceipt = {
  ...VOUCH_V1,
  attribution: { version: 2, vouched_by: 'did:key:zstaffvector' },
};

const CONTENT_V1 = {
  items: [{ name: 'Teak chair', price: { currency: 'INR', minor_units: '450000' } }],
  provenance: { '0': { name: 'confirmed', price: 'confirmed' } },
  contentRevision: 3,
  extraction: { model: 'gemini-2.5-flash', schemaVersion: 'catalog-rows-1' },
};

describe('§6.4 vouch receipt dual-read vectors', () => {
  it('the v1 digest is frozen — nothing already stored moves', () => {
    expect(vouchReceiptDigest(VOUCH_V1, hash)).toBe(
      '8d13cd825840d6855a6466c65ce2ca50b937abacdc866ef1767faa50c5ade265',
    );
    // An explicit-undefined attribution is the v1 shape, byte for byte —
    // the guard the rest-destructure exists for. Cast because the type
    // itself (exactOptionalPropertyTypes) already forbids the shape; the
    // runtime rule must hold anyway for JS callers.
    expect(
      vouchReceiptDigest({ ...VOUCH_V1, attribution: undefined } as unknown as VouchReceipt, hash),
    ).toBe(vouchReceiptDigest(VOUCH_V1, hash));
  });

  it('v2 commits under its OWN domain with the voucher inside the preimage', () => {
    const v2 = vouchReceiptDigest(VOUCH_V2, hash);
    expect(v2).toBe('24831423437f659305e5391b72e1a058dd653830fcdcf7533fc57f8f010b8154');
    expect(v2).not.toBe(vouchReceiptDigest(VOUCH_V1, hash));
    // A different voucher is a different receipt.
    expect(
      vouchReceiptDigest(
        { ...VOUCH_V1, attribution: { version: 2, vouched_by: 'did:key:zother' } },
        hash,
      ),
    ).not.toBe(v2);
  });

  it('the validator narrows attribution to exactly {version: 2, vouched_by DID}', () => {
    expect(validateVouchReceipt(VOUCH_V1)).toBeNull();
    expect(validateVouchReceipt(VOUCH_V2)).toBeNull();
    expect(
      validateVouchReceipt({ ...VOUCH_V1, attribution: { version: 3, vouched_by: 'did:key:z' } }),
    ).toContain('version');
    expect(
      validateVouchReceipt({ ...VOUCH_V1, attribution: { version: 2, vouched_by: '' } }),
    ).not.toBeNull();
  });
});

describe('§6.4 content receipt dual-read vectors', () => {
  it('the v1 digest is frozen; null attribution IS v1', () => {
    const v1 = catalogContentReceiptDigest(CONTENT_V1, hash);
    expect(v1).toBe('c55c8588e09cf40cd820cafc3cb78c4772e8121e68403254571c45bc5cf1bfe2');
    expect(catalogContentReceiptDigest({ ...CONTENT_V1, attribution: null }, hash)).toBe(v1);
  });

  it('v2 commits under content_receipt_v2 with the voucher bound', () => {
    const v2 = catalogContentReceiptDigest(
      { ...CONTENT_V1, attribution: { version: 2, vouched_by: 'did:key:zstaffvector' } },
      hash,
    );
    expect(v2).toBe('e0ba848fe93efa0ec5deba75cd1e23813fadb2c10044aee72b344d0f48e4bec4');
    expect(v2).not.toBe(catalogContentReceiptDigest(CONTENT_V1, hash));
  });
});
