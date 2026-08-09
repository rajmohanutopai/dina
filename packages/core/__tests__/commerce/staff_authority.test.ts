/**
 * WS-8.4 — who may commit this business to this order (§7.2, §7.3).
 *
 * Two rules, and the second is the one that gets violated by accident:
 * caller-supplied body fields establish no identity, and the contract must not
 * encode "one phone equals the organization". The pilot may ship with one
 * owner approver — that is a CONFIGURATION with one grant in it, not a
 * shortcut in the code, and these tests are largely about the difference.
 */

import {
  chainGaps,
  evaluateStaffAuthority,
  type ActingForChain,
  type AuthorityRequest,
  type QuorumPolicy,
  type StaffGrant,
} from '../../src/commerce/staff_authority';

const NOW = 1_700_000_000_000;
const OWNER = 'did:plc:owner';
const STAFF = 'did:plc:staff';
const OTHER = 'did:plc:other';

function chain(overrides: Partial<ActingForChain> = {}): ActingForChain {
  return {
    principalDid: OWNER,
    installId: 'install-buyer',
    actingForBusinessDid: 'did:plc:sanchobusiness',
    authorityDomain: 'procurement',
    policyRevision: null,
    supplierDid: 'did:plc:chairmaker99',
    serviceRkey: 'self',
    quoteDigest: 'a'.repeat(64),
    orderDigest: 'b'.repeat(64),
    ...overrides,
  };
}

function request(overrides: Partial<AuthorityRequest> = {}): AuthorityRequest {
  return {
    total: { currency: 'INR', minor_units: '50000' },
    categoryIds: ['furniture.seating'],
    regionValue: 'admin_area:IN-KA',
    side: 'buy',
    ...overrides,
  };
}

const NO_QUORUM: QuorumPolicy = { secondPersonAtOrAboveMinorUnits: null, currency: 'INR' };

function evaluate(args: {
  grants: StaffGrant[];
  approvals?: string[];
  chain?: ActingForChain;
  request?: AuthorityRequest;
  quorum?: QuorumPolicy;
  nowMs?: number;
}) {
  return evaluateStaffAuthority({
    chain: args.chain ?? chain(),
    approvals: args.approvals ?? [OWNER],
    grants: args.grants,
    request: args.request ?? request(),
    quorum: args.quorum ?? NO_QUORUM,
    nowMs: args.nowMs ?? NOW,
  });
}

describe('the acting-for chain (§7.2)', () => {
  it('accepts a complete chain', () => {
    expect(chainGaps(chain())).toEqual([]);
  });

  it.each([
    ['principalDid', 'principal_missing'],
    ['installId', 'install_missing'],
    ['actingForBusinessDid', 'business_missing'],
    ['supplierDid', 'counterparty_missing'],
    ['orderDigest', 'payload_missing'],
  ])('reports %s as %s', (field, gap) => {
    expect(chainGaps(chain({ [field]: '' } as Partial<ActingForChain>))).toContain(gap);
  });

  it('accepts a policy revision INSTEAD of an authority domain, but not neither', () => {
    // An act is authorized either by a domain a person holds or by a policy
    // that decided without one. Neither means nothing authorized it.
    expect(chainGaps(chain({ authorityDomain: null, policyRevision: '7' }))).toEqual([]);
    expect(chainGaps(chain({ authorityDomain: null, policyRevision: null }))).toContain(
      'authority_missing',
    );
  });

  it('REFUSES on a gap rather than proceeding as the owner', () => {
    // Every field is something the caller had to learn from an authenticated
    // source. An empty one means they did not learn it, and the safe reading
    // of "I do not know who is acting" is never "proceed as the owner".
    const verdict = evaluate({
      grants: [{ kind: 'owner', principalDid: OWNER }],
      chain: chain({ principalDid: '' }),
      approvals: [''],
    });
    expect(verdict.permitted).toBe(false);
    if (verdict.permitted) throw new Error('expected a refusal');
    expect(verdict.reason).toContain('incomplete');
  });
});

