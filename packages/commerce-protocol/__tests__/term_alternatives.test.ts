/**
 * COMMITMENT_KERNEL §6, §15 step 3 — promises and alternatives on term deals.
 *
 *   P-30  an offer's alternatives: 1 to 7, sorted unique ids, full terms,
 *         structured promises only (no free text, bounded dimensions);
 *   P-31  a proposal takes one version exactly: the offer's own terms with no
 *         promises, or an alternative's terms and promises as stated.
 */

import {
  validateTermAgreementProposal,
  validateTermOffer,
  verifyTermProposalAgainstOffer,
  type TermAlternative,
} from '../src/index';

import { hash, makeOffer, makeRequest, makeTermProposal, terms } from './helpers/term_fixtures';

const TUESDAY_RUN: TermAlternative = {
  alternative_id: 'a1',
  terms: terms('230000', '1000'),
  promises: [
    { name: 'stock_run', by: 'buyer', dimensions: { crates: '2', day: 'tue', every_days: '7' } },
  ],
};

describe('alternatives and promises', () => {
  it('P-30: an offer carries well-formed alternatives only', () => {
    const offer = makeOffer(makeRequest(), { alternatives: [TUESDAY_RUN] });
    expect(validateTermOffer(offer, hash)).toBeNull();
    const bad = (alternatives: unknown) =>
      validateTermOffer(
        makeOffer(makeRequest(), { alternatives: alternatives as TermAlternative[] }),
        hash,
      );
    expect(bad([])).toMatch(/1 to 7/);
    expect(
      bad(
        Array.from({ length: 8 }, (_, i) => ({ ...TUESDAY_RUN, alternative_id: `a${String(i)}` })),
      ),
    ).toMatch(/1 to 7/);
    expect(bad([TUESDAY_RUN, TUESDAY_RUN])).toMatch(/sorted by id, unique/);
    expect(bad([{ ...TUESDAY_RUN, note: 'free text' }])).toMatch(/not a field/);
    expect(
      bad([
        {
          ...TUESDAY_RUN,
          promises: [{ name: 'stock_run', by: 'buyer', dimensions: { day: 'Tuesday please!' } }],
        },
      ]),
    ).toMatch(/lowercase/);
    expect(
      bad([
        {
          ...TUESDAY_RUN,
          promises: [{ name: 'stock_run', by: 'the store', dimensions: { day: 'tue' } }],
        },
      ]),
    ).toMatch(/buyer \| seller/);
  });

  it('P-31: a proposal takes one version exactly', () => {
    const offer = makeOffer(makeRequest(), { alternatives: [TUESDAY_RUN] });
    const own = makeTermProposal(offer);
    expect(validateTermAgreementProposal(own, hash)).toBeNull();
    expect(verifyTermProposalAgainstOffer(own, offer)).toBeNull();
    const alt = makeTermProposal(offer, {
      alternative_id: 'a1',
      terms: TUESDAY_RUN.terms,
      promises: TUESDAY_RUN.promises,
    });
    expect(validateTermAgreementProposal(alt, hash)).toBeNull();
    expect(verifyTermProposalAgainstOffer(alt, offer)).toBeNull();
    // The alternative's terms without its promise: refused.
    expect(
      verifyTermProposalAgainstOffer(
        makeTermProposal(offer, { alternative_id: 'a1', terms: TUESDAY_RUN.terms }),
        offer,
      ),
    ).toMatch(/promises differ/);
    // A changed promise field: refused.
    const changed = [
      { ...TUESDAY_RUN.promises[0], dimensions: { crates: '2', day: 'wed', every_days: '7' } },
    ];
    expect(
      verifyTermProposalAgainstOffer(
        makeTermProposal(offer, {
          alternative_id: 'a1',
          terms: TUESDAY_RUN.terms,
          promises: changed as TermAlternative['promises'],
        }),
        offer,
      ),
    ).toMatch(/promises differ/);
    // The offer's own terms with a promise attached: refused.
    expect(
      verifyTermProposalAgainstOffer(
        makeTermProposal(offer, { promises: TUESDAY_RUN.promises }),
        offer,
      ),
    ).toMatch(/carry no promises/);
    expect(
      verifyTermProposalAgainstOffer(makeTermProposal(offer, { alternative_id: 'zz' }), offer),
    ).toMatch(/no alternative/);
  });
});