describe('the authority shapes §7.3 requires', () => {
  it('lets an owner grant cover anything', () => {
    expect(evaluate({ grants: [{ kind: 'owner', principalDid: OWNER }] }).permitted).toBe(true);
  });

  it('holds a buyer to their spend ceiling, exactly', () => {
    const grants: StaffGrant[] = [
      { kind: 'buyer', principalDid: STAFF, spendCeilingMinorUnits: '50000', currency: 'INR' },
    ];
    const at = evaluate({
      grants,
      approvals: [STAFF],
      chain: chain({ principalDid: STAFF }),
      request: request({ total: { currency: 'INR', minor_units: '50000' } }),
    });
    expect(at.permitted).toBe(true);

    // One minor unit over is over. A ceiling that bent by a rupee is not a
    // ceiling anybody can rely on.
    const over = evaluate({
      grants,
      approvals: [STAFF],
      chain: chain({ principalDid: STAFF }),
      request: request({ total: { currency: 'INR', minor_units: '50001' } }),
    });
    expect(over.permitted).toBe(false);
  });

  it('does not convert currencies to fit a ceiling', () => {
    // Converting would make an authority decision depend on a rate nobody
    // approved.
    const verdict = evaluate({
      grants: [
        { kind: 'buyer', principalDid: STAFF, spendCeilingMinorUnits: '9999999', currency: 'USD' },
      ],
      approvals: [STAFF],
      chain: chain({ principalDid: STAFF }),
      request: request({ total: { currency: 'INR', minor_units: '1' } }),
    });
    expect(verdict.permitted).toBe(false);
  });

  it('requires a category buyer to cover EVERY category, not any', () => {
    // An order spanning an authorized and an unauthorized category is not
    // half-authorized.
    const grants: StaffGrant[] = [
      { kind: 'category_buyer', principalDid: STAFF, categoryIds: ['furniture.seating'] },
    ];
    expect(
      evaluate({
        grants,
        approvals: [STAFF],
        chain: chain({ principalDid: STAFF }),
        request: request({ categoryIds: ['furniture.seating'] }),
      }).permitted,
    ).toBe(true);
    expect(
      evaluate({
        grants,
        approvals: [STAFF],
        chain: chain({ principalDid: STAFF }),
        request: request({ categoryIds: ['furniture.seating', 'electronics'] }),
      }).permitted,
    ).toBe(false);
  });

  it('honours branch or location authority', () => {
    const grants: StaffGrant[] = [
      { kind: 'location', principalDid: STAFF, regionValues: ['admin_area:IN-KA'] },
    ];
    expect(
      evaluate({ grants, approvals: [STAFF], chain: chain({ principalDid: STAFF }) }).permitted,
    ).toBe(true);
    expect(
      evaluate({
        grants,
        approvals: [STAFF],
        chain: chain({ principalDid: STAFF }),
        request: request({ regionValue: 'admin_area:IN-MH' }),
      }).permitted,
    ).toBe(false);
  });

  it('keeps buying and selling authority apart', () => {
    // A sales grant does not let somebody buy, and a buyer grant does not let
    // them accept an order on the business's behalf.
    const sales: StaffGrant[] = [{ kind: 'supplier_sales', principalDid: STAFF }];
    expect(
      evaluate({
        grants: sales,
        approvals: [STAFF],
        chain: chain({ principalDid: STAFF }),
        request: request({ side: 'sell' }),
      }).permitted,
    ).toBe(true);
    expect(
      evaluate({
        grants: sales,
        approvals: [STAFF],
        chain: chain({ principalDid: STAFF }),
        request: request({ side: 'buy' }),
      }).permitted,
    ).toBe(false);
  });

  it('expires a time-bounded delegation on its own', () => {
    // §7.3's point: delegated authority stops working without anybody
    // remembering to revoke it.
    const grants: StaffGrant[] = [
      {
        kind: 'delegated',
        principalDid: STAFF,
        delegates: { kind: 'owner', principalDid: STAFF },
        notAfterMs: NOW + 1_000,
      },
    ];
    expect(
      evaluate({ grants, approvals: [STAFF], chain: chain({ principalDid: STAFF }) }).permitted,
    ).toBe(true);
    expect(
      evaluate({
        grants,
        approvals: [STAFF],
        chain: chain({ principalDid: STAFF }),
        nowMs: NOW + 1_001,
      }).permitted,
    ).toBe(false);
  });
});

describe('quorum (§7.3)', () => {
  const quorum: QuorumPolicy = { secondPersonAtOrAboveMinorUnits: '50000', currency: 'INR' };
  const grants: StaffGrant[] = [
    { kind: 'owner', principalDid: OWNER },
    { kind: 'owner', principalDid: OTHER },
  ];

  it('asks for a second person at or above the threshold', () => {
    const verdict = evaluate({ grants, quorum });
    expect(verdict.permitted).toBe(false);
    if (verdict.permitted) throw new Error('expected a refusal');
    // Distinguished from a flat refusal: a UI must be able to say "get someone
    // else" rather than "you cannot do this".
    expect(verdict.needsAnotherPrincipal).toBe(true);
  });

  it('is satisfied by two DISTINCT principals', () => {
    expect(evaluate({ grants, quorum, approvals: [OWNER, OTHER] }).permitted).toBe(true);
  });

  it('is not satisfied by one person approving twice', () => {
    // Passing the SET rather than a count is what makes the rule real.
    const verdict = evaluate({ grants, quorum, approvals: [OWNER, OWNER] });
    expect(verdict.permitted).toBe(false);
    if (verdict.permitted) throw new Error('expected a refusal');
    expect(verdict.needsAnotherPrincipal).toBe(true);
  });

  it('leaves smaller orders to one person', () => {
    expect(
      evaluate({
        grants,
        quorum,
        request: request({ total: { currency: 'INR', minor_units: '49999' } }),
      }).permitted,
    ).toBe(true);
  });
});

describe('what cannot be routed around', () => {
  it('refuses when the acting principal has not approved', () => {
    // Otherwise one person could submit an order approved entirely by other
    // people, which reads as authorized and is nobody's decision to act on.
    const verdict = evaluate({
      grants: [{ kind: 'owner', principalDid: OTHER }],
      approvals: [OTHER],
      chain: chain({ principalDid: STAFF }),
    });
    expect(verdict.permitted).toBe(false);
    if (verdict.permitted) throw new Error('expected a refusal');
    expect(verdict.reason).toContain('has not approved');
  });

  it('refuses an approver with no live grant, and names them', () => {
    const verdict = evaluate({ grants: [], approvals: [OWNER] });
    expect(verdict.permitted).toBe(false);
    if (verdict.permitted) throw new Error('expected a refusal');
    expect(verdict.reason).toContain(OWNER);
  });

  it('refuses every approver, not just the first', () => {
    // A second approver without authority does not become authorized by
    // standing next to one who has it.
    const verdict = evaluate({
      grants: [{ kind: 'owner', principalDid: OWNER }],
      approvals: [OWNER, OTHER],
      quorum: { secondPersonAtOrAboveMinorUnits: '1', currency: 'INR' },
    });
    expect(verdict.permitted).toBe(false);
    if (verdict.permitted) throw new Error('expected a refusal');
    expect(verdict.reason).toContain(OTHER);
  });

  it('treats an unreadable amount as exceeding every ceiling', () => {
    // Fails toward refusing. An unreadable total that slipped under a ceiling
    // would be the one arithmetic bug that spends money.
    const verdict = evaluate({
      grants: [
        { kind: 'buyer', principalDid: OWNER, spendCeilingMinorUnits: '999999', currency: 'INR' },
      ],
      request: request({ total: { currency: 'INR', minor_units: '12.5' } }),
    });
    expect(verdict.permitted).toBe(false);
  });

  it('has no owner branch that skips evaluation', () => {
    // §7.3: the contract must not encode "one phone equals the organization".
    // An owner with no grant record is not an owner — the pilot's single
    // approver is a CONFIGURATION, not a code path.
    expect(
      evaluate({ grants: [], approvals: [OWNER], chain: chain({ principalDid: OWNER }) }).permitted,
    ).toBe(false);
  });
});
